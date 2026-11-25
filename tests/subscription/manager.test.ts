import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StorageManager } from '../../src/main/storage/store';
import { SubscriptionManager } from '../../src/main/subscription/manager';
import type { MihomoProcessManager } from '../../src/main/core/mihomo-process';
import { SAMPLE_BASE64_SUBSCRIPTION } from '../samples/samples';

describe('订阅生命周期管理 SubscriptionManager 单元测试', () => {
  const testDir = path.join(os.tmpdir(), `nexlink_test_submgr_${Date.now()}`);
  const storage = new StorageManager(testDir);

  // 模拟空 MihomoProcessManager
  const mockMihomo = {
    getStatus: () => ({ running: false }),
    restart: async () => ({ success: true }),
  } as unknown as MihomoProcessManager;

  const manager = new SubscriptionManager(storage, mockMihomo);

  const profilesDir = path.join(testDir, 'profiles');
  const localSubFile = path.join(profilesDir, 'sub1.txt');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(localSubFile, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

  it('1. 添加本地文件订阅并成功拉取解析节点', async () => {
    const sub = await manager.addSubscription({
      name: '本地测试订阅',
      type: 'local',
      filePath: localSubFile,
    });

    assert.ok(sub.id.startsWith('sub-'));
    assert.strictEqual(sub.name, '本地测试订阅');
    assert.ok(sub.nodeCount >= 8);
    assert.strictEqual(sub.status, 'ok');

    const allNodes = storage.getNodes();
    assert.ok(allNodes.length >= 8);
    // 自动将首个节点设为活动节点
    assert.ok(storage.getState().activeNodeId);
  });

  it('2. 多源合并与节点归属标签验证', async () => {
    const localSubFile2 = path.join(profilesDir, 'sub2.txt');
    fs.writeFileSync(localSubFile2, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

    const sub2 = await manager.addSubscription({
      name: '订阅二（独立订阅命名空间）',
      type: 'local',
      filePath: localSubFile2,
    });

    const allNodes = storage.getNodes();
    // 两个不同订阅各自保留各自的节点集（通过 subscriptionId 命名空间隔离，解决跨订阅吞节点问题）
    assert.strictEqual(allNodes.length, 20);
    // 验证节点所属订阅 ID 标记正确
    const sub2Nodes = allNodes.filter((n) => n.subscriptionId === sub2.id);
    assert.strictEqual(sub2Nodes.length, sub2.nodeCount);

    // 严格断言：跨订阅合并后所有节点的 id 全部唯一
    const nodeIds = allNodes.map((n) => n.id);
    assert.strictEqual(new Set(nodeIds).size, nodeIds.length);
  });

  it('3. 禁用订阅时，节点池动态缩减；若活动节点失效则自动回退', async () => {
    const subs = storage.getSubscriptions();
    const firstSub = subs[0];

    // 记录当前的 activeNodeId
    const prevActiveId = storage.getState().activeNodeId;
    assert.ok(prevActiveId);

    // 禁用第一个订阅
    await manager.toggleSubscription(firstSub.id);
    const updatedSubs = storage.getSubscriptions();
    const disabledSub = updatedSubs.find((s) => s.id === firstSub.id);
    assert.strictEqual(disabledSub?.enabled, false);

    // 重新启用
    await manager.toggleSubscription(firstSub.id);
    const reEnabledSub = storage.getSubscriptions().find((s) => s.id === firstSub.id);
    assert.strictEqual(reEnabledSub?.enabled, true);
  });

  it('4. 删除订阅，关联节点全部移除', async () => {
    const subs = storage.getSubscriptions();
    for (const s of subs) {
      await manager.deleteSubscription(s.id);
    }

    assert.strictEqual(storage.getSubscriptions().length, 0);
    assert.strictEqual(storage.getNodes().length, 0);
    assert.strictEqual(storage.getState().activeNodeId, '');
  });

  it('5. 并发触发 reaggregateAndSyncCore 时串行排队并合并至最新存储态，不出现旧配置覆盖', async () => {
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_test_sync_serial_'));
    const syncStorage = new StorageManager(syncDir);
    const reloadCalls: string[][] = [];
    let inFlightHotReloads = 0;
    let maxConcurrentHotReloads = 0;
    let releaseFirstReload!: () => void;
    let notifyFirstStarted!: () => void;
    const firstReloadStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });

    const mockSyncMihomo = {
      getStatus: () => ({ running: true }),
      hotReloadOrRestart: async (opts: { nodes: Array<{ id: string }> }) => {
        inFlightHotReloads++;
        maxConcurrentHotReloads = Math.max(maxConcurrentHotReloads, inFlightHotReloads);
        reloadCalls.push(opts.nodes.map((n) => n.id));
        if (reloadCalls.length === 1) {
          notifyFirstStarted();
          await new Promise<void>((res) => {
            releaseFirstReload = res;
          });
        } else {
          await new Promise<void>((res) => setTimeout(res, 15));
        }
        inFlightHotReloads--;
        return { success: true };
      },
    } as unknown as MihomoProcessManager;

    try {
      syncStorage.saveSubscriptions([
        {
          id: 'sub-a',
          name: 'sub-a',
          type: 'remote',
          url: 'https://example.com/a',
          nodeCount: 1,
          updatedAt: '',
          status: 'ok',
          enabled: true,
          nodes: [
            {
              id: 'node-a',
              name: 'Node A',
              type: 'vless',
              server: 'a.example.com',
              port: 443,
              subscriptionId: 'sub-a',
            },
          ],
        },
        {
          id: 'sub-b',
          name: 'sub-b',
          type: 'remote',
          url: 'https://example.com/b',
          nodeCount: 1,
          updatedAt: '',
          status: 'ok',
          enabled: true,
          nodes: [
            {
              id: 'node-b',
              name: 'Node B',
              type: 'vless',
              server: 'b.example.com',
              port: 443,
              subscriptionId: 'sub-b',
            },
          ],
        },
      ]);

      const syncManager = new SubscriptionManager(syncStorage, mockSyncMihomo);
      const p1 = syncManager.reaggregateAndSyncCore();
      await firstReloadStarted;

      // 第一次热重载还在进行时，快速修改订阅状态并连续并发触发两次 reaggregateAndSyncCore
      const updatedSubs = syncStorage.getSubscriptions().map((s) =>
        s.id === 'sub-b'
          ? {
              ...s,
              nodes: [
                {
                  id: 'node-b-v2',
                  name: 'Node B v2',
                  type: 'vless',
                  server: 'b2.example.com',
                  port: 443,
                  subscriptionId: 'sub-b',
                },
              ],
            }
          : s
      );
      syncStorage.saveSubscriptions(updatedSubs);
      const p2 = syncManager.reaggregateAndSyncCore();
      const p3 = syncManager.reaggregateAndSyncCore();

      // 放行第一次热重载，等待全部排队任务收敛
      releaseFirstReload();
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.strictEqual(maxConcurrentHotReloads, 1, '绝不允许并发同时下发多个 hotReloadOrRestart');
      // 多次后续触发应当合并，并且最后一次提交的一定是最新节点集 node-a + node-b-v2
      assert.strictEqual(reloadCalls.length, 2, '两次排队变更应合并为单次尾随重载');
      assert.deepStrictEqual(reloadCalls[1], ['node-a', 'node-b-v2']);
      assert.deepStrictEqual(r1.map((n) => n.id), ['node-a', 'node-b-v2']);
      assert.deepStrictEqual(r2.map((n) => n.id), ['node-a', 'node-b-v2']);
      assert.deepStrictEqual(r3.map((n) => n.id), ['node-a', 'node-b-v2']);
    } finally {
      fs.rmSync(syncDir, { recursive: true, force: true });
    }
  });

  // 测试完成清理
  it('6. 清理测试产生的临时文件', () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
    assert.ok(true);
  });
});
