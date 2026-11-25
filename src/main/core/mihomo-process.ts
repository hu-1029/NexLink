/**
 * Mihomo (Clash Meta) 代理核心生命周期与进程安全管理器
 * 全面支持：真实进程启动/停止、配置预检、单实例锁与孤儿清理、异常退出与崩溃日志、
 * 本地 127.0.0.1 独立密钥 RESTful API 对接、流量实时推送与 Windows 代理安全回滚
 */

import { ChildProcess, execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { AppSettings, CoreStatus, LogItem, ProxyNode, TrafficStats, TunServiceStatus } from '../../shared/types';
import { isCurrentProcessAdmin } from '../network/tun-checker';
import { tunServiceManager } from '../network/service-manager';
import { ensureWintunDriver, getWintunStatus, type WintunDriverStatus } from '../network/wintun-manager';
import { systemProxyManager } from '../network/system-proxy';
import { storageManager } from '../storage/store';
import { MihomoApiClient } from './api-client';
import { buildMihomoConfig } from './config-builder';
import { validateMihomoConfig } from './config-validator';

/**
 * 检测本地指定端口是否未被占用 (可成功监听)
 */
export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * 校验本地指定端口是否可成功握手连接
 */
export async function canConnectToPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 400
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isSettled = false;
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      isSettled = true;
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      if (!isSettled) {
        isSettled = true;
        resolve(false);
      }
    });
    socket.once('error', () => {
      socket.destroy();
      if (!isSettled) {
        isSettled = true;
        resolve(false);
      }
    });
    socket.connect(port, host);
  });
}

/**
 * 检测本地指定端口当前是否处于 LISTENING 监听状态，并提取其 OwningProcess PID
 */
export function getListeningPidsForPort(port: number): number[] {
  if (process.platform !== 'win32') return [];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const suffix = `:${port}`;
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING' && parts[1].endsWith(suffix)) {
        const pid = parseInt(parts[4], 10);
        if (!isNaN(pid) && pid > 0) pids.add(pid);
      }
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

/**
 * 校验目标 PID 的进程名称是否确实包含 mihomo
 */
export interface PidFileRecord {
  pid: number;
  exePath?: string;
  runtimeDir?: string;
  startedAt?: number;
}

/**
 * 统一解析 PID 文件（兼容结构化 JSON 与旧版纯数字格式）
 */
export function parsePidFileContent(raw: string): PidFileRecord | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      const pid = Number(obj?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
      return {
        pid,
        exePath: typeof obj.exePath === 'string' ? obj.exePath : undefined,
        runtimeDir: typeof obj.runtimeDir === 'string' ? obj.runtimeDir : undefined,
        startedAt: typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : undefined,
      };
    } catch {
      return null;
    }
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = parseInt(trimmed, 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  return { pid };
}

/**
 * 严格验证目标 PID 是否确实为本客户端启动的 Mihomo 进程（进程名 + 完整可执行路径 + 命令行工作目录 + 启动时间）
 * 采用 fail-closed 策略：无法确认路径匹配时返回 false，绝不因 PID 复用或残留 PID 文件误杀其他程序。
 */
export interface LiveProcessProbeInfo {
  Name?: string;
  ExecutablePath?: string;
  CommandLine?: string;
  CreationMs?: number | null;
}

function normalizeComparePath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * 纯函数校验进程元数据是否确实为本客户端启动的 Mihomo（严格 fail-closed）：
 * 1. 进程名必须是 mihomo.exe / mihomo
 * 2. 提供 expectedExePath 时，必须取得 ExecutablePath 且完整路径精确一致
 * 3. 提供 expectedRuntimeDir 时，必须取得 CommandLine 且包含目标 runtimeDir
 * 4. 提供 expectedStartedAt 时，必须成功取得有效 CreationMs 且与 expectedStartedAt 差值 <= 30s
 */
export function evaluateOwnedMihomoProcessInfo(
  info: LiveProcessProbeInfo | null | undefined,
  expectedExePath?: string,
  expectedRuntimeDir?: string,
  expectedStartedAt?: number
): boolean {
  if (!info || typeof info !== 'object') return false;
  const procName = String(info.Name || '').trim().toLowerCase();
  if (procName !== 'mihomo.exe' && procName !== 'mihomo') return false;

  if (expectedExePath) {
    const exePath = typeof info.ExecutablePath === 'string' ? info.ExecutablePath.trim() : '';
    if (!exePath) return false;
    if (normalizeComparePath(exePath) !== normalizeComparePath(expectedExePath)) {
      return false;
    }
  }

  if (expectedRuntimeDir) {
    const cmdLine = typeof info.CommandLine === 'string' ? info.CommandLine.replace(/\//g, '\\').toLowerCase() : '';
    const targetDir = normalizeComparePath(expectedRuntimeDir);
    if (!cmdLine || !targetDir || !cmdLine.includes(targetDir)) {
      return false;
    }
  }

  if (typeof expectedStartedAt === 'number') {
    if (typeof info.CreationMs !== 'number' || !Number.isFinite(info.CreationMs) || info.CreationMs <= 0) {
      return false;
    }
    if (Math.abs(info.CreationMs - expectedStartedAt) > 30000) {
      return false;
    }
  }

  return true;
}

export function verifyOwnedMihomoProcess(
  pid: number,
  expectedExePath?: string,
  expectedRuntimeDir?: string,
  expectedStartedAt?: number
): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform !== 'win32') return true;
  try {
    const psQuery =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
      `if ($p) { $cms = $null; if ($p.CreationDate) { $cms = [int64]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ` +
      `[PSCustomObject]@{ Name=$p.Name; ExecutablePath=$p.ExecutablePath; CommandLine=$p.CommandLine; CreationMs=$cms } | ConvertTo-Json -Compress }`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psQuery],
      { encoding: 'utf8', timeout: 2000, windowsHide: true }
    ).trim();
    if (!out) return false;
    const info = JSON.parse(out) as LiveProcessProbeInfo;
    return evaluateOwnedMihomoProcessInfo(info, expectedExePath, expectedRuntimeDir, expectedStartedAt);
  } catch {
    return false;
  }
}

export function isPidMihomo(pid: number, expectedExePath?: string): boolean {
  return verifyOwnedMihomoProcess(pid, expectedExePath);
}

export interface ChildProcessLike {
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface TerminateChildDeps {
  verify?: typeof verifyOwnedMihomoProcess;
}

/**
 * 安全终止活跃子进程（消除验证与终止之间的 PID 复用竞争窗口）：
 * 1. 若 ChildProcess 已退出/已标记 killed，立即放弃，绝不回退按 PID 查杀。
 * 2. 先验证进程身份（路径 + runtimeDir + 启动时间）；无法确认时直接放弃。
 * 3. 验证后再次确认句柄仍存活（覆盖“验证后进程退出”窗口）。
 * 4. 仅通过 ChildProcess 自身持有的原生进程句柄执行一次 proc.kill('SIGKILL')
 *    （Windows 下 libuv 直接调用 TerminateProcess(process_handle)），绝不追加 taskkill /PID。
 */
export function terminateVerifiedChildProcess(
  proc: ChildProcessLike | null | undefined,
  expectedExePath: string,
  expectedRuntimeDir: string,
  expectedStartedAt?: number,
  deps?: TerminateChildDeps
): boolean {
  if (!proc) return false;
  const pid = proc.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (proc.killed || proc.exitCode !== null || (proc.signalCode !== undefined && proc.signalCode !== null)) {
    return false;
  }

  const verifyFn = deps?.verify ?? verifyOwnedMihomoProcess;
  if (!verifyFn(pid, expectedExePath, expectedRuntimeDir, expectedStartedAt)) {
    console.warn(`[MihomoProcess] 拒绝终止未通过归属验证的子进程 PID=${pid}`);
    return false;
  }

  // 二次检查：若在身份验证期间原进程已自然退出，立即放弃终止
  if (proc.killed || proc.exitCode !== null || (proc.signalCode !== undefined && proc.signalCode !== null)) {
    console.log(`[MihomoProcess] 子进程 PID=${pid} 在身份验证后已退出，放弃终止`);
    return false;
  }

  try {
    return Boolean(proc.kill('SIGKILL'));
  } catch {
    return false;
  }
}

export interface NativeProcessHandle {
  pid: number;
  isStillActive: () => boolean;
  probeInfo: () => LiveProcessProbeInfo | null;
  terminate: () => boolean;
  close: () => void;
}

export interface TerminateOrphanDeps {
  openHandle?: (pid: number) => NativeProcessHandle | null;
  runNativeWin32?: (
    pid: number,
    expectedExePath?: string,
    expectedRuntimeDir?: string,
    expectedStartedAt?: number
  ) => { terminated: boolean; reason: string };
}

/**
 * 生成 Windows 原生进程句柄原子验证与终止脚本（纯 ASCII + C# 5.0 P/Invoke）：
 * - 先 OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE) 获取内核句柄，
 *   持有句柄期间 Windows 内核保证该进程对象与 PID 不会被回收复用。
 * - 在同一句柄上依次完成：GetExitCodeProcess(STILL_ACTIVE) -> QueryFullProcessImageNameW ->
 *   GetProcessTimes(CreationMs) -> 校验 CommandLine -> TerminateProcess(hProc, 1) -> CloseHandle(hProc)。
 * - 全程不使用 taskkill /PID，彻底消除验证与终止之间的 TOCTOU 竞争窗口。
 */
export function buildWin32HandleVerifyAndTerminateScript(
  pid: number,
  expectedExePath?: string,
  expectedRuntimeDir?: string,
  expectedStartedAt?: number
): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const normExe = expectedExePath ? normalizeComparePath(expectedExePath) : '';
  const normRt = expectedRuntimeDir ? normalizeComparePath(expectedRuntimeDir) : '';
  const startedAtVal = typeof expectedStartedAt === 'number' && Number.isFinite(expectedStartedAt) ? Math.floor(expectedStartedAt) : -1;

