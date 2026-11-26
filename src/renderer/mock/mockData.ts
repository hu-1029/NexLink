/**
 * NexLink UI 阶段测试与交互验证专用模拟数据集
 * [NOTICE]: 本文件全部为明确标记的 [模拟演示] 数据，仅用于无真实节点时供视觉排版测试。
 */

import type { ProfileItem, ProxyNode } from '../../shared/types';

export const MOCK_NOTICE = '【模拟演示数据】当前展示均为模拟占位节点，未测速且核心未接入代理网络';

// 3 个订阅源，共 24 个模拟节点 (12 + 6 + 6 = 24)
export const MOCK_SUBSCRIPTIONS: ProfileItem[] = [
  {
    id: 'sub-01',
    name: 'CloudFlare 专线 VIP 订阅',
    type: 'remote',
    url: 'https://sub.fastspeed.link/api/v1/client/subscribe?token=cf_speed_vip_888',
    nodeCount: 12,
    updatedAt: '2026-11-01 16:30',
    status: 'ok',
    autoUpdateInterval: 1440,
    enabled: true,
    active: true,
  },
  {
    id: 'sub-02',
    name: '国际商用备用线路 [Hysteria 2]',
    type: 'remote',
    url: 'https://sub.hy2-global.net/subscribe/token_hy2_ultra',
    nodeCount: 6,
    updatedAt: '2026-10-31 09:15',
    status: 'ok',
    autoUpdateInterval: 720,
    enabled: true,
    active: false,
  },
  {
    id: 'sub-03',
    name: '本地混合导入节点集',
    type: 'local',
    filePath: '/profiles/custom-nodes.yaml',
    nodeCount: 6,
    updatedAt: '2026-11-01 12:00',
    status: 'ok',
    enabled: true,
    active: false,
  },
  {
    id: 'sub-04',
    name: '测试失效订阅示例 (用于错误预览展示)',
    type: 'remote',
    url: 'https://expired.invalid-domain.org/sub',
    nodeCount: 0,
    updatedAt: '2026-11-01 10:00',
    status: 'error',
    errorMessage: '网络连接超时 (ETIMEDOUT: 404 Not Found)',
    enabled: false,
    active: false,
  },
];

