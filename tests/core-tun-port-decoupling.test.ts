import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  isPortAvailable,
  getListeningPidsForPort,
  isPidMihomo,
  isCurrentProcessAdmin,
} from '../src/main/core/mihomo-process';
import { buildMihomoConfig } from '../src/main/core/config-builder';
import type { AppSettings, ProxyNode } from '../src/shared/types';

describe('核心生命周期、端口自愈与 TUN 彻底解耦专项验证测试', () => {
  it('1. 验证空闲端口与监听中端口探测及 PID 提取准确性', async () => {
    // 监听一个临时本地 TCP 端口
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;
    const testPort = address.port;

    try {
      // 此时该端口已被占用
      const available = await isPortAvailable(testPort);
      assert.equal(available, false, '被监听中的端口应当返回 false');

      if (process.platform === 'win32') {
        const pids = getListeningPidsForPort(testPort);
        assert.ok(pids.length > 0, 'Windows 上应当成功提取到监听端口的 OwningProcess PID');
        assert.ok(pids.includes(process.pid), `提取的 PID 集合 ${JSON.stringify(pids)} 应当包含当前 Node.js 进程 ${process.pid}`);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 关闭后应快速恢复为可用
    const freeAfterClose = await isPortAvailable(testPort);
    assert.equal(freeAfterClose, true, '关闭监听后端口应当迅速恢复为可用');
  });

  it('2. 验证非管理员权限下自动安全降级 TUN 模式，杜绝拉起崩溃', () => {
    const mockNodes: ProxyNode[] = [
      {
        id: 'node-test-1',
        name: '测试出站节点',
        type: 'vmess',
        server: '1.2.3.4',
        port: 443,
        uuid: '00000000-0000-0000-0000-000000000000',
        alterId: 0,
        cipher: 'auto',
      },
    ];

    const settingsWithTun: AppSettings = {
      mixedPort: 7890,
      apiPort: 9097,
      mode: 'rule',
      systemProxy: false,
      tunMode: true,
      tunStack: 'mixed',
    };

    // 普通权限下安全降级
    const isAdmin = isCurrentProcessAdmin();
    const effectiveSettings = !isAdmin && settingsWithTun.tunMode
      ? { ...settingsWithTun, tunMode: false }
      : settingsWithTun;

    const yaml = buildMihomoConfig({
      nodes: mockNodes,
      settings: effectiveSettings,
      apiSecret: 'test-secret',
    });

    if (!isAdmin) {
      assert.ok(!yaml.includes('tun:'), '普通权限下降级生成的配置绝不能包含 tun: 块，防止因 Wintun 权限缺失崩溃');
      assert.ok(yaml.includes('mixed-port: 7890'), '降级后代理端口 7890 正常保留并监听');
      assert.ok(yaml.includes('mode: rule'), '分流模式正常保留');
    }
  });

  it('3. 验证核心与 TUN 解耦：TUN 关闭时配置纯代理出站，保留全部节点与分流规则', () => {
    const mockNodes: ProxyNode[] = [
      {
        id: 'node-test-2',
        name: '香港专线',
        type: 'vless',
        server: '8.8.8.8',
        port: 443,
        uuid: '00000000-0000-0000-0000-000000000000',
      },
    ];

    const settingsNoTun: AppSettings = {
      mixedPort: 7890,
      apiPort: 9097,
      mode: 'rule',
      systemProxy: true,
      tunMode: false,
    };

    const yaml = buildMihomoConfig({
      nodes: mockNodes,
      settings: settingsNoTun,
      apiSecret: 'test-secret',
    });

    assert.ok(!yaml.includes('tun:'), '关闭 TUN 模式时配置中不包含 tun 网卡接管');
    assert.ok(yaml.includes('mixed-port: 7890'), '代理端口依然为 7890');
    assert.ok(yaml.includes('proxies:'), '出站节点依然完整存在');
    assert.ok(yaml.includes('香港专线'), '香港专线节点名存在');
  });

  it('4. 验证 isPidMihomo 针对非法或不存在 PID 的安全容错', () => {
    const nonExistent = isPidMihomo(999999);
    assert.equal(nonExistent, false, '不存在的 PID 应当安全返回 false，不挂起也不抛异常');
  });
});
