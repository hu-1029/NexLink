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

export function proxyNodeToMihomo(node: ProxyNode): Record<string, any> {
  // 如果节点已经包含完整的 rawConfig，优先以其为基础合并
  const base: Record<string, any> = {
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    udp: true,
  };

  const cfg = node.protocolConfig as any;

  switch (node.type) {
    case 'vless': {
      const vless = (cfg || {}) as VlessConfig;
      base.uuid = vless.uuid || '00000000-0000-0000-0000-000000000000';
      if (vless.flow) base.flow = vless.flow;
      base.network = vless.network || 'tcp';

      if (vless.security === 'reality' && vless.reality) {
        base.tls = true;
        base['reality-opts'] = {
          'public-key': vless.reality.publicKey || '1111111111111111111111111111111111111111111=',
          'short-id': vless.reality.shortId || '',
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
          headers: vless.ws.headers || {},
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
      base.uuid = vmess.uuid || '00000000-0000-0000-0000-000000000000';
      base.alterId = vmess.alterId || 0;
      base.cipher = vmess.cipher || 'auto';
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
          headers: vmess.ws.headers || {},
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
      base.cipher = ss.cipher || 'aes-256-gcm';
      base.password = ss.password || 'mockpassword123';
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
                optsObj[trimmed] = true;
              } else {
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                const mappedKey = k === 'obfs' ? 'mode' : k === 'obfs-host' ? 'host' : k;
                optsObj[mappedKey] = v;
              }
            }
            base['plugin-opts'] = optsObj;
          } else if (typeof ss.pluginOpts === 'object') {
            base['plugin-opts'] = ss.pluginOpts;
          }
        }
      }
      break;
    }

    case 'trojan': {
      const trojan = (cfg || {}) as TrojanConfig;
      base.password = trojan.password || 'mockpassword123';
      if (trojan.sni) base.sni = trojan.sni;
      if (trojan.alpn && trojan.alpn.length > 0) base.alpn = trojan.alpn;
      if (trojan.skipCertVerify) base['skip-cert-verify'] = true;
      if ((trojan as any).fingerprint) base['client-fingerprint'] = (trojan as any).fingerprint;
      base.network = trojan.network || 'tcp';

      if (trojan.network === 'ws' && trojan.ws) {
        base['ws-opts'] = {
          path: trojan.ws.path || '/',
          headers: trojan.ws.headers || {},
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
      base.password = hy2.auth || (hy2 as any).password || 'mockpassword123';
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
      base.uuid = tuic.uuid || '00000000-0000-0000-0000-000000000000';
      base.password = tuic.password || 'mockpassword123';
      if (tuic.congestionController) base['congestion-controller'] = tuic.congestionController;
      if (tuic.udpRelayMode) base['udp-relay-mode'] = tuic.udpRelayMode;
      if (tuic.sni) base.sni = tuic.sni;
      if (tuic.alpn) base.alpn = tuic.alpn;
      if (tuic.skipCertVerify) base['skip-cert-verify'] = true;
      break;
    }

    case 'wireguard': {
      const wg = (cfg || {}) as WireGuardConfig;
      base.ip = wg.ip || '10.0.0.2';
      base['private-key'] = wg.privateKey || 'aGVsbG8xMjM0NTY3ODkxMjM0NTY3ODkxMjM0NTY=';
      if (wg.publicKey) base['public-key'] = wg.publicKey;
      if (wg.presharedKey) base['preshared-key'] = wg.presharedKey;
      if (wg.mtu) base.mtu = wg.mtu;
      break;
    }

    default:
      // 如果有原始配置，合并原始配置参数
      if (node.rawConfig) {
        Object.assign(base, node.rawConfig);
      }
      break;
  }

  return base;
}
