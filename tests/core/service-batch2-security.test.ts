import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  generateServiceCSharpSource,
  isAllowedRuleFileName,
  TunServiceManager,
} from '../../src/main/network/service-manager';

function createFakePeBinary(filePath: string, tag: string): string {
  const buf = Buffer.alloc(1024 * 1024 + 128, 0);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  buf.write(tag, 64, 'utf8');
  fs.writeFileSync(filePath, buf);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

describe('Batch 2 特权服务 NTFS Owner、内核同步信任、Wintun/Rules 与日志轮转专项测试', () => {
  it('1. isAllowedRuleFileName: 仅放行安全规则扩展名，拒绝 dll/exe/脚本等可执行文件', () => {
    for (const safeName of [
      'geosite.dat',
      'geoip.dat',
      'geoip.metadb',
      'Country.mmdb',
      'custom.mrs',
      'rules.yaml',
      'rules.yml',
      'direct.list',
      'domains.txt',
    ]) {
      assert.equal(isAllowedRuleFileName(safeName), true, `应允许规则文件: ${safeName}`);
    }

    for (const dangerousName of [
      'evil.dll',
      'wintun.dll',
      'payload.exe',
      'run.ps1',
      'init.bat',
      'hook.cmd',
      'noext',
      '',
    ]) {
      assert.equal(isAllowedRuleFileName(dangerousName), false, `必须拦截危险文件: ${dangerousName}`);
    }
  });

  it('2. syncUpdatedCoreToService: 拒绝不可信源、错误文件名、非法版本号与哈希不匹配', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-sync-trust-'));
    try {
      const svcDir = path.join(tmpDir, 'NexLink', 'service');
      const mgr = new TunServiceManager(svcDir);

      // 1) 用户可写目录下伪造的无签名、不在清单中的 mihomo.exe -> 必须拒绝
      const untrustedBin = path.join(tmpDir, 'mihomo.exe');
      const untrustedHash = createFakePeBinary(untrustedBin, 'untrusted-fake-core');

      const resUntrusted = await mgr.syncUpdatedCoreToService(
        untrustedBin,
        'v1.19.99',
        untrustedHash,
        true,
        {
          builtinHashes: {},
          checkAcl: () => ({ locked: false, reason: 'Writable by Users', unsafePath: untrustedBin }),
          checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
        }
      );
      assert.equal(resUntrusted.success, false, '不可信源二进制必须被拒绝');
      assert.match(resUntrusted.error || '', /不可信|拒绝|ACL|未通过可信来源验证/);

      // 2) 错误文件名 (非 mihomo.exe) -> 必须拒绝
      const wrongNameBin = path.join(tmpDir, 'evil.exe');
      const wrongHash = createFakePeBinary(wrongNameBin, 'wrong-name');
      const resWrongName = await mgr.syncUpdatedCoreToService(wrongNameBin, 'v1.19.99', wrongHash, true);
      assert.equal(resWrongName.success, false);
      assert.match(resWrongName.error || '', /mihomo\.exe/);

      // 3) 非法版本号 (注入尝试) -> 必须拒绝
      const resBadVer = await mgr.syncUpdatedCoreToService(untrustedBin, 'v1.0.0;calc.exe', untrustedHash, true);
      assert.equal(resBadVer.success, false);
      assert.match(resBadVer.error || '', /版本号/);

      // 4) 预期 SHA-256 与实际文件不一致（即使注入了 builtinHashes） -> 必须拒绝
      const wrongExpectedHash = 'A'.repeat(64);
      const resHashMismatch = await mgr.syncUpdatedCoreToService(
        untrustedBin,
        'v1.19.99',
        wrongExpectedHash,
        true,
        {
          builtinHashes: { 'v1.19.99': untrustedHash },
          checkSignature: () => ({ valid: false }),
        }
      );
      assert.equal(resHashMismatch.success, false);
      assert.match(resHashMismatch.error || '', /指纹不一致/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. syncUpdatedCoreToService 正向与越权绕过验证：新版本在线更新通过受控来源与 -v 校验后可提权同步，且拒绝越权路径与假来源', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-sync-positive-'));
    try {
      const svcDir = path.join(tmpDir, 'ProgramData', 'NexLink', 'service');
      const userMihomoDir = path.join(tmpDir, 'userData', 'mihomo');
      const evilDir = path.join(tmpDir, 'evil');
      fs.mkdirSync(userMihomoDir, { recursive: true });
      fs.mkdirSync(evilDir, { recursive: true });

      const newExe = path.join(userMihomoDir, 'mihomo.exe');
      const newSha = createFakePeBinary(newExe, 'mihomo-v1.20.0-online-update');
      const evilExe = path.join(evilDir, 'mihomo.exe');
      const evilSha = createFakePeBinary(evilExe, 'evil-binary');

      const mgr = new TunServiceManager(svcDir);

      // 1) 正向用例：新版本不在内置清单、无 Authenticode 签名、位于普通可写 userData/mihomo，
      //    但经由在线更新受控来源与 -v 自检验证后，必须顺利进入提权同步脚本而非死锁拒绝！
      let capturedPsScript = '';
      const okOnlineRes = await mgr.syncUpdatedCoreToService(
        newExe,
        'v1.20.0',
        newSha,
        true,
        {
          builtinHashes: {},
          checkAcl: () => ({ locked: false, reason: 'User-writable userData dir', unsafePath: newExe }),
          checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
          verifiedUpdate: {
            kind: 'github-release',
            downloadUrl: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.20.0/mihomo-windows-amd64-v1.20.0.zip',
            allowedSourceDirs: [userMihomoDir],
          },
          verifyBinaryVersion: () => 'Mihomo Meta v1.20.0 windows amd64',
          executePowerShell: async (_psPath, scriptContent) => {
            capturedPsScript = scriptContent;
            return 'OK:SYNCED';
          },
        }
      );
      assert.equal(okOnlineRes.success, true, `合法在线更新应放行提权同步，实际错误: ${okOnlineRes.error}`);
      assert.ok(capturedPsScript.includes(newSha), '提权脚本必须包含新内核 SHA-256');
      assert.ok(capturedPsScript.includes('mihomo-manifest.json'), '提权脚本必须写入锁定清单');

      // 2) 正向用例：回退流程 (rollback) 位于受控目录且通过 -v 校验时应放行
      const okRollbackRes = await mgr.syncUpdatedCoreToService(
        newExe,
        'v1.20.0',
        newSha,
        true,
        {
          builtinHashes: {},
          checkAcl: () => ({ locked: false, reason: 'User-writable userData dir', unsafePath: newExe }),
          checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
          verifiedUpdate: {
            kind: 'rollback',
            allowedSourceDirs: [userMihomoDir],
          },
          verifyBinaryVersion: () => 'Mihomo Meta v1.20.0 windows amd64',
          executePowerShell: async () => 'OK:RESTARTED',
        }
      );
      assert.equal(okRollbackRes.success, true);
      assert.equal(okRollbackRes.serviceRestarted, true);

      // 3) 越权拦截：即使伪造 verifiedUpdate，路径不在 allowedSourceDirs 内 -> 必须拦截
      const resOutsideDir = await mgr.syncUpdatedCoreToService(
        evilExe,
        'v1.20.0',
        evilSha,
        true,
        {
          builtinHashes: {},
          checkSignature: () => ({ valid: false }),
          verifiedUpdate: {
            kind: 'github-release',
            downloadUrl: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.20.0/mihomo-windows-amd64-v1.20.0.zip',
            allowedSourceDirs: [userMihomoDir],
          },
          verifyBinaryVersion: () => 'Mihomo Meta v1.20.0 windows amd64',
          executePowerShell: async () => 'OK:SYNCED',
        }
      );
      assert.equal(resOutsideDir.success, false);
      assert.match(resOutsideDir.error || '', /不在主进程受控更新目录内/);

      // 4) 越权拦截：非官方 MetaCubeX/mihomo 下载源 URL -> 必须拦截
      const resBadUrl = await mgr.syncUpdatedCoreToService(
        newExe,
        'v1.20.0',
        newSha,
        true,
        {
          builtinHashes: {},
          checkSignature: () => ({ valid: false }),
          verifiedUpdate: {
            kind: 'github-release',
            downloadUrl: 'https://github.com/attacker/fake/releases/download/v1.20.0/evil.zip',
            allowedSourceDirs: [userMihomoDir],
          },
          verifyBinaryVersion: () => 'Mihomo Meta v1.20.0 windows amd64',
          executePowerShell: async () => 'OK:SYNCED',
        }
      );
      assert.equal(resBadUrl.success, false);
      assert.match(resBadUrl.error || '', /非官方 MetaCubeX\/mihomo/);

      // 5) 越权拦截：-v 自检输出不匹配 Mihomo 版本 -> 必须拦截
      const resBadVerOut = await mgr.syncUpdatedCoreToService(
        newExe,
        'v1.20.0',
        newSha,
        true,
        {
          builtinHashes: {},
          checkSignature: () => ({ valid: false }),
          verifiedUpdate: {
            kind: 'github-release',
            downloadUrl: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.20.0/mihomo-windows-amd64-v1.20.0.zip',
            allowedSourceDirs: [userMihomoDir],
          },
          verifyBinaryVersion: () => 'Some Fake Binary v9.9.9',
          executePowerShell: async () => 'OK:SYNCED',
        }
      );
      assert.equal(resBadVerOut.success, false);
      assert.match(resBadVerOut.error || '', /-v 版本校验不匹配/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. C# 服务源码加固校验与 csc.exe 真实编译验证 (Owner校验/回环控制/TUN YAML/日志轮转/恒定时间Token)', () => {
    const cs = generateServiceCSharpSource(33211);

    // 关键加固点静态验证
    assert.ok(cs.includes('GetOwner(typeof(SecurityIdentifier))'), 'C# 必须校验目录与文件 NTFS Owner');
    assert.ok(cs.includes('ConstantTimeEquals'), 'C# Token 校验必须使用恒定时间比对');
    assert.ok(cs.includes('ValidateConfigContentSafety'), 'C# /start 必须校验 external-controller 仅绑定回环');
    assert.ok(cs.includes('IsTunEnabledInYaml'), 'C# 必须采用 YAML 段落感知判定 tun.enable');
    assert.ok(
      cs.includes('MaxCoreLogBytes') && cs.includes('RotateCoreLogLockedIfNeeded'),
      'C# 必须为 mihomo-service.log 实现大小上限与轮转'
    );

    // PowerShell 脚本关键防线检查
    const smSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/network/service-manager.ts'),
      'utf8'
    );
    assert.match(smSrc, /\/setowner\s+\\?"\*S-1-5-32-544\\?"/, '安装与同步脚本必须显式锁定 NTFS Owner 为 Administrators');
    assert.ok(
      smSrc.indexOf('Assert-NoReparseChain $serviceDir') < smSrc.indexOf('New-Item -ItemType Directory -Force -Path $serviceDir'),
      '必须先执行 Assert-NoReparseChain 再创建 serviceDir，消除预创建 TOCTOU'
    );
    assert.ok(
      smSrc.indexOf('Copy-Item -LiteralPath $srcWintun -Destination $lockedWintunPath') <
        smSrc.indexOf('Get-FileHash -LiteralPath $lockedWintunPath -Algorithm SHA256'),
      'wintun.dll 必须先拷贝进锁定目录再计算 SHA-256'
    );

    if (process.platform !== 'win32') return;

    const fwCandidates = [
      path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET\\Framework64\\v4.0.30319'),
      path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET\\Framework\\v4.0.30319'),
    ];
    const fwDir = fwCandidates.find((d) => fs.existsSync(path.join(d, 'csc.exe')));
    if (!fwDir) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-csc-check-'));
    try {
      const csPath = path.join(tmpDir, 'NexLinkService.cs');
      const exePath = path.join(tmpDir, 'NexLinkService.exe');
      fs.writeFileSync(csPath, '\uFEFF' + cs, 'utf8');
      execFileSync(
        path.join(fwDir, 'csc.exe'),
        [
          '/nologo',
          '/optimize+',
          '/target:exe',
          `/r:${path.join(fwDir, 'System.ServiceProcess.dll')}`,
          `/r:${path.join(fwDir, 'System.Web.Extensions.dll')}`,
          `/out:${exePath}`,
          csPath,
        ],
        { windowsHide: true, timeout: 20000 }
      );
      assert.ok(fs.existsSync(exePath), 'csc.exe 必须成功编译生成 NexLinkService.exe');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
