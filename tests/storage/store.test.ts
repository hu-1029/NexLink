import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StorageManager } from '../../src/main/storage/store';
import type { AppSettings, ProfileItem, ProxyNode } from '../../src/shared/types';

describe('持久化存储 StorageManager 单元测试', () => {
  const testDir = path.join(os.tmpdir(), `nexlink_test_storage_${Date.now()}`);
  const storage = new StorageManager(testDir);

  it('1. 初始化时若文件不存在，应正确返回默认设置与空数据', () => {
    const data = storage.getData();
    assert.strictEqual(data.settings.mixedPort, 7890);
    assert.strictEqual(data.settings.theme, 'dark');
    assert.deepStrictEqual(data.subscriptions, []);
    assert.deepStrictEqual(data.nodes, []);
  });

  it('2. 原子保存并持久化 AppSettings', () => {
    const newSettings: Partial<AppSettings> = {
      mixedPort: 8888,
      mode: 'global',
      customRules: ['DOMAIN-SUFFIX,google.com,PROXY'],
    };
    const updated = storage.saveSettings(newSettings);
    assert.strictEqual(updated.mixedPort, 8888);
    assert.strictEqual(updated.mode, 'global');
    assert.deepStrictEqual(updated.customRules, ['DOMAIN-SUFFIX,google.com,PROXY']);

    // 重新实例化 StorageManager 验证已持久化到磁盘
    const reloadedStorage = new StorageManager(testDir);
    const reloadedSettings = reloadedStorage.getSettings();
    assert.strictEqual(reloadedSettings.mixedPort, 8888);
    assert.strictEqual(reloadedSettings.mode, 'global');
    assert.deepStrictEqual(reloadedSettings.customRules, ['DOMAIN-SUFFIX,google.com,PROXY']);
  });

  it('3. 保存订阅列表与节点列表', () => {
    const testSub: ProfileItem = {
      id: 'sub-test-1',
      name: '测试订阅源 01',
      type: 'remote',
      url: 'https://example.com/sub',
      nodeCount: 2,
      updatedAt: '2026-11-01 20:00:00',
      status: 'ok',
      enabled: true,
    };

    const testNode: ProxyNode = {
      id: 'node-1',
      name: '香港 IPLX 01',
      type: 'vless',
      server: 'hk01.test.com',
      port: 443,
      subscriptionId: 'sub-test-1',
      protocolConfig: {
        uuid: '00000000-0000-0000-0000-000000000000',
        security: 'reality',
      },
    };

    storage.saveSubscriptions([testSub]);
    storage.saveNodes([testNode]);
    storage.saveState({ activeNodeId: 'node-1', activeSubscriptionId: 'sub-test-1' });

    const reloaded = new StorageManager(testDir);
    assert.strictEqual(reloaded.getSubscriptions().length, 1);
    assert.strictEqual(reloaded.getSubscriptions()[0].name, '测试订阅源 01');
    assert.strictEqual(reloaded.getNodes().length, 1);
    assert.strictEqual(reloaded.getNodes()[0].server, 'hk01.test.com');
    assert.strictEqual(reloaded.getState().activeNodeId, 'node-1');
  });

  // 测试后清理临时目录
  it('4. 安全清理临时存储目录', () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
    assert.ok(true);
  });
});
