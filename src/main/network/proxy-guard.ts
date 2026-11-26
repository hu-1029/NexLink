/**
 * Windows 系统代理独立看门狗守护服务 (ProxyGuard)
 * 作用：解决用户直接关闭终端窗口、非正常强杀或进程崩溃时，注册表残留死代理导致浏览器断网的问题。
 * 原理：启动独立脱离控制台的守护进程（detached: true），监控主进程存活状态。
 * 一旦主进程异常消亡，守护进程立即在毫秒级内自动安全恢复 Windows 注册表直连并清理孤儿内核。
 */

import { spawn, ChildProcess } from 'child_process';

export interface OriginalProxyBackup {
  proxyEnable: number;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigURL?: string;
}

export interface ProxyRestorePlan {
  proxyEnable: 0 | 1;
  proxyServer: string;
  proxyOverride: string | null;
  autoConfigURL: string | null;
  restoredThirdParty: boolean;
}

export interface GuardOptions {
  parentPid: number;
  proxyPort: number;
  mihomoPid?: number;
  backupFilePath?: string;
}

/**
 * 判断代理服务器字符串是否指向本机指定端口
 */
export function isPortMatching(server: string | undefined, port: number): boolean {
  if (!server) return false;
  const trimmed = server.trim().toLowerCase();
  const isLoopback = /(?:^|[=;\s])(?:127\.0\.0\.1|localhost):/.test(trimmed);
  if (!isLoopback) return false;
  const regex = new RegExp(`:${port}(?:[^0-9]|$)`);
  return regex.test(trimmed);
}

/**
 * 统一构造原始系统代理/PAC 精确还原计划（供 SystemProxyManager 与 ProxyGuard 共用）
 * - 原本存在第三方代理且非本软件端口时：完整还原 ProxyEnable=1 + ProxyServer + ProxyOverride + AutoConfigURL
 * - 原本仅开启 PAC（无 ProxyServer）或原本无代理时：清空 ProxyServer，按备份原值还原或显式删除 ProxyOverride / AutoConfigURL
 */
export function buildProxyRestorePlan(
  backup: OriginalProxyBackup | null | undefined,
  expectedPort: number
): ProxyRestorePlan {
  if (!backup) {
    return {
      proxyEnable: 0,
      proxyServer: '',
      proxyOverride: null,
      autoConfigURL: null,
      restoredThirdParty: false,
    };
  }

  const trimmedServer = (backup.proxyServer || '').trim();
  const trimmedOverride = (backup.proxyOverride || '').trim();
  const trimmedAutoConfig = (backup.autoConfigURL || '').trim();

  const hasOtherClientBackup =
    backup.proxyEnable === 1 &&
    Boolean(trimmedServer) &&
    !isPortMatching(trimmedServer, expectedPort);

  if (hasOtherClientBackup) {
    return {
      proxyEnable: 1,
      proxyServer: trimmedServer,
      proxyOverride: trimmedOverride || null,
      autoConfigURL: trimmedAutoConfig || null,
      restoredThirdParty: true,
    };
  }

  const keepEnableForPacOnly =
    backup.proxyEnable === 1 && !trimmedServer && Boolean(trimmedAutoConfig);

  return {
    proxyEnable: keepEnableForPacOnly ? 1 : 0,
    proxyServer: '',
    proxyOverride: trimmedOverride || null,
    autoConfigURL: trimmedAutoConfig || null,
    restoredThirdParty: false,
  };
}

