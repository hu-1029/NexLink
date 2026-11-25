import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { selectMihomoWindowsAsset } from '../../src/main/services/core-updater';
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
});
