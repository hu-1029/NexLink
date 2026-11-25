/**
 * 多协议 URI 真实解析引擎
 * 完整支持：VMess、VLESS (Reality/Vision/WebSocket/gRPC)、Shadowsocks (SIP002/2022/Plugins)、Trojan、Hysteria2、TUIC、WireGuard
 * 针对 Cloudflare Workers / EdgeTunnel / v2rayN / Shadowrocket 产生的多种异构 Authority (Base64/none:uuid) 及别名参数深度优化
 */

import type {
  Hysteria2Config,
  ProxyNode,
  ShadowsocksConfig,
  TrojanConfig,
  TuicConfig,
  VlessConfig,
  VmessConfig,
  WireGuardConfig,
} from '../../shared/types';
import { safeBase64Decode } from './base64';
import { detectCountry } from './country';
import { generateDeterministicNodeId, isValidPort, isValidServer } from '../node/node-utils';

/**
 * 安全解码 URI 编码字符串（中文、特殊符号等）
 */
function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

interface ParsedUriParts {
  userInfo: string;
  server: string;
  port: number;
  hash: string;
  params: URLSearchParams;
}

/**
 * 弹性 URI 拆解器
 * 兼容标准 URL、未转义字符、纯 Base64 Authority、复合 Base64 全链接
 */
function parseFlexibleUri(
  rawUri: string,
  scheme: string,
  defaultPort: number = 443
): ParsedUriParts {
  let uri = rawUri.trim();
  const prefix = `${scheme}://`;
  if (uri.toLowerCase().startsWith(prefix)) {
    uri = uri.slice(prefix.length).trim();
  }

  // 1. 若整体为无 ? # @ 的 Base64 编码，先尝试整体解密
  if (!uri.includes('?') && !uri.includes('#') && !uri.includes('@')) {
    try {
      const decoded = safeBase64Decode(uri);
      if (decoded.includes('@')) {
        uri = decoded.toLowerCase().startsWith(prefix)
          ? decoded.slice(prefix.length).trim()
          : decoded.trim();
      }
    } catch {
      // 保持原始
    }
  }

  // 2. 剥离 #hash (Node Name 碎片)
  let hash = '';
  const hashIdx = uri.indexOf('#');
  if (hashIdx !== -1) {
    hash = uri.slice(hashIdx + 1);
    uri = uri.slice(0, hashIdx);
  }

  // 3. 剥离 ?query (URL 参数)
  let query = '';
  const qIdx = uri.indexOf('?');
  if (qIdx !== -1) {
    query = uri.slice(qIdx + 1);
    uri = uri.slice(0, qIdx);
  }

  // 4. 解析 authority (用户凭证 @ 目标地址)
  let authority = uri;
  if (!authority.includes('@')) {
    // 针对 authority 整体 Base64 编码的情况 (如 vless://base64(none:uuid@ip:port)?...)
    try {
      const decodedAuth = safeBase64Decode(authority);
      if (decodedAuth.includes('@')) {
        authority = decodedAuth;
      }
    } catch {
      // 无法解码
    }
  }

  if (!authority.includes('@')) {
    throw new Error(`${scheme.toUpperCase()} 链接缺少 @ 用户凭证与地址分隔符`);
  }

  const atIdx = authority.lastIndexOf('@');
  const userInfo = authority.slice(0, atIdx).trim();
  const rawHostPort = authority.slice(atIdx + 1).trim();
  const pathSlashIdx = rawHostPort.indexOf('/');
  const hostPort = pathSlashIdx !== -1 ? rawHostPort.slice(0, pathSlashIdx).trim() : rawHostPort;

  // 5. 提取 server 与 port (支持 IPv6 [::1]:port)
  let server = '';
  let port = defaultPort;

  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']');
    if (closeBracket !== -1) {
      server = hostPort.slice(1, closeBracket);
      const rest = hostPort.slice(closeBracket + 1);
      if (rest.startsWith(':')) {
        const portStr = rest.slice(1).trim();
        if (!/^\d+$/.test(portStr)) {
          throw new Error(`端口号非法: ${portStr}`);
        }
        port = Number(portStr);
      }
    } else {
      server = hostPort;
    }
  } else {
    const colonIdx = hostPort.lastIndexOf(':');
    if (colonIdx !== -1) {
      server = hostPort.slice(0, colonIdx);
      const portStr = hostPort.slice(colonIdx + 1).trim();
      if (!/^\d+$/.test(portStr)) {
        throw new Error(`端口号非法: ${portStr}`);
      }
      port = Number(portStr);
    } else {
      server = hostPort;
    }
  }

  // 处理可能包含的 IPv6 方括号清理
  server = server.replace(/^\[(.*)\]$/, '$1').trim();

  if (!isValidPort(port)) {
    throw new Error(`端口号非法 (必须为 1-65535 的有效整数): ${port}`);
  }
  if (!isValidServer(server)) {
    throw new Error(`服务器地址非法: "${server}"`);
  }

  const params = new URLSearchParams(query);
  return { userInfo, server, port, hash, params };
}

