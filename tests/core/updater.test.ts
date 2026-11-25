import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  UpdateService,
  fetchWithSafeRedirects,
  isValidGithubReleaseUrl,
  extractSha256FromText,
} from '../../src/main/services/updater';
import { StorageManager } from '../../src/main/storage/store';

describe('软件版本检测与自动更新管理器测试 (Updater Tests)', () => {
  const updater = new UpdateService();

  test('1. 语义化版本比对 (compareVersions) 逻辑准确无误', () => {
    // 基础递增比对
    assert.ok(updater.compareVersions('0.2.0', '0.1.0') > 0, '0.2.0 应当大于 0.1.0');
    assert.ok(updater.compareVersions('1.0.0', '0.9.9') > 0, '1.0.0 应当大于 0.9.9');
    assert.ok(updater.compareVersions('0.1.1', '0.1.0') > 0, '0.1.1 应当大于 0.1.0');

    // 等价比对与带 v 前缀
    assert.strictEqual(updater.compareVersions('v0.1.0', '0.1.0'), 0, '带 v 前缀与无前缀应当等价');
    assert.strictEqual(updater.compareVersions('0.1.0', '0.1.0'), 0, '相同版本比对返回 0');
    assert.strictEqual(updater.compareVersions('v1.2.3', 'V1.2.3'), 0, '大小写 V 应当忽略');

    // 逆序比对
    assert.ok(updater.compareVersions('0.1.0', '0.2.0') < 0, '0.1.0 应当小于 0.2.0');
    assert.ok(updater.compareVersions('0.9.9', '1.0.0') < 0, '0.9.9 应当小于 1.0.0');

    // 预发布版本标签比对 (正式版大于预发布版)
    assert.ok(updater.compareVersions('0.2.0', '0.2.0-beta.1') > 0, '正式版 0.2.0 应当大于 0.2.0-beta.1');
    assert.ok(updater.compareVersions('0.2.0-beta.2', '0.2.0-beta.1') > 0, 'beta.2 应当大于 beta.1');
  });

  test('2. 模拟检查更新正确识别高版本与结构字段完整性', async () => {
    const res = await updater.checkUpdate({
      mockUpdate: true,
      mockVersion: '0.2.0',
    });

    assert.strictEqual(res.hasUpdate, true, '高版本应当返回 hasUpdate = true');
    assert.strictEqual(res.latestVersion, '0.2.0', '最新版本号必须正确映射');
    assert.ok(res.downloadUrl && res.downloadUrl.includes('.exe'), '必须包含 Windows 安装包下载 URL');
    assert.ok(res.releaseNotes && res.releaseNotes.length > 0, '必须包含更新日志说明');
    assert.ok(res.assetSize && res.assetSize > 0, '必须包含有效的文件大小估计');
  });

  test('3. 当前版本为最新时正确返回 hasUpdate = false', async () => {
    const current = updater.getCurrentVersion();
    const res = await updater.checkUpdate({
      mockUpdate: true,
      mockVersion: current,
    });

    assert.strictEqual(res.hasUpdate, false, '版本相同时应当返回 hasUpdate = false');
  });

  test('4. 异常与取消下载安全兜底，不抛出未捕获崩溃', async () => {
    // 未初始化下载时取消返回 false
    assert.strictEqual(updater.cancelDownload(), false, '未在下载时取消应安全返回 false');

    // 非法链接下载返回明确错误报告
    const dlRes = await updater.downloadUpdate('http://127.0.0.1:59999/invalid-update-test.exe');
    assert.strictEqual(dlRes.success, false, '非法或离线地址必须安全返回失败报告');
    assert.ok(typeof dlRes.error === 'string', '错误报告必须包含友好错误文本');
  });

  test('5. AppSettings 持久化正确保存 autoUpdate、autoCheckUpdate 与 lastCheckUpdateAt', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_update_store_'));
    const store = new StorageManager(tempDir);

    const initialSettings = store.getSettings();
    assert.strictEqual(initialSettings.autoUpdate, true, '默认自动更新必须为 true');
    assert.strictEqual(initialSettings.autoCheckUpdate, true, '默认自动检查更新必须为 true');

    const checkTimestamp = 1794138800000;
    store.saveSettings({
      autoUpdate: false,
      autoCheckUpdate: false,
      lastCheckUpdateAt: checkTimestamp,
    });

    const updatedSettings = store.getSettings();
    assert.strictEqual(updatedSettings.autoUpdate, false, 'autoUpdate 关闭后应正确持久化');
    assert.strictEqual(updatedSettings.autoCheckUpdate, false, 'autoCheckUpdate 关闭后应正确持久化');
    assert.strictEqual(updatedSettings.lastCheckUpdateAt, checkTimestamp, 'lastCheckUpdateAt 必须准确保存');

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('6. GitHub 下载地址安全白名单校验 (isValidGithubReleaseUrl)', () => {
    // 合法 GitHub 官方域名
    assert.strictEqual(
      isValidGithubReleaseUrl('https://github.com/NexLink-App/NexLink/releases/download/v0.2.0/NexLink.exe'),
      true,
      'github.com 主域名应当允许'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/NexLink.exe'),
      true,
      'objects.githubusercontent.com 应当允许'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://raw.githubusercontent.com/NexLink-App/NexLink/main/NexLink.exe'),
      true,
      'raw.githubusercontent.com 应当允许'
    );

    // 恶意与非官方/泛子域必须彻底拦截
    assert.strictEqual(
      isValidGithubReleaseUrl('https://release-assets.githubusercontent.com/github-production-release-asset/123/NexLink.exe'),
      true,
      'release-assets.githubusercontent.com 应当允许'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://gist.github.com/attacker/123/NexLink.exe'),
      false,
      'gist.github.com 非法子域必须拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://user-images.githubusercontent.com/123/NexLink.exe'),
      false,
      'user-images.githubusercontent.com 非法子域必须拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('http://github.com/NexLink.exe'),
      false,
      'HTTP 明文传输应拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://evil-github.com/NexLink.exe'),
      false,
      '钓鱼域名 evil-github.com 应拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('https://github.com.attacker.site/NexLink.exe'),
      false,
      '以 github 开头的攻击者二级域应拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl('file:///C:/Windows/System32/cmd.exe'),
      false,
      '本地 file 协议必须拦截'
    );
    assert.strictEqual(
      isValidGithubReleaseUrl(''),
      false,
      '空地址必须拦截'
    );
  });

  test('7. SHA256 完整性哈希提取逻辑准确性 (extractSha256FromText)', () => {
    const testHash = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';

    // 格式 1: sha256sum 输出格式 "<hash>  filename"
    const sumText = `${testHash}  NexLink-Setup-0.2.0.exe`;
    assert.strictEqual(extractSha256FromText(sumText, 'NexLink-Setup-0.2.0.exe'), testHash);

    // 格式 2: Release body 键值对格式 "SHA256: <hash>"
    const bodyText = `### Release v0.2.0\nSHA256: ${testHash}\nEnjoy!`;
    assert.strictEqual(extractSha256FromText(bodyText), testHash);

    // 格式 3: 纯哈希单行
    assert.strictEqual(extractSha256FromText(testHash), testHash);

    // 格式 4: 非法/不完整字符串安全返回 undefined
    assert.strictEqual(extractSha256FromText('not-a-hash'), undefined);
    assert.strictEqual(extractSha256FromText(''), undefined);
  });

  test('8. 安装接口安全隔离：拒绝执行外部任意传入路径', async () => {
    // 尚未下载通过完整性校验的文件时，传入外部路径必须被拒绝
    const res = await updater.installUpdate('C:\\Windows\\System32\\calc.exe');
    assert.strictEqual(res.success, false, '未通过完整性校验的文件必须拒绝安装');
    assert.ok(res.error?.includes('未找到或未通过完整性校验'), '应当返回安全拦截提示');
  });

  test('9. 语义化版本对预发布版 (Pre-release) 的准确识别与比对', () => {
    // 0.2.0 预发布版高于当前 0.1.0
    assert.ok(updater.compareVersions('0.2.0-beta.1', '0.1.0') > 0, '0.2.0-beta.1 应高于 0.1.0');
    assert.ok(updater.compareVersions('0.2.0-rc.2', '0.2.0-rc.1') > 0, 'rc.2 应高于 rc.1');
    assert.ok(updater.compareVersions('0.2.0', '0.2.0-rc.2') > 0, '正式版应高于候选版');
  });

  test('10. P0-4 & 3xx 防御：fetchWithSafeRedirects 拦截非白名单跳转并放行官方 CDN 跳转', async () => {
    // 1) 跳转到官方 objects.githubusercontent.com -> 放行
    const okRes = await fetchWithSafeRedirects(
      'https://github.com/hu-1029/NexLink/releases/download/v0.2.0/Windows-NexLink-Setup.exe',
      {},
      {
        fetchFn: (async (url: string) => {
          if (url.startsWith('https://github.com/')) {
            return new Response(null, {
              status: 302,
              headers: {
                location: 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/abc/setup.exe',
              },
            });
          }
          return new Response('OK_PAYLOAD', { status: 200 });
        }) as unknown as typeof fetch,
      }
    );
    assert.strictEqual(okRes.status, 200);
    assert.strictEqual(await okRes.text(), 'OK_PAYLOAD');

    // 2) 302 跳转到恶意域名 -> 必须拦截
    await assert.rejects(
      () =>
        fetchWithSafeRedirects(
          'https://github.com/hu-1029/NexLink/releases/download/v0.2.0/Windows-NexLink-Setup.exe',
          {},
          {
            fetchFn: (async () =>
              new Response(null, {
                status: 302,
                headers: { location: 'https://evil-cdn.attacker.com/trojan.exe' },
              })) as unknown as typeof fetch,
          }
        ),
      /不在官方白名单内/
    );

    // 3) 302 降级跳转到 http:// -> 必须拦截
    await assert.rejects(
      () =>
        fetchWithSafeRedirects(
          'https://github.com/hu-1029/NexLink/releases/download/v0.2.0/Windows-NexLink-Setup.exe',
          {},
          {
            fetchFn: (async () =>
              new Response(null, {
                status: 302,
                headers: { location: 'http://github.com/downgraded.exe' },
              })) as unknown as typeof fetch,
          }
        ),
      /不在官方白名单内/
    );
  });

  test('11. P0-4 Fail-Closed 与 Pre-release 过滤：无 SHA-256 或拉取校验文件失败直接拒绝更新，默认过滤预发布版', async () => {
    const svc = new UpdateService();
    const releases = [
      {
        tag_name: 'v9.9.0-beta.1',
        name: 'v9.9.0-beta.1',
        draft: false,
        prerelease: true,
        html_url: 'https://github.com/hu-1029/NexLink/releases/tag/v9.9.0-beta.1',
        body: 'SHA256: ' + 'a'.repeat(64),
        assets: [
          {
            name: 'Windows-NexLink-Setup.exe',
            browser_download_url: 'https://github.com/hu-1029/NexLink/releases/download/v9.9.0-beta.1/Windows-NexLink-Setup.exe',
            size: 1024,
          },
        ],
      },
      {
        tag_name: 'v9.8.0',
        name: 'v9.8.0',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/hu-1029/NexLink/releases/tag/v9.8.0',
        body: 'No hash here',
        assets: [
          {
            name: 'Windows-NexLink-Setup.exe',
            browser_download_url: 'https://github.com/hu-1029/NexLink/releases/download/v9.8.0/Windows-NexLink-Setup.exe',
            size: 1024,
          },
          {
            name: 'Windows-NexLink-Setup.exe.sha256',
            browser_download_url: 'https://github.com/hu-1029/NexLink/releases/download/v9.8.0/Windows-NexLink-Setup.exe.sha256',
            size: 128,
          },
        ],
      },
    ];

    // 1) 默认跳过 prerelease (v9.9.0-beta.1)，选定 v9.8.0；且当 .sha256 拉取失败时，Fail-Closed 拦截并保留 htmlUrl 供手动查看
    const failChecksumInfo = await svc.checkUpdate({
      repo: 'hu-1029/NexLink',
      fetchFn: (async (url: string) => {
        if (url.includes('/releases?')) {
          return new Response(JSON.stringify(releases), { status: 200 });
        }
        return new Response('Server Error', { status: 500 });
      }) as unknown as typeof fetch,
    });
    assert.strictEqual(failChecksumInfo.latestVersion, '9.8.0', '默认不得选中 pre-release 版本');
    assert.strictEqual(failChecksumInfo.isPrerelease, false);
    assert.strictEqual(failChecksumInfo.downloadUrl, undefined, '校验文件拉取失败时必须清空 downloadUrl 阻止下载');
    assert.match(failChecksumInfo.error || '', /校验文件失败/);
    assert.strictEqual(failChecksumInfo.htmlUrl, 'https://github.com/hu-1029/NexLink/releases/tag/v9.8.0');

    // 直接调用 downloadUpdate（缺少 expectedSha256）同样必须 Fail-Closed 拒绝
    const dlBlocked = await svc.downloadUpdate(
      'https://github.com/hu-1029/NexLink/releases/download/v9.8.0/Windows-NexLink-Setup.exe'
    );
    assert.strictEqual(dlBlocked.success, false);
    assert.match(dlBlocked.error || '', /SHA-256/);

    // 2) 当包含有效 SHA-256 时，checkUpdate 正常返回 downloadUrl，且 downloadUpdate 校验体积上限与真实哈希
    const payload = Buffer.from('VALID_INSTALLER_BYTES');
    const validSha = crypto.createHash('sha256').update(payload).digest('hex');
    const okInfo = await svc.checkUpdate({
      repo: 'hu-1029/NexLink',
      fetchFn: (async (url: string) => {
        if (url.includes('/releases?')) {
          return new Response(
            JSON.stringify([
              {
                ...releases[1],
                assets: [
                  { ...releases[1].assets[0], digest: `sha256:${validSha}` },
                ],
              },
            ]),
            { status: 200 }
          );
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch,
    });
    assert.strictEqual(okInfo.error, undefined);
    assert.strictEqual(okInfo.expectedSha256, validSha);
    assert.ok(okInfo.downloadUrl);

    // 超出 maxBytes 上限必须被拦截
    const oversizeRes = await svc.downloadUpdate(undefined, undefined, {
      maxBytes: 4,
      fetchFn: (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch,
    });
    assert.strictEqual(oversizeRes.success, false);
    assert.match(oversizeRes.error || '', /安全上限/);

    // 哈希匹配时下载通过校验
    const dlOk = await svc.downloadUpdate(undefined, undefined, {
      fetchFn: (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch,
    });
    assert.strictEqual(dlOk.success, true);
    assert.strictEqual(dlOk.actualSha256, validSha);
    if (dlOk.filePath && fs.existsSync(dlOk.filePath)) {
      fs.unlinkSync(dlOk.filePath);
    }
  });
});
