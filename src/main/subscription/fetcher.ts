/**
 * 订阅 URL 真实拉取器与用户流量/到期信息解析引擎
 * 严格支持：HTTP/HTTPS 真实网络拉取、自定义代理客户端 UA、超时与重试策略、
 * subscription-userinfo 协议标头提取与无法获取时明确标记未知
 */

import fs from 'fs';
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

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  retryDelayMs?: number;
  allowedBaseDir?: string;
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
  retryDelayMs: number = 1000
): Promise<{ text: string; headers: Headers }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    // 整个下载生命周期（含 HTTP 握手、响应标头及全部响应体数据流传输）受全局超时严格保护，彻底防止挂起卡死
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

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

  // 2. 远程 HTTP/HTTPS 订阅拉取
  if (!sub.url || !/^https?:\/\//i.test(sub.url.trim())) {
    return {
      success: false,
      nodes: [],
      error: `无效的远程订阅 URL: ${sub.url || '未提供'}`,
    };
  }

  const timeoutMs = options?.timeoutMs ?? 15000;
  const retries = options?.retries ?? 1;
  const maxBytes = options?.maxBytes ?? 10 * 1024 * 1024;
  const retryDelayMs = options?.retryDelayMs ?? 1000;

  try {
    const { text: rawContent, headers } = await fetchTextWithLimit(
      sub.url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
      },
      retries,
      timeoutMs,
      maxBytes,
      retryDelayMs
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