/**
 * 提取节点展示名称 (优先级: Hash > remarks > name > ps > description > server:port)
 */
function extractNodeName(
  hash: string,
  params: URLSearchParams,
  server: string,
  port: number
): string {
  if (hash) {
    return safeDecode(hash);
  }
  const queryName =
    params.get('remarks') ||
    params.get('name') ||
    params.get('ps') ||
    params.get('description');
  if (queryName) {
    return safeDecode(queryName);
  }
  return `${server}:${port}`;
}

/**
 * 解析 VMess 节点链接
 * 支持官方标准 v2rayN JSON Base64 格式及 Query String 格式
 */
export function parseVmess(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const uri = rawUri.trim();
  const content = uri.slice('vmess://'.length).trim();

  // 1. 标准 v2rayN JSON Base64 格式
  try {
    const jsonStr = safeBase64Decode(content);
    if (jsonStr.startsWith('{') && jsonStr.endsWith('}')) {
      const data = JSON.parse(jsonStr);

      const server = String(data.add || '').trim();
      const port = Number(data.port) || 443;
      const uuid = String(data.id || '').trim();
      const name = String(data.ps || data.remarks || data.name || `${server}:${port}`).trim();

      if (!server || !uuid) {
        throw new Error('VMess JSON 缺失必须的 server(add) 或 uuid(id) 参数');
      }

      if (!isValidPort(port)) {
        throw new Error(`VMess 端口号非法: ${data.port}`);
      }
      if (!isValidServer(server)) {
        throw new Error(`VMess 服务器地址非法: ${server}`);
      }

      const net = (data.net || 'tcp').toLowerCase();
      const tls = (data.tls || 'none').toLowerCase();
      const country = detectCountry(name, server);

      const vmessConfig: VmessConfig = {
        uuid,
        alterId: Number(data.aid) || 0,
        cipher: data.scy || 'auto',
        network: ['ws', 'grpc', 'h2', 'tcp'].includes(net) ? net : 'tcp',
        security: tls === 'tls' ? 'tls' : 'none',
        sni: data.sni || data.peer || data.host || undefined,
        alpn: data.alpn ? String(data.alpn).split(',') : undefined,
        fingerprint: data.fp || data.fingerprint || undefined,
        ws:
          net === 'ws'
            ? {
                path: data.path || '/',
                headers: data.host ? { Host: data.host } : undefined,
              }
            : undefined,
        grpc:
          net === 'grpc'
            ? {
                serviceName: data.path || data.serviceName || undefined,
              }
            : undefined,
      };

      return {
        id: generateDeterministicNodeId('vmess', server, port, uuid, name, subscriptionId),
        name,
        type: 'vmess',
        server,
        port,
        delay: undefined, // 严禁伪造测试延时
        isAlive: false,
        country: country.country,
        countryCode: country.countryCode,
        protocolConfig: vmessConfig,
        rawUri,
        subscriptionId: subscriptionId || undefined,
      };
    }
  } catch (err: any) {
    if (!err.message?.includes('VMess JSON')) {
      // 若不是 JSON 结构，继续尝试解析兼容 Query String 格式
    } else {
      throw err;
    }
  }

  // 2. 兼容 Query 形式的 VMess (vmess://uuid@server:port?remarks=...)
  try {
    const { userInfo, server, port, hash, params } = parseFlexibleUri(uri, 'vmess', 443);
    const uuid = userInfo;
    const name = extractNodeName(hash, params, server, port);
    const country = detectCountry(name, server);
    const net = (params.get('type') || params.get('net') || 'tcp').toLowerCase();
    const tls = (params.get('security') || (params.get('tls') === '1' ? 'tls' : 'none')).toLowerCase();
    const sni = params.get('sni') || params.get('peer') || params.get('host') || undefined;

    return {
      id: generateDeterministicNodeId('vmess', server, port, uuid, name, subscriptionId),
      name,
      type: 'vmess',
      server,
      port,
      delay: undefined,
      isAlive: false,
      country: country.country,
      countryCode: country.countryCode,
      protocolConfig: {
        uuid,
        cipher: 'auto',
        network: ['ws', 'grpc', 'h2', 'tcp'].includes(net) ? (net as any) : 'tcp',
        security: tls === 'tls' ? 'tls' : 'none',
        sni,
        ws:
          net === 'ws'
            ? {
                path: params.get('path') || '/',
                headers: params.get('host') ? { Host: params.get('host')! } : undefined,
              }
            : undefined,
        grpc:
          net === 'grpc'
            ? {
                serviceName: params.get('serviceName') || params.get('path') || undefined,
              }
            : undefined,
      },
      rawUri,
      subscriptionId: subscriptionId || undefined,
    };
  } catch {
    throw new Error(`无法识别的 VMess 格式: ${uri.substring(0, 30)}...`);
  }
}

