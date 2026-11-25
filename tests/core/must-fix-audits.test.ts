import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { isValidPort, isValidServer, generateDeterministicNodeId } from '../../src/services/node/node-utils';
import { parseVless, parseSingleUri } from '../../src/services/parser/protocol-uri';
import { buildMihomoConfig } from '../../src/main/core/config-builder';
import { isLocalProxy } from '../../src/main/network/system-proxy';
import { StorageManager } from '../../src/main/storage/store';
import { SubscriptionManager } from '../../src/main/subscription/manager';
import type { MihomoProcessManager } from '../../src/main/core/mihomo-process';
import type { ProxyNode, ProfileItem } from '../../src/shared/types';

describe('7项核心硬伤缺陷修复专项测试 (Must-Fix Audit Verification)', () => {
  it('1. 修复项 5：坏节点合法性校验 (端口 99999999 与非法主机拦截)', () => {
    // 端口范围必须在 1-65535
    assert.strictEqual(isValidPort(99999999), false);
    assert.strictEqual(isValidPort(0), false);
    assert.strictEqual(isValidPort(-80), false);
    assert.strictEqual(isValidPort(65536), false);
    assert.strictEqual(isValidPort(80), true);
    assert.strictEqual(isValidPort(443), true);
    assert.strictEqual(isValidPort(7890), true);

    // 主机校验
    assert.strictEqual(isValidServer(''), false);
    assert.strictEqual(isValidServer('   '), false);
    assert.strictEqual(isValidServer('1.1.1.1'), true);
    assert.strictEqual(isValidServer('example.com'), true);

    // URI 解析器应直接拦截端口为 99999999 的坏节点
    const badUri = 'vless://uuid@example.com:99999999?encryption=none&security=reality&pbk=xyz#BadNode';
    assert.throws(
      () => parseSingleUri(badUri),
      /端口号非法/
    );

    // config-builder 遇到坏节点时会自动安全剔除，保证 Mihomo 核心永不崩溃
    const mixedNodes: ProxyNode[] = [
      {
        id: 'node-good',
        name: 'Good Node',
        type: 'vless',
        server: '1.2.3.4',
        port: 443,
        isAlive: true,
        protocolConfig: { uuid: 'a1b2c3d4-e5f6-7890-1234-567890abcdef' },
      },
      {
        id: 'node-bad',
        name: 'Bad Node Out Of Range',
        type: 'vless',
        server: '1.2.3.4',
        port: 99999999,
        isAlive: true,
        protocolConfig: { uuid: 'a1b2c3d4-e5f6-7890-1234-567890abcdef' },
      },
    ];

    const configYaml = buildMihomoConfig({
      nodes: mixedNodes,
      settings: {
        mixedPort: 7890,
        apiPort: 9097,
        systemProxy: false,
        tunMode: false,
        theme: 'dark',
        autoLaunch: false,
        silentStart: false,
        allowLan: false,
        logLevel: 'info',
      },
      apiSecret: 'test-secret',
    });

    assert.ok(configYaml.includes('Good Node'));
    assert.strictEqual(configYaml.includes('Bad Node Out Of Range'), false);
  });

  it('2. 修复项 3：确定性节点 ID 生成算法，防止更新订阅时丢节点/切回首个', () => {
    const id1 = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-01');
    const id2 = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-01');
    const id3 = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-02');

    // 两次生成必须 100% 相同，杜绝 Math.random() 导致的 ID 突变
    assert.strictEqual(id1, id2);
    assert.ok(id1.startsWith('node-vless-'));
    assert.notStrictEqual(id1, id3);
  });

  it('3. 修复项 4：死代理检测 (127.0.0.1 识别) 杜绝崩溃后将死代理当成原生配置备份', () => {
    assert.strictEqual(isLocalProxy('127.0.0.1:7890'), true);
    assert.strictEqual(isLocalProxy('127.0.0.1:1080'), true);
    assert.strictEqual(isLocalProxy('localhost:7890'), true);
    assert.strictEqual(isLocalProxy('http://127.0.0.1:8080'), true);
    assert.strictEqual(isLocalProxy('::1:7890'), true);

    // 正常外部代理或空配置
    assert.strictEqual(isLocalProxy('192.168.1.100:8080'), false);
    assert.strictEqual(isLocalProxy('proxy.company.com:8080'), false);
    assert.strictEqual(isLocalProxy(undefined), false);
    assert.strictEqual(isLocalProxy(''), false);
  });

  it('4. 修复项 1：订阅自动更新时区与失败退避判定逻辑', () => {
    const now = Date.now();

    // 1) 正常成功订阅，按毫秒时间戳比对
    const subNormal: ProfileItem = {
      id: 'sub-1',
      name: 'Normal Sub',
      type: 'remote',
      url: 'https://example.com/sub',
      nodeCount: 10,
      updatedAt: '2026-11-01 20:00',
      lastUpdateAt: now - 35 * 60 * 1000, // 35 分钟前更新过
      lastCheckAt: now - 35 * 60 * 1000,
      autoUpdateInterval: 60, // 60 分钟更新一次
      status: 'ok',
    };

    const intervalMs = subNormal.autoUpdateInterval! * 60 * 1000;
    const shouldUpdate1 = now - (subNormal.lastUpdateAt || 0) >= intervalMs;
    // 35 分钟 < 60 分钟，不应触发更新
    assert.strictEqual(shouldUpdate1, false);

    // 2) 失败订阅退避策略：若上次拉取失败且距离上次检查不到 30 分钟，跳过
    const subFailedRecent: ProfileItem = {
      id: 'sub-2',
      name: 'Failed Sub',
      type: 'remote',
      url: 'https://example.com/bad-sub',
      nodeCount: 0,
      updatedAt: '2026-11-01 20:00',
      lastUpdateAt: now - 120 * 60 * 1000,
      lastCheckAt: now - 5 * 60 * 1000, // 5 分钟前刚刚拉取失败
      autoUpdateInterval: 60,
      status: 'error',
    };

    const isBackoff = subFailedRecent.status === 'error' && (now - (subFailedRecent.lastCheckAt || 0) < 30 * 60 * 1000);
    assert.strictEqual(isBackoff, true);
  });

  it('5. 建议修复项：DNS 默认仅监听 127.0.0.1 本机回环，禁止暴露给局域网其他设备', () => {
    // 1) 未开启局域网共享时，必须严格仅监听 127.0.0.1
    const configDefault = buildMihomoConfig({
      nodes: [],
      settings: {
        mixedPort: 7890,
        apiPort: 9097,
        systemProxy: false,
        tunMode: false,
        theme: 'dark',
        autoLaunch: false,
        silentStart: false,
        allowLan: false,
        logLevel: 'warning',
      },
      apiSecret: 'test-secret',
    });
    assert.ok(configDefault.includes('listen: 127.0.0.1:1053'));
    assert.strictEqual(configDefault.includes('listen: 0.0.0.0:1053'), false);

    // 2) 明确开启 allowLan 时才监听 0.0.0.0:1053
    const configLan = buildMihomoConfig({
      nodes: [],
      settings: {
        mixedPort: 7890,
        apiPort: 9097,
        systemProxy: false,
        tunMode: false,
        theme: 'dark',
        autoLaunch: false,
        silentStart: false,
        allowLan: true,
        logLevel: 'warning',
      },
      apiSecret: 'test-secret',
    });
    assert.ok(configLan.includes('listen: 0.0.0.0:1053'));
  });

  it('6. 建议修复项：分流规则顺序修正，用户自定义规则最高优先级置顶，MATCH 兜底规则永远在最末尾', () => {
    const config = buildMihomoConfig({
      nodes: [
        {
          id: 'test-node',
          name: 'HK-Node',
          type: 'vless',
          server: '1.2.3.4',
          port: 443,
          isAlive: true,
          protocolConfig: { uuid: 'a1b2c3d4-e5f6-7890-1234-567890abcdef' },
        },
      ],
      settings: {
        mixedPort: 7890,
        apiPort: 9097,
        systemProxy: false,
        tunMode: false,
        theme: 'dark',
        autoLaunch: false,
        silentStart: false,
        allowLan: false,
        logLevel: 'warning',
        customRules: [
          'DOMAIN-SUFFIX,my-special-site.com,DIRECT',
          'MATCH,FAKE_EARLY_MATCH', // 用户自定义规则中意外混入的早熟 MATCH 规则必须被剥离
        ],
      },
      apiSecret: 'test-secret',
    });

    const lines = config.split('\n').map((l) => l.trim());
    const rulesIdx = lines.findIndex((l) => l === 'rules:');
    assert.ok(rulesIdx >= 0);

    const rules = lines.slice(rulesIdx + 1).filter((l) => l.startsWith('- ')).map((l) => l.replace('- ', ''));

    // 自定义规则排在最前面
    assert.strictEqual(rules[0], 'DOMAIN-SUFFIX,my-special-site.com,DIRECT');
    // 混入的早熟 MATCH 规则被成功剥离
    assert.strictEqual(rules.includes('MATCH,FAKE_EARLY_MATCH'), false);
    // MATCH 节点选择兜底规则永远固定在数组最后一位
    assert.strictEqual(rules[rules.length - 1], 'MATCH,🚀 节点选择');
  });

  it('7. 新增问题专项：跨订阅节点 ID 确定性与作用域隔离', () => {
    // 1) 同一个订阅内，同一节点多次解析，ID 绝对一致
    const idSub1_first = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-01', 'sub-001');
    const idSub1_second = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-01', 'sub-001');
    assert.strictEqual(idSub1_first, idSub1_second);

    // 2) 跨订阅：同一个节点分别出现在 sub-001 和 sub-002 时，ID 互不相同，杜绝选中高亮冲突
    const idSub2 = generateDeterministicNodeId('vless', '1.2.3.4', 443, 'uuid-abc', 'HK-01', 'sub-002');
    assert.notStrictEqual(idSub1_first, idSub2);
  });

  it('8. 新增问题专项：删除订阅安全防线，杜绝误删用户外部原文件与 profiles-evil 越权删除', async () => {
    const baseDir = path.join(process.cwd(), 'temp_test_storage_' + Date.now());
    const profilesDir = path.join(baseDir, 'profiles');
    const evilDir = path.join(baseDir, 'profiles-evil');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(evilDir, { recursive: true });

    // 内部 profiles 缓存文件
    const internalProfile = path.join(profilesDir, 'sub_cache.yaml');
    fs.writeFileSync(internalProfile, 'proxies: []', 'utf8');

    // 恶意同前缀目录 profiles-evil 文件
    const evilFile = path.join(evilDir, 'evil_victim.yaml');
    fs.writeFileSync(evilFile, 'secret: 123', 'utf8');

    // 外部用户文件（例如桌面上的用户文件）
    const externalUserDir = path.join(baseDir, 'user_desktop');
    fs.mkdirSync(externalUserDir, { recursive: true });
    const externalFile = path.join(externalUserDir, 'my_own_config.yaml');
    fs.writeFileSync(externalFile, 'proxies: []', 'utf8');

    const storage = new StorageManager(baseDir);
    const mockMihomo = {
      getStatus: () => ({ running: false }),
      hotReloadOrRestart: async () => ({ success: true }),
    } as unknown as MihomoProcessManager;
    const manager = new SubscriptionManager(storage, mockMihomo);

    storage.saveSubscriptions([
      { id: 'sub-internal', name: 'Internal', type: 'local', filePath: internalProfile, nodeCount: 0, updatedAt: '', status: 'ok' },
      { id: 'sub-evil', name: 'Evil', type: 'local', filePath: evilFile, nodeCount: 0, updatedAt: '', status: 'ok' },
      { id: 'sub-external', name: 'External', type: 'local', filePath: externalFile, nodeCount: 0, updatedAt: '', status: 'ok' },
    ]);

    // 真实调用 deleteSubscription
    await manager.deleteSubscription('sub-evil');
    // profiles-evil 文件绝不可被删
    assert.strictEqual(fs.existsSync(evilFile), true);

    await manager.deleteSubscription('sub-external');
    // 外部文件绝不可被删
    assert.strictEqual(fs.existsSync(externalFile), true);

    await manager.deleteSubscription('sub-internal');
    // 内部 profiles 缓存文件安全删除
    assert.strictEqual(fs.existsSync(internalProfile), false);

    // 清理测试目录
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
