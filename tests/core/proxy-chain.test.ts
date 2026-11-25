import assert from 'assert';
import YAML from 'yaml';
import { buildMihomoConfig } from '../../src/main/core/config-builder';
import type { AppSettings, ProxyChain, ProxyNode } from '../../src/shared/types';

console.log('[Test] 正在运行链式代理配置构建与解析测试...');

const mockNodes: ProxyNode[] = [
  {
    id: 'node-hk-1',
    name: '🇭🇰 香港 01 [IPLC 专线]',
    type: 'ss',
    server: '1.1.1.1',
    port: 8388,
    protocolConfig: { cipher: 'aes-128-gcm', password: 'pass' },
  },
  {
    id: 'node-jp-1',
    name: '🇯🇵 日本 01 [BGP 中继]',
    type: 'ss',
    server: '2.2.2.2',
    port: 8388,
    protocolConfig: { cipher: 'aes-128-gcm', password: 'pass' },
  },
  {
    id: 'node-us-1',
    name: '🇺🇸 美国 01 [原生解锁]',
    type: 'ss',
    server: '3.3.3.3',
    port: 8388,
    protocolConfig: { cipher: 'aes-128-gcm', password: 'pass' },
  },
];

const baseSettings: AppSettings = {
  theme: 'dark',
  systemProxy: false,
  tunMode: false,
  autoLaunch: false,
  silentStart: false,
  mixedPort: 7890,
  apiPort: 9097,
  allowLan: false,
  logLevel: 'warning',
};

// 测试 1: 未配置链式代理时，不生成 relay 策略组
{
  const yamlStr = buildMihomoConfig({
    nodes: mockNodes,
    settings: baseSettings,
    apiSecret: 'test-secret',
  });
  const parsed = YAML.parse(yamlStr);
  const groups: any[] = parsed['proxy-groups'];

  const relayGroups = groups.filter((g) => g.type === 'relay');
  assert.strictEqual(relayGroups.length, 0, '未配置链式代理时不应生成 relay 组');
  assert.strictEqual(groups.some((g) => g.name === '🔗 链式代理'), false, '不应生成空链式代理组');
  console.log('✓ 测试 1: 未配置链式代理正常生成基准配置');
}

// 测试 2: 配置一条 2 跳链式代理 (香港 -> 美国)
{
  const chain: ProxyChain = {
    id: 'chain-1',
    name: '香港 ➔ 美国解锁',
    nodeIds: ['node-hk-1', 'node-us-1'],
    enabled: true,
  };

  const yamlStr = buildMihomoConfig({
    nodes: mockNodes,
    settings: {
      ...baseSettings,
      proxyChains: [chain],
    },
    apiSecret: 'test-secret',
  });
  const parsed = YAML.parse(yamlStr);
  const groups: any[] = parsed['proxy-groups'];

  const relayGroups = groups.filter((g) => g.type === 'relay');
  assert.strictEqual(relayGroups.length, 1, '应生成 1 个 relay 组');
  const rGroup = relayGroups[0];
  assert.strictEqual(rGroup.name, '🔗 香港 ➔ 美国解锁');
  assert.deepStrictEqual(rGroup.proxies, ['🇭🇰 香港 01 [IPLC 专线]', '🇺🇸 美国 01 [原生解锁]'], '跳板顺序必须与配置一致');

  // 检查 🚀 节点选择 是否包含链式代理
  const selectGroup = groups.find((g) => g.name === '🚀 节点选择');
  assert(selectGroup.proxies.includes('🔗 香港 ➔ 美国解锁'), '节点选择组应包含该链式代理');

  // 检查 🔗 链式代理 组是否存在
  const chainSelectGroup = groups.find((g) => g.name === '🔗 链式代理');
  assert(chainSelectGroup, '应生成 🔗 链式代理 策略组');
  assert.deepStrictEqual(chainSelectGroup.proxies, ['🔗 香港 ➔ 美国解锁']);

  console.log('✓ 测试 2: 2 跳链式代理生成与代理组注入测试通过');
}

// 测试 3: 配置 3 跳链式代理 (香港 -> 日本 -> 美国) 以及禁用的链
{
  const activeChain: ProxyChain = {
    id: 'chain-2',
    name: '三跳多段加速 (港-日-美)',
    nodeIds: ['node-hk-1', 'node-jp-1', 'node-us-1'],
    enabled: true,
  };
  const disabledChain: ProxyChain = {
    id: 'chain-disabled',
    name: '已禁用链',
    nodeIds: ['node-hk-1', 'node-us-1'],
    enabled: false,
  };
  const brokenChain: ProxyChain = {
    id: 'chain-broken',
    name: '损坏链 (含不存在节点)',
    nodeIds: ['node-hk-1', 'node-not-exist'],
    enabled: true,
  };

  const yamlStr = buildMihomoConfig({
    nodes: mockNodes,
    settings: {
      ...baseSettings,
      proxyChains: [activeChain, disabledChain, brokenChain],
    },
    apiSecret: 'test-secret',
  });
  const parsed = YAML.parse(yamlStr);
  const groups: any[] = parsed['proxy-groups'];

  const relayGroups = groups.filter((g) => g.type === 'relay');
  assert.strictEqual(relayGroups.length, 1, '只有启用的完整有效链才能生成 relay');
  assert.strictEqual(relayGroups[0].name, '🔗 三跳多段加速 (港-日-美)');
  assert.deepStrictEqual(relayGroups[0].proxies, [
    '🇭🇰 香港 01 [IPLC 专线]',
    '🇯🇵 日本 01 [BGP 中继]',
    '🇺🇸 美国 01 [原生解锁]',
  ]);

  console.log('✓ 测试 3: 多跳链式代理与安全过滤测试通过');
}

console.log('🎉 链式代理所有核心测试全部通过！');
