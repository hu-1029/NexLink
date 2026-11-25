/**
 * Windows 系统代理独立看门狗守护服务 (ProxyGuard)
 * 作用：解决用户直接关闭终端窗口、非正常强杀或进程崩溃时，注册表残留死代理导致浏览器断网的问题。
 * 原理：启动独立脱离控制台的守护进程（detached: true），监控主进程存活状态。
 * 一旦主进程异常消亡，守护进程立即在毫秒级内自动安全恢复 Windows 注册表直连并清理孤儿内核。
 */

import { spawn, ChildProcess } from 'child_process';

export interface GuardOptions {
  parentPid: number;
  proxyPort: number;
  mihomoPid?: number;
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

    const { parentPid, proxyPort, mihomoPid } = options;

    // 构建独立的 PowerShell 守护命令脚本
    const script = `
$parentPid = ${parentPid}
$targetPort = ${proxyPort}
$mihomoPid = ${mihomoPid || 0}

$parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
if ($parent) {
    $parent.WaitForExit()
}

# 父进程（NexLink）退出后，等待 300 毫秒避免与正常退出时的常规恢复发生写冲突
Start-Sleep -Milliseconds 300

# 检查当前注册表状态
$regPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
$proxy = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue

# 关键安全隔离：仅当注册表代理依然指向 NexLink 自身的 targetPort 时，才进行清理！
# 如果用户已切换到 Clash Verge (7897) 或其他客户端，绝对不误动注册表！
if ($proxy -and $proxy.ProxyServer -match "^(?:http=)?(?:127\\.0\\.0\\.1|localhost):$targetPort(\\D|$)") {
    reg.exe add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f
    reg.exe add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f

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
