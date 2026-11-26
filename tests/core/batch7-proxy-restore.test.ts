import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildProxyGuardScript,
  buildProxyRestorePlan,
} from '../../src/main/network/proxy-guard';
import { SystemProxyManager } from '../../src/main/network/system-proxy';

describe('Batch 7 系统代理恢复完整性、ProxyGuard 备份还原与 NSIS 卸载守护测试', () => {
  it('1. buildProxyRestorePlan 精确生成第三方代理、纯 PAC 与空白环境还原计划（含删除残留键）', () => {
    // 1) 第三方代理 (7897) + 自定义 bypass + 无 PAC
    const thirdPartyPlan = buildProxyRestorePlan(
      {
        proxyEnable: 1,
        proxyServer: '127.0.0.1:7897',
        proxyOverride: 'localhost;127.*;*.internal',
      },
      7890
    );
    assert.deepStrictEqual(thirdPartyPlan, {
      proxyEnable: 1,
      proxyServer: '127.0.0.1:7897',
      proxyOverride: 'localhost;127.*;*.internal',
      autoConfigURL: null,
      restoredThirdParty: true,
    });

    // 2) 原有仅 PAC（无 ProxyServer，无 ProxyOverride）-> 恢复 AutoConfigURL 并删除接管写入的 ProxyOverride
    const pacOnlyPlan = buildProxyRestorePlan(
      {
        proxyEnable: 0,
        autoConfigURL: 'https://pac.example.com/proxy.pac',
      },
      7890
    );
    assert.deepStrictEqual(pacOnlyPlan, {
      proxyEnable: 0,
      proxyServer: '',
      proxyOverride: null,
      autoConfigURL: 'https://pac.example.com/proxy.pac',
      restoredThirdParty: false,
    });

    // 3) 原有空白直连环境 -> 清零并显式标记删除 ProxyOverride 与 AutoConfigURL
    const cleanPlan = buildProxyRestorePlan({ proxyEnable: 0 }, 7890);
    assert.deepStrictEqual(cleanPlan, {
      proxyEnable: 0,
      proxyServer: '',
      proxyOverride: null,
      autoConfigURL: null,
      restoredThirdParty: false,
    });
  });

  it('2. ProxyGuard 在真实 Windows 注册表隔离测试键上完整还原 PAC、第三方代理并清理残留键', () => {
    if (process.platform !== 'win32') return;

    const testKeyLeaf = `NexLink_Batch7_Test_${process.pid}_${Date.now()}`;
    const psRegPath = `HKCU:\\Software\\${testKeyLeaf}`;
    const winRegPath = `HKCU\\Software\\${testKeyLeaf}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-b7-guard-'));
    const backupFile = path.join(tempDir, 'proxy-backup.json');

    const runPs = (script: string) => {
      const wrapped = `$ProgressPreference = 'SilentlyContinue';\n${script}\nexit 0`;
      const base64 = Buffer.from(wrapped, 'utf16le').toString('base64');
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', base64],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }
      );
    };

    const readTestRegJson = () => {
      const out = runPs(
        `Get-ItemProperty -Path '${psRegPath}' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress`
      );
      return JSON.parse(out.trim());
    };

    try {
      runPs(`New-Item -Path '${psRegPath}' -Force | Out-Null`);

      // 场景 A: 备份包含 PAC (AutoConfigURL)，原本无 ProxyOverride
      fs.writeFileSync(
        backupFile,
        JSON.stringify({ proxyEnable: 0, autoConfigURL: 'http://corp.local/proxy.pac' }),
        'utf8'
      );
      runPs(`
        Set-ItemProperty -Path '${psRegPath}' -Name ProxyEnable -Value 1 -Type DWord
        Set-ItemProperty -Path '${psRegPath}' -Name ProxyServer -Value '127.0.0.1:17899' -Type String
        Set-ItemProperty -Path '${psRegPath}' -Name ProxyOverride -Value 'localhost;127.*;<local>' -Type String
        Remove-ItemProperty -Path '${psRegPath}' -Name AutoConfigURL -ErrorAction SilentlyContinue
      `);
      runPs(
        buildProxyGuardScript(
          { parentPid: 0, proxyPort: 17899, backupFilePath: backupFile },
          psRegPath
        )
      );
      const afterPac = readTestRegJson();
      assert.strictEqual(afterPac.ProxyEnable, 0);
      assert.strictEqual(afterPac.ProxyServer, '');
      assert.strictEqual(afterPac.AutoConfigURL, 'http://corp.local/proxy.pac');
      assert.strictEqual(afterPac.ProxyOverride, null, '原备份无 ProxyOverride 时必须删除残留键值');
      assert.strictEqual(fs.existsSync(backupFile), false, '恢复后应清理临时 proxy-backup.json');

      // 场景 B: 备份包含第三方代理 (7897) 与自定义 ProxyOverride
      fs.writeFileSync(
        backupFile,
        JSON.stringify({
          proxyEnable: 1,
          proxyServer: '127.0.0.1:7897',
          proxyOverride: 'localhost;*.corp',
        }),
        'utf8'
      );
      runPs(`
        Set-ItemProperty -Path '${psRegPath}' -Name ProxyEnable -Value 1 -Type DWord
        Set-ItemProperty -Path '${psRegPath}' -Name ProxyServer -Value '127.0.0.1:17899' -Type String
        Set-ItemProperty -Path '${psRegPath}' -Name AutoConfigURL -Value 'http://stale.invalid/pac' -Type String
      `);
      runPs(
        buildProxyGuardScript(
          { parentPid: 0, proxyPort: 17899, backupFilePath: backupFile },
          psRegPath
        )
      );
      const afterThirdParty = readTestRegJson();
      assert.strictEqual(afterThirdParty.ProxyEnable, 1);
      assert.strictEqual(afterThirdParty.ProxyServer, '127.0.0.1:7897');
      assert.strictEqual(afterThirdParty.ProxyOverride, 'localhost;*.corp');
      assert.strictEqual(afterThirdParty.AutoConfigURL, null, '原备份无 PAC 时必须删除残留 AutoConfigURL');

      // 场景 C: 若用户已切换到第三方 7897，ProxyGuard 绝不误清或修改当前配置
      runPs(
        buildProxyGuardScript(
          { parentPid: 0, proxyPort: 17899, backupFilePath: backupFile },
          psRegPath
        )
      );
      const untouched = readTestRegJson();
      assert.strictEqual(untouched.ProxyServer, '127.0.0.1:7897');
    } finally {
      try {
        execFileSync('reg.exe', ['delete', winRegPath, '/f'], { windowsHide: true });
      } catch {
        // 忽略清理异常
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. 备份读取失败时标记 backupFailed 并中止 enableProxy 接管，绝不盲写 { proxyEnable: 0 }', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-b7-fail-'));
    try {
      const mgr = new SystemProxyManager();
      mgr.initialize(tempDir);
      (mgr as any).readLiveProxyFn = () => ({ enabled: false, readFailed: true });

      const backupOk = await mgr.backupOriginalSettings(7890);
      assert.strictEqual(backupOk, false);
      assert.strictEqual(mgr.hasBackupFailed(), true);
      assert.strictEqual(mgr.getOriginalBackup(), null, '读取失败不得写入伪造 { proxyEnable: 0 } 备份');
      assert.strictEqual(fs.existsSync(path.join(tempDir, 'proxy-backup.json')), false);

      const enabled = await mgr.enableProxy(7890);
      assert.strictEqual(enabled, false, '备份失败时必须中止接管系统代理');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. build/installer.nsh 包含 ProgramData ($4) 非空保护并轮询 STOPPED 后再删除服务', () => {
    const nsh = fs.readFileSync(path.resolve('build/installer.nsh'), 'utf8');
    const codeOnly = nsh
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith(';'))
      .join('\n');
    assert.ok(codeOnly.includes('${if} $4 != ""'), '卸载脚本必须判断 ProgramData ($4) 非空后再操作目录');
    assert.ok(codeOnly.includes('STOPPED'), '卸载脚本必须轮询 sc.exe query 是否进入 STOPPED 状态');
    assert.strictEqual(/^\s*Sleep\s+1000\b/m.test(codeOnly), false, '不应再依赖固定 Sleep 1000 盲删服务');
  });
});