// 归属 sub-01 的 12 个节点
const SUB_01_NODES: ProxyNode[] = [
  {
    id: 'node-hk-01',
    name: '[模拟] 🇭🇰 香港 01 | 极速专线 [IPLX-Reality]',
    type: 'vless',
    server: 'hk01.nexlink-mock.net',
    port: 443,
    delay: undefined, // 未测速绝不伪造
    isAlive: false,
    country: 'Hong Kong',
    countryCode: 'HK',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-hk-02',
    name: '[模拟] 🇭🇰 香港 02 | BGP优化 [VLESS-Vision]',
    type: 'vless',
    server: 'hk02.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Hong Kong',
    countryCode: 'HK',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-hk-03',
    name: '[模拟] 🇭🇰 香港 03 | 移动CMIN2 [VMess-WS]',
    type: 'vmess',
    server: 'hk03.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Hong Kong',
    countryCode: 'HK',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-jp-01',
    name: '[模拟] 🇯🇵 日本东京 01 | 原生IP [Hysteria 2]',
    type: 'hysteria2',
    server: 'jp01.nexlink-mock.net',
    port: 8443,
    delay: undefined,
    isAlive: false,
    country: 'Japan',
    countryCode: 'JP',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-jp-02',
    name: '[模拟] 🇯🇵 日本大阪 02 | 流媒体解锁 [VMess-gRPC]',
    type: 'vmess',
    server: 'jp02.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Japan',
    countryCode: 'JP',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-sg-01',
    name: '[模拟] 🇸🇬 新加坡 01 | 低延迟节点 [TUIC-v5]',
    type: 'tuic',
    server: 'sg01.nexlink-mock.net',
    port: 10443,
    delay: undefined,
    isAlive: false,
    country: 'Singapore',
    countryCode: 'SG',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-sg-02',
    name: '[模拟] 🇸🇬 新加坡 02 | 电信CN2 GIA [Trojan]',
    type: 'trojan',
    server: 'sg02.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Singapore',
    countryCode: 'SG',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-tw-01',
    name: '[模拟] 🇨🇳 台湾台北 | 原生宽带 [Trojan]',
    type: 'trojan',
    server: 'tw01.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Taiwan',
    countryCode: 'TW',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-kr-01',
    name: '[模拟] 🇰🇷 韩国首尔 | 游戏专线 [VLESS-Reality]',
    type: 'vless',
    server: 'kr01.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'South Korea',
    countryCode: 'KR',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-us-01',
    name: '[模拟] 🇺🇸 美国洛杉矶 01 | 4K流媒体 [Hysteria 2]',
    type: 'hysteria2',
    server: 'us01.nexlink-mock.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'United States',
    countryCode: 'US',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-us-02',
    name: '[模拟] 🇺🇸 美国硅谷 02 | Shadowsocks-2022',
    type: 'ss',
    server: 'us02.nexlink-mock.net',
    port: 8388,
    delay: undefined,
    isAlive: false,
    country: 'United States',
    countryCode: 'US',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
  {
    id: 'node-de-01',
    name: '[模拟] 🇩🇪 德国法兰克福 | 隐私网络 [WireGuard]',
    type: 'wireguard',
    server: 'de01.nexlink-mock.net',
    port: 51820,
    delay: undefined,
    isAlive: false,
    country: 'Germany',
    countryCode: 'DE',
    group: '🚀 节点选择',
    subscriptionId: 'sub-01',
  },
];

// 归属 sub-02 的 6 个节点
const SUB_02_NODES: ProxyNode[] = [
  {
    id: 'node-hy2-01',
    name: '[模拟] 🇺🇸 美国波特兰 | 备用专线 [Hysteria 2]',
    type: 'hysteria2',
    server: 'us-pdx.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'United States',
    countryCode: 'US',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
  {
    id: 'node-hy2-02',
    name: '[模拟] 🇬🇧 英国伦敦 01 | 备用线路 [Hysteria 2]',
    type: 'hysteria2',
    server: 'uk-lon.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'United Kingdom',
    countryCode: 'GB',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
  {
    id: 'node-hy2-03',
    name: '[模拟] 🇯🇵 日本东京 02 | 备用超高速 [Hysteria 2]',
    type: 'hysteria2',
    server: 'jp-tyo.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Japan',
    countryCode: 'JP',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
  {
    id: 'node-hy2-04',
    name: '[模拟] 🇸🇬 新加坡 02 | 备用商务线路 [Hysteria 2]',
    type: 'hysteria2',
    server: 'sg-sin.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Singapore',
    countryCode: 'SG',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
  {
    id: 'node-hy2-05',
    name: '[模拟] 🇫🇷 法国巴黎 | 欧洲商用专线 [Hysteria 2]',
    type: 'hysteria2',
    server: 'fr-par.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'France',
    countryCode: 'FR',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
  {
    id: 'node-hy2-06',
    name: '[模拟] 🇨🇦 加拿大多伦多 | 北美备用线路 [Hysteria 2]',
    type: 'hysteria2',
    server: 'ca-tor.hy2-global.net',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Canada',
    countryCode: 'CA',
    group: '🚀 节点选择',
    subscriptionId: 'sub-02',
  },
];

// 归属 sub-03 的 6 个本地自建节点
const SUB_03_NODES: ProxyNode[] = [
  {
    id: 'node-local-01',
    name: '[模拟] 🇭🇰 自建香港家宽 | 原生IP [VLESS-Reality]',
    type: 'vless',
    server: '103.149.200.12',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Hong Kong',
    countryCode: 'HK',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
  {
    id: 'node-local-02',
    name: '[模拟] 🇯🇵 自建日本软银 | [Shadowsocks-2022]',
    type: 'ss',
    server: '150.109.112.45',
    port: 8388,
    delay: undefined,
    isAlive: false,
    country: 'Japan',
    countryCode: 'JP',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
  {
    id: 'node-local-03',
    name: '[模拟] 🇺🇸 自建美西Oracle | [WireGuard]',
    type: 'wireguard',
    server: '129.153.88.90',
    port: 51820,
    delay: undefined,
    isAlive: false,
    country: 'United States',
    countryCode: 'US',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
  {
    id: 'node-local-04',
    name: '[模拟] 🇦🇺 自建澳大利亚悉尼 | [Trojan]',
    type: 'trojan',
    server: '139.99.145.67',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Australia',
    countryCode: 'AU',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
  {
    id: 'node-local-05',
    name: '[模拟] 🇩🇪 自建德国Hetzner | [TUIC-v5]',
    type: 'tuic',
    server: '168.119.78.23',
    port: 8443,
    delay: undefined,
    isAlive: false,
    country: 'Germany',
    countryCode: 'DE',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
  {
    id: 'node-local-06',
    name: '[模拟] 🇷🇺 自建莫斯科G-Core | [VMess]',
    type: 'vmess',
    server: '92.223.100.80',
    port: 443,
    delay: undefined,
    isAlive: false,
    country: 'Russia',
    countryCode: 'RU',
    group: '🚀 节点选择',
    subscriptionId: 'sub-03',
  },
];

// 全部 24 个节点汇总
export const MOCK_NODES: ProxyNode[] = [
  ...SUB_01_NODES,
  ...SUB_02_NODES,
  ...SUB_03_NODES,
];

export const MOCK_GROUPS = [
  { id: 'proxy', name: '🚀 节点选择', type: 'select', current: 'node-hk-01' },
  { id: 'auto', name: '⚡ 自动测速选择', type: 'url-test', current: 'node-hk-01' },
  { id: 'fallback', name: '🛡️ 故障转移', type: 'fallback', current: 'node-hk-02' },
  { id: 'streaming', name: '🎬 流媒体专线', type: 'select', current: 'node-us-01' },
];

export const MOCK_PROFILES = [
  {
    id: 'profile-main',
    name: 'config.yaml (主配置 - 规则分流)',
    active: true,
    mode: 'Rule',
    rulesCount: 3840,
    updatedAt: '2026-11-01 17:00',
    content: `# NexLink 运行时 Mihomo 规则配置
port: 7890
socks-port: 7891
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9097
secret: ""

dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - https://dns.alidns.com/dns-query

proxy-groups:
  - name: 🚀 节点选择
    type: select
    proxies:
      - 🇭🇰 香港 01 | 极速专线 [IPLX-Reality]
      - 🇭🇰 香港 02 | BGP优化 [VLESS-Vision]
      - 🇯🇵 日本东京 01 | 原生IP [Hysteria 2]
      - ⚡ 自动选择

  - name: ⚡ 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
      - 🇭🇰 香港 01 | 极速专线 [IPLX-Reality]
      - 🇯🇵 日本东京 01 | 原生IP [Hysteria 2]
`,
  },
  {
    id: 'profile-global',
    name: 'global-proxy.yaml (全局代理模式)',
    active: false,
    mode: 'Global',
    rulesCount: 1,
    updatedAt: '2026-10-28 14:20',
    content: `# 全局代理配置\nmode: global\nmixed-port: 7890`,
  },
  {
    id: 'profile-direct',
    name: 'direct-pass.yaml (完全直连绕过)',
    active: false,
    mode: 'Direct',
    rulesCount: 1,
    updatedAt: '2026-10-25 10:00',
    content: `# 直连配置\nmode: direct\nmixed-port: 7890`,
  },
];
