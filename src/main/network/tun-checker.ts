/**
 * TUN 虚拟网卡模式前置条件检测与权限校验（对标 Clash Verge Rev Service Mode）
 */

import electron from 'electron';
import { exec, execFile, execFileSync } from 'child_process';
import util from 'util';
import { mihomoManager } from '../core/mihomo-process';
import { tunServiceManager } from './service-manager';

const electronApp = typeof electron === 'object' && electron ? (electron as any).app : undefined;
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

/**
 * 原生毫秒级零弹窗检测当前进程是否具备 Windows 管理员权限
 * (调用 Windows 原生 fltmc.exe 过滤管理器，管理员执行直接返回 0，非管理员抛出拒绝访问，无需拉起任何 powershell 窗口)
 */
export function isCurrentProcessAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync('fltmc.exe', [], { stdio: 'ignore', windowsHide: true, timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理历史版本遗留的 AppCompatFlags RUNASADMIN 注册表项
 * 对标 Clash Verge Rev：客户端 GUI 始终以普通用户权限运行（确保开机自启、文件拖拽正常且启动零 UAC 弹窗），
 * TUN 虚拟网卡的高权限由后台 LocalSystem 服务 (NexLinkCoreService) 独立承载。
 */
export function cleanupLegacyRunAsAdminRegistry(exePath = process.execPath): void {
  if (process.platform !== 'win32' || !exePath) return;
  if (exePath.toLowerCase().endsWith('node.exe')) return;

  try {
    execFileSync(
      'reg.exe',
      [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
        '/v',
        exePath,
        '/f',
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 2000 }
    );
  } catch {
    // 忽略项不存在
  }
}

/**
 * 兼容旧导出的别名函数：不再强制写入 RUNASADMIN，改为清理历史遗留项以遵循 Clash Verge 普通用户启动模型
 */
export function ensureRunAsAdminRegistry(exePath = process.execPath): void {
  cleanupLegacyRunAsAdminRegistry(exePath);
}

export interface TunCheckResult {
  isAdmin: boolean;
  serviceInstalled: boolean;
  serviceRunning: boolean;
  serviceReady: boolean;
  mode: 'service' | 'admin' | 'none';
  canEnableTun: boolean;
  message?: string;
}

export async function checkTunPrerequisites(): Promise<TunCheckResult> {
  if (process.platform !== 'win32') {
    return {
      isAdmin: false,
      serviceInstalled: false,
      serviceRunning: false,
      serviceReady: false,
      mode: 'none',
      canEnableTun: false,
      message: '当前操作系统非 Windows，TUN 驱动配置暂不适用',
    };
  }

  try {
    const checkAdminAsync = async (): Promise<boolean> => {
      try {
        await execFileAsync('fltmc.exe', [], { windowsHide: true, timeout: 1500 });
        return true;
      } catch {
        return false;
      }
    };
    const [serviceStatus, isAdmin] = await Promise.all([
      tunServiceManager.getServiceStatus(),
      checkAdminAsync(),
    ]);

    if (serviceStatus.reachable) {
      return {
        isAdmin,
        serviceInstalled: true,
        serviceRunning: true,
        serviceReady: true,
        mode: 'service',
        canEnableTun: true,
        message: '虚拟网卡服务模式运行正常，无需管理员权限即可直接开启 TUN',
      };
    }

    if (isAdmin) {
      return {
        isAdmin: true,
        serviceInstalled: serviceStatus.installed,
        serviceRunning: serviceStatus.running,
        serviceReady: false,
        mode: 'admin',
        canEnableTun: true,
        message: '当前具备管理员权限，可启用 TUN 模式（推荐安装虚拟网卡服务以实现普通权限免弹窗秒开）',
      };
    }

    return {
      isAdmin: false,
      serviceInstalled: serviceStatus.installed,
      serviceRunning: serviceStatus.running,
      serviceReady: false,
      mode: 'none',
      canEnableTun: false,
      message: serviceStatus.installed
        ? '检测到虚拟网卡服务已安装但未运行，请重新安装或启动服务后直接开启 TUN。'
        : '首次启用 TUN 虚拟网卡需安装一次性后台服务，安装后日常开关 TUN 均无需管理员权限。',
    };
  } catch (err: any) {
    return {
      isAdmin: false,
      serviceInstalled: false,
      serviceRunning: false,
      serviceReady: false,
      mode: 'none',
      canEnableTun: false,
      message: `检测 TUN 运行环境异常: ${err.message}`,
    };
  }
}

/**
 * 构造提权重启 PowerShell 命令脚本：dev 模式下使用 -EncodedCommand 包装内层命令，彻底避免空格与嵌套单引号冲突
 */
export function buildRestartAsAdminPsScript(options: {
  isPackaged: boolean;
  execPath: string;
  cwd: string;
}): string {
  const psEscape = (s: string) => s.replace(/'/g, "''");
  if (options.isPackaged) {
    return `Start-Process -FilePath '${psEscape(options.execPath)}' -ArgumentList '--relaunch' -Verb RunAs`;
  }
  const innerCmd = `Set-Location -LiteralPath '${psEscape(options.cwd)}'; npm run dev`;
  const innerEncoded = Buffer.from(innerCmd, 'utf16le').toString('base64');
  return `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-EncodedCommand','${innerEncoded}' -Verb RunAs`;
}

/**
 * 兜底选项：以 Windows 管理员权限重新拉起 NexLink 客户端 (严禁黑框弹窗)
 */
export async function restartAsAdmin(options?: {
  execCommand?: (cmd: string, opts?: any) => Promise<any>;
  appInstance?: any;
  mihomo?: any;
  platform?: string;
}): Promise<boolean> {
  const currentPlatform = options?.platform ?? process.platform;
  if (currentPlatform !== 'win32') return false;
  const execFn = options?.execCommand ?? execAsync;
  const appInst = options?.appInstance ?? electronApp;
  const mihomo = options?.mihomo ?? mihomoManager;

  try {
    const psScript = buildRestartAsAdminPsScript({
      isPackaged: Boolean(appInst?.isPackaged),
      execPath: process.execPath,
      cwd: process.cwd(),
    });
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    // 先触发 UAC 提权拉起新实例（新实例 --relaunch 具备 10s 单实例锁等待窗口），避免用户取消 UAC 时已断开当前代理
    if (options?.execCommand) {
      await execFn(`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`, { windowsHide: true });
    } else {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true });
    }

    await mihomo.stop();
    appInst?.releaseSingleInstanceLock?.();
    appInst?.quit?.();
    return true;
  } catch (err: any) {
    console.error('[TunChecker] 提权重启失败:', err.message);
    return false;
  }
}