/**
 * 解析 VLESS 节点链接
 * 支持 XTLS-Reality, Flow(Vision), WebSocket, gRPC, TLS
 * 兼容纯明文、Base64 复合 Authority (none:uuid@host:port)、别名参数 (remarks/peer/fingerprint/xtls)
 */
export function parseVless(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const { userInfo, server, port, hash, params } = parseFlexibleUri(
    rawUri,
    'vless',
    443
  );

  // 提取 UUID：可能为直接 uuid，或者前缀 encryption:uuid (如 none:uuid / auto:uuid)
  let uuid = userInfo;
  if (userInfo.includes(':')) {
    const parts = userInfo.split(':');
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const match = parts.find((p) => uuidRegex.test(p));
    if (match) {
      uuid = match;
    } else {
      uuid = parts[1] || parts[0];
    }
  }

  if (!uuid || !server) {
    throw new Error('VLESS 链接缺少 UUID 或服务器地址');
  }

  const name = extractNodeName(hash, params, server, port);
  const country = detectCountry(name, server);

  // Reality 密钥
  const pbk =
    params.get('pbk') ||
    params.get('publicKey') ||
    params.get('public-key') ||
    undefined;
  const sid =
    params.get('sid') ||
    params.get('shortId') ||
    params.get('short-id') ||
    undefined;
  const spx =
    params.get('spx') ||
    params.get('spiderX') ||
    params.get('spider-x') ||
    params.get('spider') ||
    '/';

  // 安全模式判断 (pbk 优先推导为 reality)
  let security: 'none' | 'tls' | 'reality' = 'none';
  if (pbk) {
    security = 'reality';
  } else if (params.get('security')) {
    const s = params.get('security')!.toLowerCase();
    if (s === 'reality') security = 'reality';
    else if (s === 'tls') security = 'tls';
    else security = 'none';
  } else if (
    params.get('tls') === '1' ||
    params.get('tls') === 'true' ||
    params.get('tls') === 'tls'
  ) {
    security = 'tls';
  }

  // 流控 Flow (兼容 xtls=2 为 vision / xtls=1 为 direct / flow=...)
  let flow = params.get('flow') || undefined;
  if (!flow) {
    const xtls = params.get('xtls');
    if (xtls === '2') {
      flow = 'xtls-rprx-vision';
    } else if (xtls === '1') {
      flow = 'xtls-rprx-direct';
    }
  }
  if (flow === 'none' || flow === '') {
    flow = undefined;
  }

  // 传输网络类型 (type / net / network / 智能嗅探)
  let type = (
    params.get('type') ||
    params.get('net') ||
    params.get('network') ||
    ''
  ).toLowerCase() as 'tcp' | 'ws' | 'grpc' | 'h2' | 'xhttp' | 'splithttp';

  if (!type || !['tcp', 'ws', 'grpc', 'h2', 'xhttp', 'splithttp'].includes(type)) {
    if (params.has('path') || params.has('ws')) {
      type = 'ws';
    } else if (params.has('serviceName') || params.has('grpc')) {
      type = 'grpc';
    } else {
      type = 'tcp';
    }
  }

  // SNI / Peer / ServerName
  const sni =
    params.get('sni') ||
    params.get('peer') ||
    params.get('serverName') ||
    params.get('servername') ||
    params.get('host') ||
    undefined;

  // 客户端指纹 Fingerprint
  const fp =
    params.get('fp') ||
    params.get('fingerprint') ||
    params.get('client-fingerprint') ||
    undefined;

  // ALPN
  const alpn = params.get('alpn')
    ? params.get('alpn')!.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  // 传输层配置
  const path = params.get('path') || undefined;
  const host =
    params.get('host') ||
    params.get('sni') ||
    params.get('peer') ||
    undefined;
  const serviceName =
    params.get('serviceName') || params.get('path') || undefined;
  const skipCertVerify =
    ['1', 'true'].includes((params.get('allowInsecure') || '').toLowerCase()) ||
    ['1', 'true'].includes((params.get('insecure') || '').toLowerCase());

  const vlessConfig: VlessConfig = {
    uuid,
    flow,
    network: type,
    security,
    sni,
    alpn,
    fingerprint: fp,
    skipCertVerify,
    reality:
      security === 'reality' && pbk
        ? {
            publicKey: pbk,
            shortId: sid,
            spiderX: spx,
          }
        : undefined,
    ws:
      type === 'ws'
        ? {
            path: path || '/',
            headers: host ? { Host: host } : undefined,
          }
        : undefined,
    grpc:
      type === 'grpc'
        ? {
            serviceName: serviceName || undefined,
          }
        : undefined,
  };

  return {
    id: generateDeterministicNodeId('vless', server, port, uuid, name, subscriptionId),
    name,
    type: 'vless',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: vlessConfig,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 解析 Shadowsocks 节点链接
 * 支持 SIP002 (ss://base64(method:password)@server:port#tag)
 * 支持 SIP002 完整加密 (ss://base64(method:password@server:port)#tag)
 * 支持 SIP003 插件 (v2ray-plugin, obfs)
 * 支持 Shadowsocks 2022 现代密码套件
 */
export function parseShadowsocks(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const uri = rawUri.trim();
  let name = '';
  let mainPart = uri.slice('ss://'.length);

  // 提取 #tag 节点名称
  const hashIdx = mainPart.indexOf('#');
  if (hashIdx !== -1) {
    name = safeDecode(mainPart.slice(hashIdx + 1));
    mainPart = mainPart.slice(0, hashIdx);
  }

  let cipher = '';
  let password = '';
  let server = '';
  let port = 0;
  let plugin = '';
  let pluginOpts = '';
  let queryParams: URLSearchParams | null = null;

  // 格式 1：SIP002 标准形式 ss://BASE64(method:password)@server:port/?plugin=...
  if (mainPart.includes('@')) {
    const atIdx = mainPart.lastIndexOf('@');
    const userinfoRaw = mainPart.slice(0, atIdx);
    const hostAndQuery = mainPart.slice(atIdx + 1);

    // 解码 userinfo: 优先识别明文/URL编码的 method:password (含 SS-2022)，再尝试 Base64 解码
    const decodedRaw = safeDecode(userinfoRaw);
    let userinfo = decodedRaw;
    if (!decodedRaw.includes(':')) {
      try {
        userinfo = safeBase64Decode(userinfoRaw);
      } catch {
        userinfo = decodedRaw;
      }
    }

    const colonIdx = userinfo.indexOf(':');
    if (colonIdx === -1) {
      throw new Error('Shadowsocks 用户信息解析失败，缺少冒号分隔');
    }
    cipher = userinfo.slice(0, colonIdx);
    password = userinfo.slice(colonIdx + 1);

    // 解析 server:port 与 query
    const slashIdx = hostAndQuery.indexOf('/');
    let hostPortStr = hostAndQuery;
    let queryStr = '';
    if (slashIdx !== -1) {
      hostPortStr = hostAndQuery.slice(0, slashIdx);
      queryStr = hostAndQuery.slice(slashIdx + 1);
    } else if (hostAndQuery.includes('?')) {
      const qIdx = hostAndQuery.indexOf('?');
      hostPortStr = hostAndQuery.slice(0, qIdx);
      queryStr = hostAndQuery.slice(qIdx + 1);
    }

    if (queryStr) {
      queryParams = new URLSearchParams(
        queryStr.startsWith('?') ? queryStr.slice(1) : queryStr
      );
    }

    const hostColon = hostPortStr.lastIndexOf(':');
    if (hostColon === -1) {
      throw new Error('Shadowsocks 链接缺少端口号');
    }
    server = hostPortStr.slice(0, hostColon).replace(/^\[(.*)\]$/, '$1').trim();
    port = Number(hostPortStr.slice(hostColon + 1));

    // 解析 plugin 参数
    if (queryParams) {
      const pluginParam = queryParams.get('plugin');
      if (pluginParam) {
        const semiIdx = pluginParam.indexOf(';');
        if (semiIdx !== -1) {
          plugin = pluginParam.slice(0, semiIdx);
          pluginOpts = pluginParam.slice(semiIdx + 1);
        } else {
          plugin = pluginParam;
        }
      }
    }
  } else {
    // 格式 2：传统全段 Base64 形式 ss://BASE64(method:password@server:port)
    const decoded = safeBase64Decode(mainPart);
    const atIdx = decoded.lastIndexOf('@');
    if (atIdx === -1) {
      throw new Error('Shadowsocks 传统链接缺少 @ 分隔符');
    }
    const userinfo = decoded.slice(0, atIdx);
    const hostPort = decoded.slice(atIdx + 1);

    const colon1 = userinfo.indexOf(':');
    cipher = userinfo.slice(0, colon1);
    password = userinfo.slice(colon1 + 1);

    const colon2 = hostPort.lastIndexOf(':');
    server = hostPort.slice(0, colon2).replace(/^\[(.*)\]$/, '$1');
    port = Number(hostPort.slice(colon2 + 1)) || 8388;
  }

  if (!server || !cipher || !isValidServer(server) || !isValidPort(port)) {
    throw new Error('Shadowsocks 参数不完整或非法 (server, port 或 cipher)');
  }

  if (!name && queryParams) {
    const qName =
      queryParams.get('remarks') ||
      queryParams.get('name') ||
      queryParams.get('ps');
    if (qName) name = safeDecode(qName);
  }
  name = name || `${server}:${port}`;
  const country = detectCountry(name, server);

  const ssConfig: ShadowsocksConfig = {
    cipher,
    password,
    plugin: plugin || undefined,
    pluginOpts: pluginOpts || undefined,
  };

  return {
    id: generateDeterministicNodeId('ss', server, port, ssConfig.password || '', name, subscriptionId),
    name,
    type: 'ss',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: ssConfig,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 解析 Trojan 节点链接
 * 支持 trojan://password@server:port?security=tls&sni=...#NodeName
 * 兼容 base64 authority 与 remarks 别名
 */
export function parseTrojan(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const { userInfo, server, port, hash, params } = parseFlexibleUri(
    rawUri,
    'trojan',
    443
  );

  const password = safeDecode(userInfo);
  if (!password || !server) {
    throw new Error('Trojan 缺少密码或服务器地址');
  }

  const name = extractNodeName(hash, params, server, port);
  const country = detectCountry(name, server);

  const sni =
    params.get('sni') ||
    params.get('peer') ||
    params.get('serverName') ||
    params.get('servername') ||
    params.get('host') ||
    undefined;
  const alpn = params.get('alpn') ? params.get('alpn')!.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  let type = (
    params.get('type') ||
    params.get('net') ||
    params.get('network') ||
    'tcp'
  ).toLowerCase() as 'tcp' | 'ws' | 'grpc';

  if (!['tcp', 'ws', 'grpc'].includes(type)) {
    if (params.has('path') || params.has('ws')) type = 'ws';
    else if (params.has('serviceName') || params.has('grpc')) type = 'grpc';
    else type = 'tcp';
  }

  const path = params.get('path') || undefined;
  const host =
    params.get('host') ||
    params.get('sni') ||
    params.get('peer') ||
    undefined;
  const serviceName =
    params.get('serviceName') || params.get('path') || undefined;
  const skipCertVerify =
    ['1', 'true'].includes((params.get('allowInsecure') || '').toLowerCase()) ||
    ['1', 'true'].includes((params.get('insecure') || '').toLowerCase());
  const fp =
    params.get('fp') ||
    params.get('fingerprint') ||
    params.get('client-fingerprint') ||
    undefined;

  const trojanConfig: TrojanConfig = {
    password,
    sni,
    alpn,
    network: type,
    skipCertVerify,
    fingerprint: fp,
    ws:
      type === 'ws'
        ? {
            path: path || '/',
            headers: host ? { Host: host } : undefined,
          }
        : undefined,
    grpc:
      type === 'grpc'
        ? {
            serviceName: serviceName || undefined,
          }
        : undefined,
  };

  return {
    id: generateDeterministicNodeId('trojan', server, port, password, name, subscriptionId),
    name,
    type: 'trojan',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: trojanConfig,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 解析 Hysteria 2 / Hy2 节点链接
 * 支持 hysteria2://password@server:port?insecure=1&sni=...&obfs=salamander&obfs-password=...#NodeName
 */
export function parseHysteria2(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const uri = rawUri.trim();
  const scheme = uri.toLowerCase().startsWith('hy2://') ? 'hy2' : 'hysteria2';
  const { userInfo, server, port, hash, params } = parseFlexibleUri(
    uri,
    scheme,
    443
  );

  const auth = safeDecode(userInfo);
  if (!server) {
    throw new Error('Hysteria 2 缺少服务器地址');
  }

  const name = extractNodeName(hash, params, server, port);
  const country = detectCountry(name, server);

  const sni =
    params.get('sni') ||
    params.get('peer') ||
    params.get('serverName') ||
    params.get('servername') ||
    undefined;
  const insecure =
    ['1', 'true'].includes((params.get('insecure') || '').toLowerCase()) ||
    ['1', 'true'].includes((params.get('allowInsecure') || '').toLowerCase());
  const obfs = params.get('obfs') || undefined;
  const obfsPassword = params.get('obfs-password') || undefined;
  const mport = params.get('mport') || undefined;

  const hy2Config: Hysteria2Config = {
    auth,
    sni,
    skipCertVerify: insecure,
    obfs,
    obfsPassword,
    ports: mport,
  };

  return {
    id: generateDeterministicNodeId('hysteria2', server, port, auth, name, subscriptionId),
    name,
    type: 'hysteria2',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: hy2Config,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 解析 TUIC v5 节点链接
 * 支持 tuic://uuid:password@server:port?congestion_control=bbr&alpn=h3&sni=...#NodeName
 */
export function parseTuic(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const { userInfo, server, port, hash, params } = parseFlexibleUri(
    rawUri,
    'tuic',
    8443
  );

  let uuid = safeDecode(userInfo);
  let password: string | undefined = undefined;
  if (userInfo.includes(':')) {
    const colon = userInfo.indexOf(':');
    uuid = safeDecode(userInfo.slice(0, colon));
    const rawPwd = userInfo.slice(colon + 1);
    password = rawPwd ? safeDecode(rawPwd) : undefined;
  }

  if (!uuid || !server) {
    throw new Error('TUIC 缺少 UUID 或服务器地址');
  }

  const name = extractNodeName(hash, params, server, port);
  const country = detectCountry(name, server);

  const sni =
    params.get('sni') ||
    params.get('peer') ||
    params.get('serverName') ||
    params.get('servername') ||
    undefined;
  const alpn = params.get('alpn') ? params.get('alpn')!.split(',').map((s) => s.trim()).filter(Boolean) : ['h3'];
  const cc = params.get('congestion_control') || 'bbr';
  const udpRelayMode = params.get('udp_relay_mode') || 'native';
  const insecure =
    ['1', 'true'].includes((params.get('allow_insecure') || '').toLowerCase()) ||
    ['1', 'true'].includes((params.get('insecure') || '').toLowerCase()) ||
    ['1', 'true'].includes((params.get('allowInsecure') || '').toLowerCase());

  const tuicConfig: TuicConfig = {
    uuid,
    password,
    congestionController: cc,
    udpRelayMode,
    sni,
    alpn,
    skipCertVerify: insecure,
  };

  return {
    id: generateDeterministicNodeId('tuic', server, port, uuid, name, subscriptionId),
    name,
    type: 'tuic',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: tuicConfig,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 解析 WireGuard 节点链接
 * 支持 wireguard://privateKey@server:port?publickey=...&ip=...#NodeName
 */
export function parseWireGuard(rawUri: string, subscriptionId: string = ''): ProxyNode {
  const uri = rawUri.trim();
  const scheme = uri.toLowerCase().startsWith('wg://') ? 'wg' : 'wireguard';
  const { userInfo, server, port, hash, params } = parseFlexibleUri(
    uri,
    scheme,
    51820
  );

  const privateKey = safeDecode(userInfo);
  const name = extractNodeName(hash, params, server, port);
  const country = detectCountry(name, server);

  const publicKey =
    params.get('publickey') || params.get('publicKey') || undefined;
  const ip = params.get('ip') || params.get('address') || '10.0.0.2/32';
  const presharedKey =
    params.get('presharedkey') || params.get('presharedKey') || undefined;
  const mtu = params.get('mtu') ? Number(params.get('mtu')) : 1420;

  const wgConfig: WireGuardConfig = {
    privateKey,
    publicKey,
    ip,
    presharedKey,
    mtu,
    peers: publicKey
      ? [
          {
            publicKey,
            endpoint: `${server}:${port}`,
            allowedIps: ['0.0.0.0/0'],
          },
        ]
      : undefined,
  };

  return {
    id: generateDeterministicNodeId('wireguard', server, port, privateKey, name, subscriptionId),
    name,
    type: 'wireguard',
    server,
    port,
    delay: undefined,
    isAlive: false,
    country: country.country,
    countryCode: country.countryCode,
    protocolConfig: wgConfig,
    rawUri,
    subscriptionId: subscriptionId || undefined,
  };
}

/**
 * 统一调度单条节点 URI 解析
 */
export function parseSingleUri(line: string, subscriptionId: string = ''): ProxyNode {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  let node: ProxyNode;
  if (lower.startsWith('vmess://')) {
    node = parseVmess(trimmed, subscriptionId);
  } else if (lower.startsWith('vless://')) {
    node = parseVless(trimmed, subscriptionId);
  } else if (lower.startsWith('ss://')) {
    node = parseShadowsocks(trimmed, subscriptionId);
  } else if (lower.startsWith('trojan://')) {
    node = parseTrojan(trimmed, subscriptionId);
  } else if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) {
    node = parseHysteria2(trimmed, subscriptionId);
  } else if (lower.startsWith('tuic://')) {
    node = parseTuic(trimmed, subscriptionId);
  } else if (lower.startsWith('wireguard://') || lower.startsWith('wg://')) {
    node = parseWireGuard(trimmed, subscriptionId);
  } else {
    throw new Error(`未受支持的节点协议前缀: ${trimmed.split('://')[0]}://`);
  }
  if (subscriptionId) {
    node.subscriptionId = subscriptionId;
  }
  return node;
}
