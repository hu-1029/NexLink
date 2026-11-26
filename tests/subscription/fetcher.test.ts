import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import {
  assertSafeRemoteSubscriptionUrl,
  fetchSubscription,
  fetchTextWithLimit,
  parseSubscriptionUserInfo,
} from '../../src/main/subscription/fetcher';
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

  it('7. Batch 5 SSRF 防护：拦截回环/私网/云元数据 IP、IPv6 映射地址、本地域名、DNS 私有解析及 302 内网重定向', async () => {
    const blockedUrls = [
      'http://127.0.0.1:8080/sub',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal',
      'http://172.16.5.4/internal',
      'http://192.168.1.1/router',
      'http://100.64.0.1/cgnat',
      'http://[::1]:8080/sub',
      'http://[::ffff:127.0.0.1]/sub',
      'http://[::ffff:169.254.169.254]/sub',
      'http://[fe80::1]/sub',
      'http://[fc00::1]/sub',
      'http://0x7f.0.0.1/sub',
      'http://localhost:9090/sub',
      'http://metadata.internal/sub',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'ftp://example.com/sub',
    ];

    for (const blocked of blockedUrls) {
      await assert.rejects(
        () => assertSafeRemoteSubscriptionUrl(blocked),
        /安全拦截|不支持|仅支持/,
        `必须拦截 SSRF 危险地址: ${blocked}`
      );
    }

    // 域名解析出私网 IP（DNS Rebinding / 内网域名）也必须拦截
    await assert.rejects(
      () =>
        assertSafeRemoteSubscriptionUrl('https://sub.example.com/v1', false, async () => [
          { address: '10.10.0.5', family: 4 },
        ]),
      /安全拦截/
    );

    // 公网域名解析出公网 IP 应正常放行
    const safeParsed = await assertSafeRemoteSubscriptionUrl(
      'https://sub.example.com/v1',
      false,
      async () => [{ address: '93.184.216.34', family: 4 }]
    );
    assert.strictEqual(safeParsed.hostname, 'sub.example.com');

    // fetchSubscription 对远程内网地址直接返回安全拦截，不发起网络请求也不重试
    const directRes = await fetchSubscription('http://169.254.169.254/latest/meta-data/', {
      retries: 0,
      timeoutMs: 500,
    });
    assert.strictEqual(directRes.success, false);
    assert.match(directRes.error || '', /安全拦截/);

    // 模拟公网入口 302 重定向到 169.254.169.254：validateUrl 回调必须在第二跳精准拦截
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    try {
      let hopCount = 0;
      await assert.rejects(
        () =>
          fetchTextWithLimit(
            `http://127.0.0.1:${port}/redir`,
            {},
            0,
            1000,
            1024 * 1024,
            10,
            async (targetUrl) => {
              hopCount++;
              // 第一跳允许本地模拟入口，第二跳起严格执行正式 SSRF 校验
              await assertSafeRemoteSubscriptionUrl(targetUrl, hopCount === 1);
            }
          ),
        /安全拦截/
      );
      assert.strictEqual(hopCount, 2, '重定向第二跳必须触发校验并在请求内网前中断');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('8. TUN Fake-IP 兼容性：仅在 allowFakeIpRange=true 且为域名解析结果时放行 198.18.0.0/16，字面 IP 与其他私网仍严格拦截', async () => {
    // 1) 未开启 TUN Fake-IP (allowFakeIpRange=false) 时，域名解析返回 198.18.x.x 必须按保留地址拦截
    await assert.rejects(
      () =>
        assertSafeRemoteSubscriptionUrl(
          'https://sub.example.com/v1',
          false,
          async () => [{ address: '198.18.0.5', family: 4 }],
          false
        ),
      /安全拦截/
    );

    // 2) 开启 TUN Fake-IP (allowFakeIpRange=true) 时，公网域名解析出 198.18.0.5 应正常放行
    const fakeIpAllowed = await assertSafeRemoteSubscriptionUrl(
      'https://sub.example.com/v1',
      false,
      async () => [{ address: '198.18.0.5', family: 4 }],
      true
    );
    assert.strictEqual(fakeIpAllowed.hostname, 'sub.example.com');

    // 3) 即使处于 Fake-IP 运行态，若 URL 本身是字面 198.18.x.x IP，仍必须严格拦截
    await assert.rejects(
      () => assertSafeRemoteSubscriptionUrl('http://198.18.0.1/admin', false, undefined, true),
      /安全拦截/
    );

    // 4) 即使处于 Fake-IP 运行态，域名解析返回 198.19.x.x 或 127.0.0.1 / 10.x / 169.254.169.254 / ::1 仍必须严格拦截
    for (const badResolvedIp of ['198.19.0.1', '127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
      await assert.rejects(
        () =>
          assertSafeRemoteSubscriptionUrl(
            'https://sub.example.com/v1',
            false,
            async () => [{ address: badResolvedIp, family: badResolvedIp.includes(':') ? 6 : 4 }],
            true
          ),
        /安全拦截/,
        `Fake-IP 模式下仍应严格拦截非 198.18/16 的私有/保留地址: ${badResolvedIp}`
      );
    }

    // 5) fetchSubscription 入口透传 allowFakeIpRange 与 lookupFn 行为一致（字面 198.18 仍阻断）
    const literalRes = await fetchSubscription('http://198.18.0.1/admin', {
      retries: 0,
      timeoutMs: 500,
      allowFakeIpRange: true,
    });
    assert.strictEqual(literalRes.success, false);
    assert.match(literalRes.error || '', /安全拦截/);
  });
});
