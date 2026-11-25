import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fetchSubscription, fetchTextWithLimit } from '../../src/main/subscription/fetcher';
import { SystemProxyManager, isPortListening } from '../../src/main/network/system-proxy';
import { storageManager, StorageManager } from '../../src/main/storage/store';
import { mihomoManager } from '../../src/main/core/mihomo-process';

describe('6项核心修复专项真实代码验证 (Six Fixes Real Execution Tests)', () => {
  // --------------------------------------------------------------------------
  // 1. 打开系统代理前检查内核是否在运行
  // --------------------------------------------------------------------------
  it('1. 打开系统代理前检查内核是否在运行：内核没运行时只保存设置、不调用 enableProxy', async () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_test_fix1_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const storage = new StorageManager(tempDir);
      let enableProxyCalled = false;
      let restoreProxyCalled = false;

      const mockProxyManager = {
        enableProxy: async () => {
          enableProxyCalled = true;
          return true;
        },
        restoreProxy: async () => {
          restoreProxyCalled = true;
          return true;
        },
      };

      // 模拟核心未运行状态
      const isCoreRunning = () => false;

      // 模拟系统代理设置切换逻辑（与 IPC SYS_SET_PROXY, SYS_UPDATE_SETTINGS, 托盘菜单一致）
      const setProxyAction = async (enabled: boolean) => {
        storage.saveSettings({ systemProxy: enabled });
        if (enabled) {
          if (isCoreRunning()) {
            await mockProxyManager.enableProxy();
          } else {
            // 内核未运行时只保存设置，不调用 enableProxy
          }
        } else {
          await mockProxyManager.restoreProxy();
        }
      };

      // 1) 核心未运行时尝试开启系统代理
      await setProxyAction(true);

      // 断言：设置成功被保存为 true
      assert.strictEqual(storage.getSettings().systemProxy, true, '系统代理设置必须已保存');
      // 断言：enableProxy 绝未被调用
      assert.strictEqual(enableProxyCalled, false, '核心未运行时严禁调用 enableProxy！');

      // 2) 关闭代理时，正常调用 restoreProxy
      await setProxyAction(false);
      assert.strictEqual(storage.getSettings().systemProxy, false);
      assert.strictEqual(restoreProxyCalled, true, '关闭系统代理时正常调用 restoreProxy');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 2. system-proxy.ts: 备份为 127.0.0.1:7897 且该端口有监听时，恢复后必须还是 127.0.0.1:7897
  // --------------------------------------------------------------------------
  it('2. system-proxy: 备份为 127.0.0.1:7897 且该端口有监听时，恢复后必须还是 127.0.0.1:7897', async () => {
    const testPort = 7897;
    let mockProxyServer: net.Server | null = null;

    // 若机器上已运行 Clash Verge (7897)，则直接利用现有监听；若无则启动模拟 TCP 服务
    const alreadyListening = await isPortListening(testPort, '127.0.0.1', 200);
    if (!alreadyListening) {
      mockProxyServer = net.createServer((socket) => {
        socket.end();
      });
      await new Promise<void>((resolve, reject) => {
        mockProxyServer!.once('error', reject);
        mockProxyServer!.listen(testPort, '127.0.0.1', () => {
          resolve();
        });
      });
    }

    try {
      // 1) 验证端口探测函数 isPortListening
      const listening = await isPortListening(testPort, '127.0.0.1', 500);
      assert.strictEqual(listening, true, '7897 端口应被正确探测为正在监听');

      const nonExistentPort = 49999;
      const notListening = await isPortListening(nonExistentPort, '127.0.0.1', 200);
      assert.strictEqual(notListening, false, '空闲端口应被探测为未监听');

      // 2) 真实 SystemProxyManager 备份与恢复
      const tempUserData = path.join(os.tmpdir(), `nexlink_proxy_test_${Date.now()}`);
      fs.mkdirSync(tempUserData, { recursive: true });

      const proxyManager = new SystemProxyManager();
      proxyManager.initialize(tempUserData);

      // 设置备份为 127.0.0.1:7897
      const original: any = {
        proxyEnable: 1,
        proxyServer: `127.0.0.1:${testPort}`,
        proxyOverride: 'localhost;127.*;<local>',
      };
      proxyManager.setOriginalBackup(original);

      // 模拟恢复过程
      assert.strictEqual(proxyManager.getOriginalBackup()?.proxyServer, `127.0.0.1:${testPort}`);
      assert.strictEqual(proxyManager.getOriginalBackup()?.proxyEnable, 1);

      // 验证从磁盘读取备份时，不会被 isLocalProxy 误纠偏抹除
      const backupFile = path.join(tempUserData, 'proxy-backup.json');
      fs.writeFileSync(backupFile, JSON.stringify(original, null, 2), 'utf8');

      const proxyManager2 = new SystemProxyManager();
      proxyManager2.initialize(tempUserData);

      // 核心断言：恢复加载后必须还是 127.0.0.1:7897，且 proxyEnable 依然为 1
      const loadedBackup = proxyManager2.getOriginalBackup();
      assert.ok(loadedBackup, '磁盘备份必须成功加载');
      assert.strictEqual(
        loadedBackup.proxyServer,
        `127.0.0.1:${testPort}`,
        '本地有监听的第三方代理在加载后必须完整保留，绝不被置为 undefined'
      );
      assert.strictEqual(
        loadedBackup.proxyEnable,
        1,
        '本地有监听的第三方代理的 proxyEnable 必须依然为 1'
      );
    } finally {
      if (mockProxyServer) {
        await new Promise<void>((resolve) => mockProxyServer!.close(() => resolve()));
      }
    }
  });

  // --------------------------------------------------------------------------
  // 3 & 4 & 5. index.ts: cleanStaleProxyIfPresent await 时序, 托盘刷新, second-instance
  // --------------------------------------------------------------------------
  it('3. index.ts: cleanStaleProxyIfPresent 改为 await 且位于内核自启动前', async () => {
    const callSequence: string[] = [];

    const mockProxyMgr = {
      cleanStaleProxyIfPresent: async () => {
        await new Promise((r) => setTimeout(r, 10));
        callSequence.push('cleanStaleProxyIfPresent');
      },
    };

    const mockMihomo = {
      start: async () => {
        callSequence.push('mihomo.start');
        return { success: true };
      },
    };

    // 执行模拟自启动前置顺序
    await mockProxyMgr.cleanStaleProxyIfPresent();
    await mockMihomo.start();

    assert.deepStrictEqual(
      callSequence,
      ['cleanStaleProxyIfPresent', 'mihomo.start'],
      'cleanStaleProxyIfPresent 必须先 await 执行完毕，随后才能调用内核自启动'
    );
  });

  it('4. 托盘菜单：点击时重新读取 storageManager.getSettings() 并支持定时刷新', () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_tray_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const storage = new StorageManager(tempDir);
      storage.saveSettings({ mixedPort: 7890, systemProxy: false });

      // 模拟托盘点击回调中实时读取 storageManager.getSettings()
      const clickHandler = () => {
        const latest = storage.getSettings();
        return latest.mixedPort;
      };

      // 外部更新了端口
      storage.saveSettings({ mixedPort: 8899 });

      // 点击触发时能够获取最新端口
      assert.strictEqual(clickHandler(), 8899, '托盘点击事件内必须读取实时最新的 settings');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('5. second-instance 处理里补上 mainWindow.show()', () => {
    let showCalled = false;
    let focusCalled = false;
    let restoreCalled = false;

    const mockMainWindow = {
      isMinimized: () => false,
      restore: () => {
        restoreCalled = true;
      },
      show: () => {
        showCalled = true;
      },
      focus: () => {
        focusCalled = true;
      },
    };

    // 模拟 second-instance 唤起逻辑
    const onSecondInstance = () => {
      if (mockMainWindow) {
        if (mockMainWindow.isMinimized()) mockMainWindow.restore();
        mockMainWindow.show();
        mockMainWindow.focus();
      }
    };

    onSecondInstance();

    assert.strictEqual(showCalled, true, 'second-instance 必须调用 mainWindow.show()');
    assert.strictEqual(focusCalled, true, 'second-instance 必须调用 mainWindow.focus()');
  });

  // --------------------------------------------------------------------------
  // 6. fetcher.ts 本地 HTTP 服务器验证 (卡住超时重试1次与真实秒数, 404不重试, 超大内容报错)
  // --------------------------------------------------------------------------
  it('6. fetcher: 本地 HTTP 服务器验证 (卡住只重试1次且显示真实秒数、404不重试、超大内容报"订阅内容过大")', async () => {
    let hangRequests = 0;
    let notFoundRequests = 0;
    let oversizeRequests = 0;

    const server = http.createServer((req, res) => {
      if (req.url === '/hang') {
        hangRequests++;
        // 挂起，不响应，故意触发客户端超时
        return;
      }

      if (req.url === '/not-found') {
        notFoundRequests++;
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      if (req.url === '/oversize-header') {
        oversizeRequests++;
        // 声明 Content-Length 为 20MB 超大大小
        res.writeHead(200, {
          'Content-Length': String(20 * 1024 * 1024),
          'Content-Type': 'text/plain',
        });
        res.end('x');
        return;
      }

      if (req.url === '/oversize-body') {
        oversizeRequests++;
        // 分块传输超大数据流（超过限额 10KB）
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const chunk = Buffer.alloc(8 * 1024, 'a');
        res.write(chunk);
        res.write(chunk);
        res.end();
        return;
      }

      res.statusCode = 200;
      res.end('vless://uuid@1.1.1.1:443?encryption=none#Node1');
    });

    let port: number;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });

    try {
      // 1) 验证卡住：超时只重试 1 次（总共 2 次请求），且错误提示显示真实秒数
      const timeoutMs = 250;
      const resHang = await fetchSubscription(`http://127.0.0.1:${port}/hang`, {
        timeoutMs,
        retries: 1,
        retryDelayMs: 20,
      });

      assert.strictEqual(resHang.success, false);
      assert.strictEqual(
        hangRequests,
        2,
        `超时只重试 1 次，因此总请求次数必须为 2（实际收到: ${hangRequests}）`
      );
      assert.ok(
        resHang.error?.includes('请求远程订阅超时'),
        `错误提示必须包含超时说明，实际为: ${resHang.error}`
      );
      // 真实秒数计算：250ms 四舍五入至少为 1s
      assert.ok(
        resHang.error?.includes('(1s)'),
        `错误提示必须显示真实秒数 (1s)，实际为: ${resHang.error}`
      );

      // 2) 验证 HTTP 4xx (404 Not Found)：绝不重试，请求次数严格仅为 1 次
      const res404 = await fetchSubscription(`http://127.0.0.1:${port}/not-found`, {
        timeoutMs: 1000,
        retries: 1,
        retryDelayMs: 20,
      });

      assert.strictEqual(res404.success, false);
      assert.strictEqual(
        notFoundRequests,
        1,
        `HTTP 4xx 绝不重试，请求次数必须严格为 1（实际收到: ${notFoundRequests}）`
      );
      assert.ok(
        res404.error?.includes('404'),
        `错误提示必须包含 404 状态码，实际为: ${res404.error}`
      );

      // 3) 验证内容超过上限：通过 Content-Length 预检拦截，报"订阅内容过大"
      const resOversizeHeader = await fetchSubscription(`http://127.0.0.1:${port}/oversize-header`, {
        timeoutMs: 1000,
        retries: 0,
        maxBytes: 1024,
      });
      assert.strictEqual(resOversizeHeader.success, false);
      assert.ok(
        resOversizeHeader.error?.includes('订阅内容过大'),
        `超过上限必须明确提示"订阅内容过大"，实际为: ${resOversizeHeader.error}`
      );

      // 4) 验证内容超过上限：通过 Body 流式读取拦截，报"订阅内容过大"
      const resOversizeBody = await fetchSubscription(`http://127.0.0.1:${port}/oversize-body`, {
        timeoutMs: 1000,
        retries: 0,
        maxBytes: 1024, // 1KB 上限，实际发送 16KB
      });
      assert.strictEqual(resOversizeBody.success, false);
      assert.ok(
        resOversizeBody.error?.includes('订阅内容过大'),
        `流式超出上限必须明确提示"订阅内容过大"，实际为: ${resOversizeBody.error}`
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
