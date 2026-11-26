import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function allocateFreePort(avoidPorts: number[] = []): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const assigned = typeof addr === 'object' && addr ? addr.port : 0;
        server.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port > 0 && port <= 65533 && !avoidPorts.includes(port)) {
      return port;
    }
  }
  throw new Error('无法分配到空闲测试端口');
}
import { MihomoProcessManager } from '../../src/main/core/mihomo-process';
import {
  shouldEnableRemoteDebugging,
  stopWithTimeoutAndFallback,
} from '../../src/main/index';
import { DEFAULT_SETTINGS, storageManager } from '../../src/main/storage/store';
import type { CoreStatus } from '../../src/shared/types';

describe('Batch 4 Service 看门狗、热重载 mode/TUN 同步与退出/调试边界测试', () => {
  it('1. Service 模式核心失联/崩溃时，看门狗自动重置运行态、通知前端、恢复代理并清理路由', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-b4-watchdog-'));
    const resourcesDir = path.resolve('resources');

    try {
      const mgr = new MihomoProcessManager();
      mgr.initialize(tmpDir, resourcesDir);

      const statusEvents: CoreStatus[] = [];
      mgr.setCallbacks(
        () => {},
        (st) => statusEvents.push({ ...st })
      );

      // 模拟当前正以 Service 模式运行
      (mgr as any).runMode = 'service';
      (mgr as any).serviceCorePid = 44556;
      (mgr as any).currentStatus = {
        running: true,
        version: 'Mihomo v1.19.29',
        mixedPort: 17890,
        apiPort: 19097,
        uptime: 12,
        mode: 'rule',
        coreRunMode: 'service',
        tunActive: true,
      };

      let proxyRestoredPort: number | null = null;
      let routesCleaned = false;
      let coreAlive = true;

      mgr.startServiceWatchdog(60000, {
        getServiceStatus: async () => ({
          installed: true,
          running: true,
          reachable: true,
          coreRunning: coreAlive,
          corePid: coreAlive ? 44556 : undefined,
        }),
        getApiVersion: async () => {
          if (!coreAlive) throw new Error('ECONNREFUSED');
          return { version: 'v1.19.29' };
        },
        restoreProxy: async (port) => {
          proxyRestoredPort = port;
          return true;
        },
        cleanupRoutesViaService: async () => {
          routesCleaned = true;
          return true;
        },
        isSystemProxyEnabled: () => true,
      });

      // 1) 健康时保持 running=true
      const healthy = await mgr.checkServiceCoreHealth();
      assert.equal(healthy, true);
      assert.equal(mgr.getStatus().running, true);
      assert.equal(proxyRestoredPort, null);

      // 2) 模拟 SYSTEM 托管的 mihomo.exe 崩溃退出 (coreRunning=false)
      coreAlive = false;
      const afterCrash = await mgr.checkServiceCoreHealth();
      assert.equal(afterCrash, false);

      const finalStatus = mgr.getStatus();
      assert.equal(finalStatus.running, false, '核心退出后 running 必须复位为 false');
      assert.equal(finalStatus.tunActive, false, '核心退出后 tunActive 必须复位为 false');
      assert.equal(proxyRestoredPort, 17890, '必须触发系统代理恢复');
      assert.equal(routesCleaned, true, '必须触发服务端路由清理');
      assert.ok(
        statusEvents.some((s) => s.running === false && s.tunActive === false),
        '必须通过 onStatusCallback 通知渲染层/托盘重置状态'
      );

      mgr.stopServiceWatchdog();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. Service 模式且服务本身不可达连续 2 次失联时触发自动恢复', async () => {
    const mgr = new MihomoProcessManager();
    (mgr as any).runMode = 'service';
    (mgr as any).serviceCorePid = 9988;
    (mgr as any).currentStatus = {
      running: true,
      version: 'Mihomo v1.19.29',
      mixedPort: 17891,
      apiPort: 19098,
      uptime: 5,
      mode: 'rule',
      coreRunMode: 'service',
      tunActive: true,
    };

    let restored = false;
    mgr.startServiceWatchdog(60000, {
      getServiceStatus: async () => ({ installed: true, running: false, reachable: false }),
      getApiVersion: async () => {
        throw new Error('ECONNREFUSED');
      },
      restoreProxy: async () => {
        restored = true;
        return true;
      },
      isSystemProxyEnabled: () => true,
    });

    // 第 1 次失联：容忍一次瞬时抖动
    await mgr.checkServiceCoreHealth();
    assert.equal(mgr.getStatus().running, true);

    // 第 2 次失联：确认崩溃并执行善后
    await mgr.checkServiceCoreHealth();
    assert.equal(mgr.getStatus().running, false);
    assert.equal(restored, true);
    mgr.stopServiceWatchdog();
  });

  it('2b. Service 声明 coreRunning=true 但 REST API 连续 2 次无响应时同样触发恢复', async () => {
    const mgr = new MihomoProcessManager();
    (mgr as any).runMode = 'service';
    (mgr as any).serviceCorePid = 7766;
    (mgr as any).currentStatus = {
      running: true,
      version: 'Mihomo v1.19.29',
      mixedPort: 17892,
      apiPort: 19099,
      uptime: 5,
      mode: 'rule',
      coreRunMode: 'service',
      tunActive: true,
    };

    let restoredPort: number | null = null;
    let routesCleaned = false;
    mgr.startServiceWatchdog(60000, {
      getServiceStatus: async () => ({
        installed: true,
        running: true,
        reachable: true,
        coreRunning: true,
        corePid: 7766,
      }),
      getApiVersion: async () => {
        throw new Error('Request timeout');
      },
      restoreProxy: async (port) => {
        restoredPort = port;
        return true;
      },
      cleanupRoutesViaService: async () => {
        routesCleaned = true;
        return true;
      },
      isSystemProxyEnabled: () => true,
    });

    // 第 1 次 REST API 无响应：计数加 1，暂不复位
    const firstProbe = await mgr.checkServiceCoreHealth();
    assert.equal(firstProbe, true);
    assert.equal(mgr.getStatus().running, true);
    assert.equal(restoredPort, null);

    // 第 2 次 REST API 无响应：触发自动恢复
    const secondProbe = await mgr.checkServiceCoreHealth();
    assert.equal(secondProbe, false);
    assert.equal(mgr.getStatus().running, false);
    assert.equal(mgr.getStatus().tunActive, false);
    assert.equal(restoredPort, 17892);
    assert.equal(routesCleaned, true);
    mgr.stopServiceWatchdog();
  });

  it('3. hotReloadOrRestart 同步更新 currentStatus.mode 并在 TUN 降级时返回警告标记', async () => {
    const resourcesDir = path.resolve('resources');
    const exePath = path.join(resourcesDir, 'mihomo/mihomo.exe');
    if (process.platform !== 'win32' || !fs.existsSync(exePath)) {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-b4-reload-'));
    try {
      const mixedPort = await allocateFreePort();
      const apiPort = await allocateFreePort([mixedPort, mixedPort + 1]);
      const mgr = new MihomoProcessManager();
      mgr.initialize(tmpDir, resourcesDir);

      const startRes = await mgr.start({
        nodes: [],
        settings: {
          ...DEFAULT_SETTINGS,
          mixedPort,
          apiPort,
          systemProxy: false,
          tunMode: false,
          mode: 'rule',
        },
      });
      assert.equal(startRes.success, true, startRes.error);
      assert.equal(mgr.getStatus().mode, 'rule');

      // 热重载切换为 global 模式，应同步更新 currentStatus.mode
      const reloadRes = await mgr.hotReloadOrRestart({
        nodes: [],
        settings: {
          ...DEFAULT_SETTINGS,
          mixedPort,
          apiPort,
          systemProxy: false,
          tunMode: false,
          mode: 'global',
        },
      });
      assert.equal(reloadRes.success, true, reloadRes.error);
      assert.equal(mgr.getStatus().mode, 'global', '热重载后 currentStatus.mode 必须同步更新为 global');

      // 模拟非管理员且无服务时触发 TUN 降级，应返回 tunDowngraded=true 与明确 warning 提示
      (mgr as any).tunPrereqCheckHook = async () => ({
        serviceReady: false,
        isAdmin: false,
        driverOk: true,
      });
      const downgradeRes = await mgr.hotReloadOrRestart({
        nodes: [],
        settings: {
          ...DEFAULT_SETTINGS,
          mixedPort,
          apiPort,
          systemProxy: false,
          tunMode: true,
          mode: 'direct',
        },
      });
      assert.equal(downgradeRes.success, true);
      assert.equal(downgradeRes.tunDowngraded, true, 'TUN 被迫降级时必须返回 tunDowngraded=true');
      assert.match(downgradeRes.warning || '', /降级/);
      assert.equal(mgr.getStatus().tunActive, false);
      assert.equal(mgr.getStatus().mode, 'direct');

      await mgr.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. child.on(exit) 读取实时 storageManager.getSettings().systemProxy 而非启动闭包旧值', () => {
    const src = fs.readFileSync(path.resolve('src/main/core/mihomo-process.ts'), 'utf8');
    assert.ok(
      src.includes('storageManager.getSettings().systemProxy'),
      'child.on(exit) 必须读取最新 storageManager.getSettings().systemProxy'
    );
    assert.equal(
      src.includes('if (settings.systemProxy) {\n            systemProxyManager.restoreProxySync'),
      false
    );
    // 验证 storageManager 实时读写可达
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-b4-store-'));
    const prevDir = storageManager.getBaseDir();
    try {
      storageManager.initialize(dir);
      storageManager.saveSettings({ systemProxy: true });
      assert.equal(storageManager.getSettings().systemProxy, true);
    } finally {
      if (prevDir) storageManager.initialize(prevDir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5. shouldEnableRemoteDebugging: 打包版 (isPackaged=true) 严禁开启 9222 调试端口', () => {
    assert.equal(
      shouldEnableRemoteDebugging(true, { NEXLINK_DEBUG_PORT: '1' }, ['--remote-debugging-port=9222']),
      false,
      '生产打包版本即使携带环境变量与命令行参数也必须禁用调试端口'
    );
    assert.equal(shouldEnableRemoteDebugging(false, { NEXLINK_DEBUG_PORT: '1' }, []), true);
    assert.equal(
      shouldEnableRemoteDebugging(false, {}, ['app.exe', '--remote-debugging-port=9222']),
      true
    );
    assert.equal(shouldEnableRemoteDebugging(false, {}, ['app.exe']), false);
  });

  it('6. stopWithTimeoutAndFallback: 停止超时或抛错时不阻塞退出并触发紧急清理兜底', async () => {
    let emergencyCalled = 0;

    // 正常及时完成
    const fastRes = await stopWithTimeoutAndFallback(
      async () => true,
      () => {
        emergencyCalled++;
      },
      200
    );
    assert.deepEqual(fastRes, { timedOut: false, stopped: true });
    assert.equal(emergencyCalled, 0);

    // 模拟 stop 挂死超时
    const timeoutRes = await stopWithTimeoutAndFallback(
      () => new Promise<boolean>(() => {}),
      () => {
        emergencyCalled++;
      },
      60
    );
    assert.deepEqual(timeoutRes, { timedOut: true, stopped: false });
    assert.equal(emergencyCalled, 1, '超时后必须触发紧急清理兜底');

    // 模拟 stop 抛异常
    const throwRes = await stopWithTimeoutAndFallback(
      async () => {
        throw new Error('stop boom');
      },
      () => {
        emergencyCalled++;
      },
      200
    );
    assert.deepEqual(throwRes, { timedOut: false, stopped: false });
    assert.equal(emergencyCalled, 2, '异常后必须触发紧急清理兜底');
  });
});
