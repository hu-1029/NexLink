/**
 * Mihomo (Clash Meta) 节点配置标准生成器
 * 将标准 ProxyNode 转换为 Mihomo 运行时所需的原生 Proxy 字典
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

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ALLOWED_RAW_PROXY_KEYS = new Set([
  'udp',
  'tls',
  'sni',
  'servername',
  'alpn',
  'skip-cert-verify',
  'client-fingerprint',
  'fingerprint',
  'network',
  'flow',
  'uuid',
  'password',
  'cipher',
  'alterId',
  'plugin',
  'plugin-opts',
  'ws-opts',
  'grpc-opts',
  'h2-opts',
  'http-opts',
  'reality-opts',
  'xhttp-opts',
  'obfs',
  'obfs-password',
  'ports',
  'up',
  'down',
  'congestion-controller',
  'udp-relay-mode',
  'disable-sni',
  'reduce-rtt',
  'heartbeat-interval',
  'ip',
  'ipv6',
  'public-key',
  'private-key',
  'preshared-key',
  'mtu',
  'peers',
  'reserved',
  'token',
  'version',
  'username',
  'dialer-proxy',
  'interface-name',
  'routing-mark',
  'smux',
  'tfo',
  'mptcp',
  'fast-open',
]);

function resolveCredential(...candidates: unknown[]): string {
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim() !== '') {
      return val.trim();
    }
  }
  return '';
}

function sanitizePlainValue(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (depth > 8) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlainValue(item, depth + 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) continue;
    const cleanVal = sanitizePlainValue(val, depth + 1);
    if (cleanVal !== undefined) {
      Object.defineProperty(sanitized, key, {
        value: cleanVal,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return sanitized;
}

export function proxyNodeToMihomo(node: ProxyNode): Record<string, any> {
  const base: Record<string, any> = {
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    udp: true,
  };

  const cfg = node.protocolConfig as any;
  const raw = (node.rawConfig && typeof node.rawConfig === 'object' ? node.rawConfig : {}) as Record<string, any>;
  const rootAny = node as Record<string, any>;

  switch (node.type) {
    case 'vless': {
      const vless = (cfg || {}) as VlessConfig;
      const uuid = resolveCredential(vless.uuid, rootAny.uuid, raw.uuid);
      if (!uuid) {
        throw new Error(`VLESS 节点 "${node.name}" 缺少必需的 uuid`);
      }
      base.uuid = uuid;
      if (vless.flow) base.flow = vless.flow;
      base.network = vless.network || 'tcp';

      if (vless.security === 'reality' && vless.reality) {
        const realityPubKey = resolveCredential(
          vless.reality.publicKey,
          raw['reality-opts']?.['public-key'],
          raw['reality-opts']?.public_key
        );
        if (!realityPubKey) {
          throw new Error(`VLESS Reality 节点 "${node.name}" 缺少必需的 publicKey`);
        }
        base.tls = true;
        base['reality-opts'] = {
          'public-key': realityPubKey,
          'short-id': vless.reality.shortId || '',
          ...(vless.reality.spiderX ? { 'spider-x': vless.reality.spiderX } : {}),
        };
        if (vless.fingerprint) base['client-fingerprint'] = vless.fingerprint;
      } else if (vless.security === 'tls') {
        base.tls = true;
        if (vless.fingerprint) base['client-fingerprint'] = vless.fingerprint;
      }

      if (vless.sni && vless.security !== 'none') base.servername = vless.sni;
      if (vless.alpn && vless.alpn.length > 0) base.alpn = vless.alpn;
      if (vless.skipCertVerify) base['skip-cert-verify'] = true;

      if (vless.network === 'ws' && vless.ws) {
        base['ws-opts'] = {
          path: vless.ws.path || '/',
          headers: sanitizePlainValue(vless.ws.headers || {}) as Record<string, string>,
        };
      } else if (vless.network === 'grpc' && vless.grpc) {
        base['grpc-opts'] = {
          'grpc-service-name': vless.grpc.serviceName || '',
        };
      } else if (vless.network === 'xhttp' || vless.network === 'splithttp' || (cfg && (cfg.xhttp || cfg.obfs === 'xhttp'))) {
        base.network = 'xhttp';
        base['xhttp-opts'] = {
          mode: cfg?.xhttp?.mode || 'auto',
          path: cfg?.xhttp?.path || vless.ws?.path || '/xhttp',
          'x-padding-bytes': '100-1000',
        };
      }
      break;
    }

    case 'vmess': {
      const vmess = (cfg || {}) as VmessConfig;
      const uuid = resolveCredential(vmess.uuid, rootAny.uuid, raw.uuid);
      if (!uuid) {
        throw new Error(`VMess 节点 "${node.name}" 缺少必需的 uuid`);
      }
      base.uuid = uuid;
      base.alterId = vmess.alterId ?? rootAny.alterId ?? 0;
      base.cipher = vmess.cipher || rootAny.cipher || 'auto';
      base.network = vmess.network || 'tcp';

      if (vmess.security === 'tls') {
        base.tls = true;
        if (vmess.sni) base.servername = vmess.sni;
        if (vmess.alpn && vmess.alpn.length > 0) base.alpn = vmess.alpn;
        if ((vmess as any).fingerprint) base['client-fingerprint'] = (vmess as any).fingerprint;
        if ((vmess as any).skipCertVerify) base['skip-cert-verify'] = true;
      }

      if (vmess.network === 'ws' && vmess.ws) {
        base['ws-opts'] = {
          path: vmess.ws.path || '/',
          headers: sanitizePlainValue(vmess.ws.headers || {}) as Record<string, string>,
        };
      } else if (vmess.network === 'grpc' && vmess.grpc) {
        base['grpc-opts'] = {
          'grpc-service-name': vmess.grpc.serviceName || '',
        };
      }
      break;
    }

    case 'ss': {
      const ss = (cfg || {}) as ShadowsocksConfig;
      const cipher = resolveCredential(ss.cipher, rootAny.cipher, raw.cipher) || 'aes-256-gcm';
      const password = resolveCredential(ss.password, rootAny.password, raw.password);
      if (!password && cipher !== 'none' && cipher !== 'plain') {
        throw new Error(`Shadowsocks 节点 "${node.name}" 缺少必需的 password`);
      }
      base.cipher = cipher;
      if (password) {
        base.password = password;
      }
      if (ss.plugin) {
        const rawPlugin = ss.plugin.toLowerCase();
        base.plugin = rawPlugin === 'obfs-local' || rawPlugin === 'simple-obfs' ? 'obfs' : ss.plugin;
        if (ss.pluginOpts) {
          if (typeof ss.pluginOpts === 'string') {
            const optsObj: Record<string, any> = {};
            for (const pair of ss.pluginOpts.split(';')) {
              const trimmed = pair.trim();
              if (!trimmed) continue;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx === -1) {
                if (!FORBIDDEN_PROTO_KEYS.has(trimmed)) {
                  Object.defineProperty(optsObj, trimmed, {
                    value: true,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              } else {
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                const mappedKey = k === 'obfs' ? 'mode' : k === 'obfs-host' ? 'host' : k;
                if (!FORBIDDEN_PROTO_KEYS.has(mappedKey)) {
                  Object.defineProperty(optsObj, mappedKey, {
                    value: v,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                }
              }
            }
            base['plugin-opts'] = optsObj;
          } else if (typeof ss.pluginOpts === 'object') {
            base['plugin-opts'] = sanitizePlainValue(ss.pluginOpts);
          }
        }
      }
      break;
    }

    case 'trojan': {
      const trojan = (cfg || {}) as TrojanConfig;
      const password = resolveCredential(trojan.password, rootAny.password, raw.password);
      if (!password) {
        throw new Error(`Trojan 节点 "${node.name}" 缺少必需的 password`);
      }
      base.password = password;
      if (trojan.sni) base.sni = trojan.sni;
      if (trojan.alpn && trojan.alpn.length > 0) base.alpn = trojan.alpn;
      if (trojan.skipCertVerify) base['skip-cert-verify'] = true;
      if ((trojan as any).fingerprint) base['client-fingerprint'] = (trojan as any).fingerprint;
      base.network = trojan.network || 'tcp';

      if (trojan.network === 'ws' && trojan.ws) {
        base['ws-opts'] = {
          path: trojan.ws.path || '/',
          headers: sanitizePlainValue(trojan.ws.headers || {}) as Record<string, string>,
        };
      } else if (trojan.network === 'grpc' && trojan.grpc) {
        base['grpc-opts'] = {
          'grpc-service-name': trojan.grpc.serviceName || '',
        };
      }
      break;
    }

    case 'hysteria2': {
      const hy2 = (cfg || {}) as Hysteria2Config;
      const password = resolveCredential(hy2.auth, (hy2 as any).password, rootAny.password, raw.password);
      if (!password) {
        throw new Error(`Hysteria2 节点 "${node.name}" 缺少必需的 password/auth`);
      }
      base.password = password;
      if (hy2.sni) base.sni = hy2.sni;
      if (hy2.skipCertVerify) base['skip-cert-verify'] = true;
      if (hy2.obfs) {
        base.obfs = hy2.obfs;
        if (hy2.obfsPassword) base['obfs-password'] = hy2.obfsPassword;
      }
      if (hy2.ports) base.ports = hy2.ports;
      break;
    }

    case 'tuic': {
      const tuic = (cfg || {}) as TuicConfig;
      const uuid = resolveCredential(tuic.uuid, rootAny.uuid, raw.uuid);
      if (!uuid) {
        throw new Error(`TUIC 节点 "${node.name}" 缺少必需的 uuid`);
      }
      base.uuid = uuid;
      const password = resolveCredential(tuic.password, rootAny.password, raw.password);
      if (password) {
        base.password = password;
      }
      if (tuic.congestionController) base['congestion-controller'] = tuic.congestionController;
      if (tuic.udpRelayMode) base['udp-relay-mode'] = tuic.udpRelayMode;
      if (tuic.sni) base.sni = tuic.sni;
      if (tuic.alpn) base.alpn = tuic.alpn;
      if (tuic.skipCertVerify) base['skip-cert-verify'] = true;
      break;
    }

    case 'wireguard': {
      const wg = (cfg || {}) as WireGuardConfig;
      const privateKey = resolveCredential(wg.privateKey, rootAny.privateKey, raw['private-key']);
      if (!privateKey) {
        throw new Error(`WireGuard 节点 "${node.name}" 缺少必需的 privateKey`);
      }
      base.ip = wg.ip || '10.0.0.2';
      base['private-key'] = privateKey;
      if (wg.publicKey) base['public-key'] = wg.publicKey;
      if (wg.presharedKey) base['preshared-key'] = wg.presharedKey;
      if (wg.mtu) base.mtu = wg.mtu;
      break;
    }

    default:
      // 仅按白名单深度过滤后安全拷贝原始配置字段，严格阻断 __proto__/constructor/prototype 污染与核心字段覆盖
      if (node.rawConfig && typeof node.rawConfig === 'object') {
        for (const [key, val] of Object.entries(node.rawConfig)) {
          if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_RAW_PROXY_KEYS.has(key)) {
            continue;
          }
          const cleanVal = sanitizePlainValue(val);
          if (cleanVal !== undefined) {
            Object.defineProperty(base, key, {
              value: cleanVal,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
        }
      }
      break;
  }

  return base;
}
