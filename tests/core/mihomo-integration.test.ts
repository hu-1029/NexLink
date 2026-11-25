import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { buildMihomoConfig } from '../../src/main/core/config-builder';
import { validateMihomoConfig } from '../../src/main/core/config-validator';
import { MOCK_NODES } from '../../src/renderer/mock/mockData';

const runtimeDir = path.resolve('data/runtime');
const rulesDir = path.resolve('resources/rules');
const mihomoExe = path.resolve('resources/mihomo/mihomo.exe');

// 确保测试前规则文件就绪
function prepareRules() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const file of fs.readdirSync(rulesDir)) {
    if (file === '.gitkeep') continue;
    const src = path.join(rulesDir, file);
    const dst = path.join(runtimeDir, file);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

test('Mihomo 核心配置生成与真实预检校验测试', async (t) => {
  prepareRules();

  await t.test('1. 正确生成包含真实多协议节点的完整 config.yaml', () => {
    const yamlConfig = buildMihomoConfig({
      nodes: MOCK_NODES,
      settings: {
        theme: 'dark',
        systemProxy: false,
        tunMode: false,
        autoLaunch: false,
        silentStart: false,
        mixedPort: 7890,
        apiPort: 9097,
        allowLan: false,
        logLevel: 'info',
      },
      apiSecret: 'test-secret-safe-12345',
    });

    assert.ok(yamlConfig.includes('external-controller: 127.0.0.1:9097'));
    assert.ok(yamlConfig.includes('secret: test-secret-safe-12345'));
    assert.ok(yamlConfig.includes('proxies:'));
    assert.ok(yamlConfig.includes('proxy-groups:'));
    assert.ok(yamlConfig.includes('rules:'));
  });

  await t.test('2. 使用真实 mihomo.exe -t 进行合法配置校验', async () => {
    const configPath = path.join(runtimeDir, 'test_valid_config.yaml');
    const yamlConfig = buildMihomoConfig({
      nodes: MOCK_NODES,
      settings: {
        theme: 'dark',
        systemProxy: false,
        tunMode: false,
        autoLaunch: false,
        silentStart: false,
        mixedPort: 7890,
        apiPort: 9097,
        allowLan: false,
        logLevel: 'info',
      },
      apiSecret: 'valid-secret-999',
    });
    fs.writeFileSync(configPath, yamlConfig, 'utf8');

    const result = await validateMihomoConfig(mihomoExe, configPath, runtimeDir);
    assert.strictEqual(result.valid, true, `校验失败原因: ${result.error}`);
  });

  await t.test('3. 对非法配置（如端口冲突/语法错误）能正确拦截并返回具体错误信息', async () => {
    const invalidConfigPath = path.join(runtimeDir, 'test_invalid_config.yaml');
    // 写入一个代理指向不存在的类型与坏格式
    const brokenYaml = `
mixed-port: not_a_number
rules:
  - BAD_RULE_SYNTAX
`;
    fs.writeFileSync(invalidConfigPath, brokenYaml, 'utf8');

    const result = await validateMihomoConfig(mihomoExe, invalidConfigPath, runtimeDir);
    assert.strictEqual(result.valid, false, '非法配置应被拦截');
    assert.ok(result.error && result.error.length > 0, '应返回具体错误信息');
  });

  await t.test('4. 第三阶段真实解析协议样本注入 Mihomo 配置并通过校验', async () => {
    const { smartParse } = await import('../../src/services/importer/smart-importer');
    const {
      SAMPLE_VMESS_WS,
      SAMPLE_VLESS_REALITY,
      SAMPLE_SS_SIP002,
      SAMPLE_TROJAN_WS,
      SAMPLE_HYSTERIA2_OBFS,
    } = await import('../samples/samples');

    const rawBatch = [
      SAMPLE_VMESS_WS,
      SAMPLE_VLESS_REALITY,
      SAMPLE_SS_SIP002,
      SAMPLE_TROJAN_WS,
      SAMPLE_HYSTERIA2_OBFS,
    ].join('\n');

    const parseResult = smartParse(rawBatch);
    assert.ok(parseResult.success);
    assert.strictEqual(parseResult.nodes.length, 5);

    const configPath = path.join(runtimeDir, 'test_parsed_nodes_config.yaml');
    const yamlConfig = buildMihomoConfig({
      nodes: parseResult.nodes,
      settings: {
        theme: 'dark',
        systemProxy: false,
        tunMode: false,
        autoLaunch: false,
        silentStart: false,
        mixedPort: 7890,
        apiPort: 9097,
        allowLan: false,
        logLevel: 'info',
      },
      apiSecret: 'test-real-samples-secret',
    });
    fs.writeFileSync(configPath, yamlConfig, 'utf8');

    const result = await validateMihomoConfig(mihomoExe, configPath, runtimeDir);
    assert.strictEqual(result.valid, true, `真实解析节点配置校验失败: ${result.error}`);
  });
});
