/**
 * 订阅 URL 真实拉取器与用户流量/到期信息解析引擎
 * 严格支持：HTTP/HTTPS 真实网络拉取、自定义代理客户端 UA、超时与重试策略、
 * subscription-userinfo 协议标头提取与无法获取时明确标记未知
 */

import dns from 'dns';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ParseError, ProfileItem, ProxyNode, SubscriptionUserInfo } from '../../shared/types';
import { smartParse } from '../../services/importer/smart-importer';
import { storageManager } from '../storage/store';

export interface FetchSubscriptionResult {
  success: boolean;
  nodes: ProxyNode[];
  userInfo?: SubscriptionUserInfo;
  rawText?: string;
  error?: string;
}

const USER_AGENT = 'clash-verge/v1.7.0 NexLink/0.1.0 Mihomo/1.19.32';

/**
 * 解析 subscription-userinfo 响应标头
 * 样例: "upload=1073741824; download=2147483648; total=107374182400; expire=1735689600"
 */
export function parseSubscriptionUserInfo(headerValue: string | null): SubscriptionUserInfo | undefined {
  if (!headerValue || !headerValue.trim()) {
    return undefined;
  }

  const result: SubscriptionUserInfo = {};
  const parts = headerValue.split(';');

  for (const part of parts) {
    const [rawKey, rawVal] = part.split('=');
    if (!rawKey || !rawVal) continue;
    const key = rawKey.trim().toLowerCase();
    const val = Number(rawVal.trim());

    if (isNaN(val)) continue;

    if (key === 'upload') result.upload = val;
    else if (key === 'download') result.download = val;
    else if (key === 'total') result.total = val;
    else if (key === 'expire') {
      result.expire = val;
      // expire <= 0 表示永不过期，不转换为 1970-01-01
      if (val > 0) {
        const ts = val > 1e11 ? val : val * 1000;
        const d = new Date(ts);
        if (!isNaN(d.getTime())) {
          result.expireDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate()
          ).padStart(2, '0')}`;
        }
      }
    }
  }

  // 必须至少包含一项有效信息，否则视为未知
  if (
    result.upload !== undefined ||
    result.download !== undefined ||
    result.total !== undefined ||
    result.expire !== undefined
  ) {
    return result;
  }

  return undefined;
}

export type DnsLookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  retryDelayMs?: number;
  allowedBaseDir?: string;
  allowPrivateNetwork?: boolean;
  allowFakeIpRange?: boolean;
  lookupFn?: DnsLookupFn;
}

const MAX_REMOTE_REDIRECTS = 5;

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 未指定网段
  if (a === 10) return true; // 10.0.0.0/8 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地与云元数据 (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私网
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 组播与 240.0.0.0/4 保留地址
  return false;
}

function parseIPv6Hextets(rawIp: string): number[] | null {
  let addr = rawIp.toLowerCase();
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const ipv4Part = addr.slice(lastColon + 1);
    const octets = ipv4Part.split('.').map((p) => Number(p));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const nums: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      nums.push(parseInt(token, 16));
    }
    return nums;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(halves[0]);
  const right = parseSide(halves[1]);
  if (!left || !right) return null;
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array<number>(zeroCount).fill(0), ...right];
}

function hextetsToIPv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const cleaned = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(cleaned);
  if (family === 4) {
    return isPrivateOrReservedIPv4(cleaned);
  }
  if (family === 6) {
    const h = parseIPv6Hextets(cleaned);
    if (!h) return true;
    const isAllZero = h.every((g) => g === 0);
    if (isAllZero) return true; // ::
    const isLoopback = h.slice(0, 7).every((g) => g === 0) && h[7] === 1;
    if (isLoopback) return true; // ::1

    // IPv4-mapped (::ffff:0:0/96) / IPv4-compatible (::/96) / NAT64 (64:ff9b::/96)
    const isMappedV4 = h.slice(0, 5).every((g) => g === 0) && h[5] === 0xffff;
    const isCompatV4 = h.slice(0, 6).every((g) => g === 0);
    const isNat64 = h[0] === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((g) => g === 0);
    if (isMappedV4 || isCompatV4 || isNat64) {
      return isPrivateOrReservedIPv4(hextetsToIPv4(h[6], h[7]));
    }

    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地
    if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
    if (h[0] === 0x2002) {
      return isPrivateOrReservedIPv4(hextetsToIPv4(h[1], h[2])); // 6to4 内嵌 IPv4
    }
    if (h[0] === 0x2001 && (h[1] === 0x0000 || h[1] === 0x0db8)) return true; // Teredo / Documentation
    return false;
  }
  return true;
}

function isFakeIpAddress(rawIp: string): boolean {
  const cleaned = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIP(cleaned) !== 4) {
    return false;
  }
  const parts = cleaned.split('.').map((p) => Number(p));
  // Mihomo TUN Fake-IP 默认配置网段: 198.18.0.1/16 (仅放行 198.18.x.x)
  return parts.length === 4 && parts[0] === 198 && parts[1] === 18;
}

function createSsrfError(message: string): Error & { noRetry: boolean } {
  const err = new Error(message) as Error & { noRetry: boolean };
  err.noRetry = true;
  return err;
}

/**
 * 校验远程订阅 URL 安全性：仅允许 http/https，并拦截回环、私网、云元数据及本地内部域名（SSRF 防护）
 * 当 TUN Fake-IP 模式激活 (allowFakeIpRange=true) 时，允许公网域名经系统 DNS 解析出的 198.18.0.0/16 地址，
 * 但若 URL 主机名本身为字面 IP（如 http://198.18.0.1/...）仍严格拦截。
 */
export async function assertSafeRemoteSubscriptionUrl(
  rawUrl: string,
  allowPrivateNetwork: boolean = false,
  lookupFn?: DnsLookupFn,
  allowFakeIpRange: boolean = false
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw createSsrfError(`无效的远程订阅 URL: ${rawUrl || '未提供'}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createSsrfError(`安全拦截: 远程订阅仅支持 HTTP/HTTPS 协议，已拒绝 ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!hostname) {
    throw createSsrfError('无效的远程订阅 URL: 缺少主机名');
  }

  if (allowPrivateNetwork) {
    return parsed;
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw createSsrfError(`安全拦截: 远程订阅禁止访问本地或内网保留域名 (${hostname})`);
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw createSsrfError(`安全拦截: 远程订阅禁止访问回环、私网或保留 IP 地址 (${hostname})`);
    }
    return parsed;
  }

  const resolve =
    lookupFn || ((host: string) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const records = await resolve(hostname);
  if (!records || records.length === 0) {
    throw new Error(`无法解析远程订阅域名: ${hostname}`);
  }
  for (const rec of records) {
    if (allowFakeIpRange && isFakeIpAddress(rec.address)) {
      continue;
    }
    if (isPrivateOrReservedIp(rec.address)) {
      throw createSsrfError(
        `安全拦截: 远程订阅域名 ${hostname} 解析到了禁止访问的私网/保留 IP (${rec.address})`
      );
    }
  }

  return parsed;
}

function isPathInsideDir(parentDir: string, childPath: string): boolean {
  const normParent = process.platform === 'win32' ? parentDir.toLowerCase() : parentDir;
  const normChild = process.platform === 'win32' ? childPath.toLowerCase() : childPath;
  const rel = path.relative(normParent, normChild);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !rel.startsWith('../') &&
    !path.isAbsolute(rel)
  );
}

/**
 * 校验本地订阅文件路径是否严格位于受控 profiles/ 目录内（基于 realpathSync 阻断目录穿越与符号链接逃逸）
 */
export function resolveSafeLocalProfilePath(
  candidatePath: string,
  baseDir?: string
): { ok: true; realPath: string } | { ok: false; error: string } {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    return { ok: false, error: '本地订阅文件路径不能为空' };
  }

  const effectiveBaseDir = baseDir !== undefined ? baseDir : storageManager.getBaseDir();
  if (!effectiveBaseDir || !effectiveBaseDir.trim()) {
    return { ok: false, error: '受控存储目录未初始化，已拒绝读取本地文件' };
  }

  const profilesDir = path.resolve(effectiveBaseDir, 'profiles');
  const resolvedCandidate = path.resolve(candidatePath.trim());

  // 词法预检：先阻断明显位于受控目录之外的路径，避免对任意磁盘路径做存在性探测
  if (!isPathInsideDir(profilesDir, resolvedCandidate)) {
    return { ok: false, error: '安全拦截: 本地订阅文件必须位于受控 profiles 目录内' };
  }

  if (!fs.existsSync(profilesDir)) {
    return { ok: false, error: '受控 profiles 目录不存在' };
  }

  try {
    const realProfilesDir = fs.realpathSync(profilesDir);
    if (!fs.existsSync(resolvedCandidate)) {
      return { ok: false, error: '本地配置文件不存在或不可访问' };
    }
    const realTarget = fs.realpathSync(resolvedCandidate);
    if (!isPathInsideDir(realProfilesDir, realTarget)) {
      return { ok: false, error: '安全拦截: 检测到路径穿越或符号链接逃逸，已拒绝读取' };
    }
    return { ok: true, realPath: realTarget };
  } catch (err: any) {
    return { ok: false, error: `本地配置文件路径校验失败: ${err?.message || '不可访问'}` };
  }
}

/**
 * 将 ParseError[] 格式化为可读文本，避免出现 [object Object]
 */
export function formatParseErrors(errors?: ParseError[]): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return '';
  }
  return errors
    .map((err) => {
      if (typeof err === 'string') return err;
      const msg = err?.error || '未知解析错误';
      return err?.line !== undefined ? `第 ${err.line} 行: ${msg}` : msg;
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * 带有全局生命周期超时、流量上限控制与失败重试的流式 Fetch 封装
 */
export async function fetchTextWithLimit(
  url: string,
  options: RequestInit,
  retries: number = 1,
  timeoutMs: number = 15000,
  maxBytes: number = 10 * 1024 * 1024, // 10MB 安全上限
  retryDelayMs: number = 1000,
  validateUrl?: (targetUrl: string) => Promise<void>
): Promise<{ text: string; headers: Headers }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    // 整个下载生命周期（含 HTTP 握手、重定向校验、响应标头及响应体数据流传输）受全局超时严格保护，彻底防止挂起卡死
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let currentUrl = url;
      let response: Response | null = null;

      for (let hop = 0; hop <= MAX_REMOTE_REDIRECTS; hop++) {
        if (validateUrl) {
          await validateUrl(currentUrl);
        }

        response = await fetch(currentUrl, {
          ...options,
          redirect: 'manual',
          signal: controller.signal,
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location) {
            throw createSsrfError(`远程订阅重定向缺少 Location 标头 (HTTP ${response.status})`);
          }
          if (hop >= MAX_REMOTE_REDIRECTS) {
            throw createSsrfError(`远程订阅重定向次数超过上限 (${MAX_REMOTE_REDIRECTS})`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        break;
      }

      if (!response) {
        throw new Error('未能获取有效的远程响应');
      }

      if (!response.ok) {
        const error: any = new Error(`HTTP 状态码异常: ${response.status} ${response.statusText}`);
        error.status = response.status;
        // HTTP 4xx 客户端错误 (如 404, 403, 401) 严禁重试，直接抛出
        if (response.status >= 400 && response.status < 500) {
          clearTimeout(timer);
          throw error;
        }
        throw error;
      }

      // 预检 Content-Length 标头
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
          clearTimeout(timer);
          await response.body?.cancel().catch(() => {});
          const sizeErr: any = new Error(`订阅内容过大 (${Math.round(contentLength / 1024 / 1024)}MB)，超出安全上限`);
          sizeErr.noRetry = true;
          throw sizeErr;
        }
      }

      if (!response.body) {
        const text = await response.text();
        clearTimeout(timer);
        return { text, headers: response.headers };
      }

      // 流式读取数据并严格限制最大内存字节，防范慢速挂起与内存耗尽
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            if (totalBytes > maxBytes) {
              await reader.cancel();
              const sizeErr: any = new Error(`订阅内容过大，超出安全上限，已主动中止下载`);
              sizeErr.noRetry = true;
              throw sizeErr;
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }

      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      return { text, headers: response.headers };
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;

      // 若为 HTTP 4xx 或不可重试错误（如超限），直接向上抛出
      if (err.noRetry || (err.status >= 400 && err.status < 500)) {
        throw err;
      }

      if (attempt < retries) {
        // 超时或可重试网络错误：仅重试 1 次
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError || new Error(`拉取订阅失败 (${retries + 1} 次重试均失败)`);
}

/**
 * 真实拉取并解析单个订阅源
 */
export async function fetchSubscription(
  subInput: ProfileItem | string,
  options?: FetchOptions
): Promise<FetchSubscriptionResult> {
  let sub: ProfileItem;
  if (typeof subInput === 'string') {
    const trimmed = subInput.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      sub = { id: 'temp', name: 'temp', type: 'remote', url: trimmed, nodeCount: 0, updatedAt: '', status: 'ok' };
    } else {
      sub = { id: 'temp', name: 'temp', type: 'local', filePath: trimmed, nodeCount: 0, updatedAt: '', status: 'ok' };
    }
  } else {
    // 禁止将 ProfileItem.url 回退当成本地 filePath
    sub = { ...subInput };
  }

  // 1. 本地文件或自定义原始文本 (Direct content / Base64 / URI / Sandboxed local file)
  if (sub.type === 'local') {
    if (sub.url && sub.url.trim()) {
      return {
        success: false,
        nodes: [],
        error: '安全拦截: 本地订阅不允许通过 url 字段读取路径或内容',
      };
    }

    // 情况 A: 提供了本地文件路径（强制 realpathSync 锁定在受控 profiles/ 目录内）
    if (sub.filePath && sub.filePath.trim()) {
      const pathCheck = resolveSafeLocalProfilePath(sub.filePath, options?.allowedBaseDir);
      if (!pathCheck.ok) {
        return {
          success: false,
          nodes: [],
          error: pathCheck.error,
        };
      }

      try {
        const stat = fs.statSync(pathCheck.realPath);
        if (!stat.isFile()) {
          return { success: false, nodes: [], error: '目标路径不是有效文件' };
        }
        if (stat.size > 15 * 1024 * 1024) {
          return { success: false, nodes: [], error: '本地配置文件体积超过 15MB 安全上限' };
        }
        const content = fs.readFileSync(pathCheck.realPath, 'utf8');
        const parseRes = smartParse(content, { subscriptionId: sub.id });
        if (!parseRes.success || parseRes.nodes.length === 0) {
          const detailErr = formatParseErrors(parseRes.errors);
          return {
            success: false,
            nodes: [],
            error: detailErr || '本地配置文件中未解析出有效节点',
          };
        }
        const taggedNodes = parseRes.nodes.map((n) => ({
          ...n,
          subscriptionId: sub.id,
        }));
        return {
          success: true,
          nodes: taggedNodes,
          rawText: content,
          userInfo: undefined, // 本地文件无服务商流量标头，如实标记为 undefined (展示未知)
        };
      } catch (err: any) {
        return {
          success: false,
          nodes: [],
          error: `读取本地配置文件异常: ${err.message}`,
        };
      }
    }

    // 情况 B: 用户在地址栏直接粘贴了节点 URI (vless/vmess/ss/trojan/hy2/tuic/wg), Base64 密文或 YAML/JSON 配置内容
    const rawContent = sub.rawContent;
    if (rawContent && rawContent.trim()) {
      try {
        const parseRes = smartParse(rawContent.trim(), { subscriptionId: sub.id });
        if (parseRes.nodes.length === 0) {
          const detailErr = formatParseErrors(parseRes.errors) || '未能识别出有效的代理节点';
          return {
            success: false,
            nodes: [],
            error: detailErr,
          };
        }
        const taggedNodes = parseRes.nodes.map((n) => ({
          ...n,
          subscriptionId: sub.id,
        }));
        return {
          success: true,
          nodes: taggedNodes,
          rawText: rawContent,
          userInfo: undefined,
        };
      } catch (err: any) {
        return {
          success: false,
          nodes: [],
          error: `解析节点内容异常: ${err.message}`,
        };
      }
    }

    return {
      success: false,
      nodes: [],
      error: '无效的本地文件路径或未提供内容',
    };
  }

  // 2. 远程 HTTP/HTTPS 订阅拉取（含协议校验与 SSRF 防护）
  if (!sub.url || !sub.url.trim()) {
    return {
      success: false,
      nodes: [],
      error: `无效的远程订阅 URL: ${sub.url || '未提供'}`,
    };
  }

  const allowPrivateNetwork = options?.allowPrivateNetwork === true;
  const allowFakeIpRange = options?.allowFakeIpRange === true;
  const lookupFn = options?.lookupFn;
  const validateRemoteUrl = async (targetUrl: string): Promise<void> => {
    await assertSafeRemoteSubscriptionUrl(
      targetUrl,
      allowPrivateNetwork,
      lookupFn,
      allowFakeIpRange
    );
  };

  const timeoutMs = options?.timeoutMs ?? 15000;
  const retries = options?.retries ?? 1;
  const maxBytes = options?.maxBytes ?? 10 * 1024 * 1024;
  const retryDelayMs = options?.retryDelayMs ?? 1000;

  try {
    const { text: rawContent, headers } = await fetchTextWithLimit(
      sub.url.trim(),
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
      },
      retries,
      timeoutMs,
      maxBytes,
      retryDelayMs,
      validateRemoteUrl
    );

    // 提取服务商流量与到期信息标头 (大小写不敏感)
    const userInfoHeader =
      headers.get('subscription-userinfo') ||
      headers.get('Subscription-Userinfo') ||
      headers.get('Subscription-UserInfo');

    const userInfo = parseSubscriptionUserInfo(userInfoHeader);

    if (!rawContent.trim()) {
      return {
        success: false,
        nodes: [],
        userInfo,
        error: '远程服务器返回空内容',
      };
    }

    const parseRes = smartParse(rawContent, { subscriptionId: sub.id });

    if (!parseRes.success || parseRes.nodes.length === 0) {
      const detailErr = formatParseErrors(parseRes.errors);
      return {
        success: false,
        nodes: [],
        userInfo,
        error: detailErr
          ? `无法从订阅内容中解析出有效代理节点 (格式: ${parseRes.format}): ${detailErr}`
          : `无法从订阅内容中解析出有效代理节点 (格式: ${parseRes.format})`,
      };
    }

    const taggedNodes = parseRes.nodes.map((n) => ({
      ...n,
      subscriptionId: sub.id,
    }));

    return {
      success: true,
      nodes: taggedNodes,
      userInfo,
      rawText: rawContent,
    };
  } catch (err: any) {
    const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('aborted'));
    const realSec = Math.max(1, Math.round(timeoutMs / 1000));
    return {
      success: false,
      nodes: [],
      error: isTimeout ? `请求远程订阅超时 (${realSec}s)` : err.message || '网络连接失败',
    };
  }
}
