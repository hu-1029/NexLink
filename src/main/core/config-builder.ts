/**
 * Mihomo 运行时完整配置文件动态生成器
 * 将标准 ProxyNode 列表与运行时设置组装为标准的 config.yaml
 */

import YAML from 'yaml';
import type { AppSettings, ProxyNode } from '../../shared/types';
import { proxyNodeToMihomo } from '../../services/converter/mihomo-generator';
import { isValidPort, isValidServer } from '../../services/node/node-utils';

export interface BuildConfigOptions {
  nodes: ProxyNode[];
  settings: AppSettings;
  apiSecret: string;
  selectedNodeName?: string;
}

export function buildMihomoConfig(options: BuildConfigOptions): string {
  const { nodes, settings, apiSecret, selectedNodeName } = options;

  // 将所有有效节点转换为 Mihomo 原生 Proxy 字典，并强制全局名称去重防止 Mihomo 启动报错
  const rawProxies: Record<string, any>[] = [];
  const nodeNames: string[] = [];
  const nodeMap = new Map<string, string>(); // nodeId -> uniqueNodeName
  const usedNames = new Set<string>([
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

  for (const node of nodes) {
    if (!node.server || !node.port || !isValidServer(node.server) || !isValidPort(node.port)) {
      console.warn(`[ConfigBuilder] 过滤掉非法参数坏节点: ${node.name} (${node.server}:${node.port})`);
      continue;
    }
    try {
      const mihomoProxy = proxyNodeToMihomo(node);
      let uniqueName = (mihomoProxy.name || node.name || 'Node').trim();
      if (usedNames.has(uniqueName)) {
        let suffix = 2;
        while (usedNames.has(`${uniqueName} (${suffix})`)) suffix++;
        uniqueName = `${uniqueName} (${suffix})`;
      }
      usedNames.add(uniqueName);
      mihomoProxy.name = uniqueName;
      rawProxies.push(mihomoProxy);
      nodeNames.push(uniqueName);
      nodeMap.set(node.id, uniqueName);
    } catch (err: any) {
      console.warn(`[ConfigBuilder] 节点 ${node.name} 转换失败:`, err.message);
    }
  }

  // 必须至少保留一个出站（若无节点，使用 DIRECT 兜底）
  const fallbackList = nodeNames.length > 0 ? nodeNames : ['DIRECT'];

  // 构建链式代理 (Proxy Chaining / Relay) 策略组
  const relayGroups: Record<string, any>[] = [];
  const validChainNames: string[] = [];

  if (Array.isArray(settings.proxyChains)) {
    for (const chain of settings.proxyChains) {
      if (chain.enabled === false) continue;
      if (!Array.isArray(chain.nodeIds) || chain.nodeIds.length < 2) continue;

      // 解析节点序列中的实际节点名称
      const chainNodeNames: string[] = [];
      let allNodesExist = true;

      for (const nid of chain.nodeIds) {
        const foundName = nodeMap.get(nid);
        if (foundName) {
          chainNodeNames.push(foundName);
        } else {
          allNodesExist = false;
          break;
        }
      }

      if (allNodesExist && chainNodeNames.length >= 2) {
        const chainGroupName = chain.name.startsWith('🔗') ? chain.name : `🔗 ${chain.name}`;
        relayGroups.push({
          name: chainGroupName,
          type: 'relay',
          proxies: chainNodeNames,
        });
        validChainNames.push(chainGroupName);
      }
    }
  }

  // 可选出站代理总池 (包含普通节点与启用的链式代理)
  const allSelectableProxies = [...validChainNames, ...fallbackList];

  // 默认节点选择（若指定了选中节点则置于策略组列表首位，严格遵循 Mihomo 标准 YAML 规范）
  const defaultSelected =
    selectedNodeName && (nodeNames.includes(selectedNodeName) || validChainNames.includes(selectedNodeName))
      ? selectedNodeName
      : allSelectableProxies[0];
  const orderedSelectableProxies =
    defaultSelected && allSelectableProxies.includes(defaultSelected)
      ? [defaultSelected, ...allSelectableProxies.filter((p) => p !== defaultSelected)]
      : allSelectableProxies;

  // 构建标准策略组
  const proxyGroups: Record<string, any>[] = [
    {
      name: '🚀 节点选择',
      type: 'select',
      proxies: [...orderedSelectableProxies, '⚡ 自动选择', 'DIRECT'],
    },
    {
      name: '⚡ 自动选择',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: [...fallbackList],
    },
    {
      name: '🐟 漏网之鱼',
      type: 'select',
      proxies: ['🚀 节点选择', 'DIRECT'],
    },
  ];

  // 若存在有效的链式代理，额外提供一个聚合选择组并追加各 relay 组
  if (validChainNames.length > 0) {
    proxyGroups.push({
      name: '🔗 链式代理',
      type: 'select',
      proxies: [...validChainNames],
    });
    // 注入 relay 具体中继链路组
    proxyGroups.push(...relayGroups);
  }

  const mixedPort = settings.mixedPort || 7890;
  const apiPort = settings.apiPort || 9097;

  // 基础运行字典
  const configObj: Record<string, any> = {
    'mixed-port': mixedPort,
    'allow-lan': Boolean(settings.allowLan),
    mode: settings.mode || 'rule',
    // 默认级别采用 warning，避免在 info/debug 下记录用户每次访问的域名与连接明细
    'log-level': settings.logLevel || 'info',
    ipv6: false,

    // 安全约束：API 严格仅监听 127.0.0.1 本地回环地址，严禁暴露公网
    'external-controller': `127.0.0.1:${apiPort}`,
    secret: apiSecret,

    dns: {
      enable: typeof settings.dns?.enable === 'boolean' ? settings.dns.enable : true,
      // 仅在显式开启局域网共享 (allowLan) 时监听 0.0.0.0:1053，默认仅绑定本地回环
      listen: settings.allowLan ? '0.0.0.0:1053' : '127.0.0.1:1053',
      ipv6: false,
      'enhanced-mode': settings.dns?.enhancedMode || 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      // 对齐标准网络健康白名单：微软 Windows 连通性探测域名与局域网不走 Fake-IP，彻底杜绝系统判定“无 Internet”
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        '*.arpa',
        'time.*.com',
        'ntp.*.com',
        '*.msftncsi.com',
        'www.msftconnecttest.com',
        'localhost.ptlogin2.qq.com',
        '+.market.xiaomi.com',
      ],
      'default-nameserver': [
        '223.5.5.5',
        '119.29.29.29',
        '8.8.8.8',
      ],
      nameserver: settings.dns?.nameservers || [
        '223.5.5.5',
        '119.29.29.29',
        'https://dns.alidns.com/dns-query',
        'https://doh.pub/dns-query',
      ],
      fallback: settings.dns?.fallbacks || [
        'https://1.1.1.1/dns-query',
        'https://8.8.8.8/dns-query',
      ],
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4', '0.0.0.0/32'],
      },
    },

    proxies: rawProxies,
    'proxy-groups': proxyGroups,

    // 规则分流执行顺序安全加固：
    // 1. 用户自定义规则最高优先级置顶（剥除意外混入的 MATCH 规则）
    // 2. 基础系统规则（广告拦截、局域网直连、CN 直连）
    // 3. MATCH 终极兜底规则永远必须放在最末尾
    rules: [
      ...((settings.customRules || [])
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim())
        .filter((r) => r.length > 0 && !r.startsWith('#') && !/^MATCH\s*,/i.test(r))),
      'GEOSITE,category-ads-all,REJECT',
      'GEOSITE,private,DIRECT',
      'GEOIP,private,DIRECT,no-resolve',
      'GEOSITE,cn,DIRECT',
      'GEOIP,CN,DIRECT',
      'MATCH,🚀 节点选择',
    ],
  };

  // 仅在派生端口处于合法范围 (<= 65535) 且绝不与外部控制端口冲突时才开启独立的 HTTP/SOCKS 衍生端口
  if (mixedPort + 1 <= 65535 && mixedPort + 1 !== apiPort) {
    configObj.port = mixedPort + 1;
  }
  if (mixedPort + 2 <= 65535 && mixedPort + 2 !== apiPort) {
    configObj['socks-port'] = mixedPort + 2;
  }

  // TUN 虚拟网卡模式配置 (使用 NexLink 专属网卡名称，与外部第三方客户端彻底隔离)
  if (settings.tunMode) {
    configObj.tun = {
      enable: true,
      device: (settings as any).tunDevice || 'Meta',
      stack: settings.tunStack || 'mixed',
      'dns-hijack': ['any:53', 'tcp://any:53'],
      'auto-route': true,
      'strict-route': false,
      'auto-detect-interface': true,
      mtu: 9000,
      'endpoint-independent-nat': true,
    };
  }

  return YAML.stringify(configObj);
}
