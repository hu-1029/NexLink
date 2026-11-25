import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateService, isValidGithubReleaseUrl, extractSha256FromText } from '../../src/main/services/updater';
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

    // 恶意与非官方域名必须彻底拦截
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
});
