/**
 * Clash / Mihomo YAML 配置文件深度解析器
 * 完整提取 proxies 列表中的节点并转换为标准 ProxyNode
 */

import YAML from 'yaml';
import type { ProxyNode } from '../../shared/types';
import { detectCountry } from '../parser/country';
import { generateDeterministicNodeId, isValidPort, isValidServer } from '../node/node-utils';

export function parseClashYaml(yamlText: string, subscriptionId: string = ''): ProxyNode[] {
  let doc: any;
  try {
    doc = YAML.parse(yamlText);
  } catch (err: any) {
    throw new Error(`YAML 语法解析错误: ${err.message}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new Error('YAML 内容无效或非字典对象');
  }

  const rawProxies = doc.proxies || doc.Proxy || [];
  if (!Array.isArray(rawProxies)) {
    throw new Error('YAML 中未找到有效的 proxies 数组');
  }

  const nodes: ProxyNode[] = [];

  for (const raw of rawProxies) {
    if (!raw || typeof raw !== 'object') continue;

    const name = String(raw.name || '').trim();
    const server = String(raw.server || '').trim();
    const port = Number(raw.port) || 443;
    const typeStr = String(raw.type || '').toLowerCase();

    if (!name || !server || !isValidServer(server) || !isValidPort(port)) continue;

    const country = detectCountry(name, server);
    const authKey = String(raw.uuid || raw.password || raw.auth || raw['private-key'] || '');
    const id = generateDeterministicNodeId(typeStr, server, port, authKey, name, subscriptionId);

    switch (typeStr) {
      case 'vless': {
        const realityOpts = raw['reality-opts'] || {};
        const wsOpts = raw['ws-opts'] || {};
        const grpcOpts = raw['grpc-opts'] || {};

        nodes.push({
          id,
          name,
          type: 'vless',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            uuid: raw.uuid,
            flow: raw.flow,
            network: raw.network || 'tcp',
            security: realityOpts.public_key || realityOpts['public-key'] ? 'reality' : raw.tls ? 'tls' : 'none',
            sni: raw.servername || raw.sni,
            alpn: raw.alpn,
            fingerprint: raw['client-fingerprint'],
            skipCertVerify: Boolean(raw['skip-cert-verify']),
            reality: (realityOpts['public-key'] || realityOpts.public_key)
              ? {
                  publicKey: realityOpts['public-key'] || realityOpts.public_key,
                  shortId: realityOpts['short-id'] || realityOpts.short_id || '',
                }
              : undefined,
            ws: raw.network === 'ws' ? { path: wsOpts.path, headers: wsOpts.headers } : undefined,
            grpc: raw.network === 'grpc' ? { serviceName: grpcOpts['grpc-service-name'] } : undefined,
          },
          rawConfig: raw,
        });
        break;
      }

      case 'vmess': {
        const wsOpts = raw['ws-opts'] || {};
        const grpcOpts = raw['grpc-opts'] || {};

        nodes.push({
          id,
          name,
          type: 'vmess',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            uuid: raw.uuid,
            alterId: raw.alterId || 0,
            cipher: raw.cipher || 'auto',
            network: raw.network || 'tcp',
            security: raw.tls ? 'tls' : 'none',
            sni: raw.servername || raw.sni,
            alpn: raw.alpn,
            ws: raw.network === 'ws' ? { path: wsOpts.path, headers: wsOpts.headers } : undefined,
            grpc: raw.network === 'grpc' ? { serviceName: grpcOpts['grpc-service-name'] } : undefined,
          },
          rawConfig: raw,
        });
        break;
      }

      case 'ss': {
        nodes.push({
          id,
          name,
          type: 'ss',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            cipher: raw.cipher,
            password: raw.password,
            plugin: raw.plugin,
            pluginOpts: raw['plugin-opts'],
          },
          rawConfig: raw,
        });
        break;
      }

      case 'trojan': {
        const wsOpts = raw['ws-opts'] || {};
        const grpcOpts = raw['grpc-opts'] || {};

        nodes.push({
          id,
          name,
          type: 'trojan',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            password: raw.password,
            sni: raw.sni || raw.servername,
            alpn: raw.alpn,
            network: raw.network || 'tcp',
            skipCertVerify: raw['skip-cert-verify'],
            ws: raw.network === 'ws' ? { path: wsOpts.path, headers: wsOpts.headers } : undefined,
            grpc: raw.network === 'grpc' ? { serviceName: grpcOpts['grpc-service-name'] } : undefined,
          },
          rawConfig: raw,
        });
        break;
      }

      case 'hysteria2':
      case 'hy2': {
        nodes.push({
          id,
          name,
          type: 'hysteria2',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            auth: raw.password || raw.auth,
            sni: raw.sni,
            skipCertVerify: raw['skip-cert-verify'],
            obfs: raw.obfs,
            obfsPassword: raw['obfs-password'],
            ports: raw.ports,
          },
          rawConfig: raw,
        });
        break;
      }

      case 'tuic': {
        nodes.push({
          id,
          name,
          type: 'tuic',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            uuid: raw.uuid,
            password: raw.password,
            congestionController: raw['congestion-controller'],
            udpRelayMode: raw['udp-relay-mode'],
            sni: raw.sni,
            alpn: raw.alpn,
            skipCertVerify: raw['skip-cert-verify'],
          },
          rawConfig: raw,
        });
        break;
      }

      case 'wireguard': {
        nodes.push({
          id,
          name,
          type: 'wireguard',
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            privateKey: raw['private-key'],
            publicKey: raw['public-key'],
            ip: raw.ip,
            presharedKey: raw['preshared-key'],
            mtu: raw.mtu,
          },
          rawConfig: raw,
        });
        break;
      }

      default:
        // 兼容未知或自定义协议类型
        nodes.push({
          id,
          name,
          type: typeStr as any,
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          rawConfig: raw,
        });
        break;
    }
  }

  return nodes.map((n) => ({
    ...n,
    subscriptionId: subscriptionId || undefined,
  }));
}
