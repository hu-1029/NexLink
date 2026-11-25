import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { UwpAppItem } from '../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const STRICT_UWP_SID_REGEX = /^S-1-15-2(?:-\d+){7}$/;

// 常见重要系统 UWP 应用的中文友好映射字典
const KNOWN_UWP_NAMES: Record<string, string> = {
  'microsoft.windowsstore': 'Microsoft Store (微软应用商店)',
  'microsoft.windowscalculator': 'Windows 计算器',
  'microsoft.windowsnotepad': 'Windows 记事本',
  'microsoft.screensketch': '截图和草图 (Snipping Tool)',
  'microsoft.paint': '画图 (Paint)',
  'microsoft.windowsterminal': 'Windows Terminal (终端)',
  'microsoft.windowscommunicationsapps': '邮件与日历 (Outlook Mail & Calendar)',
  'microsoft.gethelp': '获取帮助 (Get Help)',
  'microsoft.sechealthui': 'Windows 安全中心 (Defender UI)',
  'microsoft.bingweather': 'MSN 天气 (Weather)',
  'microsoft.bingnews': '微软新闻 (News)',
  'microsoft.xboxapp': 'Xbox 主机小帮手',
  'microsoft.gamingapp': 'Xbox App (游戏中心)',
  'microsoft.xboxidentityprovider': 'Xbox 身份验证服务',
  'microsoft.xboxgameoverlay': 'Xbox Game Bar',
  'microsoft.zunevideo': '电影和电视 (Movies & TV)',
  'microsoft.zunemusic': 'Windows Media Player (媒体播放器)',
  'microsoft.microsoftstickynotes': '便签 (Sticky Notes)',
  'microsoft.people': '人脉 (Contacts)',
  'microsoft.yourphone': '手机连接 (Phone Link)',
  'microsoft.todos': 'Microsoft To Do (待办事项)',
  'microsoft.whiteboard': 'Microsoft Whiteboard (白板)',
  'microsoft.powerautomatedesktop': 'Power Automate 桌面版',
  'microsoft.copilot': 'Microsoft Copilot',
  'clipchamp.clipchamp': 'Clipchamp 视频编辑器',
};

function resolveFriendlyName(moniker: string, rawDisplayName: string): string {
  const lowerMoniker = (moniker || '').toLowerCase().replace(/_[a-z0-9]+$/, '');

  // 1. 优先已知字典精准匹配
  if (KNOWN_UWP_NAMES[lowerMoniker]) {
    return KNOWN_UWP_NAMES[lowerMoniker];
  }

  // 2. 如果原始 DisplayName 不是资源占位符，且长度大于 1，直接使用
  if (rawDisplayName && !rawDisplayName.startsWith('ms-resource:') && !rawDisplayName.startsWith('@{')) {
    return rawDisplayName.trim();
  }

  // 3. 从 moniker 美化展示
  const clean = lowerMoniker
    .replace(/^microsoft\./i, 'Microsoft ')
    .replace(/^windows\./i, 'Windows ')
    .replace(/_/g, ' ');

  return clean || moniker;
}

/**
 * 检测当前进程是否拥有管理员权限
 */
async function isRunningAsAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execAsync('fltmc.exe', { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 批量执行 CheckNetIsolation 命令 (支持已有管理员权限直接执行或通过 PowerShell 提权执行)
 */
async function executeLoopbackSids(action: 'clear-and-add' | 'add-only' | 'clear-only', sids: string[]): Promise<boolean> {
  const safeSids = sids.filter((sid) => STRICT_UWP_SID_REGEX.test(sid));
  const isAdmin = await isRunningAsAdmin();

  if (isAdmin) {
    if (action === 'clear-and-add' || action === 'clear-only') {
      await execFileAsync('CheckNetIsolation.exe', ['LoopbackExempt', '-c'], { windowsHide: true, timeout: 10000 });
    }
    if (action === 'clear-and-add' || action === 'add-only') {
      for (const sid of safeSids) {
        try {
          await execFileAsync('CheckNetIsolation.exe', ['LoopbackExempt', '-a', `-p=${sid}`], { windowsHide: true, timeout: 10000 });
        } catch (err: any) {
          console.warn('[UwpTool] 添加豁免失败:', sid, err.message);
        }
      }
    }
    return true;
  }

  const innerLines: string[] = [];
  if (action === 'clear-and-add' || action === 'clear-only') {
    innerLines.push('& CheckNetIsolation.exe LoopbackExempt -c | Out-Null');
  }
  if ((action === 'clear-and-add' || action === 'add-only') && safeSids.length > 0) {
    const sidList = safeSids.map((s) => `'${s}'`).join(',');
    innerLines.push(`foreach ($s in @(${sidList})) { & CheckNetIsolation.exe LoopbackExempt -a "-p=$s" | Out-Null }`);
  }
  if (innerLines.length === 0) return true;
  const innerEncoded = Buffer.from(innerLines.join('\n'), 'utf16le').toString('base64');
  const launcher = `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${innerEncoded}' -Verb RunAs -Wait -WindowStyle Hidden`;
  const launcherEncoded = Buffer.from(launcher, 'utf16le').toString('base64');

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', launcherEncoded],
      { windowsHide: true, timeout: 30000 }
    );
    return true;
  } catch (err: any) {
    console.error('[UwpTool] 提权执行失败:', err.message);
    if (err.message && err.message.toLowerCase().includes('canceled')) {
      throw new Error('用户取消了管理员权限授权');
    }
    throw new Error(`执行失败: ${err.message}`);
  }
}

