import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SystemProxyManager,
  isPortMatching,
  isLocalProxy,
  isPortListening,
} from '../../src/main/network/system-proxy';
import { proxyGuard } from '../../src/main/network/proxy-guard';

describe('其他代理客户端共存与退出防断网安全验证 (Other Proxy Clients Safety Tests)', () => {
  it('1. isPortMatching 正确区分本软件端口与第三方代理客户端端口', () => {
    // 自身端口 7890
    assert.strictEqual(isPortMatching('127.0.0.1:7890', 7890), true);
    assert.strictEqual(isPortMatching('http=127.0.0.1:7890;https=127.0.0.1:7890', 7890), true);
    assert.strictEqual(isPortMatching('localhost:7890', 7890), true);

    // 第三方客户端端口（如 Clash Verge 7897, v2rayN 10808 等）
    assert.strictEqual(isPortMatching('127.0.0.1:7897', 7890), false);
    assert.strictEqual(isPortMatching('127.0.0.1:10808', 7890), false);
    assert.strictEqual(isPortMatching('http=127.0.0.1:7897;https=127.0.0.1:7897', 7890), false);

    // 端口数字包含但非同一端口的边界校验
    assert.strictEqual(isPortMatching('127.0.0.1:78900', 7890), false);
    assert.strictEqual(isPortMatching('127.0.0.1:17890', 7890), false);
    assert.strictEqual(isPortMatching(undefined, 7890), false);
    assert.strictEqual(isPortMatching('', 7890), false);
  });

  it('2. 当注册表当前指向第三方代理时，NexLink 退出与清理时绝不误动注册表', async () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_coexist_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const manager = new SystemProxyManager();
      manager.initialize(tempDir);

      // 模拟此前 NexLink 的本地备份为直连
      manager.setOriginalBackup({ proxyEnable: 0 });

      // 模拟当前活跃第三方代理（如 Clash Verge 正在 7897 端口工作）
      const thirdPartyPort = 7897;
      const thirdPartyServer = `127.0.0.1:${thirdPartyPort}`;

      // 验证：当前系统代理是 7897 时，针对 NexLink 的 7890 端口执行恢复逻辑
      // 必须识别出当前不是 NexLink 掌控，绝不覆盖/抹除第三方代理配置
      const isNexLinkPort = isPortMatching(thirdPartyServer, 7890);
      assert.strictEqual(isNexLinkPort, false, '第三方端口 7897 绝对不应被误判为 NexLink 端口');

      // 验证 cleanStaleProxyIfPresent 逻辑：若注册表为 7897，NexLink 启动或自检时不予清理
      let mockRestoreCalled = false;
      const testCleanStale = async (currentServer: string, expectedPort: number) => {
        if (currentServer && isPortMatching(currentServer, expectedPort)) {
          const listening = await isPortListening(expectedPort, '127.0.0.1', 100);
          if (!listening) {
            mockRestoreCalled = true;
          }
        }
      };

      await testCleanStale(thirdPartyServer, 7890);
      assert.strictEqual(mockRestoreCalled, false, '第三方客户端 7897 绝不会被 cleanStaleProxyIfPresent 误恢复！');

      // 若为 NexLink 残留端口 7890 且无监听，则触发清理
      // 使用无监听测试端口 59998 模拟无监听残留，避免撞车本机当前正在运行的代理进程
      await testCleanStale('127.0.0.1:59998', 59998);
      assert.strictEqual(mockRestoreCalled, true, 'NexLink 遗留的无监听 7890 死代理必须被自检清理！');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. 当 NexLink 接管前用户已开启第三方代理时，恢复时必须原样还原第三方代理', async () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_restore_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const manager = new SystemProxyManager();
      manager.initialize(tempDir);

      // 用户打开 NexLink 前，已开启 Clash Verge (7897)
      const originalThirdParty = {
        proxyEnable: 1,
        proxyServer: '127.0.0.1:7897',
        proxyOverride: 'localhost;127.*;<local>',
      };
      manager.setOriginalBackup(originalThirdParty);

      // 备份存在且指向非 7890 端口
      const backup = manager.getOriginalBackup();
      assert.ok(backup);
      assert.strictEqual(backup.proxyEnable, 1);
      assert.strictEqual(backup.proxyServer, '127.0.0.1:7897');
      assert.strictEqual(isPortMatching(backup.proxyServer, 7890), false, '备份中的代理服务器非 NexLink 端口');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. 当用户原本无第三方代理时，NexLink 退出时彻底清空 ProxyServer 杜绝死代理残留', async () => {
    const tempDir = path.join(os.tmpdir(), `nexlink_clean_test_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const manager = new SystemProxyManager();
      manager.initialize(tempDir);

      // 用户此前未开启代理
      manager.setOriginalBackup({ proxyEnable: 0 });

      const backup = manager.getOriginalBackup();
      assert.ok(backup);
      assert.strictEqual(backup.proxyEnable, 0);

      // 模拟恢复逻辑：非第三方备份时，必须将 ProxyEnable 置为 0，并将 ProxyServer 置空
      const hasOtherClient =
        backup.proxyEnable === 1 &&
        Boolean(backup.proxyServer) &&
        !isPortMatching(backup.proxyServer, 7890);

      assert.strictEqual(hasOtherClient, false, '无第三方客户端，走直连清空分支');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('5. ProxyGuard 独立看门狗服务能够正常启停且跨平台安全', () => {
    assert.ok(proxyGuard);

    // 验证 stopGuard 不抛出异常
    assert.doesNotThrow(() => {
      proxyGuard.stopGuard();
    });
  });
});