  return [
    "$ErrorActionPreference = 'Stop'",
    "$targetPid = " + String(pid),
    "$expectedExe = '" + esc(normExe) + "'",
    "$expectedRt = '" + esc(normRt) + "'",
    "$expectedStartedAt = [int64]" + String(startedAtVal),
    "$csCode = @'",
    "using System;",
    "using System.IO;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class NexLinkProcHandleGuard {",
    "    private const uint PROCESS_TERMINATE = 0x0001;",
    "    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;",
    "    private const uint STILL_ACTIVE = 259;",
    "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);",
    "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "    public static extern bool CloseHandle(IntPtr hObject);",
    "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint exitCode);",
    "    [DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)]",
    "    public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, int flags, StringBuilder exeName, ref int size);",
    "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "    public static extern bool GetProcessTimes(IntPtr hProcess, out long creationTime, out long exitTime, out long kernelTime, out long userTime);",
    "    [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);",
    "    public static IntPtr OpenLocked(int pid) {",
    "        return OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, pid);",
    "    }",
    "    public static bool IsStillActive(IntPtr hProc) {",
    "        uint code = 0;",
    "        return GetExitCodeProcess(hProc, out code) && code == STILL_ACTIVE;",
    "    }",
    "    public static string GetImagePath(IntPtr hProc) {",
    "        int cap = 1024;",
    "        StringBuilder sb = new StringBuilder(cap);",
    "        if (!QueryFullProcessImageNameW(hProc, 0, sb, ref cap)) return \"\";",
    "        return sb.ToString();",
    "    }",
    "    public static long GetCreationUnixMs(IntPtr hProc) {",
    "        long c, e, k, u;",
    "        if (!GetProcessTimes(hProc, out c, out e, out k, out u) || c <= 0) return -1;",
    "        DateTime dt = DateTime.FromFileTimeUtc(c);",
    "        return (long)(dt - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;",
    "    }",
    "}",
    "'@",
    "if (-not ([System.Management.Automation.PSTypeName]'NexLinkProcHandleGuard').Type) { Add-Type -TypeDefinition $csCode -Language CSharp }",
    "$h = [NexLinkProcHandleGuard]::OpenLocked($targetPid)",
    "if ($h -eq [IntPtr]::Zero) { [PSCustomObject]@{ terminated=$false; reason='OPEN_FAILED' } | ConvertTo-Json -Compress; exit 0 }",
    "try {",
    "    if (-not [NexLinkProcHandleGuard]::IsStillActive($h)) { [PSCustomObject]@{ terminated=$false; reason='ALREADY_EXITED' } | ConvertTo-Json -Compress; exit 0 }",
    "    $imgPath = ([NexLinkProcHandleGuard]::GetImagePath($h)).Trim()",
    "    if (-not $imgPath) { [PSCustomObject]@{ terminated=$false; reason='IMAGE_PATH_UNAVAILABLE' } | ConvertTo-Json -Compress; exit 0 }",
    "    $imgName = [System.IO.Path]::GetFileName($imgPath).ToLowerInvariant()",
    "    if ($imgName -ne 'mihomo.exe' -and $imgName -ne 'mihomo') { [PSCustomObject]@{ terminated=$false; reason='NAME_MISMATCH' } | ConvertTo-Json -Compress; exit 0 }",
    "    $normImg = $imgPath.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant()",
    "    if ($expectedExe -and ($normImg -ne $expectedExe)) { [PSCustomObject]@{ terminated=$false; reason='EXE_PATH_MISMATCH' } | ConvertTo-Json -Compress; exit 0 }",
    "    $creationMs = [NexLinkProcHandleGuard]::GetCreationUnixMs($h)",
    "    if ($expectedStartedAt -gt 0) {",
    "        if ($creationMs -le 0 -or [Math]::Abs($creationMs - $expectedStartedAt) -gt 30000) { [PSCustomObject]@{ terminated=$false; reason='CREATION_TIME_MISMATCH' } | ConvertTo-Json -Compress; exit 0 }",
    "    }",
    "    if ($expectedRt) {",
    "        $cim = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $targetPid) -ErrorAction SilentlyContinue",
    "        if (-not $cim -or -not $cim.CommandLine) { [PSCustomObject]@{ terminated=$false; reason='CMDLINE_UNAVAILABLE' } | ConvertTo-Json -Compress; exit 0 }",
    "        $cmdNorm = ([string]$cim.CommandLine).Replace('/', '\\').ToLowerInvariant()",
    "        if (-not $cmdNorm.Contains($expectedRt)) { [PSCustomObject]@{ terminated=$false; reason='RUNTIME_DIR_MISMATCH' } | ConvertTo-Json -Compress; exit 0 }",
    "    }",
    "    if (-not [NexLinkProcHandleGuard]::IsStillActive($h)) { [PSCustomObject]@{ terminated=$false; reason='EXITED_AFTER_VERIFY' } | ConvertTo-Json -Compress; exit 0 }",
    "    $ok = [NexLinkProcHandleGuard]::TerminateProcess($h, 1)",
    "    [PSCustomObject]@{ terminated=[bool]$ok; reason=$(if ($ok) { 'TERMINATED' } else { 'TERMINATE_FAILED' }) } | ConvertTo-Json -Compress",
    "} finally {",
    "    [void][NexLinkProcHandleGuard]::CloseHandle($h)",
    "}",
  ].join('\r\n');
}

/**
 * 安全终止孤儿进程（使用 Windows 原生进程句柄原子完成身份校验与 TerminateProcess）：
 * - 持有句柄期间 PID 不可被系统复用，彻底消除验证与终止之间的竞争窗口。
 * - 身份无法确认或进程已退出时必须放弃终止（fail-closed）。
 * - 绝不调用 taskkill /PID。
 */
export function terminateVerifiedOrphanProcess(
  pid: number,
  expectedExePath?: string,
  expectedRuntimeDir?: string,
  expectedStartedAt?: number,
  deps?: TerminateOrphanDeps
): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;

  if (deps?.openHandle) {
    const handle = deps.openHandle(pid);
    if (!handle) return false;
    try {
      if (!handle.isStillActive()) return false;
      const info = handle.probeInfo();
      if (!evaluateOwnedMihomoProcessInfo(info, expectedExePath, expectedRuntimeDir, expectedStartedAt)) {
        return false;
      }
      if (!handle.isStillActive()) return false;
      return Boolean(handle.terminate());
    } finally {
      handle.close();
    }
  }

  if (deps?.runNativeWin32) {
    return Boolean(deps.runNativeWin32(pid, expectedExePath, expectedRuntimeDir, expectedStartedAt)?.terminated);
  }

  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const script = buildWin32HandleVerifyAndTerminateScript(
      pid,
      expectedExePath,
      expectedRuntimeDir,
      expectedStartedAt
    );
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 3500, windowsHide: true }
    ).trim();
    if (!out) return false;
    const parsed = JSON.parse(out) as { terminated?: boolean; reason?: string };
    return Boolean(parsed?.terminated);
  } catch {
    return false;
  }
}

export { isCurrentProcessAdmin };

export class MihomoProcessManager {
  private process: ChildProcess | null = null;
  private apiClient: MihomoApiClient;
  private currentStatus: CoreStatus = {
    running: false,
    version: 'Mihomo Meta v1.19.32',
    mixedPort: 7890,
    apiPort: 9097,
    uptime: 0,
    mode: 'rule',
  };

