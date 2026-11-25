import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StorageManager } from '../../src/main/storage/store';
import { SubscriptionManager } from '../../src/main/subscription/manager';
import type { MihomoProcessManager } from '../../src/main/core/mihomo-process';
import { devCspPlugin, DEV_CSP } from '../../vite.config';
import { restartAsAdmin } from '../../src/main/network/tun-checker';
import { acquireSingleInstanceLock } from '../../src/main/index';

describe('5项核心问题修复专项真实代码验证 (Five Bugfixes Real Execution Tests)', () => {
  const mockMihomo = {
    getStatus: () => ({ running: false }),
    restart: async () => ({ success: true }),
    hotReloadOrRestart: async () => ({ success: true }),
    stop: async () => {},
  } as unknown as MihomoProcessManager;

  // -------------------------------------------------------------
  // 测试 1: fetcher.ts 里 smartParse 传入 subscriptionId
  // -------------------------------------------------------------
  it('1. fetcher smartParse 传递 subscriptionId：真实添加两份相同内容的订阅，断言 storage.getNodes() 的 id 全部唯一', async () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_test_fix1_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const storage = new StorageManager(tempDir);
      const manager = new SubscriptionManager(storage, mockMihomo);

      // 提供同一份节点内容 (多行 URI 样例)
      const identicalNodesContent = [
        'vless://11111111-2222-3333-4444-555555555555@hk01.example.com:443?encryption=none&security=reality&pbk=xyz#HK-Node-01',
        'vmess://ewoidiI6ICIyIiwgInBzIjogIlNHLU5vZGUtMDIiLCAiYWRkIjogInNnMDEuZXhhbXBsZS5jb20iLCAicG9ydCI6IDQ0MywgImlkIjogImExYjJjM2Q0LWU1ZjYtNzg5MC0xMjM0LTU2Nzg5MGFiY2RlZiIsICJuZXQiOiAid3MiLCAidHlwZSI6ICJub25lIiwgInBhdGgiOiAiL3ZtZXNzIiwgInRscyI6ICJ0bHMiIH0=',
        'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQxMjM=@jp01.example.com:8388#JP-Node-03',
      ].join('\n');

      // 真实调用 SubscriptionManager 添加两个内容完全相同的订阅
      const subA = await manager.addSubscription({
        name: '订阅A',
        type: 'local',
        rawContent: identicalNodesContent,
      });

      const subB = await manager.addSubscription({
        name: '订阅B',
        type: 'local',
        rawContent: identicalNodesContent,
      });

      assert.ok(subA.id && subB.id);
      assert.notStrictEqual(subA.id, subB.id);

      // 从 storage 真实获取聚合后的所有节点
      const nodes = storage.getNodes();
      // 3 个节点 x 2 个订阅 = 6 个节点
      assert.strictEqual(nodes.length, 6);

      // 验证每一个节点的 id 都是唯一的，不存在任何碰撞
      const allIds = nodes.map((n) => n.id);
      const uniqueIds = new Set(allIds);
      assert.strictEqual(
        uniqueIds.size,
        allIds.length,
        `节点 ID 必须全部唯一！总数: ${allIds.length}, 去重后: ${uniqueIds.size}`
      );

      // 验证节点归属分别与两个订阅相对应
      const nodesA = nodes.filter((n) => n.subscriptionId === subA.id);
      const nodesB = nodes.filter((n) => n.subscriptionId === subB.id);
      assert.strictEqual(nodesA.length, 3);
      assert.strictEqual(nodesB.length, 3);

      // 验证同名同配置节点在不同订阅下的 id 截然不同
      assert.notStrictEqual(nodesA[0].id, nodesB[0].id);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------
  // 测试 2: index.html 的 CSP 与 vite dev 放宽
  // -------------------------------------------------------------
  it('2. index.html 的 CSP：生产严格无 unsafe-inline/eval/宽松connect-src，开发模式通过插件放宽', () => {
    // 1) 验证 index.html 源码的生产严格 CSP
    const indexHtmlPath = path.resolve(process.cwd(), 'index.html');
    const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

    const cspMatch = htmlContent.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
    assert.ok(cspMatch, 'index.html 必须包含 Content-Security-Policy meta 标签');
    const csp = cspMatch[1];

    // script-src 验证：绝不包含 'unsafe-inline' 或 'unsafe-eval'
    const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
    assert.ok(scriptSrcMatch);
    const scriptSrc = scriptSrcMatch[1];
    assert.strictEqual(scriptSrc.includes("'unsafe-inline'"), false, "生产 script-src 严禁包含 'unsafe-inline'");
    assert.strictEqual(scriptSrc.includes("'unsafe-eval'"), false, "生产 script-src 严禁包含 'unsafe-eval'");
    assert.ok(scriptSrc.includes("'self'"), "script-src 必须包含 'self'");

    // connect-src 验证：绝不包含通配或宽泛的 ws: http: https:（仅允许本地回环 127.0.0.1 端口）
    const connectSrcMatch = csp.match(/connect-src\s+([^;]+)/);
    assert.ok(connectSrcMatch);
    const connectSrc = connectSrcMatch[1];
    const connectTokens = connectSrc.trim().split(/\s+/);
    assert.strictEqual(connectTokens.includes('ws:'), false, '生产 connect-src 严禁包含宽泛 ws:');
    assert.strictEqual(connectTokens.includes('http:'), false, '生产 connect-src 严禁包含宽泛 http:');
    assert.strictEqual(connectTokens.includes('https:'), false, '生产 connect-src 严禁包含宽泛 https:');
    assert.ok(connectTokens.includes('ws://127.0.0.1:*'), 'connect-src 允许连接本地 Mihomo ws');
    assert.ok(connectTokens.includes('http://127.0.0.1:*'), 'connect-src 允许连接本地 Mihomo http');

    // 2) 验证 vite dev 开发插件放宽逻辑
    const plugin = devCspPlugin();
    assert.strictEqual(plugin.apply, 'serve', 'devCspPlugin 必须仅作用于 serve 开发服务器');

    // 真实调用 transformIndexHtml 钩子
    const transformFn = plugin.transformIndexHtml as (html: string) => string;
    const transformedHtml = transformFn(htmlContent);

    // 断言开发模式下被放宽，且包含了开发所需的 unsafe-inline / unsafe-eval / ws: http: https:
    assert.ok(transformedHtml.includes(DEV_CSP), '开发模式 HTML 转换后必须包含放宽的 DEV_CSP');
    assert.ok(transformedHtml.includes("'unsafe-inline'"));
    assert.ok(transformedHtml.includes("'unsafe-eval'"));
    assert.ok(transformedHtml.includes('ws: http: https:'));
  });

  // -------------------------------------------------------------
  // 测试 3: manager.ts 删除订阅的目录判断 path.relative(profilesDir, resolved)
  // -------------------------------------------------------------
  it('3. manager.ts 删除订阅目录判断：调用真实 deleteSubscription，验证 profiles-evil/ 下的文件不会被删', async () => {
    const baseDir = path.join(os.tmpdir(), `nexlink_test_fix3_${Date.now()}`);
    const profilesDir = path.join(baseDir, 'profiles');
    const evilDir = path.join(baseDir, 'profiles-evil');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(evilDir, { recursive: true });

    try {
      const storage = new StorageManager(baseDir);
      const manager = new SubscriptionManager(storage, mockMihomo);

      // 在 profiles-evil 目录下创建敏感目标文件
      const evilTargetFile = path.join(evilDir, 'victim_config.yaml');
      fs.writeFileSync(evilTargetFile, 'secret-data: true', 'utf8');

      // 在 profiles 目录下创建正常内部缓存文件
      const normalCacheFile = path.join(profilesDir, 'sub-normal.txt');
      fs.writeFileSync(normalCacheFile, 'normal-proxies: []', 'utf8');

      // 手动在存储中构造一个指向 profiles-evil 恶意路径的订阅
      storage.saveSubscriptions([
        {
          id: 'sub-evil',
          name: '恶意前缀伪造订阅',
          type: 'local',
          filePath: evilTargetFile,
          nodeCount: 0,
          updatedAt: '2026-11-03 20:00',
          status: 'ok',
        },
        {
          id: 'sub-normal',
          name: '正常订阅',
          type: 'local',
          filePath: normalCacheFile,
          nodeCount: 0,
          updatedAt: '2026-11-03 20:00',
          status: 'ok',
        },
      ]);

      // 1) 真实调用 deleteSubscription 删除恶意订阅
      await manager.deleteSubscription('sub-evil');

      // 核心断言：profiles-evil/ 下的文件绝对未被删除！
      assert.strictEqual(
        fs.existsSync(evilTargetFile),
        true,
        'profiles-evil/ 下的文件绝不可被删除！防御 path.relative 校验成功'
      );

      // 2) 真实调用 deleteSubscription 删除正常内部缓存订阅
      await manager.deleteSubscription('sub-normal');

      // 核心断言：正常 profiles/ 内部缓存文件被安全清理
      assert.strictEqual(
        fs.existsSync(normalCacheFile),
        false,
        'profiles/ 下的正常内部缓存文件应该被物理清理'
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------
  // 测试 4: tun-checker.ts restartAsAdmin 的执行顺序与安全退出（含 Linux 平台模拟与打包版 --relaunch 校验）
  // -------------------------------------------------------------
  it('4. tun-checker restartAsAdmin：支持跨平台模拟 (Linux 下也能跑)，打包版增加 -ArgumentList \'--relaunch\'，先 await mihomo.stop()，再 releaseSingleInstanceLock，最后 app.quit()，不调用 app.exit(0)', async () => {
    const originalPlatform = process.platform;

    try {
      // 1) 验证非 Windows 平台 (如真实 Linux 或模拟 Linux) 下，直接返回 false 且不执行任何提权命令
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      let linuxExecCalled = false;
      const linuxRes = await restartAsAdmin({
        execCommand: async () => {
          linuxExecCalled = true;
          return { stdout: '', stderr: '' };
        },
      });
      assert.strictEqual(linuxRes, false, '非 win32 平台必须直接返回 false');
      assert.strictEqual(linuxExecCalled, false, '非 win32 平台绝不执行提权命令');

      // 2) 模拟 Windows 平台 (win32)，使该测试在任何操作系统 (如 Linux CI) 均能 100% 运行
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      // 验证打包版 (isPackaged = true)：PowerShell 必须携带 -ArgumentList '--relaunch'
      const packagedCommands: string[] = [];
      const packagedApp = {
        isPackaged: true,
        releaseSingleInstanceLock: () => {},
        quit: () => {},
      };
      await restartAsAdmin({
        execCommand: async (cmd: string) => {
          packagedCommands.push(cmd);
          return { stdout: '', stderr: '' };
        },
        appInstance: packagedApp,
        mihomo: { stop: async () => {} },
      });
      assert.strictEqual(packagedCommands.length, 1);
      const encMatch = packagedCommands[0].match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
      const decodedCmd = encMatch
        ? Buffer.from(encMatch[1], 'base64').toString('utf16le')
        : packagedCommands[0];
      assert.ok(
        decodedCmd.includes("-ArgumentList '--relaunch'"),
        `打包版启动命令必须包含 -ArgumentList '--relaunch'，实际为: ${decodedCmd}`
      );

      // 验证执行时序与生命周期完整性
      const executionOrder: string[] = [];
      const mockMihomoTracker = {
        stop: async () => {
          // 模拟异步 stop 等待
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionOrder.push('mihomo.stop');
        },
      };

      const mockApp = {
        isPackaged: false,
        releaseSingleInstanceLock: () => {
          executionOrder.push('releaseSingleInstanceLock');
        },
        quit: () => {
          executionOrder.push('app.quit');
        },
        exit: (code: number) => {
          executionOrder.push(`app.exit(${code})`);
        },
      };

      const mockExec = async (cmd: string) => {
        executionOrder.push(`execAsync`);
        return { stdout: '', stderr: '' };
      };

      // 真实调用 restartAsAdmin
      const success = await restartAsAdmin({
        execCommand: mockExec,
        appInstance: mockApp,
        mihomo: mockMihomoTracker,
      });

      assert.strictEqual(success, true);

      // 严格校验执行顺序
      assert.deepStrictEqual(
        executionOrder,
        ['execAsync', 'mihomo.stop', 'releaseSingleInstanceLock', 'app.quit'],
        '执行顺序必须是：拉起进程 -> await mihomo.stop() -> releaseSingleInstanceLock -> app.quit()'
      );

      // 严禁调用 app.exit
      assert.strictEqual(
        executionOrder.some((item) => item.includes('app.exit')),
        false,
        '严禁调用 app.exit(0)'
      );
    } finally {
      // 还原系统真实 platform
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  // -------------------------------------------------------------
  // 测试 5: store.ts 默认日志级别为 info，且平滑恢复旧版强制迁移的 warning
  it('5. store.ts 默认日志级别为 info，平滑恢复旧版自动迁移的 warning 且不覆盖用户手动设置', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-store-test-'));
    try {
      const settingsPath = path.join(tmpDir, 'settings.json');
      // 1) 模拟旧版被自动迁移为 warning + logLevelMigrated: true 的配置
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          theme: 'dark',
          logLevel: 'warning',
          logLevelMigrated: true,
        }),
        'utf8'
      );

      const storage1 = new StorageManager(tmpDir);
      const settingsAfterFirstLoad = storage1.getSettings();
      assert.strictEqual(
        settingsAfterFirstLoad.logLevel,
        'info',
        '旧版自动迁移的 warning 应一次性平滑恢复为 info 以正常显示连接日志'
      );
      assert.strictEqual(
        settingsAfterFirstLoad.logLevelMigrated,
        false,
        '恢复后应清除 logLevelMigrated 标记'
      );

      // 2) 若用户后续手动设为 warning，再次重启不再覆盖
      storage1.saveSettings({ logLevel: 'warning' });
      const storage2 = new StorageManager(tmpDir);
      assert.strictEqual(
        storage2.getSettings().logLevel,
        'warning',
        '用户主动设置的 warning 不应被覆盖'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
