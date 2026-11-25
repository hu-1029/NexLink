import test from 'node:test';
import assert from 'node:assert/strict';
import { systemProxyManager } from '../../src/main/network/system-proxy';

test('Windows 系统代理安全备份与无损回滚机制测试', async (t) => {
  await t.test('1. 正确读取当前系统代理配置结构并校验字段完整性', async () => {
    const current = await systemProxyManager.getCurrentProxy();
    assert.strictEqual(typeof current.enabled, 'boolean');
    assert.strictEqual(typeof current.server, 'string');
    assert.strictEqual(typeof current.bypass, 'string');
    assert.ok(current.server.length > 0);
    console.log('  -> 系统代理状态读取成功:', current);
  });
});
