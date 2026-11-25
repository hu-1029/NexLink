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

  it('4. 写入磁盘失败时应抛出异常且 memoryCache 绝不脏写偏离磁盘状态', () => {
    // 1) 未初始化存储目录时写盘直接抛错且内存不提交
    const uninitStore = new StorageManager();
    const prevMixedPort = uninitStore.getSettings().mixedPort;
    assert.throws(
      () => uninitStore.saveSettings({ mixedPort: 9999 }),
      /尚未初始化存储目录/,
      '未初始化存储写入必须上抛异常'
    );
    assert.strictEqual(uninitStore.getSettings().mixedPort, prevMixedPort, '写盘失败不得污染内存 settings');

    // 2) 目标 JSON 文件被同名目录占用导致写入/替换失败时，抛出异常且 memoryCache 保持原值
    const failDir = path.join(os.tmpdir(), `nexlink_test_storage_fail_${Date.now()}`);
    const failStore = new StorageManager(failDir);
    try {
      failStore.saveSettings({ mixedPort: 7895 });
      failStore.saveNodes([]);
      failStore.saveState({ activeNodeId: 'node-orig' });

      // 将目标文件替换成目录，强制 renameSync / copyFileSync 落盘失败
      for (const name of ['settings.json', 'nodes.json', 'state.json']) {
        const target = path.join(failDir, name);
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target);
      }

      assert.throws(() => failStore.saveSettings({ mixedPort: 6666 }));
      assert.strictEqual(failStore.getSettings().mixedPort, 7895, 'settings 写入失败必须回滚/保持旧值');

      assert.throws(() =>
        failStore.saveNodes([
          { id: 'dirty', name: 'dirty', type: 'vless', server: '1.1.1.1', port: 443 },
        ])
      );
      assert.strictEqual(failStore.getNodes().length, 0, 'nodes 写入失败不得保留脏内存状态');

      assert.throws(() => failStore.saveState({ activeNodeId: 'dirty-id' }));
      assert.strictEqual(failStore.getState().activeNodeId, 'node-orig', 'state 写入失败不得修改内存状态');
    } finally {
      fs.rmSync(failDir, { recursive: true, force: true });
    }
  });

  // 测试后清理临时目录
  it('5. 安全清理临时存储目录', () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
    assert.ok(true);
  });
});