export class UwpToolService {
  /**
   * 获取系统所有 UWP 应用及其当前回环豁免状态
   */
  public async getUwpApps(): Promise<UwpAppItem[]> {
    if (process.platform !== 'win32') {
      return [];
    }

    try {
      // 1. 查询当前已豁免的 AppContainer SIDs (以纯 ASCII SID 匹配，彻底避免 Windows 控制台 GBK 乱码影响)
      const exemptSids = new Set<string>();
      try {
        const { stdout: sOutput } = await execAsync('CheckNetIsolation.exe LoopbackExempt -s', {
          windowsHide: true,
          encoding: 'utf8',
        });
        const sidRegex = /SID:\s*(S-1-15-2-[^\r\n\s]+)/gi;
        let match: RegExpExecArray | null;
        while ((match = sidRegex.exec(sOutput)) !== null) {
          exemptSids.add(match[1].trim());
        }
      } catch (err: any) {
        console.warn('[UwpTool] 获取已豁免列表异常:', err.message);
      }

      // 2. 查询注册表中的所有 AppContainer Mappings
      const appsMap = new Map<string, UwpAppItem>();
      try {
        const { stdout: regOutput } = await execAsync(
          'reg query "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings" /s',
          { windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
        );

        const sections = regOutput.split(
          /HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\/i
        );

        for (const sec of sections) {
          const lines = sec.trim().split('\n');
          if (lines.length < 2) continue;
          const sid = lines[0].trim();
          if (!sid.startsWith('S-1-15-2-')) continue;

          let rawDisplayName = '';
          let moniker = '';

          for (const line of lines) {
            if (line.includes('DisplayName')) {
              const parts = line.trim().split(/\s{2,}REG_SZ\s{2,}/);
              if (parts.length > 1) rawDisplayName = parts[1].trim();
            } else if (line.includes('Moniker')) {
              const parts = line.trim().split(/\s{2,}REG_SZ\s{2,}/);
              if (parts.length > 1) moniker = parts[1].trim();
            }
          }

          if (moniker || rawDisplayName) {
            const cleanMoniker = moniker || sid;
            const friendlyName = resolveFriendlyName(cleanMoniker, rawDisplayName);
            const isExempt = exemptSids.has(sid);

            appsMap.set(sid, {
              sid,
              packageFamilyName: cleanMoniker,
              displayName: friendlyName,
              isExempt,
            });
          }
        }
      } catch (err: any) {
        console.warn('[UwpTool] 查询 AppContainer 注册表失败:', err.message);
      }

      // 3. 排序：已豁免靠前，随后按中文友好名称字母序排序
      return Array.from(appsMap.values()).sort((a, b) => {
        if (a.isExempt !== b.isExempt) return a.isExempt ? -1 : 1;
        return a.displayName.localeCompare(b.displayName, 'zh-CN');
      });
    } catch (err: any) {
      console.error('[UwpTool] 获取 UWP 应用异常:', err);
      return [];
    }
  }

  /**
   * 一键为所有已识别的 UWP 应用开启回环豁免
   */
  public async exemptAll(): Promise<{ success: boolean; count: number; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, count: 0, error: '仅支持 Windows 系统' };
    }

    try {
      const apps = await this.getUwpApps();
      if (apps.length === 0) {
        return { success: false, count: 0, error: '未检测到已安装的 UWP 应用' };
      }

      const validSids = apps.map((app) => app.sid).filter((sid) => STRICT_UWP_SID_REGEX.test(sid));
      await executeLoopbackSids('add-only', validSids);

      return { success: true, count: validSids.length };
    } catch (err: any) {
      return { success: false, count: 0, error: err.message || String(err) };
    }
  }

  /**
   * 一键清除全部 UWP 回环豁免
   */
  public async clearAll(): Promise<{ success: boolean; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 系统' };
    }

    try {
      await executeLoopbackSids('clear-only', []);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * 保存自定义勾选的 UWP 豁免列表
   */
  public async saveExemptions(exemptSids: string[]): Promise<{ success: boolean; count: number; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, count: 0, error: '仅支持 Windows 系统' };
    }

    try {
      const validSids = exemptSids.filter((sid) => STRICT_UWP_SID_REGEX.test(sid));
      await executeLoopbackSids('clear-and-add', validSids);

      return { success: true, count: validSids.length };
    } catch (err: any) {
      return { success: false, count: 0, error: err.message || String(err) };
    }
  }
}

export const uwpToolService = new UwpToolService();
