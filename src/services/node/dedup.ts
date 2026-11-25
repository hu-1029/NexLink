/**
 * 节点智能去重与命名冲突处理
 */

import type { ProxyNode } from '../../shared/types';
import { generateDeterministicNodeId } from './node-utils';

/**
 * 计算节点的唯一指纹特征
 * 包含协议、服务器地址、端口、认证密钥、网络模式、伪装域名与路径
 * 并在具备订阅归属 (subscriptionId) 时进行命名空间隔离，绝不误删跨订阅节点
 */
export function getNodeFingerprint(node: ProxyNode): string {
  const cfg = (node.protocolConfig || {}) as any;
  const raw = (node.rawConfig || {}) as any;

  const authKey =
    cfg.uuid ||
    cfg.password ||
    cfg.auth ||
    cfg.privateKey ||
    raw.uuid ||
    raw.password ||
    raw.auth ||
    raw['private-key'] ||
    '';

  const path =
    cfg.ws?.path ||
    cfg.grpc?.serviceName ||
    raw['ws-opts']?.path ||
    raw['grpc-opts']?.['grpc-service-name'] ||
    raw.path ||
    '';

  const sni = String(cfg.sni || raw.servername || raw.sni || '').toLowerCase();
  const realityKey = cfg.reality?.publicKey || raw['reality-opts']?.['public-key'] || '';
  const shortId = cfg.reality?.shortId || raw['reality-opts']?.['short-id'] || '';
  const network = String(cfg.network || raw.network || 'tcp').toLowerCase();
  const wsHost = String(cfg.ws?.headers?.Host || cfg.ws?.headers?.host || raw['ws-opts']?.headers?.Host || '').toLowerCase();
  const extra = [cfg.cipher || '', cfg.security || '', cfg.flow || '', cfg.obfs || '', cfg.plugin || '', cfg.password && cfg.uuid ? cfg.password : ''].join(':');
  const subId = node.subscriptionId || '';

  return `${subId}#${node.type.toLowerCase()}://${node.server.toLowerCase()}:${node.port}#${network}#${authKey}#${sni}#${wsHost}#${path}#${realityKey}#${shortId}#${extra}`;
}

/**
 * 智能去重节点数组，并在同名节点间添加递增编号后缀
 */
export function deduplicateNodes(nodes: ProxyNode[], existingNodes: ProxyNode[] = []): ProxyNode[] {
  const seenFingerprints = new Set<string>();
  const seenNames = new Set<string>([
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'GLOBAL',
    '🚀 节点选择',
    '⚡ 自动选择',
    '🐟 漏网之鱼',
    '🔗 链式代理',
  ]);

  // 预装入已有节点的指纹与名称
  for (const n of existingNodes) {
    seenFingerprints.add(getNodeFingerprint(n));
    seenNames.add(n.name);
  }

  const result: ProxyNode[] = [];

  for (const node of nodes) {
    const fp = getNodeFingerprint(node);
    if (seenFingerprints.has(fp)) {
      // 相同出站协议与密钥服务器的重复节点，直接跳过
      continue;
    }
    seenFingerprints.add(fp);

    // 处理重名情况
    let finalName = node.name;
    let counter = 1;
    while (seenNames.has(finalName)) {
      counter++;
      finalName = `${node.name} (${counter})`;
    }
    seenNames.add(finalName);

    const finalId =
      finalName !== node.name
        ? generateDeterministicNodeId(node.type, node.server, node.port, fp, finalName, node.subscriptionId)
        : node.id;
    result.push({
      ...node,
      id: finalId,
      name: finalName,
    });
  }

  return result;
}
