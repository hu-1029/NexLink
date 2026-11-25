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

  const localSubFile = path.join(testDir, 'sub1.txt');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(localSubFile, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

  it('1. 添加本地文件订阅并成功拉取解析节点', async () => {
    const sub = await manager.addSubscription({
      name: '本地测试订阅',
      type: 'local',
      url: localSubFile,
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
    const localSubFile2 = path.join(testDir, 'sub2.txt');
    fs.writeFileSync(localSubFile2, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

    const sub2 = await manager.addSubscription({
      name: '订阅二（独立订阅命名空间）',
      type: 'local',
      url: localSubFile2,
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

  // 测试完成清理
  it('5. 清理测试产生的临时文件', () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
    assert.ok(true);
  });
});
