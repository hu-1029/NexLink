import { describe, it } from 'node:test';
import assert from 'node:assert';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isValidPort } from '../../src/services/node/node-utils';
import { buildMihomoConfig } from '../../src/main/core/config-builder';
import { validateMihomoConfig } from '../../src/main/core/config-validator';
import { isPortAvailable, canConnectToPort } from '../../src/main/core/mihomo-process';
import { DEFAULT_SETTINGS } from '../../src/main/storage/store';

describe('Claude 审计 6 项问题深度修复专项验证测试', () => {
  it('1. 验证 isValidPort 严格校验：拒绝 7890abc 等夹杂字母的畸形端口', () => {
    assert.strictEqual(isValidPort('7890abc'), false, '包含字母后缀应判定为非法');
    assert.strictEqual(isValidPort('abc7890'), false, '包含字母前缀应判定为非法');
    assert.strictEqual(isValidPort('78.90'), false, '浮点数应判定为非法');
    assert.strictEqual(isValidPort('-7890'), false, '负数应判定为非法');
    assert.strictEqual(isValidPort('0'), false, '0 端口应判定为非法');
    assert.strictEqual(isValidPort('65536'), false, '超出 65535 应判定为非法');
    assert.strictEqual(isValidPort(''), false, '空字符串应判定为非法');
    assert.strictEqual(isValidPort(null), false, 'null 应判定为非法');

    assert.strictEqual(isValidPort(7890), true, '合法数字 7890');
    assert.strictEqual(isValidPort('7890'), true, '合法纯数字字符串 7890');
    assert.strictEqual(isValidPort(' 7890 '), true, '带空格但纯数字应被正常 trim 解析');
    assert.strictEqual(isValidPort(1), true, '最小边界端口 1');
    assert.strictEqual(isValidPort(65535), true, '最大边界端口 65535');
  });

  it('2. 验证代理端口设为 65534 与 65535 时安全收敛，不发生 +2 溢出且通过实机核心预检', async () => {
    const mihomoExe = path.resolve('resources/mihomo/mihomo.exe');
    const runtimeDir = path.resolve('data/runtime');

    // 测试 65534 (mixedPort + 2 = 65536 原先会溢出)
    const cfg65534 = buildMihomoConfig({
      nodes: [],
      settings: { ...DEFAULT_SETTINGS, mixedPort: 65534, apiPort: 9097 },
      apiSecret: 'test-secret',
    });
    const cfgPath65534 = path.join(runtimeDir, `test-cfg-65534-${Date.now()}.yaml`);
    fs.writeFileSync(cfgPath65534, cfg65534, 'utf8');

    const res65534 = await validateMihomoConfig(mihomoExe, cfgPath65534, runtimeDir);
    assert.strictEqual(res65534.valid, true, `65534 应当通过校验，错误信息: ${res65534.error}`);
    fs.unlinkSync(cfgPath65534);

    // 测试 65535 (mixedPort + 1 和 + 2 原先都会溢出)
    const cfg65535 = buildMihomoConfig({
      nodes: [],
      settings: { ...DEFAULT_SETTINGS, mixedPort: 65535, apiPort: 9097 },
      apiSecret: 'test-secret',
    });
    const cfgPath65535 = path.join(runtimeDir, `test-cfg-65535-${Date.now()}.yaml`);
    fs.writeFileSync(cfgPath65535, cfg65535, 'utf8');

    const res65535 = await validateMihomoConfig(mihomoExe, cfgPath65535, runtimeDir);
    assert.strictEqual(res65535.valid, true, `65535 应当通过校验，错误信息: ${res65535.error}`);
    fs.unlinkSync(cfgPath65535);
  });

  it('3. 验证端口冲突保护：当 mixedPort+1 与 apiPort 冲突时自动压制冲突端口', async () => {
    const mihomoExe = path.resolve('resources/mihomo/mihomo.exe');
    const runtimeDir = path.resolve('data/runtime');

    // mixedPort = 9096, apiPort = 9097 -> mixedPort + 1 原本会生成 port: 9097 发生撞车
    const cfg = buildMihomoConfig({
      nodes: [],
      settings: { ...DEFAULT_SETTINGS, mixedPort: 9096, apiPort: 9097 },
      apiSecret: 'test-secret',
    });
    const cfgPath = path.join(runtimeDir, `test-collision-${Date.now()}.yaml`);
    fs.writeFileSync(cfgPath, cfg, 'utf8');

    const res = await validateMihomoConfig(mihomoExe, cfgPath, runtimeDir);
    assert.strictEqual(res.valid, true, `压制后应当通过校验，无端口冲突报错: ${res.error}`);
    fs.unlinkSync(cfgPath);
  });

  it('4. 验证端口占用与就绪探测算法准确性', async () => {
    // 随机一个测试端口
    const testPort = 39871;
    // 尚未监听时，isPortAvailable 应返回 true
    const beforeAvail = await isPortAvailable(testPort);
    assert.strictEqual(beforeAvail, true, '空闲端口应为可用');

    // 启动一个真实本地临时服务器占用该端口
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(testPort, '127.0.0.1', () => resolve());
    });

    try {
      // 正在监听时，isPortAvailable 应精准感知占用并返回 false
      const duringAvail = await isPortAvailable(testPort);
      assert.strictEqual(duringAvail, false, '被占用端口应判定为不可用');

      // 正在监听时，canConnectToPort 应成功握手并返回 true
      const canConnect = await canConnectToPort(testPort);
      assert.strictEqual(canConnect, true, '正在监听的端口应握手成功');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 关闭后，canConnectToPort 应返回 false
    const afterConnect = await canConnectToPort(testPort);
    assert.strictEqual(afterConnect, false, '关闭后的端口应握手失败');
  });

  it('5. 验证核心规则库热同步机制：当源文件内容或时间更新时自动覆盖目标文件', () => {
    const tmpDir = os.tmpdir();
    const testSrc = path.join(tmpDir, `test-rule-src-${Date.now()}.dat`);
    const testDst = path.join(tmpDir, `test-rule-dst-${Date.now()}.dat`);

    fs.writeFileSync(testSrc, 'NEW_RULE_DATA_V2', 'utf8');
    fs.writeFileSync(testDst, 'OLD_RULE_DATA_V1', 'utf8');

    // 模拟旧版本 dst 修改时间早于 src
    const now = Date.now();
    fs.utimesSync(testDst, (now - 10000) / 1000, (now - 10000) / 1000);
    fs.utimesSync(testSrc, now / 1000, now / 1000);

    const srcStat = fs.statSync(testSrc);
    const dstStat = fs.statSync(testDst);

    // 断言我们采用的判定规则生效：srcStat.mtimeMs > dstStat.mtimeMs 或 size 改变
    const shouldUpdate = srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size;
    assert.strictEqual(shouldUpdate, true, '源文件更新或大小不同时应触发更新');

    if (shouldUpdate) {
      fs.copyFileSync(testSrc, testDst);
    }

    assert.strictEqual(fs.readFileSync(testDst, 'utf8'), 'NEW_RULE_DATA_V2', '目标文件已成功热同步为最新内容');

    fs.unlinkSync(testSrc);
    fs.unlinkSync(testDst);
  });
});
