/**
 * Sing-box / V2Ray JSON 配置解析器
 * 解析 outbounds 列表并将出站代理节点转换为标准 ProxyNode
 */

import type { ProxyNode } from '../../shared/types';
import { detectCountry } from '../parser/country';
import { generateDeterministicNodeId, isValidPort, isValidServer } from '../node/node-utils';

export function parseJsonConfig(jsonText: string, subscriptionId: string = ''): ProxyNode[] {
  let doc: any;
  try {
    doc = JSON.parse(jsonText);
  } catch (err: any) {
    throw new Error(`JSON 语法解析错误: ${err.message}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new Error('JSON 格式无效');
  }

  const outbounds = doc.outbounds || [];
  if (!Array.isArray(outbounds)) {
    throw new Error('JSON 中未找到有效的 outbounds 列表');
  }

  const nodes: ProxyNode[] = [];

  for (const ob of outbounds) {
    if (!ob || typeof ob !== 'object') continue;

    // 忽略直连、拦截与 DNS 等非代理出站
    const rawType = (ob.type || ob.protocol || '').toLowerCase();
    if (['direct', 'block', 'dns', 'freedom', 'blackhole', 'selector', 'urltest'].includes(rawType)) {
      continue;
    }
    const typeStr = rawType === 'shadowsocks' ? 'ss' : rawType;

    const tag = ob.tag || ob.remarks || `${typeStr}-${nodes.length + 1}`;

    // 1. Sing-box 格式
    if (ob.server) {
      const server = String(ob.server);
      const port = Number(ob.server_port ?? ob.port);
      if (!isValidServer(server) || !isValidPort(port)) continue;
      const country = detectCountry(tag, server);
      const authKey = String(ob.uuid || ob.password || ob.private_key || '');
      const id = generateDeterministicNodeId(typeStr, server, port, authKey, tag, subscriptionId);

      const tlsEnabled = Boolean(ob.tls?.enabled);
      const realityEnabled = Boolean(ob.tls?.reality?.enabled || ob.tls?.reality?.public_key);
      const security = realityEnabled ? 'reality' : tlsEnabled ? 'tls' : 'none';
      const transportType = (ob.transport?.type || 'tcp').toLowerCase();

      const protocolConfig: Record<string, any> = {
        uuid: ob.uuid,
        password: ob.password,
        auth: ob.password,
        cipher: ob.method || ob.security,
        alterId: ob.alter_id,
        network: transportType,
        flow: ob.flow,
        security,
        sni: ob.tls?.server_name,
        alpn: ob.tls?.alpn,
        fingerprint: ob.tls?.utls?.fingerprint,
        skipCertVerify: Boolean(ob.tls?.insecure),
        reality: realityEnabled
          ? {
              publicKey: ob.tls?.reality?.public_key || '',
              shortId: ob.tls?.reality?.short_id || '',
            }
          : undefined,
        ws: transportType === 'ws' ? { path: ob.transport?.path || '/', headers: ob.transport?.headers } : undefined,
        grpc: transportType === 'grpc' ? { serviceName: ob.transport?.service_name || '' } : undefined,
        obfs: ob.obfs?.type,
        obfsPassword: ob.obfs?.password,
        congestionController: ob.congestion_control,
        udpRelayMode: ob.udp_relay_mode,
        ip: Array.isArray(ob.local_address) ? ob.local_address[0] : ob.local_address,
        privateKey: ob.private_key,
        publicKey: ob.peer_public_key,
        presharedKey: ob.pre_shared_key,
        mtu: ob.mtu,
      };

      nodes.push({
        id,
        name: tag,
        type: typeStr as any,
        server,
        port,
        delay: undefined,
        isAlive: false,
        country: country.country,
        countryCode: country.countryCode,
        protocolConfig,
        rawConfig: ob,
      });
      continue;
    }

    // 2. V2Ray 标准 outbounds 格式 (vnext / servers)
    if (ob.settings) {
      const targets = [
        ...(Array.isArray(ob.settings.vnext) ? ob.settings.vnext : []),
        ...(Array.isArray(ob.settings.servers) ? ob.settings.servers : []),
      ];
      const ss = ob.streamSettings || {};
      const netType = (ss.network || 'tcp').toLowerCase();
      const sec = (ss.security || 'none').toLowerCase();
      const tlsObj = ss.tlsSettings || {};
      const realityObj = ss.realitySettings || {};

      for (const target of targets) {
        if (!target || !target.address) continue;
        const server = String(target.address);
        const port = Number(target.port);
        if (!isValidServer(server) || !isValidPort(port)) continue;
        const country = detectCountry(tag, server);
        const user = target.users?.[0];
        const authKey = String(user?.id || user?.password || target.password || '');
        const id = generateDeterministicNodeId(typeStr, server, port, authKey, tag, subscriptionId);

        nodes.push({
          id,
          name: tag,
          type: typeStr as any,
          server,
          port,
          delay: undefined,
          isAlive: false,
          country: country.country,
          countryCode: country.countryCode,
          protocolConfig: {
            uuid: user?.id,
            password: user?.password || target.password,
            cipher: target.method || user?.security,
            alterId: user?.alterId,
            flow: user?.flow,
            network: netType,
            security: sec,
            sni: realityObj.serverName || tlsObj.serverName,
            alpn: tlsObj.alpn,
            fingerprint: realityObj.fingerprint || tlsObj.fingerprint,
            skipCertVerify: Boolean(tlsObj.allowInsecure),
            reality: sec === 'reality' ? { publicKey: realityObj.publicKey || '', shortId: realityObj.shortId || '' } : undefined,
            ws: netType === 'ws' ? { path: ss.wsSettings?.path || '/', headers: ss.wsSettings?.headers } : undefined,
            grpc: netType === 'grpc' ? { serviceName: ss.grpcSettings?.serviceName || '' } : undefined,
          },
          rawConfig: ob,
        });
      }
    }
  }

  return nodes.map((n) => ({
    ...n,
    subscriptionId: subscriptionId || undefined,
  }));
}
