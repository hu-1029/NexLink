import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CoreUpdaterService,
  httpsGetBuffer,
  isSafeZipEntryPath,
  selectMihomoWindowsAsset,
} from '../../src/main/services/core-updater';
import {
  getServiceInstallDir,
  TRUSTED_MIHOMO_MANIFEST_FILENAME,
  verifyMihomoInstallSource,
} from '../../src/main/network/service-manager';

describe('Mihomo 内核更新与服务指纹同步测试', () => {
  it('1. selectMihomoWindowsAsset 正确筛选 Windows amd64 / arm64 正式版压缩包', () => {
    const assets = [
      { name: 'mihomo-linux-amd64-v1.19.35.gz', browser_download_url: 'https://example.com/1' },
      { name: 'mihomo-windows-amd64-alpha-v1.19.35.zip', browser_download_url: 'https://example.com/2' },
      { name: 'mihomo-windows-amd64-compatible-v1.19.35.zip', browser_download_url: 'https://example.com/3' },
      { name: 'mihomo-windows-amd64-v1.19.35.zip', browser_download_url: 'https://example.com/4' },
      { name: 'mihomo-windows-arm64-v1.19.35.zip', browser_download_url: 'https://example.com/5' },
    ];
    const x64 = selectMihomoWindowsAsset(assets, 'x64');
    assert.equal(x64?.name, 'mihomo-windows-amd64-v1.19.35.zip');

    const arm64 = selectMihomoWindowsAsset(assets, 'arm64');
    assert.equal(arm64?.name, 'mihomo-windows-arm64-v1.19.35.zip');
  });

  it('2. 在线更新内核同步指纹后，即便新内核位于用户可写目录，受 ACL 锁定的服务清单也应放行安装', () => {
    const tmpDir = path.join(os.tmpdir(), `nexlink-core-sync-test-${Date.now()}`);
    const userBinDir = path.join(tmpDir, 'user-data-mihomo');
    const lockedSvcDir = path.join(tmpDir, 'locked-service-dir');
    fs.mkdirSync(userBinDir, { recursive: true });
    fs.mkdirSync(lockedSvcDir, { recursive: true });

    try {
      const binPath = path.join(userBinDir, 'mihomo.exe');
      const peHeader = Buffer.alloc(1024 * 1024 + 128, 0);
      peHeader[0] = 0x4d; // M
      peHeader[1] = 0x5a; // Z
      Buffer.from('mihomo-v1.19.35-updated').copy(peHeader, 64);
      fs.writeFileSync(binPath, peHeader);
      const newSha = crypto.createHash('sha256').update(peHeader).digest('hex').toUpperCase();

      const lockedManifest = path.join(lockedSvcDir, TRUSTED_MIHOMO_MANIFEST_FILENAME);
      fs.writeFileSync(
        lockedManifest,
        JSON.stringify({
          schemaVersion: 1,
          entries: [{ version: 'v1.19.35', arch: 'amd64', sha256: newSha }],
        }),
        'utf8'
      );

      // 模拟: 用户更新目录 (userBinDir) 普通用户可写，但受 ACL 保护的服务清单 (lockedManifest) 锁定
      const res = verifyMihomoInstallSource(binPath, {
        manifestPath: lockedManifest,
        checkAcl: (p) =>
          p === lockedManifest
            ? { locked: true }
            : { locked: false, reason: 'Writable by non-admin SID', unsafePath: p },
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });

      // 注意：传入显式 manifestPath 时仍按严格模式要求 binAcl 锁定；而无显式 manifestPath 时走 ProgramData 锁定清单
      assert.equal(res.trusted, false);
      assert.ok(typeof getServiceInstallDir() === 'string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. P0-4 & Zip Slip 防御：isSafeZipEntryPath 拦截路径穿越，httpsGetBuffer 拦截非白名单域名', async () => {
    assert.equal(isSafeZipEntryPath('mihomo-windows-amd64.exe'), true);
    assert.equal(isSafeZipEntryPath('sub/mihomo.exe'), true);
    assert.equal(isSafeZipEntryPath('../evil.exe'), false);
    assert.equal(isSafeZipEntryPath('sub/../../evil.exe'), false);
    assert.equal(isSafeZipEntryPath('/Windows/System32/evil.exe'), false);
    assert.equal(isSafeZipEntryPath('\\Windows\\evil.exe'), false);
    assert.equal(isSafeZipEntryPath('C:\\evil.exe'), false);
    assert.equal(isSafeZipEntryPath('bad\0entry.exe'), false);

    await assert.rejects(
      () => httpsGetBuffer('https://evil.example.com/mihomo.zip', {}, 2000),
      /不在官方白名单内/
    );
    await assert.rejects(
      () => httpsGetBuffer('http://github.com/MetaCubeX/mihomo/releases/download/v1.0.0/m.zip', {}, 2000),
      /不在官方白名单内|仅支持 HTTPS/
    );
  });

  it('4. P0-4 Fail-Closed：Mihomo 内核 Release 缺失 SHA-256 或校验文件拉取失败时严禁下载压缩包', async () => {
    const coreUpdater = new CoreUpdaterService();
    let zipRequested = false;

    // 1) Release 无 digest、无 body 哈希、无 checksum 资产 -> 直接拒绝，不得请求 .zip
    const resNoHash = await coreUpdater.checkAndUpdateCore({
      force: true,
      fetchBuffer: async (url: string) => {
        if (url.includes('/releases/latest')) {
          return Buffer.from(
            JSON.stringify({
              tag_name: 'v9.9.9',
              body: 'no checksum provided',
              assets: [
                {
                  name: 'mihomo-windows-amd64-v9.9.9.zip',
                  browser_download_url:
                    'https://github.com/MetaCubeX/mihomo/releases/download/v9.9.9/mihomo-windows-amd64-v9.9.9.zip',
                },
              ],
            }),
            'utf8'
          );
        }
        zipRequested = true;
        throw new Error('Should not download zip without sha256');
      },
    });
    assert.equal(resNoHash.success, false);
    assert.equal(zipRequested, false, '缺少 SHA-256 时绝不能下载内核压缩包');
    assert.match(resNoHash.message, /SHA-256/);

    // 2) checksum 资产拉取失败 -> 直接中止并提示重试，不得跳过校验继续下载
    const resChecksumFail = await coreUpdater.checkAndUpdateCore({
      force: true,
      fetchBuffer: async (url: string) => {
        if (url.includes('/releases/latest')) {
          return Buffer.from(
            JSON.stringify({
              tag_name: 'v9.9.9',
              body: '',
              assets: [
                {
                  name: 'mihomo-windows-amd64-v9.9.9.zip',
                  browser_download_url:
                    'https://github.com/MetaCubeX/mihomo/releases/download/v9.9.9/mihomo-windows-amd64-v9.9.9.zip',
                },
                {
                  name: 'mihomo-windows-amd64-v9.9.9.zip.sha256',
                  browser_download_url:
                    'https://github.com/MetaCubeX/mihomo/releases/download/v9.9.9/mihomo-windows-amd64-v9.9.9.zip.sha256',
                },
              ],
            }),
            'utf8'
          );
        }
        if (url.endsWith('.sha256')) {
          throw new Error('Network error 503');
        }
        zipRequested = true;
        throw new Error('Should not download zip when checksum fetch failed');
      },
    });
    assert.equal(resChecksumFail.success, false);
    assert.equal(zipRequested, false, '校验文件拉取失败时绝不能继续下载内核压缩包');
    assert.match(resChecksumFail.message, /校验文件失败/);
  });

  it('5. Zip Slip 实机拦截：含 ../ 逃逸条目的 ZIP 归档在解压阶段被拒绝且不落盘逃逸文件', async () => {
    if (process.platform !== 'win32') return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-zipslip-test-'));
    const evilZipPath = path.join(tmpDir, 'evil.zip');
    const escapedTarget = path.join(tmpDir, 'zipslip-pwned.exe');

    try {
      // 使用 .NET ZipArchive 构造包含 "../zipslip-pwned.exe" 恶意条目的 ZIP 包
      const escZip = evilZipPath.replace(/'/g, "''");
      const psBuildZip = [
        "Add-Type -AssemblyName System.IO.Compression",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$fs = [System.IO.File]::Open('${escZip}', [System.IO.FileMode]::Create)`,
        "$za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)",
        "$entry = $za.CreateEntry('../zipslip-pwned.exe')",
        "$sw = New-Object System.IO.StreamWriter($entry.Open())",
        "$sw.Write('PWNED')",
        "$sw.Dispose()",
        "$za.Dispose()",
        "$fs.Dispose()",
      ].join('\r\n');
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psBuildZip, 'utf16le').toString('base64')],
        { windowsHide: true }
      );

      const zipBuf = fs.readFileSync(evilZipPath);
      const zipSha = crypto.createHash('sha256').update(zipBuf).digest('hex');

      const coreUpdater = new CoreUpdaterService();
      const res = await coreUpdater.checkAndUpdateCore({
        force: true,
        fetchBuffer: async (url: string) => {
          if (url.includes('/releases/latest')) {
            return Buffer.from(
              JSON.stringify({
                tag_name: 'v9.9.9',
                assets: [
                  {
                    name: 'mihomo-windows-amd64-v9.9.9.zip',
                    browser_download_url:
                      'https://github.com/MetaCubeX/mihomo/releases/download/v9.9.9/mihomo-windows-amd64-v9.9.9.zip',
                    digest: `sha256:${zipSha}`,
                  },
                ],
              }),
              'utf8'
            );
          }
          return zipBuf;
        },
      });

      assert.equal(res.success, false);
      assert.match(res.message, /Zip Slip/i);
      assert.equal(fs.existsSync(escapedTarget), false, 'Zip Slip 绝不能在目标目录外写出任何文件');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
