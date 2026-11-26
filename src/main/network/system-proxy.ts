/**
 * Windows 原生系统代理安全控制器
 * 严格支持：开启代理、关闭代理、备份用户原始配置、安全回滚与 WinINet 广播刷新
 * 具备磁盘持久化备份保护、防范 127.0.0.1 死代理污染、以及应用退出/崩溃时的同步恢复能力
 */

import { execFile, execFileSync } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import net from 'net';
import type { SystemProxyConfig } from '../../shared/types';
import { isValidPort } from '../../services/node/node-utils';
import {
  buildProxyRestorePlan,
  isPortMatching,
  proxyGuard,
  type OriginalProxyBackup,
  type ProxyRestorePlan,
} from './proxy-guard';

export { buildProxyRestorePlan, isPortMatching };
export type { OriginalProxyBackup, ProxyRestorePlan };

const execFileAsync = util.promisify(execFile);

const REG_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WIN_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * 探测指定本地端口是否有程序在监听
 */
export function isPortListening(port: number, host: string = '127.0.0.1', timeoutMs: number = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));

    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/**
 * 同步快速读取 Windows 注册表实时的当前代理配置（5-15ms 原生极速，不依赖 PowerShell，零黑框弹窗）
 */
export function getLiveRegistryProxySync(): {
  enabled: boolean;
  server?: string;
  override?: string;
  autoConfigURL?: string;
  readFailed?: boolean;
} {
  if (process.platform !== 'win32') {
    return { enabled: false };
  }
  try {
    const out = execFileSync('reg.exe', ['query', WIN_REG_PATH], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    });
    const enableMatch = out.match(/ProxyEnable[ \t]+REG_DWORD[ \t]+0x([0-9a-fA-F]+)/i);
    const serverMatch = out.match(/ProxyServer[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
    const overrideMatch = out.match(/ProxyOverride[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
    const autoConfigMatch = out.match(/AutoConfigURL[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
    return {
      enabled: enableMatch ? parseInt(enableMatch[1], 16) === 1 : false,
      server: serverMatch ? serverMatch[1].trim() : undefined,
      override: overrideMatch ? overrideMatch[1].trim() : undefined,
      autoConfigURL: autoConfigMatch ? autoConfigMatch[1].trim() : undefined,
    };
  } catch (err: any) {
    console.warn('[SystemProxy] 获取实时注册表代理失败:', err?.message);
    return { enabled: false, readFailed: true };
  }
}

/**
 * 判断代理服务器地址是否为本地回环死代理
 */
export function isLocalProxy(server?: string): boolean {
  if (!server) return false;
  const s = server.trim().toLowerCase();
  return (
    s.includes('127.0.0.1') ||
    s.includes('localhost') ||
    s.includes('::1') ||
    s.startsWith('127.')
  );
}

async function runPowerShell(script: string): Promise<string> {
  const wrapped = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const base64 = Buffer.from(wrapped, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      base64,
    ],
    { windowsHide: true, timeout: 8000 }
  );
  return stdout;
}

export class SystemProxyManager {
  private originalBackup: OriginalProxyBackup | null = null;
  private isNexLinkControlling: boolean = false;
  private backupFilePath: string | null = null;
  private backupFailed: boolean = false;
  private lastBackupError: string | null = null;
  private readLiveProxyFn: () => ReturnType<typeof getLiveRegistryProxySync> = getLiveRegistryProxySync;

  /**
   * 初始化存储目录并从磁盘恢复原始代理备份
   */
  public initialize(userDataDir: string): void {
    this.backupFilePath = path.join(userDataDir, 'proxy-backup.json');
    this.loadBackupFromDisk();
  }

  private loadBackupFromDisk(): void {
    if (!this.backupFilePath || !fs.existsSync(this.backupFilePath)) return;
    try {
      const content = fs.readFileSync(this.backupFilePath, 'utf8');
      const parsed = JSON.parse(content) as OriginalProxyBackup;
      if (parsed && typeof parsed.proxyEnable === 'number') {
        // 按磁盘备份原样加载恢复，不进行 isLocalProxy 过滤
        this.originalBackup = parsed;
        console.log('[SystemProxy] 成功从磁盘加载原始系统代理备份:', this.originalBackup);
      }
    } catch (err: any) {
      console.warn('[SystemProxy] 加载磁盘原始代理备份警告:', err.message);
    }
  }

  private saveBackupToDisk(): void {
    if (!this.backupFilePath || !this.originalBackup) return;
    try {
      fs.mkdirSync(path.dirname(this.backupFilePath), { recursive: true });
      fs.writeFileSync(this.backupFilePath, JSON.stringify(this.originalBackup, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[SystemProxy] 持久化原始代理备份警告:', err.message);
    }
  }

  private clearDiskBackup(): void {
    if (!this.backupFilePath) return;
    try {
      if (fs.existsSync(this.backupFilePath)) {
        fs.unlinkSync(this.backupFilePath);
      }
    } catch (_e) {
      void _e;
    }
  }

  /**
   * 启动时检查注册表是否残留 NexLink 自己的死代理（上次非正常崩溃或强制终止遗留），若有立即自动清理恢复网络
   * 严格限定仅清理指向 NexLink 自己端口且无程序监听的死代理，绝对不误关外部其他代理工具（如 Clash Verge、v2rayN）
   */
  public async cleanStaleProxyIfPresent(expectedPort: number = 7890): Promise<void> {
    try {
      const live = getLiveRegistryProxySync();
      // 仅当注册表中的代理服务器指向 NexLink 的端口时才检测（绝不误动其他客户端端口）
      if (live.server && isPortMatching(live.server, expectedPort)) {
        const listening = await isPortListening(expectedPort, '127.0.0.1', 300);
        if (!listening) {
          // 该端口当前无任何进程监听，确认为上次崩溃或异常残留的死代理，立即同步清理恢复直连网络！
          console.warn(`[SystemProxy] 启动自检：检测到残留的无监听死代理 (${live.server})，立即自动清理恢复网络！`);
          this.restoreProxySync(expectedPort);
        }
      }
    } catch (err: any) {
      console.warn('[SystemProxy] 启动自检残留代理异常:', err.message);
    }
  }

  /**
   * 读取当前 Windows 注册表中的代理配置 (优先读取原生注册表，零黑框弹窗)
   */
  async getCurrentProxy(): Promise<SystemProxyConfig> {
    if (process.platform === 'win32') {
      const live = getLiveRegistryProxySync();
      return {
        enabled: live.enabled,
        server: live.server || '127.0.0.1:7890',
        bypass: live.override || 'localhost;127.*;10.*;172.16.*;192.168.*;<local>',
      };
    }
    return {
      enabled: false,
      server: '127.0.0.1:7890',
      bypass: 'localhost;127.*;10.*;172.16.*;192.168.*;<local>',
    };
  }

  /**
   * 备份用户原本的系统代理配置（仅在首次由 NexLink 接管前记录一次）
   * "死代理"只在备份阶段判断：端口等于 NexLink 自己的端口，或本机该端口没有程序监听（用 net.connect 探测）
   * 若注册表读取失败则明确标记 backupFailed 状态并中止接管，绝不盲写 { proxyEnable: 0 } 覆盖用户原有代理/PAC
   */
  async backupOriginalSettings(expectedPort: number = 7890): Promise<boolean> {
    if (this.originalBackup !== null) {
      this.backupFailed = false;
      this.lastBackupError = null;
      return true; // 已有备份，无需重复覆盖
    }

    try {
      const reg = this.readLiveProxyFn();
      if (reg.readFailed) {
        this.backupFailed = true;
        this.lastBackupError = '读取当前 Windows 系统代理注册表失败，已拒绝覆盖原有外部代理/PAC 配置';
        console.error('[SystemProxy]', this.lastBackupError);
        return false;
      }

      const isEnabled = reg.enabled;
      const server = (reg.server || '').trim();

      let isDeadProxy = false;

      // 仅当用户原本开启了代理且配置了本地代理地址时，才进行死代理判定
      if (isEnabled && server && isLocalProxy(server)) {
        const match = server.match(/(?:127\.0\.0\.1|localhost|::1):(\d+)/i) || server.match(/:(\d+)$/);
        const port = match ? parseInt(match[1], 10) : NaN;

        if (!isNaN(port)) {
          if (port === expectedPort) {
            // 条件 1: 端口等于 NexLink 自己的端口
            isDeadProxy = true;
          } else {
            // 条件 2: 端口不等于 NexLink，用 net.connect 探测本机该端口是否有程序监听
            const listening = await isPortListening(port, '127.0.0.1');
            if (!listening) {
              isDeadProxy = true;
            }
          }
        } else {
          isDeadProxy = true;
        }
      }

      if (isDeadProxy) {
        console.warn(`[SystemProxy] 检测到残留的本地死代理 (${server})，自动纠偏为直连并保留原有 ProxyOverride/PAC (ProxyEnable=0)`);
        this.originalBackup = {
          proxyEnable: 0,
          proxyOverride: reg.override || undefined,
          autoConfigURL: reg.autoConfigURL || undefined,
        };
      } else {
        this.originalBackup = {
          proxyEnable: isEnabled ? 1 : 0,
          proxyServer: reg.server || undefined,
          proxyOverride: reg.override || undefined,
          autoConfigURL: reg.autoConfigURL || undefined,
        };
      }
      this.backupFailed = false;
      this.lastBackupError = null;
      this.saveBackupToDisk();
      console.log('[SystemProxy] 成功备份用户原始代理设置:', this.originalBackup);
      return true;
    } catch (err: any) {
      this.backupFailed = true;
      this.lastBackupError = err?.message || '备份用户原始代理设置异常';
      console.error('[SystemProxy] 备份用户原始代理设置失败，已拒绝强行接管:', this.lastBackupError);
      return false;
    }
  }

  /**
   * 开启 NexLink 系统代理
   */
  async enableProxy(port: number = 7890, bypassList?: string, mihomoPid?: number): Promise<boolean> {
    if (!isValidPort(port)) {
      console.error(`[SystemProxy] 拒绝设置非法代理端口: ${port}`);
      return false;
    }

    const backupReady = await this.backupOriginalSettings(port);
    if (!backupReady) {
      console.error('[SystemProxy] 因原始代理备份失败，中止开启系统代理以保护用户原有网络设置');
      return false;
    }

    const proxyServer = `127.0.0.1:${port}`;
    // 严格净化白名单参数，只允许合法域名、IP与标点符号，坚决防范 PowerShell 命令注入
    let bypass = 'localhost;127.*;10.*;172.16.*;192.168.*;<local>';
    if (bypassList && typeof bypassList === 'string') {
      const sanitized = bypassList.replace(/[^a-zA-Z0-9.*:;<>\-_\s]/g, '').trim();
      if (sanitized) bypass = sanitized;
    }

    const script = `
Set-ItemProperty -Path '${REG_KEY}' -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path '${REG_KEY}' -Name ProxyServer -Value '${proxyServer}' -Type String
Set-ItemProperty -Path '${REG_KEY}' -Name ProxyOverride -Value '${bypass}' -Type String
Remove-ItemProperty -Path '${REG_KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue

$source = @"
using System;
using System.Runtime.InteropServices;
public class WinINet {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@
Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue
[WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;

    try {
      await runPowerShell(script);
      this.isNexLinkControlling = true;
      console.log(`[SystemProxy] 系统代理已成功设置为: ${proxyServer}`);
      // 启动独立脱离控制台的守护看门狗，传入 proxy-backup.json 路径以便异常消亡时精准还原 PAC/第三方代理
      proxyGuard.startGuard({
        parentPid: process.pid,
        proxyPort: port,
        mihomoPid,
        backupFilePath: this.backupFilePath || undefined,
      });
      return true;
    } catch (err: any) {
      console.error('[SystemProxy] 开启系统代理失败:', err.message);
      return false;
    }
  }

  /**
   * 关闭系统代理并安全恢复用户原有设置 (异步执行，包含完整 WinINet 广播)
   */
  async restoreProxy(expectedPort: number = 7890): Promise<boolean> {
    if (process.platform !== 'win32') return true;

    if (!this.originalBackup) {
      this.loadBackupFromDisk();
    }

    // 1. 读取 Windows 注册表实时的当前代理状态
    const live = this.readLiveProxyFn();
    if (live.readFailed) {
      console.warn('[SystemProxy] 异步恢复前无法读取实时注册表，跳过写操作避免误伤外部代理');
      return false;
    }

    // 关键安全隔离 1：如果当前注册表中配置了代理，且该代理端口指向其他客户端（即不等于 NexLink 的 expectedPort）
    // 无论 NexLink 内部状态如何，坚决不触碰注册表！绝不误杀正在运行的 Clash Verge、v2rayN 等其他客户端！
    if (live.server && !isPortMatching(live.server, expectedPort)) {
      console.log(`[SystemProxy] 当前注册表代理指向其他第三方客户端 (${live.server})，跳过异步恢复以保持其他客户端正常运行！`);
      this.isNexLinkControlling = false;
      this.originalBackup = null;
      this.clearDiskBackup();
      return true;
    }

    const hasDiskBackup = this.backupFilePath ? fs.existsSync(this.backupFilePath) : false;
    const isPointingToNexLink = isPortMatching(live.server, expectedPort);
    if (!isPointingToNexLink && !this.isNexLinkControlling && !this.originalBackup && !hasDiskBackup) {
      return true;
    }

    const plan = buildProxyRestorePlan(this.originalBackup, expectedPort);

    const psEscape = (val: string) => val.replace(/'/g, "''").replace(/[\r\n]/g, '');
    let script = `
Set-ItemProperty -Path '${REG_KEY}' -Name ProxyEnable -Value ${plan.proxyEnable} -Type DWord
Set-ItemProperty -Path '${REG_KEY}' -Name ProxyServer -Value '${psEscape(plan.proxyServer)}' -Type String
`;
    if (plan.proxyOverride !== null) {
      script += `Set-ItemProperty -Path '${REG_KEY}' -Name ProxyOverride -Value '${psEscape(plan.proxyOverride)}' -Type String\n`;
    } else {
      script += `Remove-ItemProperty -Path '${REG_KEY}' -Name ProxyOverride -ErrorAction SilentlyContinue\n`;
    }
    if (plan.autoConfigURL !== null) {
      script += `Set-ItemProperty -Path '${REG_KEY}' -Name AutoConfigURL -Value '${psEscape(plan.autoConfigURL)}' -Type String\n`;
    } else {
      script += `Remove-ItemProperty -Path '${REG_KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue\n`;
    }

    script += `
$source = @"
using System;
using System.Runtime.InteropServices;
public class WinINet {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@
Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue
[WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;

    try {
      await runPowerShell(script);
      this.isNexLinkControlling = false;
      this.originalBackup = null;
      this.clearDiskBackup();
      proxyGuard.stopGuard();
      console.log('[SystemProxy] 已安全恢复用户原始代理设置');
      return true;
    } catch (err: any) {
      console.error('[SystemProxy] 恢复系统代理设置失败:', err.message);
      return false;
    }
  }

  /**
   * 同步恢复系统代理（专供 Electron before-quit / will-quit / 核心崩溃紧急处理）
   * 使用 reg.exe 原生命令行毫秒级同步执行，绝不因 Electron 进程销毁而中断
   */
  public restoreProxySync(expectedPort: number = 7890): boolean {
    if (process.platform !== 'win32') return true;

    if (!this.originalBackup) {
      this.loadBackupFromDisk();
    }

    // 1. 读取 Windows 注册表实时的当前代理状态
    const live = this.readLiveProxyFn();
    if (live.readFailed) {
      console.warn('[SystemProxy] 同步恢复前无法读取实时注册表，跳过写操作避免误伤外部代理');
      return false;
    }

    // 关键安全隔离 1：如果当前注册表中配置了代理，且该代理端口指向其他客户端（即不等于 NexLink 的 expectedPort）
    // 无论 NexLink 内部状态如何，坚决不触碰注册表！绝不误杀正在运行的 Clash Verge、v2rayN 等其他客户端！
    if (live.server && !isPortMatching(live.server, expectedPort)) {
      console.log(`[SystemProxy] 当前注册表代理指向其他第三方客户端 (${live.server})，跳过恢复以保持其他客户端正常运行！`);
      this.isNexLinkControlling = false;
      this.originalBackup = null;
      this.clearDiskBackup();
      return true;
    }

    // 关键安全隔离 2：若当前注册表没有指向 NexLink，且 NexLink 没有接管记录且无备份，直接退出
    const hasDiskBackup = this.backupFilePath ? fs.existsSync(this.backupFilePath) : false;
    const isPointingToNexLink = isPortMatching(live.server, expectedPort);
    if (!isPointingToNexLink && !this.isNexLinkControlling && !this.originalBackup && !hasDiskBackup) {
      return true;
    }

    try {
      const plan = buildProxyRestorePlan(this.originalBackup, expectedPort);
      const deleteRegValueIfPresent = (valueName: string) => {
        try {
          execFileSync('reg.exe', ['delete', WIN_REG_PATH, '/v', valueName, '/f'], {
            timeout: 2000,
            windowsHide: true,
          });
        } catch {
          // 键原本不存在时 reg delete 返回非零，忽略即可
        }
      };

      execFileSync(
        'reg.exe',
        ['add', WIN_REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(plan.proxyEnable), '/f'],
        { timeout: 2000, windowsHide: true }
      );
      execFileSync(
        'reg.exe',
        ['add', WIN_REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', plan.proxyServer, '/f'],
        { timeout: 2000, windowsHide: true }
      );

      if (plan.proxyOverride !== null) {
        execFileSync(
          'reg.exe',
          ['add', WIN_REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', plan.proxyOverride, '/f'],
          { timeout: 2000, windowsHide: true }
        );
      } else {
        deleteRegValueIfPresent('ProxyOverride');
      }

      if (plan.autoConfigURL !== null) {
        execFileSync(
          'reg.exe',
          ['add', WIN_REG_PATH, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', plan.autoConfigURL, '/f'],
          { timeout: 2000, windowsHide: true }
        );
      } else {
        deleteRegValueIfPresent('AutoConfigURL');
      }

      // 毫秒级同步触发 WinINet 广播刷新
      try {
        const psRefresh = `
$ProgressPreference = 'SilentlyContinue';
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinINetFast {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@ -ErrorAction SilentlyContinue
[WinINetFast]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[WinINetFast]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`;
        const base64 = Buffer.from(psRefresh, 'utf16le').toString('base64');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', base64], { timeout: 3000, windowsHide: true });
      } catch (_e) {
        void _e;
        // reg.exe 已经生效，直连已就绪
      }

      this.isNexLinkControlling = false;
      this.originalBackup = null;
      this.clearDiskBackup();
      proxyGuard.stopGuard();
      console.log('[SystemProxy] 已同步安全恢复用户原生代理设置并清理备份');
      return true;
    } catch (err: any) {
      console.error('[SystemProxy] 同步恢复系统代理发生错误:', err.message);
      return false;
    }
  }

  public getOriginalBackup(): OriginalProxyBackup | null {
    return this.originalBackup;
  }

  public hasBackupFailed(): boolean {
    return this.backupFailed;
  }

  public getLastBackupError(): string | null {
    return this.lastBackupError;
  }

  public setOriginalBackup(backup: OriginalProxyBackup | null): void {
    this.originalBackup = backup;
    this.isNexLinkControlling = Boolean(backup);
    if (backup) {
      this.backupFailed = false;
      this.lastBackupError = null;
    }
  }
}

export const systemProxyManager = new SystemProxyManager();
