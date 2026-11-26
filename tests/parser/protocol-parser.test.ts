/**
 * NexLink 阶段三：多协议与订阅解析引擎核心单元测试
 * 运行方式: node --experimental-strip-types tests/parser/protocol-parser.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isLikelyBase64, safeBase64Decode, safeBase64Encode } from '../../src/services/parser/base64';
import {
  parseVmess,
  parseVless,
  parseShadowsocks,
  parseTrojan,
  parseHysteria2,
  parseTuic,
  parseWireGuard,
  parseSingleUri,
} from '../../src/services/parser/protocol-uri';
import { parseClashYaml } from '../../src/services/converter/clash-parser';
import { parseJsonConfig } from '../../src/services/converter/json-parser';
import { proxyNodeToMihomo } from '../../src/services/converter/mihomo-generator';
import { deduplicateNodes } from '../../src/services/node/dedup';
import { smartParse } from '../../src/services/importer/smart-importer';

import {
  SAMPLE_VMESS_WS,
  SAMPLE_VLESS_REALITY,
  SAMPLE_USER_VLESS_REALITY_BASE64,
  SAMPLE_CF_WORKER_VLESS_WS_TLS,
  SAMPLE_CF_CLEAN_IP_VLESS_REALITY,
  SAMPLE_VLESS_GRPC,
  SAMPLE_SS_SIP002,
  SAMPLE_SS_2022,
  SAMPLE_SS_PLUGIN,
  SAMPLE_TROJAN_WS,
  SAMPLE_HYSTERIA2_OBFS,
  SAMPLE_TUIC_V5,
  SAMPLE_WIREGUARD,
  SAMPLE_BASE64_SUBSCRIPTION,
  SAMPLE_CLASH_YAML,
  SAMPLE_SINGBOX_JSON,
} from '../samples/samples';

describe('1. Base64 检测与解码测试', () => {
  it('应当正确编解码包含中文字符与特殊符号的字符串', () => {
    const raw = '🇭🇰 香港 01 | 极速专线 [IPLX-Reality] & 特殊符号';
    const encoded = safeBase64Encode(raw);
    const decoded = safeBase64Decode(encoded);
    assert.strictEqual(decoded, raw);
  });

  it('应当正确处理 URL-Safe Base64 与缺失 padding 的情况', () => {
    const raw = 'test-url-safe-string_123';
    const encoded = safeBase64Encode(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const decoded = safeBase64Decode(encoded);
    assert.strictEqual(decoded, raw);
  });

  it('应当自动识别 Base64 订阅数据块', () => {
    assert.strictEqual(isLikelyBase64(SAMPLE_BASE64_SUBSCRIPTION), true);
    assert.strictEqual(isLikelyBase64('vmess://something'), false);
    assert.strictEqual(isLikelyBase64('proxies:\n  - name: test'), false);
  });
});

describe('2. VMess 协议解析测试', () => {
  it('应当正确解析标准 v2rayN JSON Base64 格式的 VMess 节点', () => {
    const node = parseVmess(SAMPLE_VMESS_WS);
    assert.strictEqual(node.type, 'vmess');
    assert.strictEqual(node.server, 'hk.example.com');
    assert.strictEqual(node.port, 443);
    assert.strictEqual(node.countryCode, 'HK');
    assert.strictEqual(node.delay, undefined, '未测速节点延迟必须为 undefined');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, 'a0b1c2d3-e4f5-6789-0123-456789abcdef');
    assert.strictEqual(cfg.network, 'ws');
    assert.strictEqual(cfg.security, 'tls');
    assert.strictEqual(cfg.ws.path, '/vmess-ws');
    assert.strictEqual(cfg.ws.headers.Host, 'hk.example.com');
  });
});

describe('3. VLESS 协议解析测试 (Reality & gRPC)', () => {
  it('应当正确解析 VLESS XTLS-Reality 与 Vision 节点', () => {
    const node = parseVless(SAMPLE_VLESS_REALITY);
    assert.strictEqual(node.type, 'vless');
    assert.strictEqual(node.server, 'us.reality.net');
    assert.strictEqual(node.port, 443);
    assert.strictEqual(node.countryCode, 'US');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, '550e8400-e29b-41d4-a716-446655440000');
    assert.strictEqual(cfg.flow, 'xtls-rprx-vision');
    assert.strictEqual(cfg.security, 'reality');
    assert.strictEqual(cfg.fingerprint, 'chrome');
    assert.strictEqual(cfg.reality.publicKey, 'O2xZgL7b3K5q-X12vN3Y8u9I_P0kL4mJ7nH6gF5dE4s');
    assert.strictEqual(cfg.reality.shortId, '6ba7b810');
  });

  it('应当正确解析用户反馈的实机 Base64 复合 Authority (none:uuid) 与别名参数 VLESS Reality 节点', () => {
    const node = parseVless(SAMPLE_USER_VLESS_REALITY_BASE64);
    assert.strictEqual(node.type, 'vless');
    assert.strictEqual(node.name, 'vless+reality-圣何塞');
    assert.strictEqual(node.server, '198.51.100.10');
    assert.strictEqual(node.port, 17626);
    assert.strictEqual(node.countryCode, 'US');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(cfg.flow, 'xtls-rprx-vision');
    assert.strictEqual(cfg.security, 'reality');
    assert.strictEqual(cfg.sni, 'www.sony.com');
    assert.strictEqual(cfg.fingerprint, 'chrome');
    assert.strictEqual(cfg.reality.publicKey, 'FakeRealityPublicKeyExample0000000000000001');
    assert.strictEqual(cfg.reality.shortId, '19d4');
  });

  it('应当正确解析 Cloudflare Workers 优选 IP (VLESS WS+TLS) 节点', () => {
    const node = parseVless(SAMPLE_CF_WORKER_VLESS_WS_TLS);
    assert.strictEqual(node.type, 'vless');
    assert.strictEqual(node.server, '104.16.1.1');
    assert.strictEqual(node.port, 443);

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, 'd342d11e-d424-4583-b36e-524ab1f0afa4');
    assert.strictEqual(cfg.network, 'ws');
    assert.strictEqual(cfg.security, 'tls');
    assert.strictEqual(cfg.sni, 'my-sub.workers.dev');
    assert.strictEqual(cfg.ws.path, '/?ed=2048');
    assert.strictEqual(cfg.ws.headers.Host, 'my-sub.workers.dev');
  });

  it('应当正确解析 Cloudflare 优选 IP Reality 节点', () => {
    const node = parseVless(SAMPLE_CF_CLEAN_IP_VLESS_REALITY);
    assert.strictEqual(node.type, 'vless');
    assert.strictEqual(node.server, '203.0.113.20');
    assert.strictEqual(node.port, 443);

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, '22222222-3333-4444-5555-666666666666');
    assert.strictEqual(cfg.flow, 'xtls-rprx-vision');
    assert.strictEqual(cfg.security, 'reality');
    assert.strictEqual(cfg.sni, 'gateway.icloud.com');
    assert.strictEqual(cfg.reality.publicKey, 'FakeRealityPublicKeyExample0000000000000002');
    assert.strictEqual(cfg.reality.shortId, 'a1b2c3d4e5f60708');
  });

  it('应当正确解析 VLESS gRPC 节点', () => {
    const node = parseVless(SAMPLE_VLESS_GRPC);
    assert.strictEqual(node.type, 'vless');
    assert.strictEqual(node.countryCode, 'JP');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.network, 'grpc');
    assert.strictEqual(cfg.grpc.serviceName, 'vless-grpc');
  });
});

describe('4. Shadowsocks 协议解析测试 (SIP002 / 2022 / Plugin)', () => {
  it('应当正确解析 SIP002 标准格式 SS 节点', () => {
    const node = parseShadowsocks(SAMPLE_SS_SIP002);
    assert.strictEqual(node.type, 'ss');
    assert.strictEqual(node.server, 'sg.ss-node.org');
    assert.strictEqual(node.port, 8388);
    assert.strictEqual(node.countryCode, 'SG');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.cipher, 'aes-256-gcm');
    assert.strictEqual(cfg.password, 'mySecretPassword123');
  });

  it('应当正确解析 Shadowsocks 2022 现代加密套件', () => {
    const node = parseShadowsocks(SAMPLE_SS_2022);
    assert.strictEqual(node.type, 'ss');
    assert.strictEqual(node.countryCode, 'TW');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.cipher, '2022-blake3-aes-128-gcm');
    assert.strictEqual(cfg.password, 'v8k6d3G8QZ1yK2b7L5n9X3j1');
  });

  it('应当正确解析附带 v2ray-plugin 插件参数的 SS 节点', () => {
    const node = parseShadowsocks(SAMPLE_SS_PLUGIN);
    assert.strictEqual(node.type, 'ss');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.cipher, 'chacha20-ietf-poly1305');
    assert.strictEqual(cfg.plugin, 'v2ray-plugin');
    assert.ok(cfg.pluginOpts.includes('tls'));
  });
});

describe('5. Trojan / Hysteria 2 / TUIC / WireGuard 解析测试', () => {
  it('应当正确解析 Trojan WebSocket 节点', () => {
    const node = parseTrojan(SAMPLE_TROJAN_WS);
    assert.strictEqual(node.type, 'trojan');
    assert.strictEqual(node.countryCode, 'KR');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.password, 'myTrojanPassword');
    assert.strictEqual(cfg.network, 'ws');
    assert.strictEqual(cfg.ws.path, '/trojan-ws');
  });

  it('应当正确解析 Hysteria 2 节点及其混淆与多端口参数', () => {
    const node = parseHysteria2(SAMPLE_HYSTERIA2_OBFS);
    assert.strictEqual(node.type, 'hysteria2');
    assert.strictEqual(node.countryCode, 'GB');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.auth, 'ultraAuthKey');
    assert.strictEqual(cfg.obfs, 'salamander');
    assert.strictEqual(cfg.obfsPassword, 'hy2ObfsPass123');
    assert.strictEqual(cfg.ports, '20000-40000');
  });

  it('应当正确解析 TUIC v5 节点', () => {
    const node = parseTuic(SAMPLE_TUIC_V5);
    assert.strictEqual(node.type, 'tuic');
    assert.strictEqual(node.countryCode, 'FR');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.uuid, '99999999-8888-7777-6666-555555555555');
    assert.strictEqual(cfg.password, 'tuicPassword');
    assert.strictEqual(cfg.congestionController, 'bbr');
  });

  it('应当正确解析 WireGuard 节点', () => {
    const node = parseWireGuard(SAMPLE_WIREGUARD);
    assert.strictEqual(node.type, 'wireguard');
    assert.strictEqual(node.countryCode, 'CA');

    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.ip, '10.0.0.2');
    assert.ok(cfg.privateKey);
  });
});

describe('6. 配置文件解析测试 (Clash YAML & Sing-box JSON)', () => {
  it('应当从 Clash YAML 中完整提取 4 个多协议代理节点', () => {
    const nodes = parseClashYaml(SAMPLE_CLASH_YAML);
    assert.strictEqual(nodes.length, 4);

    const vlessNode = nodes.find((n) => n.type === 'vless');
    assert.ok(vlessNode);
    assert.strictEqual(vlessNode.server, 'hk.clash.net');

    const hy2Node = nodes.find((n) => n.type === 'hysteria2');
    assert.ok(hy2Node);
    assert.strictEqual(hy2Node.server, 'sg.clash.net');
  });

  it('应当从 Sing-box JSON 中过滤并提取代理出站节点', () => {
    const nodes = parseJsonConfig(SAMPLE_SINGBOX_JSON);
    assert.strictEqual(nodes.length, 2, '应当忽略 direct 出站，只提取 2 个代理节点');
    assert.strictEqual(nodes[0].type, 'vless');
    assert.strictEqual(nodes[1].type, 'ss');
  });
});

describe('7. 智能导入中心统一调度与 Base64 订阅包解析', () => {
  it('应当自动识别并递归解包 Base64 订阅包，成功提取 10 个跨协议节点', () => {
    const result = smartParse(SAMPLE_BASE64_SUBSCRIPTION);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.format, 'base64-blob');
    assert.strictEqual(result.nodes.length, 10);
    assert.strictEqual(result.errors.length, 0);

    const types = new Set(result.nodes.map((n) => n.type));
    assert.ok(types.has('vmess'));
    assert.ok(types.has('vless'));
    assert.ok(types.has('ss'));
    assert.ok(types.has('trojan'));
    assert.ok(types.has('hysteria2'));
    assert.ok(types.has('tuic'));
    assert.ok(types.has('wireguard'));
  });

  it('应当容忍异常错误行并准确输出错误报告，而不导致全局崩溃', () => {
    const mixedInput = `${SAMPLE_VMESS_WS}\ncorrupted://invalid-link-content\n${SAMPLE_VLESS_REALITY}\nss://invalid-base64-info`;
    const result = smartParse(mixedInput);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodes.length, 2, '应当成功解析出 2 个有效节点');
    assert.strictEqual(result.errors.length, 2, '应当精准收集 2 个错误行');
    assert.strictEqual(result.errors[0].line, 2);
    assert.strictEqual(result.errors[1].line, 4);
  });

  it('应当通过 smartParse 成功识别用户反馈的 Base64 复合 authority VLESS Reality 节点', () => {
    const result = smartParse(SAMPLE_USER_VLESS_REALITY_BASE64);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodes.length, 1);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.nodes[0].name, 'vless+reality-圣何塞');
    assert.strictEqual(result.nodes[0].server, '198.51.100.10');
    assert.strictEqual(result.nodes[0].port, 17626);
  });
});

describe('8. 节点去重与命名冲突处理测试', () => {
  it('应当过滤重复指纹节点并为重名节点添加数字编号', () => {
    const node1 = parseSingleUri(SAMPLE_VLESS_REALITY);
    const node2 = parseSingleUri(SAMPLE_VLESS_REALITY); // 完全重复
    const node3 = { ...parseSingleUri(SAMPLE_VLESS_GRPC), name: node1.name }; // 同名但不同服务器

    const deduped = deduplicateNodes([node1, node2, node3]);
    assert.strictEqual(deduped.length, 2, '重复节点应当被剔除');
    assert.strictEqual(deduped[0].name, node1.name);
    assert.strictEqual(deduped[1].name, `${node1.name} (2)`, '同名节点应自动添加序号后缀');
  });
});

describe('9. Mihomo (Clash Meta) 标准配置转换测试', () => {
  it('应当将解析出的 VLESS Reality 节点正确转换为标准 Mihomo 字典', () => {
    const node = parseVless(SAMPLE_VLESS_REALITY);
    const mihomoConfig = proxyNodeToMihomo(node);

    assert.strictEqual(mihomoConfig.name, node.name);
    assert.strictEqual(mihomoConfig.type, 'vless');
    assert.strictEqual(mihomoConfig.server, 'us.reality.net');
    assert.strictEqual(mihomoConfig.port, 443);
    assert.strictEqual(mihomoConfig.tls, true);
    assert.strictEqual(mihomoConfig.flow, 'xtls-rprx-vision');
    assert.strictEqual(mihomoConfig['client-fingerprint'], 'chrome');
    assert.strictEqual(
      mihomoConfig['reality-opts']['public-key'],
      'O2xZgL7b3K5q-X12vN3Y8u9I_P0kL4mJ7nH6gF5dE4s'
    );
  });

  it('应当将解析出的 Hysteria 2 节点正确转换为标准 Mihomo 字典', () => {
    const node = parseHysteria2(SAMPLE_HYSTERIA2_OBFS);
    const mihomoConfig = proxyNodeToMihomo(node);

    assert.strictEqual(mihomoConfig.type, 'hysteria2');
    assert.strictEqual(mihomoConfig.password, 'ultraAuthKey');
    assert.strictEqual(mihomoConfig.obfs, 'salamander');
    assert.strictEqual(mihomoConfig['obfs-password'], 'hy2ObfsPass123');
    assert.strictEqual(mihomoConfig.ports, '20000-40000');
  });
});

describe('10. Batch 6 解析与配置生成安全加固专项测试', () => {
  it('1. SS URI 包含 plugin=v2ray-plugin;path=/ws 时不再被 / 截断', () => {
    const uri = `ss://${safeBase64Encode('aes-256-gcm:pass123')}@ss-ws.example.com:8388?plugin=v2ray-plugin;mode=websocket;path=/ws#SS-WS`;
    const node = parseShadowsocks(uri);
    assert.strictEqual(node.server, 'ss-ws.example.com');
    assert.strictEqual(node.port, 8388);
    assert.strictEqual(node.name, 'SS-WS');
    const cfg = node.protocolConfig as any;
    assert.strictEqual(cfg.plugin, 'v2ray-plugin');
    assert.strictEqual(cfg.pluginOpts, 'mode=websocket;path=/ws');
  });

  it('2. IPv6 Shadowsocks URI (SIP002 与传统 Base64 格式) 正常解析且严格校验端口与括号', () => {
    const sip002Ipv6 = `ss://${safeBase64Encode('chacha20-ietf-poly1305:secret')}@[2001:db8::1]:8388/?plugin=v2ray-plugin;path=/v6#IPv6-SS`;
    const node1 = parseShadowsocks(sip002Ipv6);
    assert.strictEqual(node1.server, '2001:db8::1');
    assert.strictEqual(node1.port, 8388);
    assert.strictEqual((node1.protocolConfig as any).pluginOpts, 'path=/v6');

    const legacyIpv6 = `ss://${safeBase64Encode('aes-128-gcm:secret@[2001:db8::2]:9443')}#Legacy-IPv6`;
    const node2 = parseShadowsocks(legacyIpv6);
    assert.strictEqual(node2.server, '2001:db8::2');
    assert.strictEqual(node2.port, 9443);

    assert.throws(
      () => parseShadowsocks(`ss://${safeBase64Encode('aes-128-gcm:secret')}@[2001:db8::1]#NoPort`),
      /端口号/
    );
  });

  it('3. 双重与三重嵌套 Base64 订阅可通过 isLikelyBase64 与 smartParse 正常解码，且超过上限安全停止', () => {
    const doubleEncoded = safeBase64Encode(SAMPLE_BASE64_SUBSCRIPTION);
    assert.strictEqual(isLikelyBase64(doubleEncoded), true, '双重 Base64 订阅必须被识别为合法 Base64');

    const parsedDouble = smartParse(doubleEncoded);
    assert.strictEqual(parsedDouble.success, true);
    assert.strictEqual(parsedDouble.format, 'base64-blob');
    assert.strictEqual(parsedDouble.nodes.length, 10);

    const tripleEncoded = safeBase64Encode(doubleEncoded);
    const parsedTriple = smartParse(tripleEncoded);
    assert.strictEqual(parsedTriple.success, true);
    assert.strictEqual(parsedTriple.nodes.length, 10);

    // 超过递归上限 (6 层 > MAX_BASE64_SNIFF_DEPTH=5) 安全返回 false 不死循环
    let deep = SAMPLE_BASE64_SUBSCRIPTION;
    for (let i = 0; i < 6; i++) {
      deep = safeBase64Encode(deep);
    }
    assert.strictEqual(isLikelyBase64(deep), false);
  });

  it('4. proxyNodeToMihomo 阻断 __proto__/constructor 原型污染与核心字段篡改，并拒绝缺省假凭证', () => {
    const maliciousRaw = JSON.parse(
      '{"__proto__":{"pollutedBatch6":"yes"},"constructor":{"prototype":{"evil":true}},"server":"attacker.invalid","port":9999,"external-controller":"0.0.0.0:9099","dialer-proxy":"RelayGroup","ws-opts":{"path":"/ok","__proto__":{"nestedPolluted":"yes"}}}'
    );

    const mihomoDict = proxyNodeToMihomo({
      id: 'custom-1',
      name: 'CustomSafe',
      type: 'custom-type' as any,
      server: 'origin.example.com',
      port: 443,
      rawConfig: maliciousRaw,
    });

    assert.strictEqual(({} as any).pollutedBatch6, undefined, 'Object.prototype 绝不能被污染');
    assert.strictEqual(({} as any).evil, undefined, 'constructor.prototype 绝不能被污染');
    assert.strictEqual(mihomoDict.server, 'origin.example.com', 'rawConfig 不得覆盖核心 server 字段');
    assert.strictEqual(mihomoDict.port, 443, 'rawConfig 不得覆盖核心 port 字段');
    assert.strictEqual(mihomoDict['external-controller'], undefined, '非白名单危险字段必须被过滤');
    assert.strictEqual(mihomoDict['dialer-proxy'], 'RelayGroup', '白名单扩展字段应正常保留');
    assert.strictEqual(mihomoDict['ws-opts'].path, '/ok');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(mihomoDict['ws-opts'], '__proto__'), false);

    // 缺失必选认证字段时拒绝生成假默认值 ('00000000-...' / 'mockpassword123')
    assert.throws(
      () => proxyNodeToMihomo({ id: 'bad-vless', name: 'BadVless', type: 'vless', server: '1.1.1.1', port: 443 }),
      /缺少必需的 uuid/
    );
    assert.throws(
      () => proxyNodeToMihomo({ id: 'bad-ss', name: 'BadSS', type: 'ss', server: '1.1.1.1', port: 8388 }),
      /缺少必需的 password/
    );
    assert.throws(
      () => proxyNodeToMihomo({ id: 'bad-trojan', name: 'BadTrojan', type: 'trojan', server: '1.1.1.1', port: 443 }),
      /缺少必需的 password/
    );
    assert.throws(
      () => proxyNodeToMihomo({ id: 'bad-hy2', name: 'BadHy2', type: 'hysteria2', server: '1.1.1.1', port: 443 }),
      /缺少必需的 password\/auth/
    );
    assert.throws(
      () => proxyNodeToMihomo({ id: 'bad-wg', name: 'BadWG', type: 'wireguard', server: '1.1.1.1', port: 51820 }),
      /缺少必需的 privateKey/
    );
  });

  it('5. Reality spiderX 参数应从 URI 解析并完整透传至 reality-opts.spider-x', () => {
    const node = parseVless(SAMPLE_CF_CLEAN_IP_VLESS_REALITY);
    assert.strictEqual((node.protocolConfig as any).reality?.spiderX, '/HesarWeb');

    const mihomoConfig = proxyNodeToMihomo(node);
    assert.strictEqual(mihomoConfig['reality-opts']['spider-x'], '/HesarWeb');
  });
});
