import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleFileContent, normalizeRuleLine } from '../../src/services/parser/rule-parser';

describe('分流规则解析器测试 (Rule Parser Tests)', () => {
  it('1. 单行规则标准化转换', () => {
    assert.strictEqual(
      normalizeRuleLine('DOMAIN-SUFFIX,google.com,PROXY'),
      'DOMAIN-SUFFIX,google.com,🚀 节点选择'
    );
    assert.strictEqual(
      normalizeRuleLine('DOMAIN,github.com,DIRECT'),
      'DOMAIN,github.com,DIRECT'
    );
    assert.strictEqual(
      normalizeRuleLine('IP-CIDR,10.0.0.0/8,REJECT'),
      'IP-CIDR,10.0.0.0/8,REJECT'
    );
    assert.strictEqual(
      normalizeRuleLine('+.youtube.com'),
      'DOMAIN-SUFFIX,youtube.com,🚀 节点选择'
    );
    assert.strictEqual(
      normalizeRuleLine('twitter.com'),
      'DOMAIN-SUFFIX,twitter.com,🚀 节点选择'
    );
    assert.strictEqual(normalizeRuleLine('# 注释行'), null);
  });

  it('2. YAML rules 列表解析', () => {
    const yamlContent = `
rules:
  - DOMAIN-SUFFIX,google.com,PROXY
  - DOMAIN-KEYWORD,google,DIRECT
  - IP-CIDR,192.168.1.0/24,DIRECT
  - GEOSITE,category-ads-all,REJECT
`;
    const rules = parseRuleFileContent(yamlContent);
    assert.strictEqual(rules.length, 4);
    assert.ok(rules.includes('DOMAIN-SUFFIX,google.com,🚀 节点选择'));
    assert.ok(rules.includes('DOMAIN-KEYWORD,google,DIRECT'));
    assert.ok(rules.includes('IP-CIDR,192.168.1.0/24,DIRECT'));
    assert.ok(rules.includes('GEOSITE,category-ads-all,REJECT'));
  });

  it('3. YAML payload (Rule Provider) 列表解析', () => {
    const payloadYaml = `
payload:
  - '+.google.com'
  - '+.googleapis.com'
  - 'DOMAIN-SUFFIX,gstatic.com'
  - '1.1.1.1/32'
`;
    const rules = parseRuleFileContent(payloadYaml);
    assert.strictEqual(rules.length, 4);
    assert.ok(rules.includes('DOMAIN-SUFFIX,google.com,🚀 节点选择'));
    assert.ok(rules.includes('DOMAIN-SUFFIX,googleapis.com,🚀 节点选择'));
    assert.ok(rules.includes('DOMAIN-SUFFIX,gstatic.com,🚀 节点选择'));
    assert.ok(rules.includes('IP-CIDR,1.1.1.1/32,🚀 节点选择'));
  });

  it('4. Surge / Shadowrocket .conf 格式解析', () => {
    const confContent = `
# Surge ruleset
[Rule]
DOMAIN-SUFFIX,apple.com,DIRECT
DOMAIN-KEYWORD,test,REJECT
IP-CIDR,17.0.0.0/8,DIRECT,no-resolve
USER-AGENT,*YouTube*,Proxy
`;
    const rules = parseRuleFileContent(confContent);
    assert.strictEqual(rules.length, 3);
    assert.ok(rules.includes('DOMAIN-SUFFIX,apple.com,DIRECT'));
    assert.ok(rules.includes('DOMAIN-KEYWORD,test,REJECT'));
    assert.ok(rules.includes('IP-CIDR,17.0.0.0/8,DIRECT,no-resolve'));
  });

  it('5. 纯文本 / ACL4SSR 纯域名列表 (.list / .txt) 解析', () => {
    const textContent = `
# 广告拦截列表
adservice.google.com
analytics.google.com
doubleclick.net
`;
    const rules = parseRuleFileContent(textContent, 'REJECT');
    assert.strictEqual(rules.length, 3);
    assert.ok(rules.includes('DOMAIN-SUFFIX,adservice.google.com,REJECT'));
    assert.ok(rules.includes('DOMAIN-SUFFIX,analytics.google.com,REJECT'));
    assert.ok(rules.includes('DOMAIN-SUFFIX,doubleclick.net,REJECT'));
  });
});