  private apiSecret: string = '';
  private mihomoExePath: string = '';
  private resourcesDir: string = '';
  private runtimeDir: string = '';
  private configPath: string = '';
  private logDir: string = '';
  private logPath: string = '';
  private crashLogPath: string = '';

  private isStopping: boolean = false;
  private tunActivatedInSession: boolean = false;
  private lifecycleQueue: Promise<any> = Promise.resolve();

  private withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.then(fn, fn);
    this.lifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  private startTime: number = 0;
  private runMode: 'service' | 'sidecar' = 'sidecar';
  private serviceCorePid: number | undefined = undefined;
  private serviceWatchdogTimer: NodeJS.Timeout | null = null;
  private serviceWatchdogInFlight: boolean = false;
  private serviceWatchdogMissCount: number = 0;
  private serviceWatchdogHooks?: {
    getServiceStatus?: () => Promise<TunServiceStatus>;
    getApiVersion?: () => Promise<any>;
    restoreProxy?: (port: number) => Promise<boolean>;
    cleanupRoutesViaService?: () => Promise<boolean>;
    isSystemProxyEnabled?: () => boolean;
  };
  private tunPrereqCheckHook?: (mixedPort: number) => Promise<{
    serviceReady: boolean;
    isAdmin: boolean;
    driverOk: boolean;
    driverError?: string;
  }>;
  private processStartedAt: number | undefined = undefined;
  private logStream: fs.WriteStream | null = null;
  private trafficStopFn: (() => void) | null = null;

  private totalUpload: number = 0;
  private totalDownload: number = 0;

  private onTrafficCallback?: (stats: TrafficStats) => void;
  private onStatusCallback?: (status: CoreStatus) => void;
  private onLogCallback?: (log: LogItem) => void;
  private logItems: LogItem[] = [];
  private logStreamStopFn: (() => void) | null = null;

  constructor() {
    this.apiClient = new MihomoApiClient(9097, '');
  }

  /**
   * 初始化工作路径与依赖规则库
   */
  public initialize(workDir: string, resourcesDir: string): void {
    this.resourcesDir = resourcesDir;
    // 无论是打包安装版（不可写入 Program Files）还是开发调试环境，均严格使用系统可写的运行时数据目录
    this.runtimeDir = path.basename(workDir) === 'runtime' ? workDir : path.join(workDir, 'runtime');
    const userMihomoPath = path.join(path.dirname(this.runtimeDir), 'mihomo', 'mihomo.exe');
    const bundledMihomoPath = path.join(resourcesDir, 'mihomo/mihomo.exe');
    if (fs.existsSync(userMihomoPath)) {
      try {
        const st = fs.statSync(userMihomoPath);
        if (st.isFile() && st.size >= 1024 * 1024) {
          this.mihomoExePath = userMihomoPath;
        } else {
          this.mihomoExePath = bundledMihomoPath;
        }
      } catch {
        this.mihomoExePath = bundledMihomoPath;
      }
    } else {
      this.mihomoExePath = bundledMihomoPath;
    }
    this.configPath = path.join(this.runtimeDir, 'config.yaml');
    this.logDir = path.join(this.runtimeDir, 'logs');
    this.logPath = path.join(this.logDir, 'mihomo.log');
    this.crashLogPath = path.join(this.logDir, 'crash.log');

    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
    this.cleanExpiredLogs(7);

    // 复制规则库文件 (Country.mmdb, ASN.mmdb, geoip.dat, geosite.dat)
    this.ensureRules(path.join(resourcesDir, 'rules'), this.runtimeDir);

    // 仅同步本地已自带的 wintun.dll 到运行时工作目录；不主动在冷启动时静默联网下载
    const wintunSrc = path.join(resourcesDir, 'mihomo/wintun.dll');
    const wintunDst = path.join(this.runtimeDir, 'wintun.dll');
    this.copyIfNewerOrMissing(wintunSrc, wintunDst);

    // 预热加载历史运行日志
    this.loadRecentLogsFromDisk(200);
  }

  /**
   * 设置事件监听回调
   */
  public setCallbacks(
    onTraffic: (stats: TrafficStats) => void,
    onStatus: (status: CoreStatus) => void,
    onLog?: (log: LogItem) => void
  ) {
    this.onTrafficCallback = onTraffic;
    this.onStatusCallback = onStatus;
    this.onLogCallback = onLog;
  }

