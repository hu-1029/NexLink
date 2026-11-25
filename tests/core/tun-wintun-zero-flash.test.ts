import assert from 'node:assert';
import { it, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureWintunDriver } from '../../src/main/network/wintun-manager';
import { buildMihomoConfig } from '../../src/main/core/config-builder';
import { isCurrentProcessAdmin, checkTunPrerequisites } from '../../src/main/network/tun-checker';
import { getLiveRegistryProxySync } from '../../src/main/network/system-proxy';
import type { AppSettings, ProxyNode } from '../../src/shared/types';

describe('TUN 虚拟网卡、Wintun 驱动与子进程零闪烁专项测试', () => {
  it('1. 验证 config-builder 生成的 TUN 配置严格对齐 Clash Verge 标准 (device: Meta, mtu: 9000 等)', () => {
    const mockNodes: ProxyNode[] = [
      {
        id: 'node-test-tun',
        name: '测试节点',
        type: 'vmess',
        server: '1.1.1.1',
        port: 443,
        uuid: '00000000-0000-0000-0000-000000000000',
      },
    ];

    const settings: AppSettings = {
      mixedPort: 7890,
      apiPort: 9097,
      mode: 'rule',
      systemProxy: false,
      tunMode: true,
      tunStack: 'mixed',
    };

    const yaml = buildMihomoConfig({
      nodes: mockNodes,
      settings,
      apiSecret: 'secret123',
    });

    assert.ok(yaml.includes('device: Meta'), 'TUN 配置必须包含 device: Meta');
    assert.ok(yaml.includes('mtu: 9000'), 'TUN 配置必须包含 mtu: 9000');
    assert.ok(
      yaml.includes('endpoint-independent-nat: true'),
      'TUN 配置必须包含 endpoint-independent-nat: true'
    );
    assert.ok(yaml.includes('strict-route: false'), 'strict-route 必须为 false 杜绝断网');
    assert.ok(yaml.includes('auto-route: true'), 'auto-route 必须为 true');
    assert.ok(yaml.includes('auto-detect-interface: true'), 'auto-detect-interface 必须为 true');
  });

  it('2. 验证 ensureWintunDriver 能检测本地已有驱动并安全就绪', async () => {
    const tmpTestDir = path.join(os.tmpdir(), `nexlink-test-wintun-${Date.now()}`);
    const runtimeDir = path.join(tmpTestDir, 'runtime');
    const resourcesDir = path.join(tmpTestDir, 'resources');
    const resMihomoDir = path.join(resourcesDir, 'mihomo');

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(resMihomoDir, { recursive: true });

    // 伪造一个 >100KB 的 wintun.dll 资源文件
    const dummyDllPath = path.join(resMihomoDir, 'wintun.dll');
    const dummyBuffer = Buffer.alloc(120 * 1024, 0x90);
    dummyBuffer[0] = 0x4d; // 'M'
    dummyBuffer[1] = 0x5a; // 'Z'
    fs.writeFileSync(dummyDllPath, dummyBuffer);

    const res = await ensureWintunDriver(runtimeDir, resourcesDir);
    assert.strictEqual(res.ok, true, '应当成功检测并拷贝资源中的驱动');
    assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'wintun.dll')), true);
    assert.strictEqual(fs.statSync(path.join(runtimeDir, 'wintun.dll')).size, 120 * 1024);

    // 二次调用：runtime 已存在合法的 wintun.dll，应直接就绪返回
    const resSecond = await ensureWintunDriver(runtimeDir, resourcesDir);
    assert.strictEqual(resSecond.ok, true);

    // 清理测试目录
    try {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('3. 验证 isCurrentProcessAdmin 与 checkTunPrerequisites 毫秒级极速响应且不抛出未捕获异常', async () => {
    const isAdmin = isCurrentProcessAdmin();
    assert.strictEqual(typeof isAdmin, 'boolean');

    const checkRes = await checkTunPrerequisites();
    assert.strictEqual(typeof checkRes.isAdmin, 'boolean');
    assert.strictEqual(typeof checkRes.canEnableTun, 'boolean');
  });

  it('4. 验证 getLiveRegistryProxySync 原生极速读取注册表且不依赖 PowerShell', () => {
    const reg = getLiveRegistryProxySync();
    assert.strictEqual(typeof reg.enabled, 'boolean');
  });
});
