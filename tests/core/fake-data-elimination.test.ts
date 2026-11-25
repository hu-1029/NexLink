import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { MihomoApiClient } from '../../src/main/core/api-client';
import { IPC_CHANNELS } from '../../src/shared/ipc-events';

const rootDir = process.cwd();

describe('虚假数据与逻辑缺陷专项消除验证测试 (Fake Data Elimination Verification)', () => {
  it('1. 验证 Google/ChatGPT/GitHub 延迟初始值绝非固定假值 (564/320/847ms)', () => {
    const dashboardCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/dashboard/DashboardPage.tsx'),
      'utf8'
    );
    assert.strictEqual(
      dashboardCode.includes('useState<number | null>(564)'),
      false,
      'DashboardPage 依然写死 564ms 初始值'
    );
    assert.strictEqual(
      dashboardCode.includes('useState<number | null>(320)'),
      false,
      'DashboardPage 依然写死 320ms 初始值'
    );
    assert.strictEqual(
      dashboardCode.includes('useState<number | null>(847)'),
      false,
      'DashboardPage 依然写死 847ms 初始值'
    );
    assert.ok(
      dashboardCode.includes('useState<number | null>(null)'),
      '初始状态必须为 null (待测速状态)'
    );
  });

  it('2. 验证未激活节点时出站 IP 不再兜底假值 206.189.39.92', () => {
    const dashboardCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/dashboard/DashboardPage.tsx'),
      'utf8'
    );
    assert.strictEqual(
      dashboardCode.includes('206.189.39.92'),
      false,
      'DashboardPage 仍然存在写死假出站 IP 206.189.39.92'
    );
  });

  it('3. 验证内网 IP 与局域网共享不再硬编码 192.168.1.28', () => {
    const dashboardCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/dashboard/DashboardPage.tsx'),
      'utf8'
    );
    assert.strictEqual(
      dashboardCode.includes('192.168.1.28'),
      false,
      'DashboardPage 仍有写死内网 IP 192.168.1.28'
    );
    assert.ok(
      dashboardCode.includes('lanIp'),
      'DashboardPage 必须通过动态 lanIp 进行渲染与复制'
    );
  });

  it('4. 验证内存监控数据不再写死 165.8 MB 与 77%/23%', () => {
    const dashboardCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/dashboard/DashboardPage.tsx'),
      'utf8'
    );
    assert.strictEqual(
      dashboardCode.includes('165.8'),
      false,
      'DashboardPage 仍然写死 165.8 MB 静态内存数据'
    );
    assert.strictEqual(
      dashboardCode.includes("style={{ width: '77%' }}"),
      false,
      'DashboardPage 仍然写死 77% 应用内存比例'
    );
    assert.ok(
      dashboardCode.includes('memoryStats.totalMB'),
      'DashboardPage 必须基于真实的 memoryStats 进行动态渲染'
    );
  });

  it('5. 验证节点单测与批量测速失败时彻底消除 ~196ms 伪造延迟', () => {
    const storeCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/store/useProxyStore.ts'),
      'utf8'
    );
    assert.strictEqual(
      storeCode.includes('196 + jitter'),
      false,
      'useProxyStore 依然存在伪造 196ms 成功延迟的代码'
    );
    assert.strictEqual(
      storeCode.includes("node.server.startsWith('147.224')"),
      false,
      'useProxyStore 依然存在对特定 IP 段伪造延迟的代码'
    );
  });

  it('6. 验证解锁测试在无核心时不伪造 160-480ms 随机延迟并假称已解锁', () => {
    const testPageCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/test/TestPage.tsx'),
      'utf8'
    );
    assert.strictEqual(
      testPageCode.includes('Math.floor(160 + Math.random() * 320)'),
      false,
      'TestPage 仍然在无核心时伪造 160-480ms 延迟'
    );
  });

  it('7. 验证 MihomoApiClient 具备 flushDns 与 getMemory 真实接口定义', () => {
    const client = new MihomoApiClient(9097, '');
    assert.strictEqual(typeof client.flushDns, 'function');
    assert.strictEqual(typeof client.getMemory, 'function');
    assert.ok('SYS_GET_LAN_IP' in IPC_CHANNELS);
    assert.ok('SYS_GET_MEMORY' in IPC_CHANNELS);
  });

  it('8. 验证配置刷新在无订阅且核心未运行时进行明确拦截，不盲目弹窗报喜', () => {
    const dashboardCode = fs.readFileSync(
      path.resolve(rootDir, 'src/renderer/pages/dashboard/DashboardPage.tsx'),
      'utf8'
    );
    assert.ok(
      dashboardCode.includes('!activeSub && !coreStatus.running'),
      'handleRefreshConfig 必须前置校验 activeSub 与 coreStatus.running'
    );
  });
});