  /**
   * 安全同步文件：当目标不存在、源文件修改时间更新或文件大小不同时自动覆盖同步
   */
  private copyIfNewerOrMissing(src: string, dst: string): void {
    if (!fs.existsSync(src)) return;
    try {
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.log(`[MihomoProcess] 已初始化核心依赖文件: ${path.basename(dst)}`);
        return;
      }
      const srcStat = fs.statSync(src);
      const dstStat = fs.statSync(dst);
      if (srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size) {
        fs.copyFileSync(src, dst);
        console.log(
          `[MihomoProcess] 检测到新版本资源，已同步更新: ${path.basename(dst)} (大小: ${dstStat.size} -> ${srcStat.size})`
        );
      }
    } catch (err: any) {
      console.warn(`[MihomoProcess] 同步文件 ${path.basename(dst)} 警告:`, err.message);
    }
  }

  /**
   * 确保地理规则库文件存在于运行时目录并保持最新
   */
  private ensureRules(rulesDir: string, destDir: string): void {
    if (!fs.existsSync(rulesDir)) return;
    try {
      const files = fs.readdirSync(rulesDir);
      for (const file of files) {
        if (file === '.gitkeep') continue;
        const src = path.join(rulesDir, file);
        const dst = path.join(destDir, file);
        this.copyIfNewerOrMissing(src, dst);
      }
    } catch (err: any) {
      console.warn('[MihomoProcess] 同步规则文件警告:', err.message);
    }
  }

  private getPidFilePath(): string {
    return path.join(this.runtimeDir, 'mihomo.pid');
  }

  public writePidFile(
    pid: number,
    exePath: string = this.mihomoExePath,
    runtimeDir: string = this.runtimeDir,
    startedAt: number = Date.now()
  ): void {
    try {
      const record: PidFileRecord = {
        pid,
        exePath: path.resolve(exePath),
        runtimeDir: path.resolve(runtimeDir),
        startedAt,
      };
      fs.writeFileSync(this.getPidFilePath(), JSON.stringify(record), 'utf8');
    } catch (_e) {
      void _e;
    }
  }

  private readAndConsumePidFile(): PidFileRecord | null {
    const pidFile = this.getPidFilePath();
    if (!fs.existsSync(pidFile)) return null;
    try {
      const raw = fs.readFileSync(pidFile, 'utf8');
      fs.unlinkSync(pidFile);
      return parsePidFileContent(raw);
    } catch (_e) {
      void _e;
      return null;
    }
  }

  /**
   * 准备并轮转日志文件，避免单文件无限增长
   */
  private rotateLogs(): void {
    try {
      if (fs.existsSync(this.logPath)) {
        const stats = fs.statSync(this.logPath);
        if (stats.size > 2 * 1024 * 1024) {
          const bakPath = path.join(this.logDir, 'mihomo.log.bak');
          if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
          fs.renameSync(this.logPath, bakPath);
          console.log('[MihomoProcess] 日志超出 2MB，已完成自动轮转');
        }
      }
    } catch (err: any) {
      console.warn('[MihomoProcess] 日志轮转警告:', err.message);
    }
  }

  /**
   * 清理运行时日志与崩溃记录
   */
  /**
   * 自动清理超过 7 天的历史日志文件，与其他主流代理客户端通用标准完全一致
   */
  public cleanExpiredLogs(maxDays = 7): void {
    try {
      if (!fs.existsSync(this.logDir)) return;
      const now = Date.now();
      const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (!file.endsWith('.log') && !file.endsWith('.bak')) continue;
        const filePath = path.join(this.logDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            console.log(`[MihomoProcess] 已按 7 天保存标准自动清理过期历史日志: ${file}`);
          }
        } catch {
          // ignore
        }
      }
    } catch (err: any) {
      console.warn('[MihomoProcess] 检查清理过期日志异常:', err.message);
    }
  }

  /**
   * 向内存循环缓冲区写入一条日志，并推送到渲染进程
   */
  public pushLog(
    levelOrItem: 'debug' | 'info' | 'warn' | 'error' | Partial<LogItem>,
    messageText?: string,
    rawTime?: string
  ): LogItem {
    let actualLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';
    let actualMessage = '';
    let actualTime = rawTime;

    if (typeof levelOrItem === 'object' && levelOrItem !== null) {
      actualLevel = levelOrItem.level || 'info';
      actualMessage = levelOrItem.message || '';
      actualTime = levelOrItem.time || rawTime;
    } else {
      actualLevel = levelOrItem || 'info';
      actualMessage = messageText || '';
    }

    const now = new Date();
    const timeStr =
      actualTime ||
      `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(
        now.getHours()
      ).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
        now.getSeconds()
      ).padStart(2, '0')}`;
    const item: LogItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time: timeStr,
      level: actualLevel,
      message: actualMessage.trim(),
    };
    this.logItems.push(item);
    if (this.logItems.length > 1000) {
      this.logItems.splice(0, this.logItems.length - 1000);
    }
    this.onLogCallback?.(item);
    return item;
  }

  /**
   * 解析 Mihomo 单行日志文本为标准 LogItem
   */
  public parseLogLine(rawLine: string): LogItem | null {
    const line = rawLine.trim();
    if (!line || line.startsWith('--- NexLink Mihomo')) return null;

    let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
    let message = line;
    let timeStr: string | undefined = undefined;

    // 匹配: time="2026-11-23T16:54:16.180564800+08:00"
    const timeMatch = line.match(/time="([^"]+)"/);
    if (timeMatch) {
      try {
        const d = new Date(timeMatch[1]);
        if (!isNaN(d.getTime())) {
          timeStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
            d.getHours()
          ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        }
      } catch {
        // ignore
      }
    }

    // 匹配 level
    const levelMatch = line.match(/\blevel=([a-zA-Z]+)\b/i);
    if (levelMatch) {
      const lvl = levelMatch[1].toLowerCase();
      if (lvl === 'warning' || lvl === 'warn') level = 'warn';
      else if (lvl === 'error' || lvl === 'fatal') level = 'error';
      else if (lvl === 'debug') level = 'debug';
      else level = 'info';
    } else {
      if (/^ERR\b|\[ERROR\]/i.test(line)) level = 'error';
      else if (/^WRN\b|\[WARN\]|warning/i.test(line)) level = 'warn';
      else if (/^DBG\b|\[DEBUG\]/i.test(line)) level = 'debug';
    }

    // 匹配 msg="..."
    const msgMatch = line.match(/\bmsg="([^"]+)"/);
    if (msgMatch) {
      message = msgMatch[1];
    } else if (timeMatch || levelMatch) {
      message = line
        .replace(/time="[^"]*"\s*/g, '')
        .replace(/level=[a-zA-Z]+\s*/g, '')
        .trim();
    }

    if (!message) return null;

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time:
        timeStr ||
        (() => {
          const now = new Date();
          return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(
            now.getHours()
          ).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        })(),
      level,
      message,
    };
  }

  /**
   * 从磁盘读取最近 N 行历史日志填入内存缓存
   */
  public loadRecentLogsFromDisk(maxLines = 200): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const content = fs.readFileSync(this.logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const recentLines = lines.slice(-maxLines);
      for (const line of recentLines) {
        const item = this.parseLogLine(line);
        if (item) {
          this.logItems.push(item);
        }
      }
      if (this.logItems.length > 1000) {
        this.logItems.splice(0, this.logItems.length - 1000);
      }
    } catch (err: any) {
      console.warn('[MihomoProcess] 加载磁盘历史日志失败:', err.message);
    }
  }

  /**
   * 实时解析并推送 stdout/stderr 输出
   */
  public parseAndPushStdout(text: string): void {
    const lines = text.split('\n');
    for (const raw of lines) {
      const item = this.parseLogLine(raw);
      if (item) {
        this.pushLog(item);
      }
    }
  }

  /**
   * 获取最近内存缓存的日志 (最多 1000 条)
   */
  public getLogs(): LogItem[] {
    if (this.logItems.length === 0) {
      this.loadRecentLogsFromDisk(200);
    }
    return [...this.logItems];
  }

  public clearLogs(): void {
    this.logItems = [];
    try {
      if (fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '', 'utf8');
      if (fs.existsSync(this.crashLogPath)) fs.writeFileSync(this.crashLogPath, '', 'utf8');
      console.log('[MihomoProcess] 已清空 mihomo.log 与 crash.log');
    } catch (err: any) {
      console.warn('[MihomoProcess] 清理日志异常:', err.message);
    }
  }

  /**
   * 启动前仅清理 NexLink 自己残留的孤儿进程（根据 PID 文件与端口智能核销）
   */
  private async killOrphanedMihomo(): Promise<void> {
    const rec = this.readAndConsumePidFile();
    if (rec) {
      const terminated = terminateVerifiedOrphanProcess(
        rec.pid,
        rec.exePath || this.mihomoExePath,
        rec.runtimeDir || this.runtimeDir,
        rec.startedAt
      );
      if (terminated) {
        console.log(`[MihomoProcess] 已通过原生进程句柄验证并清理历史核心进程: PID=${rec.pid}`);
      } else {
        console.log(`[MihomoProcess] PID 文件记录的 PID ${rec.pid} 未通过归属校验或已退出，跳过清理`);
      }
    }
    this.cleanupTunRoutesSync();
  }

  /**
   * 智能检测并清理霸占指定端口的残留 mihomo 进程
   */
  public autoHealPortCollisions(ports: number[]): void {
    if (process.platform !== 'win32') return;
    for (const port of ports) {
      const pids = getListeningPidsForPort(port);
      for (const pid of pids) {
        if (terminateVerifiedOrphanProcess(pid, this.mihomoExePath, this.runtimeDir)) {
          console.log(`[MihomoProcess] 发现端口 ${port} 被本客户端残留 mihomo 核心 (PID ${pid}) 占用，已通过原生句柄安全终止`);
        }
      }
    }
  }

  /**
   * 自动彻底清理残留的 TUN 路由黑洞与 Fake-IP 映射，并同步刷新 Windows 系统 DNS 解析器缓存，
   * 确保即便核心非正常退出或切换至第三方客户端时，浏览器也绝不发生 Fake-IP 悬空断网
   */
  public cleanupTunRoutesSync(): void {
    if (process.platform !== 'win32') return;
    if (!this.tunActivatedInSession) return;
    this.tunActivatedInSession = false;

    // 1. 同步清理路由表：仅在当前会话启用过 TUN 时删除默认全局 TUN 路由与 Fake-IP 网段路由
    try {
      execFileSync('route.exe', ['delete', '0.0.0.0', '198.18.0.2'], {
        stdio: 'ignore',
        timeout: 1500,
        windowsHide: true,
      });
    } catch (_e) {
      void _e;
    }

    try {
      execFileSync('route.exe', ['delete', '198.18.0.0'], {
        stdio: 'ignore',
        timeout: 1500,
        windowsHide: true,
      });
    } catch (_e) {
      void _e;
    }

    // 2. 瞬间清空 Windows DNS 客户端缓存 (普通用户权限即可执行，彻底清除浏览器及系统留存的旧 Fake-IP 缓存)
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Clear-DnsClientCache -ErrorAction SilentlyContinue'],
        {
          stdio: 'ignore',
          timeout: 2000,
          windowsHide: true,
        }
      );
    } catch (_e) {
      void _e;
    }

    // 3. 兜底尝试 ipconfig.exe /flushdns
    try {
      execFileSync('ipconfig.exe', ['/flushdns'], {
        stdio: 'ignore',
        timeout: 1500,
        windowsHide: true,
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * 强力终极清算：确保本软件关联的 Mihomo 进程被彻底杀死，绝不允许任何孤儿进程留在后台霸占端口
   */
  public forceKillAllSync(skipPid?: number): void {
    this.stopServiceWatchdog();
    const rec = this.readAndConsumePidFile();
    const proc = this.process;
    const procStartedAt = this.processStartedAt;
    this.process = null;
    this.processStartedAt = undefined;

    const killedLive = terminateVerifiedChildProcess(
      proc,
      this.mihomoExePath,
      this.runtimeDir,
      procStartedAt
    );
    const handledPid = killedLive ? proc?.pid : skipPid;

    if (rec && rec.pid !== handledPid) {
      terminateVerifiedOrphanProcess(
        rec.pid,
        rec.exePath || this.mihomoExePath,
        rec.runtimeDir || this.runtimeDir,
        rec.startedAt
      );
    }

    const mixedPort = this.currentStatus.mixedPort || 7890;
    const apiPort = this.currentStatus.apiPort || 9097;
    this.autoHealPortCollisions([mixedPort, apiPort]);

    this.cleanupTunRoutesSync();
    this.currentStatus.running = false;
  }

  /**
   * 启动核心
   */
  public start(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    return this.withLifecycleLock(() => this.startInternal(options));
  }

  private async startInternal(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    if (this.currentStatus.running && (this.process || this.runMode === 'service')) {
      return { success: true };
    }

    this.stopServiceWatchdog();
    this.isStopping = false;
    const { nodes, settings, selectedNodeName } = options;
    const mixedPort = settings.mixedPort || 7890;
    const apiPort = settings.apiPort || 9097;

    try {
      // 1. 生成安全随机 API 密钥（杜绝硬编码）
      this.apiSecret = crypto.randomBytes(16).toString('hex');

      // 1.5 检测虚拟网卡特权服务模式 (对标 Clash Verge Service Mode) 与管理员权限
      const prereqOverride = this.tunPrereqCheckHook
        ? await this.tunPrereqCheckHook(mixedPort)
        : null;
      const serviceReady = prereqOverride
        ? prereqOverride.serviceReady
        : await tunServiceManager.isServiceReady();
      const isAdmin = prereqOverride ? prereqOverride.isAdmin : isCurrentProcessAdmin();
      const useServiceMode = serviceReady;

      let effectiveSettings = settings;
      let tunDowngradeWarning: string | undefined;
      if (settings.tunMode) {
        if (!serviceReady && !isAdmin) {
          tunDowngradeWarning = '未安装虚拟网卡特权服务且非管理员权限，TUN 模式已安全降级为普通代理模式';
          console.warn(`[MihomoProcess] ${tunDowngradeWarning}`);
          effectiveSettings = { ...settings, tunMode: false };
        } else {
          const driverRes = prereqOverride
            ? { ok: prereqOverride.driverOk, error: prereqOverride.driverError }
            : await ensureWintunDriver(this.runtimeDir, this.resourcesDir, mixedPort);
          if (!driverRes.ok) {
            tunDowngradeWarning = `虚拟网卡驱动未就绪 (${driverRes.error || '未知错误'})，TUN 模式已安全降级为普通代理模式`;
            console.warn(`[MihomoProcess] ${tunDowngradeWarning}`);
            effectiveSettings = { ...settings, tunMode: false };
          }
        }
      }



      // 4. 清理残留孤儿进程并对端口执行智能自愈
      await this.killOrphanedMihomo();
      this.autoHealPortCollisions([mixedPort, apiPort]);

      // 5. 端口占用预检与智能自愈：在拉起前检查代理端口与控制端口
      let isMixedPortAvail = await isPortAvailable(mixedPort);
      let isApiPortAvail = await isPortAvailable(apiPort);

      // 若端口暂时未释放，尝试自愈清理并重试
      if (!isMixedPortAvail || !isApiPortAvail) {
        this.autoHealPortCollisions([mixedPort, apiPort]);
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (!isMixedPortAvail) isMixedPortAvail = await isPortAvailable(mixedPort);
          if (!isApiPortAvail) isApiPortAvail = await isPortAvailable(apiPort);
          if (isMixedPortAvail && isApiPortAvail) break;
        }
      }

      // 若仍被占用，二次终极核销清理孤儿进程并再次探测
      if (!isMixedPortAvail || !isApiPortAvail) {
        this.forceKillAllSync();
        this.autoHealPortCollisions([mixedPort, apiPort]);
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!isMixedPortAvail) isMixedPortAvail = await isPortAvailable(mixedPort);
          if (!isApiPortAvail) isApiPortAvail = await isPortAvailable(apiPort);
          if (isMixedPortAvail && isApiPortAvail) break;
        }
      }

      // 5.5 端口智能避让（Auto Port Fallback）：若端口仍被第三方软件或死锁进程占用，自动顺延探测可用端口，绝不弹窗阻断核心
      let actualMixedPort = mixedPort;
      if (!isMixedPortAvail) {
        console.warn(`[MihomoProcess] 代理端口 ${mixedPort} 被占用，正在自动智能避让并探测可用端口...`);
        for (let candidate = mixedPort + 1; candidate <= mixedPort + 20; candidate++) {
          if (await isPortAvailable(candidate)) {
            actualMixedPort = candidate;
            isMixedPortAvail = true;
            console.log(`[MihomoProcess] 已成功智能避让至可用代理端口: ${actualMixedPort}`);
            break;
          }
        }
      }

      let actualApiPort = apiPort;
      if (!isApiPortAvail) {
        console.warn(`[MihomoProcess] 控制端口 ${apiPort} 被占用，正在自动智能避让并探测可用端口...`);
        for (let candidate = apiPort + 1; candidate <= apiPort + 20; candidate++) {
          if (candidate !== actualMixedPort && (await isPortAvailable(candidate))) {
            actualApiPort = candidate;
            isApiPortAvail = true;
            console.log(`[MihomoProcess] 已成功智能避让至可用控制端口: ${actualApiPort}`);
            break;
          }
        }
      }

      if (!isMixedPortAvail) {
        const errorMsg = `代理端口 ${mixedPort} 及后续顺延端口均被占用，无法启动！\n请退出冲突软件后再开启核心。`;
        console.error('[MihomoProcess]', errorMsg);
        return { success: false, error: errorMsg };
      }

      if (!isApiPortAvail) {
        const errorMsg = `控制端口 ${apiPort} 及后续顺延端口均被占用，无法启动！\n请退出冲突软件后再开启核心。`;
        console.error('[MihomoProcess]', errorMsg);
        return { success: false, error: errorMsg };
      }

      // 5.6 动态生成完整的 Mihomo 运行时配置 YAML (采用最终确认可用的端口)
      effectiveSettings = {
        ...effectiveSettings,
        mixedPort: actualMixedPort,
        apiPort: actualApiPort,
      };

      const configYaml = buildMihomoConfig({
        nodes,
        settings: effectiveSettings,
        apiSecret: this.apiSecret,
        selectedNodeName,
      });

      fs.writeFileSync(this.configPath, configYaml, 'utf8');

      // 5.7 配置预检校验：调用 mihomo.exe -t 进行语法和出站合法性验证
      console.log('[MihomoProcess] 正在执行配置预检校验...');
      const validation = await validateMihomoConfig(
        this.mihomoExePath,
        this.configPath,
        this.runtimeDir
      );

      if (!validation.valid) {
        const errorMsg = `配置校验失败，已拒绝启动:\n${validation.error}`;
        console.error('[MihomoProcess]', errorMsg);
        return { success: false, error: errorMsg };
      }

      // 6. 准备日志文件轮转保护（关闭上次残留句柄，防止 Windows EBUSY）
      this.closeLogStream();
      this.rotateLogs();

      let lastStderrOutput = '';
      let activePid: number | undefined = undefined;

      // 7. 启动 Mihomo 进程（服务模式已就绪时由 LocalSystem 服务托管，否则普通子进程拉起）
      if (useServiceMode) {
        console.log(
          `[MihomoProcess] 通过虚拟网卡特权服务 (Service Mode) 拉起 Mihomo 核心 (代理:${actualMixedPort}, API:${actualApiPort}, TUN:${Boolean(effectiveSettings.tunMode)})`
        );
        const svcRes = await tunServiceManager.startCoreViaService({
          binPath: this.mihomoExePath,
          configDir: this.runtimeDir,
          configPath: this.configPath,
          apiPort: actualApiPort,
          secret: this.apiSecret,
          logPath: this.logPath,
        });
        if (!svcRes.ok) {
          return {
            success: false,
            error: `通过虚拟网卡服务启动核心失败: ${svcRes.error || '未知错误'}`,
          };
        }
        this.runMode = 'service';
        this.process = null;
        this.serviceCorePid = svcRes.pid;
        activePid = svcRes.pid;
        if (svcRes.pid) {
          this.writePidFile(
            svcRes.pid,
            path.join(tunServiceManager.getServiceDir(), 'bin', 'mihomo.exe'),
            path.join(tunServiceManager.getServiceDir(), 'runtime')
          );
        }
      } else {
        this.runMode = 'sidecar';
        this.serviceCorePid = undefined;
        const logStream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8' });
        logStream.on('error', (err) => {
          console.warn('[MihomoProcess] 日志流写入异常:', err.message);
        });
        const safeWriteLog = (text: string) => {
          if (!logStream.writableEnded && !logStream.destroyed) {
            try { logStream.write(text); } catch { /* ignore */ }
          }
        };
        this.logStream = logStream;
        const nowStr = new Date().toISOString();
        safeWriteLog(`\n--- NexLink Mihomo Core Starting at ${nowStr} ---\n`);

        console.log(`[MihomoProcess] 正在拉起 Mihomo 核心 (代理:${actualMixedPort}, API:${actualApiPort}): ${this.mihomoExePath}`);
        const child = spawn(
          this.mihomoExePath,
          [
            '-d',
            this.runtimeDir,
            '-f',
            this.configPath,
            '-ext-ctl',
            `127.0.0.1:${actualApiPort}`,
          ],
          {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );

        const childStartedAt = Date.now();
        this.process = child;
        this.processStartedAt = childStartedAt;
        activePid = child.pid;
        (child as any).isExpectedExit = false;

        if (child.pid) {
          this.writePidFile(child.pid, this.mihomoExePath, this.runtimeDir, childStartedAt);
        }

        child.stdout?.on('data', (data) => {
          const text = data.toString();
          safeWriteLog(text);
          this.parseAndPushStdout(text);
        });

        child.stderr?.on('data', (data) => {
          const text = data.toString();
          lastStderrOutput = (lastStderrOutput + text).slice(-4096);
          safeWriteLog(text);
          this.parseAndPushStdout(text);
        });

        child.on('error', (spawnErr) => {
          console.error('[MihomoProcess] 核心子进程启动或运行出错:', spawnErr.message);
          this.pushLog('error', `核心进程异常: ${spawnErr.message}`);
        });

        child.on('exit', (code, signal) => {
          console.log(`[MihomoProcess] 核心进程退出, 退出码: ${code}, 信号: ${signal}`);
          try { if (!logStream.writableEnded) logStream.end(); } catch { /* ignore */ }
          // 防止陈旧子进程异步退出事件污染新拉起的核心实例状态
          if (this.process !== child) {
            return;
          }
          this.logStream = null;
          const isExpected =
            (child as any).isExpectedExit ||
            this.isStopping ||
            signal === 'SIGINT' ||
            signal === 'SIGTERM' ||
            code === 0;

          if (!isExpected) {
            try {
              const crashContent = `[${new Date().toISOString()}] Mihomo 异常退出! 退出码: ${code}, 信号: ${signal}\n最近错误输出:\n${lastStderrOutput}\n\n`;
              fs.appendFileSync(this.crashLogPath, crashContent, 'utf8');
              console.error('[MihomoProcess] 检测到核心异常崩溃，已写入 crash.log');
            } catch (_logErr) {
              void _logErr;
            }
          }

          try {
            const pidFile = this.getPidFilePath();
            if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
          } catch (_e) {
            void _e;
          }

          this.process = null;
          this.processStartedAt = undefined;
          this.currentStatus.running = false;
          this.currentStatus.tunActive = false;
          this.onStatusCallback?.({ ...this.currentStatus });

          const liveSystemProxy = storageManager.getBaseDir()
            ? Boolean(storageManager.getSettings().systemProxy)
            : Boolean(settings.systemProxy);
          if (liveSystemProxy) {
            systemProxyManager.restoreProxySync(actualMixedPort);
          }

          this.cleanupTunRoutesSync();
        });
      }

      // 8. 更新 API 客户端凭据并等待控制 API 与代理端口真实就绪 (双向握手验证)
      this.apiClient.updateEndpoint(actualApiPort, this.apiSecret);
      let apiReady = false;
      let proxyPortReady = false;

      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          if (!apiReady) {
            const version = await this.apiClient.getVersion();
            if (version?.version) {
              apiReady = true;
              this.currentStatus.version = `Mihomo ${version.version}`;
            }
          }
          if (apiReady && !proxyPortReady) {
            proxyPortReady = await canConnectToPort(actualMixedPort);
          }
          if (apiReady && proxyPortReady) {
            break;
          }
        } catch {
          // 重试等待
        }
      }

      if (!apiReady) {
        console.error('[MihomoProcess] Mihomo 控制 API 响应超时，强制终止进程');
        await this.stopInternal();
        return {
          success: false,
          error: `Mihomo 核心启动失败或控制端口响应超时 (127.0.0.1:${actualApiPort})。\n${lastStderrOutput || '请查看运行日志 logs/mihomo.log 了解详情。'}`,
        };
      }

      if (!proxyPortReady) {
        console.error(`[MihomoProcess] Mihomo 代理端口 (127.0.0.1:${actualMixedPort}) 握手失败，停止核心`);
        await this.stopInternal();
        return {
          success: false,
          error: `Mihomo 核心已拉起但代理端口未能成功监听 (127.0.0.1:${actualMixedPort})。\n可能该端口被外部程序抢占或安全软件拦截。\n${lastStderrOutput || '请查看运行日志 logs/mihomo.log 了解详情。'}`,
        };
      }

      // 8. 启动实时流量推送
      this.startTime = Date.now();
      if (effectiveSettings.tunMode) {
        this.tunActivatedInSession = true;
      }
      this.currentStatus = {
        running: true,
        version: this.currentStatus.version,
        mixedPort: actualMixedPort,
        apiPort: actualApiPort,
        uptime: 0,
        mode: (settings.mode as any) || 'rule',
        coreRunMode: this.runMode,
        tunActive: Boolean(effectiveSettings.tunMode),
      };

      if (this.trafficStopFn) {
        this.trafficStopFn();
      }

      this.trafficStopFn = this.apiClient.startTrafficStream(
        (data) => {
          this.totalUpload += data.up;
          this.totalDownload += data.down;
          this.onTrafficCallback?.({
            up: data.up,
            down: data.down,
            upTotal: this.totalUpload,
            downTotal: this.totalDownload,
          });
        },
        (err) => {
          console.warn('[MihomoProcess] 流量流断开:', err.message);
        }
      );

      this.attachLogStream(settings.logLevel || 'info');
      this.pushLog('info', `Mihomo 代理核心已成功启动并就绪 (代理端口: ${actualMixedPort}, 控制端口: ${actualApiPort})`);

      // 8.5 核心就绪后，若指定了选定出站节点，立即通过 REST API 真正应用到策略组
      if (selectedNodeName) {
        try {
          await this.apiClient.selectProxy('🚀 节点选择', selectedNodeName);
          await this.apiClient.selectProxy('GLOBAL', selectedNodeName);
          console.log(`[MihomoProcess] 核心就绪，已成功真正应用出站节点: ${selectedNodeName}`);
        } catch (selErr: any) {
          console.warn('[MihomoProcess] 启动后自动应用指定节点提示:', selErr.message);
        }
      }

      // 9. 若开启了系统代理，配置 Windows 注册表并激活独立看门狗守护（同步携带用户自定义绕过白名单）
      if (settings.systemProxy) {
        await systemProxyManager.enableProxy(actualMixedPort, settings.bypassList, activePid);
      }

      if (tunDowngradeWarning) {
        this.pushLog('warn', tunDowngradeWarning);
      }

      if (this.runMode === 'service') {
        this.startServiceWatchdog();
      }

      this.onStatusCallback?.({ ...this.currentStatus });
      console.log('[MihomoProcess] Mihomo 核心已成功启动并就绪');
      return {
        success: true,
        ...(tunDowngradeWarning ? { warning: tunDowngradeWarning, tunDowngraded: true } : {}),
      };
    } catch (err: any) {
      console.error('[MihomoProcess] 启动过程发生未捕获异常:', err.message);
      await this.stopInternal();
      return {
        success: false,
        error: `启动异常: ${err.message}`,
      };
    }
  }

  /**
   * 停止核心并清理所有网络代理与子进程（严格终止本客户端创建的核心进程树，秒级彻底释放端口）
   */
  public stop(): Promise<boolean> {
    return this.withLifecycleLock(() => this.stopInternal());
  }

  private async stopInternal(): Promise<boolean> {
    this.isStopping = true;
    this.stopServiceWatchdog();

    // 1. 停止流量监听与日志监听
    if (this.trafficStopFn) {
      this.trafficStopFn();
      this.trafficStopFn = null;
    }
    if (this.logStreamStopFn) {
      this.logStreamStopFn();
      this.logStreamStopFn = null;
    }

    const mixedPort = this.currentStatus.mixedPort || 7890;
    const apiPort = this.currentStatus.apiPort || 9097;

    // 2. 必须安全恢复用户原始 Windows 代理配置（若检测到用户已切换到其他客户端则不予触碰）
    await systemProxyManager.restoreProxy(mixedPort);

    // 3. 终止核心进程（优先通知特权服务停止，兼容普通子进程树强杀）
    if (this.runMode === 'service') {
      await tunServiceManager.stopCoreViaService();
      this.serviceCorePid = undefined;
    }

    const proc = this.process;
    const procStartedAt = this.processStartedAt;
    if (proc) {
      (proc as any).isExpectedExit = true;
    }
    this.process = null;
    this.processStartedAt = undefined;

    const killedLive = terminateVerifiedChildProcess(
      proc,
      this.mihomoExePath,
      this.runtimeDir,
      procStartedAt
    );

    this.closeLogStream();

    // 4. 清算可能残留的孤儿进程与路由黑洞（跳过已由活跃句柄安全终止的同一 PID，杜绝重复终止）
    this.forceKillAllSync(killedLive ? proc?.pid : undefined);

    // 5. 快速确认端口释放回收（最多 800ms，每 50ms 轮询一次）
    for (let i = 0; i < 16; i++) {
      const isFree =
        (await isPortAvailable(mixedPort)) &&
        (await isPortAvailable(apiPort));
      if (isFree) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 6. 若端口依然未释放，主动执行端口自愈核销
    if (!(await isPortAvailable(mixedPort)) || !(await isPortAvailable(apiPort))) {
      this.autoHealPortCollisions([mixedPort, apiPort]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.currentStatus.running = false;
    this.currentStatus.tunActive = false;
    this.onStatusCallback?.({ ...this.currentStatus });
    console.log('[MihomoProcess] Mihomo 核心已安全停止，端口已释放，代理已恢复');
    return true;
  }

  /**
   * 启动 Service 模式健康心跳监控（防 SYSTEM 托管核心异常退出后 UI 永久假在线）
   */
  public startServiceWatchdog(
    intervalMs: number = 3000,
    hooks?: {
      getServiceStatus?: () => Promise<TunServiceStatus>;
      getApiVersion?: () => Promise<any>;
      restoreProxy?: (port: number) => Promise<boolean>;
      cleanupRoutesViaService?: () => Promise<boolean>;
      isSystemProxyEnabled?: () => boolean;
    }
  ): void {
    this.stopServiceWatchdog();
    this.serviceWatchdogHooks = hooks;
    this.serviceWatchdogTimer = setInterval(() => {
      void this.checkServiceCoreHealth();
    }, intervalMs);
    this.serviceWatchdogTimer.unref?.();
  }

  public stopServiceWatchdog(): void {
    if (this.serviceWatchdogTimer) {
      clearInterval(this.serviceWatchdogTimer);
      this.serviceWatchdogTimer = null;
    }
    this.serviceWatchdogMissCount = 0;
  }

  /**
   * 单次探测 Service 托管核心存活状态，确认失联/退出后自动恢复代理、清路由并重置状态
   */
  public async checkServiceCoreHealth(): Promise<boolean> {
    if (
      this.isStopping ||
      !this.currentStatus.running ||
      this.runMode !== 'service' ||
      this.serviceWatchdogInFlight
    ) {
      return false;
    }

    this.serviceWatchdogInFlight = true;
    try {
      const getSvcStatus =
        this.serviceWatchdogHooks?.getServiceStatus ??
        (() => tunServiceManager.getServiceStatus());
      const getApiVer =
        this.serviceWatchdogHooks?.getApiVersion ?? (() => this.apiClient.getVersion());

      let svcStatus: TunServiceStatus | null = null;
      try {
        svcStatus = await getSvcStatus();
      } catch {
        svcStatus = null;
      }

      if (svcStatus?.reachable) {
        if (svcStatus.coreRunning === true) {
          if (
            this.serviceCorePid &&
            svcStatus.corePid &&
            svcStatus.corePid !== this.serviceCorePid
          ) {
            console.warn(
              `[MihomoProcess] Service 核心 PID 变更 (${this.serviceCorePid} -> ${svcStatus.corePid})`
            );
            this.serviceCorePid = svcStatus.corePid;
          }
          try {
            await getApiVer();
            this.serviceWatchdogMissCount = 0;
            return true;
          } catch {
            // 服务声明运行但 REST API 无响应，计一次异常
            this.serviceWatchdogMissCount++;
          }
        } else {
          // 服务端明确确认 _coreProcess.HasExited === true
          this.serviceWatchdogMissCount = 2;
        }
      } else {
        // 服务不可达，回退探测 REST API 确认核心是否仍存活
        try {
          await getApiVer();
          this.serviceWatchdogMissCount = 0;
          return true;
        } catch {
          this.serviceWatchdogMissCount++;
        }
      }

      if (this.serviceWatchdogMissCount < 2) {
        return true;
      }

      await this.withLifecycleLock(async () => {
        if (this.isStopping || !this.currentStatus.running || this.runMode !== 'service') {
          return;
        }
        this.stopServiceWatchdog();
        console.error('[MihomoProcess] 检测到 Service 模式托管的 Mihomo 核心异常退出，正在执行自动善后恢复...');
        this.pushLog('error', '检测到服务模式核心异常退出，已自动恢复系统代理并重置运行状态');

        try {
          if (this.crashLogPath) {
            fs.appendFileSync(
              this.crashLogPath,
              `[${new Date().toISOString()}] Service 模式 Mihomo 异常退出 (PID=${this.serviceCorePid || 'unknown'})\n\n`,
              'utf8'
            );
          }
        } catch {
          // ignore
        }

        if (this.trafficStopFn) {
          this.trafficStopFn();
          this.trafficStopFn = null;
        }
        if (this.logStreamStopFn) {
          this.logStreamStopFn();
          this.logStreamStopFn = null;
        }

        try {
          const pidFile = this.getPidFilePath();
          if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch {
          // ignore
        }

        const mixedPort = this.currentStatus.mixedPort || 7890;
        this.serviceCorePid = undefined;
        this.currentStatus.running = false;
        this.currentStatus.tunActive = false;
        this.onStatusCallback?.({ ...this.currentStatus });

        const liveProxy = this.serviceWatchdogHooks?.isSystemProxyEnabled
          ? this.serviceWatchdogHooks.isSystemProxyEnabled()
          : Boolean(storageManager.getBaseDir() ? storageManager.getSettings().systemProxy : false);
        if (liveProxy) {
          const restoreFn =
            this.serviceWatchdogHooks?.restoreProxy ??
            ((p: number) => systemProxyManager.restoreProxy(p));
          await restoreFn(mixedPort).catch(() => false);
        }

        this.cleanupTunRoutesSync();
        if (svcStatus?.reachable) {
          const cleanupSvcFn =
            this.serviceWatchdogHooks?.cleanupRoutesViaService ??
            (() => tunServiceManager.cleanupRoutesViaService());
          await cleanupSvcFn().catch(() => false);
        }
      });

      return false;
    } finally {
      this.serviceWatchdogInFlight = false;
    }
  }

  /**
   * 重启核心
   */
  public restart(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    return this.withLifecycleLock(() => this.restartInternal(options));
  }

  private async restartInternal(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    await this.stopInternal();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.startInternal(options);
  }

  /**
   * 平滑热重载配置（订阅更新、节点变动时优先调用，零断网、不重置现有连接）
   */
  public hotReloadOrRestart(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    return this.withLifecycleLock(() => this.hotReloadOrRestartInternal(options));
  }

  private async hotReloadOrRestartInternal(options: {
    nodes: ProxyNode[];
    settings: AppSettings;
    selectedNodeName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string; tunDowngraded?: boolean }> {
    if (!this.currentStatus.running) {
      return this.startInternal(options);
    }

    const hotPort = this.currentStatus.mixedPort || options.settings.mixedPort || 7890;
    const prereqOverride = this.tunPrereqCheckHook
      ? await this.tunPrereqCheckHook(hotPort)
      : null;
    const serviceReady = prereqOverride
      ? prereqOverride.serviceReady
      : await tunServiceManager.isServiceReady();
    const isAdmin = prereqOverride ? prereqOverride.isAdmin : isCurrentProcessAdmin();
    let effectiveSettings = options.settings;
    let tunDowngradeWarning: string | undefined;

    if (options.settings.tunMode) {
      if (!serviceReady && !isAdmin) {
        tunDowngradeWarning = '未安装虚拟网卡特权服务且非管理员权限，TUN 模式已安全降级为普通代理模式';
        console.warn(`[MihomoProcess] 热重载: ${tunDowngradeWarning}`);
        effectiveSettings = { ...options.settings, tunMode: false };
      } else {
        const driverRes = prereqOverride
          ? { ok: prereqOverride.driverOk, error: prereqOverride.driverError }
          : await ensureWintunDriver(
              this.runtimeDir,
              this.resourcesDir,
              this.currentStatus.mixedPort || options.settings.mixedPort
            );
        if (!driverRes.ok) {
          tunDowngradeWarning = `虚拟网卡驱动未就绪 (${driverRes.error || '未知错误'})，TUN 模式已安全降级为普通代理模式`;
          console.warn(`[MihomoProcess] 热重载: ${tunDowngradeWarning}`);
          effectiveSettings = { ...options.settings, tunMode: false };
        } else if (serviceReady && this.runMode !== 'service') {
          // 刚安装完特权服务但当前核心仍是普通权限子进程，自动平滑迁移到服务模式以激活 TUN
          console.log('[MihomoProcess] 检测到特权服务已就绪，正在将核心从普通进程平滑切换至 Service Mode 以激活 TUN...');
          return this.restartInternal({ ...options, settings: effectiveSettings });
        }
      }
    }

    try {
      // 锁定当前实际运行端口，避免自动端口避让后热重载写回冲突端口
      const lockedSettings: AppSettings = {
        ...effectiveSettings,
        mixedPort: this.currentStatus.mixedPort || effectiveSettings.mixedPort || 7890,
        apiPort: this.currentStatus.apiPort || effectiveSettings.apiPort || 9097,
      };
      const newConfigYaml = buildMihomoConfig({
        nodes: options.nodes,
        settings: lockedSettings,
        apiSecret: this.apiSecret,
        selectedNodeName: options.selectedNodeName,
      });

      // 对比配置是否有实质改动
      if (fs.existsSync(this.configPath)) {
        const currentYaml = fs.readFileSync(this.configPath, 'utf8');
        if (currentYaml === newConfigYaml) {
          if (lockedSettings.mode) {
            this.currentStatus.mode = lockedSettings.mode;
          }
          if (tunDowngradeWarning) {
            this.pushLog('warn', tunDowngradeWarning);
          }
          console.log('[MihomoProcess] 配置内容未变动，无需重载');
          return {
            success: true,
            ...(tunDowngradeWarning ? { warning: tunDowngradeWarning, tunDowngraded: true } : {}),
          };
        }
      }

      // 预检校验新配置有效性
      const testConfigPath = path.join(this.runtimeDir, 'config.test.yaml');
      fs.writeFileSync(testConfigPath, newConfigYaml, 'utf8');
      const checkRes = await validateMihomoConfig(
        this.mihomoExePath,
        testConfigPath,
        this.runtimeDir
      );

      try {
        if (fs.existsSync(testConfigPath)) fs.unlinkSync(testConfigPath);
      } catch (_e) {
        void _e;
      }

      if (!checkRes.valid) {
        console.warn('[MihomoProcess] 新配置未通过预检，放弃热重载以保护现有连接:', checkRes.error);
        return { success: false, error: checkRes.error };
      }

      // 写入新配置
      fs.writeFileSync(this.configPath, newConfigYaml, 'utf8');

      // 调用 RESTful API 热重载
      console.log('[MihomoProcess] 正在执行无缝平滑热重载 (PUT /configs)...');
      await this.apiClient.reloadConfigs(this.configPath, true);
      this.attachLogStream(lockedSettings.logLevel || 'info');
      const wasTunActive = Boolean(this.currentStatus.tunActive);
      this.currentStatus.tunActive = Boolean(effectiveSettings.tunMode);
      if (lockedSettings.mode) {
        this.currentStatus.mode = lockedSettings.mode;
      }
      if (effectiveSettings.tunMode) this.tunActivatedInSession = true;
      if (tunDowngradeWarning) {
        this.pushLog('warn', tunDowngradeWarning);
      }
      this.onStatusCallback?.({ ...this.currentStatus });
      console.log('[MihomoProcess] 平滑热重载成功，现有网络连接无中断保持');

      // 若从 TUN 开启状态切换为关闭状态，必须清空旧 TUN 路由与系统 DNS 缓存
      if (wasTunActive && !effectiveSettings.tunMode) {
        console.log('[MihomoProcess] TUN 模式已关闭，正在同步清理路由残留与刷新系统 DNS 缓存...');
        this.cleanupTunRoutesSync();
        tunServiceManager.cleanupRoutesViaService().catch(() => {});
      }

      // 切换出站节点
      if (options.selectedNodeName) {
        try {
          await this.apiClient.selectProxy('🚀 节点选择', options.selectedNodeName);
          await this.apiClient.selectProxy('GLOBAL', options.selectedNodeName);
        } catch (_e) {
          void _e;
        }
      }

      return {
        success: true,
        ...(tunDowngradeWarning ? { warning: tunDowngradeWarning, tunDowngraded: true } : {}),
      };
    } catch (err: any) {
      console.warn('[MihomoProcess] 平滑热重载遇到异常，安全降级为重启核心:', err.message);
      return this.restartInternal({ ...options, settings: effectiveSettings });
    }
  }

  /**
   * 获取当前状态
   */
  public getStatus(): CoreStatus {
    if (this.currentStatus.running && this.startTime > 0) {
      this.currentStatus.uptime = Math.floor((Date.now() - this.startTime) / 1000);
    }
    return { ...this.currentStatus };
  }

  /**
   * 动态切换核心分流模式 (rule / global / direct)
   */
  public async setMode(mode: 'rule' | 'global' | 'direct'): Promise<boolean> {
    const prevMode = this.currentStatus.mode;
    if (this.currentStatus.running) {
      try {
        let ok = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          ok = await this.apiClient.changeMode(mode);
          if (ok) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!ok) {
          this.currentStatus.mode = prevMode;
          return false;
        }
        this.currentStatus.mode = mode;
        this.onStatusCallback?.({ ...this.currentStatus });
        return true;
      } catch (err: any) {
        this.currentStatus.mode = prevMode;
        console.error('[MihomoProcess] 动态切换分流模式异常:', err.message);
        return false;
      }
    }
    this.currentStatus.mode = mode;
    this.onStatusCallback?.({ ...this.currentStatus });
    return true;
  }

  private attachLogStream(logLevel: string = 'info'): void {
    if (this.logStreamStopFn) {
      this.logStreamStopFn();
      this.logStreamStopFn = null;
    }
    this.logStreamStopFn = this.apiClient.startLogStream(
      logLevel || 'info',
      (logData) => {
        const rawType = (logData.type || 'info').toLowerCase();
        const level: 'debug' | 'info' | 'warn' | 'error' =
          rawType === 'error'
            ? 'error'
            : rawType === 'warning' || rawType === 'warn'
            ? 'warn'
            : rawType === 'debug'
            ? 'debug'
            : 'info';
        this.pushLog(level, logData.payload);
      },
      (err) => {
        console.warn('[MihomoProcess] 实时日志流断开:', err.message);
      }
    );
  }

  private closeLogStream(): void {
    if (this.logStream) {
      try {
        this.logStream.end();
      } catch {
        // ignore
      }
      this.logStream = null;
    }
  }

  public getWintunStatus(): WintunDriverStatus {
    return getWintunStatus(this.runtimeDir, this.resourcesDir);
  }

  public async ensureWintunReady(): Promise<{ ok: boolean; dllPath: string; error?: string }> {
    const proxyPort = this.currentStatus.running ? this.currentStatus.mixedPort : undefined;
    return await ensureWintunDriver(this.runtimeDir, this.resourcesDir, proxyPort);
  }

  /**
   * 获取当前 Mihomo 可执行文件路径
   */
  public getMihomoExePath(): string {
    return this.mihomoExePath;
  }

  public setMihomoExePath(exePath: string): void {
    this.mihomoExePath = exePath;
  }

  public getUserMihomoDir(): string {
    return path.join(path.dirname(this.runtimeDir), 'mihomo');
  }

  public getBundledMihomoExePath(): string {
    return path.join(this.resourcesDir, 'mihomo/mihomo.exe');
  }

  public getRuntimeDir(): string {
    return this.runtimeDir;
  }

  /**
   * 查询指定或当前 mihomo.exe 的真实版本号（例如 v1.19.29）
   */
  public getInstalledCoreVersion(exePath?: string): string {
    try {
      const target = exePath || this.mihomoExePath;
      if (!target || !fs.existsSync(target)) {
        return '';
      }
      const out = execFileSync(target, ['-v'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const match = out.match(/v?\d+\.\d+\.\d+(?:-[\w.]+)?/i);
      if (match) {
        return match[0].startsWith('v') ? match[0] : `v${match[0]}`;
      }
      return '';
    } catch {
      return '';
    }
  }

  public getPid(): number | undefined {
    return this.process?.pid || this.serviceCorePid;
  }

  /**
   * 获取 REST API 客户端实例
   */
  public getApiClient(): MihomoApiClient {
    return this.apiClient;
  }

  /**
   * 获取当前生成的运行时 config.yaml 内容
   */
  public getRuntimeConfig(): string {
    if (this.configPath && fs.existsSync(this.configPath)) {
      try {
        return fs.readFileSync(this.configPath, 'utf8');
      } catch (err: any) {
        console.warn('[MihomoProcess] 读取运行时配置失败:', err.message);
      }
    }
    return '';
  }
}

export const mihomoManager = new MihomoProcessManager();