function escapePsSingleQuoted(val: string): string {
  return val.replace(/'/g, "''").replace(/[\r\n]/g, '');
}

/**
 * 生成脱离控制台的 ProxyGuard PowerShell 守护恢复脚本（支持读取 proxy-backup.json 完整还原 PAC 与第三方代理）
 */
export function buildProxyGuardScript(
  options: GuardOptions,
  regPathOverride?: string
): string {
  const { parentPid, proxyPort, mihomoPid, backupFilePath } = options;
  const targetRegPath =
    regPathOverride || 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const safeRegPath = escapePsSingleQuoted(targetRegPath);
  const safeBackupPath = backupFilePath ? escapePsSingleQuoted(backupFilePath) : '';

  return `
$parentPid = ${parentPid}
$targetPort = ${proxyPort}
$mihomoPid = ${mihomoPid || 0}
$regPath = '${safeRegPath}'
$backupFilePath = '${safeBackupPath}'

if ($parentPid -gt 0) {
    $parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
    if ($parent) {
        $parent.WaitForExit()
    }
    # 父进程（NexLink）退出后，等待 300 毫秒避免与正常退出时的常规恢复发生写冲突
    Start-Sleep -Milliseconds 300
}

# 检查当前注册表状态
$proxy = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue

# 关键安全隔离：仅当注册表代理依然指向 NexLink 自身的 targetPort 时，才执行备份还原或清理！
# 如果用户已切换到 Clash Verge (7897) 或其他客户端，绝对不误动注册表！
if ($proxy -and $proxy.ProxyServer -match "^(?:http=)?(?:127\\.0\\.0\\.1|localhost):$targetPort(\\D|$)") {
    $backup = $null
    if ($backupFilePath -and (Test-Path -LiteralPath $backupFilePath)) {
        try {
            $backup = Get-Content -LiteralPath $backupFilePath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            $backup = $null
        }
    }

    $restoreEnable = 0
    $restoreServer = ''
    $restoreOverride = $null
    $restoreAutoConfig = $null

    if ($backup) {
        $bkEnable = 0
        if ($null -ne $backup.proxyEnable) { $bkEnable = [int]$backup.proxyEnable }
        $bkServer = ''
        if ($backup.proxyServer) { $bkServer = ([string]$backup.proxyServer).Trim() }
        $bkOverride = ''
        if ($backup.proxyOverride) { $bkOverride = ([string]$backup.proxyOverride).Trim() }
        $bkAutoConfig = ''
        if ($backup.autoConfigURL) { $bkAutoConfig = ([string]$backup.autoConfigURL).Trim() }

        $isLoopbackSelf = ($bkServer.ToLower() -match '(?:^|[=;\\s])(?:127\\.0\\.0\\.1|localhost):') -and ($bkServer -match ":$targetPort(?:[^0-9]|$)")
        $hasOtherClient = ($bkEnable -eq 1) -and (-not [string]::IsNullOrWhiteSpace($bkServer)) -and (-not $isLoopbackSelf)

        if ($hasOtherClient) {
            $restoreEnable = 1
            $restoreServer = $bkServer
        } elseif ($bkEnable -eq 1 -and [string]::IsNullOrWhiteSpace($bkServer) -and (-not [string]::IsNullOrWhiteSpace($bkAutoConfig))) {
            $restoreEnable = 1
            $restoreServer = ''
        }

        if (-not [string]::IsNullOrWhiteSpace($bkOverride)) {
            $restoreOverride = $bkOverride
        }
        if (-not [string]::IsNullOrWhiteSpace($bkAutoConfig)) {
            $restoreAutoConfig = $bkAutoConfig
        }
    }

    Set-ItemProperty -Path $regPath -Name ProxyEnable -Value $restoreEnable -Type DWord
    Set-ItemProperty -Path $regPath -Name ProxyServer -Value $restoreServer -Type String

    if ($null -ne $restoreOverride) {
        Set-ItemProperty -Path $regPath -Name ProxyOverride -Value $restoreOverride -Type String
    } else {
        Remove-ItemProperty -Path $regPath -Name ProxyOverride -ErrorAction SilentlyContinue
    }

    if ($null -ne $restoreAutoConfig) {
        Set-ItemProperty -Path $regPath -Name AutoConfigURL -Value $restoreAutoConfig -Type String
    } else {
        Remove-ItemProperty -Path $regPath -Name AutoConfigURL -ErrorAction SilentlyContinue
    }

    if ($backupFilePath -and (Test-Path -LiteralPath $backupFilePath)) {
        Remove-Item -LiteralPath $backupFilePath -Force -ErrorAction SilentlyContinue
    }

    $source = @"
    using System;
    using System.Runtime.InteropServices;
    public class WinINetGuardFast {
        [DllImport("wininet.dll", SetLastError = true)]
        public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
    }
"@
    Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue
    [WinINetGuardFast]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    [WinINetGuardFast]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
}

if ($mihomoPid -gt 0) {
    $coreProc = Get-Process -Id $mihomoPid -ErrorAction SilentlyContinue
    if ($coreProc -and $coreProc.ProcessName -eq 'mihomo') {
        Stop-Process -Id $mihomoPid -Force -ErrorAction SilentlyContinue
    }
}
`;
}

export class ProxyGuard {
  private guardProcess: ChildProcess | null = null;

  /**
   * 启动代理看门狗守护进程
   */
  public startGuard(options: GuardOptions): boolean {
    if (process.platform !== 'win32') return false;

    // 先终止旧的看门狗（若存在）
    this.stopGuard();

    const { parentPid, proxyPort } = options;
    const script = buildProxyGuardScript(options);

    try {
      const base64 = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', base64],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      );

      // 解除对子进程的引用，允许主进程独立退出
      child.unref();
      this.guardProcess = child;
      console.log(`[ProxyGuard] 独立看门狗已启动 (守护目标: PID=${parentPid}, Port=${proxyPort})`);
      return true;
    } catch (err: any) {
      console.warn('[ProxyGuard] 启动独立看门狗失败:', err.message);
      return false;
    }
  }

  /**
   * 停止看门狗守护
   */
  public stopGuard(): void {
    if (this.guardProcess) {
      try {
        if (!this.guardProcess.killed && this.guardProcess.pid) {
          process.kill(this.guardProcess.pid);
        }
      } catch (_e) {
        void _e;
      }
      this.guardProcess = null;
    }
  }
}

export const proxyGuard = new ProxyGuard();
