import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { mihomoManager } from '../../src/main/core/mihomo-process';
import { MOCK_NODES } from '../../src/renderer/mock/mockData';

test('Mihomo 真实进程生命周期与 RESTful API 实机集成测试', async (t) => {
  const baseDir = process.cwd();
  const resourcesDir = path.resolve('resources');
  const exePath = path.join(resourcesDir, 'mihomo/mihomo.exe');

  // 跨平台与云端沙箱自适应：若运行在非 Windows 容器环境，跳过 Windows PE 二进制实机拉起
  if (process.platform !== 'win32' || !fs.existsSync(exePath)) {
    t.skip('当前运行环境非 Windows 平台，跳过 Windows PE 专属的 Mihomo.exe 实机进程生命周期测试');
    return;
  }

  const runtimeDir = path.resolve('data/runtime');
  mihomoManager.initialize(runtimeDir, resourcesDir);
  const origTunPrereqHook = (mihomoManager as any).tunPrereqCheckHook;
  (mihomoManager as any).tunPrereqCheckHook = async () => ({
    serviceReady: false,
    isAdmin: false,
    driverOk: true,
  });

  try {

  await t.test('1. 成功拉起真实 Mihomo 进程并通过 API 握手', async () => {
    const startResult = await mihomoManager.start({
      nodes: MOCK_NODES,
      settings: {
        theme: 'dark',
        systemProxy: false,
        tunMode: false,
        autoLaunch: false,
        silentStart: false,
        mixedPort: 7898,
        apiPort: 9098,
        allowLan: false,
        logLevel: 'info',
      },
    });

    assert.strictEqual(startResult.success, true, `启动失败原因: ${startResult.error}`);
    assert.strictEqual(mihomoManager.getStatus().running, true);

    const apiClient = mihomoManager.getApiClient();
    const versionInfo = await apiClient.getVersion();
    assert.ok(versionInfo.version.includes('Meta') || versionInfo.version.length > 0);
    console.log('  -> 真实 API 握手成功, 版本:', versionInfo.version);
  });

  await t.test('2. 真实获取代理策略组并执行出站切换', async () => {
    const apiClient = mihomoManager.getApiClient();
    const proxiesRes = await apiClient.getProxies();
    assert.ok(proxiesRes.proxies['🚀 节点选择'], '策略组应存在');

    // 切换至 DIRECT
    const switchRes = await apiClient.selectProxy('🚀 节点选择', 'DIRECT');
    assert.strictEqual(switchRes, true);

    const groupInfo = await apiClient.getProxyGroup('🚀 节点选择');
    assert.strictEqual(groupInfo.now, 'DIRECT', '当前出站应已切换为 DIRECT');
    console.log('  -> 真实策略组出站节点切换验证通过');
  });

  await t.test('3. 真实查询连接列表并正常停止核心进程', async () => {
    const apiClient = mihomoManager.getApiClient();
    const conns = await apiClient.getConnections();
    assert.ok(Array.isArray(conns.connections));

    const stopRes = await mihomoManager.stop();
    assert.strictEqual(stopRes, true);
    assert.strictEqual(mihomoManager.getStatus().running, false);
    console.log('  -> 真实核心优雅退出完成');
  });

  await t.test('4. 核心异常退出检测与 crash.log 崩溃记录校验', async () => {
    const startResult = await mihomoManager.start({
      nodes: MOCK_NODES,
      settings: {
        theme: 'dark',
        systemProxy: false,
        tunMode: false,
        autoLaunch: false,
        silentStart: false,
        mixedPort: 7898,
        apiPort: 9098,
        allowLan: false,
        logLevel: 'info',
      },
    });

    assert.strictEqual(startResult.success, true);
    assert.strictEqual(mihomoManager.getStatus().running, true);

    // 人为模拟核心外部崩溃（强杀进程，模拟断电或闪退）
    const child = (mihomoManager as any).process;
    assert.ok(child);
    child.kill('SIGKILL');

    // 等待异常退出捕获
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.strictEqual(mihomoManager.getStatus().running, false);

    const crashLogPath = path.join(baseDir, 'data/runtime/logs/crash.log');
    assert.ok(fs.existsSync(crashLogPath), 'crash.log 文件应已生成');
    const crashContent = fs.readFileSync(crashLogPath, 'utf8');
    assert.ok(crashContent.includes('Mihomo 异常退出'));
    console.log('  -> 异常退出捕获与 crash.log 崩溃日志记录测试通过');
  });
  } finally {
    (mihomoManager as any).tunPrereqCheckHook = origTunPrereqHook;
    await mihomoManager.stop().catch(() => {});
  }
});
