import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fetchSubscription, parseSubscriptionUserInfo } from '../../src/main/subscription/fetcher';
import { SAMPLE_BASE64_SUBSCRIPTION } from '../samples/samples';

describe('订阅抓取与解析 fetcher 单元测试', () => {
  it('1. 正确解析 commercial subscription-userinfo 响应头', () => {
    const rawHeader = 'upload=1073741824; download=5368709120; total=107374182400; expire=1793500000';
    const info = parseSubscriptionUserInfo(rawHeader);

    assert.ok(info !== undefined);
    assert.strictEqual(info?.upload, 1073741824);
    assert.strictEqual(info?.download, 5368709120);
    assert.strictEqual(info?.total, 107374182400);
    assert.strictEqual(info?.expire, 1793500000);
    assert.ok(info?.expireDate.startsWith('2026-'));
  });

  it('2. 针对无头部或非法头部，安全返回 undefined，绝不伪造虚假数据', () => {
    assert.strictEqual(parseSubscriptionUserInfo(null), undefined);
    assert.strictEqual(parseSubscriptionUserInfo(undefined), undefined);
    assert.strictEqual(parseSubscriptionUserInfo(''), undefined);
    assert.strictEqual(parseSubscriptionUserInfo('invalid-content-header'), undefined);
  });

  it('3. 本地文件订阅抓取：读取真实 Base64 订阅文件并完成解析', async () => {
    const tempFile = path.join(os.tmpdir(), `nexlink_sub_${Date.now()}.txt`);
    fs.writeFileSync(tempFile, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

    try {
      const result = await fetchSubscription(tempFile);
      assert.strictEqual(result.success, true);
      assert.ok(result.nodes.length >= 8);
      assert.strictEqual(result.userInfo, undefined); // 本地文件无 HTTP header，诚实返回 undefined
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });

  it('4. 不存在的本地文件抓取应优雅返回错误报告，不抛出未捕获异常', async () => {
    const nonExistent = path.join(os.tmpdir(), `non_existent_file_${Date.now()}.yaml`);
    const result = await fetchSubscription(nonExistent);
    assert.strictEqual(result.success, false);
    assert.ok(result.error !== undefined);
    assert.strictEqual(result.nodes.length, 0);
  });
});
