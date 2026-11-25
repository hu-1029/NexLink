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

  it('3. 本地文件订阅抓取：读取受控 profiles/ 目录内的真实 Base64 订阅文件并完成解析', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_sub_base_'));
    const profilesDir = path.join(baseDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const tempFile = path.join(profilesDir, 'sub1.txt');
    fs.writeFileSync(tempFile, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

    try {
      const result = await fetchSubscription(
        { id: 'local-1', name: 'local-1', type: 'local', filePath: tempFile, nodeCount: 0, updatedAt: '', status: 'ok' },
        { allowedBaseDir: baseDir }
      );
      assert.strictEqual(result.success, true);
      assert.ok(result.nodes.length >= 8);
      assert.strictEqual(result.userInfo, undefined); // 本地文件无 HTTP header，诚实返回 undefined
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('4. 不存在的本地文件抓取应优雅返回错误报告，不抛出未捕获异常', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_sub_missing_'));
    const profilesDir = path.join(baseDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const nonExistent = path.join(profilesDir, `non_existent_file_${Date.now()}.yaml`);
    try {
      const result = await fetchSubscription(
        { id: 'local-missing', name: 'missing', type: 'local', filePath: nonExistent, nodeCount: 0, updatedAt: '', status: 'ok' },
        { allowedBaseDir: baseDir }
      );
      assert.strictEqual(result.success, false);
      assert.ok(result.error !== undefined);
      assert.strictEqual(result.nodes.length, 0);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('5. P0-3 防御：拒绝 local 订阅通过 url 字段、../ 穿越或目录软链接/Junction 读取受控目录外文件', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_sub_sec_'));
    const profilesDir = path.join(baseDir, 'profiles');
    const outsideDir = path.join(baseDir, 'outside');
    const evilPrefixDir = path.join(baseDir, 'profiles-evil');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(evilPrefixDir, { recursive: true });

    const outsideSecret = path.join(outsideDir, 'secret.txt');
    const evilPrefixSecret = path.join(evilPrefixDir, 'secret.txt');
    fs.writeFileSync(outsideSecret, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');
    fs.writeFileSync(evilPrefixSecret, SAMPLE_BASE64_SUBSCRIPTION, 'utf8');

    try {
      // 1) local 类型传入 url 试图读取外部文件 -> 必须拦截
      const viaUrlRes = await fetchSubscription(
        { id: 'evil-url', name: 'evil-url', type: 'local', url: outsideSecret, nodeCount: 0, updatedAt: '', status: 'ok' },
        { allowedBaseDir: baseDir }
      );
      assert.strictEqual(viaUrlRes.success, false);
      assert.match(viaUrlRes.error || '', /安全拦截/);

      // 2) ../ 路径穿越读取 profiles 外文件 -> 必须拦截
      const traversalPath = path.join(profilesDir, '..', 'outside', 'secret.txt');
      const traversalRes = await fetchSubscription(
        { id: 'evil-trav', name: 'evil-trav', type: 'local', filePath: traversalPath, nodeCount: 0, updatedAt: '', status: 'ok' },
        { allowedBaseDir: baseDir }
      );
      assert.strictEqual(traversalRes.success, false);
      assert.match(traversalRes.error || '', /安全拦截/);

      // 3) profiles-evil 前缀绕过尝试 -> 必须拦截
      const prefixRes = await fetchSubscription(
        { id: 'evil-prefix', name: 'evil-prefix', type: 'local', filePath: evilPrefixSecret, nodeCount: 0, updatedAt: '', status: 'ok' },
        { allowedBaseDir: baseDir }
      );
      assert.strictEqual(prefixRes.success, false);
      assert.match(prefixRes.error || '', /安全拦截/);

      // 4) 软链接 / Windows Junction 逃逸 -> 必须被 realpathSync 拦截
      const linkDir = path.join(profilesDir, 'escape-link');
      let linkCreated = false;
      try {
        fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
        linkCreated = true;
      } catch {
        linkCreated = false;
      }
      if (linkCreated) {
        const escapedFile = path.join(linkDir, 'secret.txt');
        const symlinkRes = await fetchSubscription(
          { id: 'evil-link', name: 'evil-link', type: 'local', filePath: escapedFile, nodeCount: 0, updatedAt: '', status: 'ok' },
          { allowedBaseDir: baseDir }
        );
        assert.strictEqual(symlinkRes.success, false);
        assert.match(symlinkRes.error || '', /安全拦截|逃逸/);
      }
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('6. ParseError[] 错误格式化：解析失败时输出可读文本，绝不输出 [object Object]', async () => {
    const res = await fetchSubscription({
      id: 'bad-raw',
      name: 'bad-raw',
      type: 'local',
      rawContent: 'vless://bad-node-without-at-or-port',
      nodeCount: 0,
      updatedAt: '',
      status: 'ok',
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error && res.error.length > 0);
    assert.strictEqual(res.error.includes('[object Object]'), false);
  });
});
