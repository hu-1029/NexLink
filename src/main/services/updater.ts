/**
 * NexLink 软件版本检测与自动更新管理器
 * 负责 GitHub Releases 检测、版本语义比对、更新包断点续传/流式下载与安全安装启动
 */

import * as Electron from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import type { UpdateDownloadProgress, UpdateInfo } from '../../shared/types';
import { storageManager } from '../storage/store';
import { systemProxyManager } from '../network/system-proxy';
import { mihomoManager } from '../core/mihomo-process';
import { IPC_CHANNELS } from '../../shared/ipc-events';

/**
 * 校验更新包下载地址是否来自官方 GitHub 安全域名
 */
export function isValidGithubReleaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const validExactHosts = [
      'github.com',
      'api.github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
      'github-production-release-asset-2e65be.s3.amazonaws.com',
    ];
    return (
      validExactHosts.includes(parsed.hostname) ||
      parsed.hostname.endsWith('.github.com') ||
      parsed.hostname.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

/**
 * 从文本 (Release Body 或校验文件) 中提取预期 SHA256 散列值
 */
export function extractSha256FromText(text: string, assetName?: string): string | undefined {
  if (!text) return undefined;

  // 1. 若指定文件名，优先匹配校验和列表格式: "<hash>  filename" 或 "<hash> *filename"
  if (assetName) {
    const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fileRegex = new RegExp(`([a-fA-F0-9]{64})\\s+[*]?${escaped}`, 'i');
    const match = text.match(fileRegex);
    if (match) return match[1].toLowerCase();
  }

  // 2. 匹配键值对形式，例如 "SHA256: <hash>" 或 "sha-256 = <hash>"
  const kvMatch = text.match(/sha-?256\s*[:=]\s*([a-fA-F0-9]{64})/i);
  if (kvMatch) return kvMatch[1].toLowerCase();

  // 3. 匹配独立的 64 位十六进制行
  const lineMatch = text.match(/^[a-fA-F0-9]{64}$/m);
  if (lineMatch) return lineMatch[0].toLowerCase();

  return undefined;
}

export class UpdateService {
  private abortController: AbortController | null = null;
  private isDownloading = false;
  private downloadedFilePath: string | null = null;
  private downloadedFileVerified = false;
  private latestUpdateInfo: UpdateInfo | null = null;
  private autoCheckTimer: NodeJS.Timeout | null = null;
  private beforeQuitCallback?: (() => Promise<void> | void) | null = null;

  public setBeforeQuitCallback(cb: () => Promise<void> | void): void {
    this.beforeQuitCallback = cb;
  }

  /**
   * 语义化版本比对
   * 返回 > 0: v1 > v2 (有新版本)
   * 返回 0: v1 == v2 (版本一致)
   * 返回 < 0: v1 < v2
   */
  public compareVersions(v1: string, v2: string): number {
    const clean1 = (v1 || '').replace(/^[vV]/, '').trim();
    const clean2 = (v2 || '').replace(/^[vV]/, '').trim();

    if (!clean1 && !clean2) return 0;
    if (!clean1) return -1;
    if (!clean2) return 1;

    // 分离预发布标签 (如 1.0.0-beta.1)
    const [main1, pre1] = clean1.split('-');
    const [main2, pre2] = clean2.split('-');

    const parts1 = main1.split('.').map((p) => parseInt(p, 10) || 0);
    const parts2 = main2.split('.').map((p) => parseInt(p, 10) || 0);

    const maxLength = Math.max(parts1.length, parts2.length, 3);
    for (let i = 0; i < maxLength; i++) {
      const p1 = parts1[i] ?? 0;
      const p2 = parts2[i] ?? 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }

    // 主版本号完全一致时，无预发布标识大于有预发布标识 (如 1.0.0 > 1.0.0-rc1)
    if (!pre1 && pre2) return 1;
    if (pre1 && !pre2) return -1;
    if (pre1 && pre2) {
      return pre1.localeCompare(pre2);
    }

    return 0;
  }

  /**
   * 获取当前应用版本号
   */
  public getCurrentVersion(): string {
    if (Electron.app?.getVersion) {
      return Electron.app.getVersion();
    }
    return '0.1.0';
  }

  /**
   * 获取当前已下载且通过安全验证的安装包路径
   */
  public getDownloadedFilePath(): string | null {
    if (this.downloadedFileVerified && this.downloadedFilePath && fs.existsSync(this.downloadedFilePath)) {
      return this.downloadedFilePath;
    }
    return null;
  }

  /**
   * 检查软件更新 (使用 releases 列表 API，完整覆盖正式版与预发布版 Pre-release)
   */
  public async checkUpdate(options?: {
    repo?: string;
    mockUpdate?: boolean;
    mockVersion?: string;
    mockSha256?: string;
  }): Promise<UpdateInfo> {
    const currentVer = this.getCurrentVersion();
    const settings = storageManager.getSettings();
    const rawRepo = options?.repo || settings?.githubRepo || 'hu-1029/NexLink';
    const repo = rawRepo.trim();

    // 记录本次检查时间戳
    try {
      storageManager.saveSettings({ lastCheckUpdateAt: Date.now() });
    } catch (_err) {
      void _err;
    }

    // 单元测试或本地模拟分支
    if (options?.mockUpdate) {
      const mockVer = options.mockVersion || '0.2.0';
      const hasUpdate = this.compareVersions(mockVer, currentVer) > 0;
      const mockInfo: UpdateInfo = {
        hasUpdate,
        currentVersion: currentVer,
        latestVersion: mockVer,
        releaseName: `NexLink v${mockVer} 体验版发布`,
        releaseDate: new Date().toISOString().split('T')[0],
        releaseNotes: [
          '### NexLink 新版特性速览',
          '- 🚀 新增：一键检查更新与自动后台静默升级服务',
          '- ⚡ 优化：UWP 回环免流极速保存与一键隔离策略',
          '- 🛡️ 加固：Mihomo 核心运行配置原子校验与崩溃保护',
        ].join('\n'),
        downloadUrl: `https://github.com/${repo}/releases/download/v${mockVer}/NexLink-Setup-${mockVer}.exe`,
        assetName: `NexLink-Setup-${mockVer}.exe`,
        assetSize: 45 * 1024 * 1024,
        expectedSha256: options.mockSha256 || undefined,
        htmlUrl: `https://github.com/${repo}/releases/tag/v${mockVer}`,
      };
      this.latestUpdateInfo = mockInfo;
      return mockInfo;
    }

    // 强校验 GitHub 仓库命名合法性 (必须为 owner/repo)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`非法的 GitHub 仓库全称格式: ${repo}`);
    }

    // 改为请求全量版本列表 (per_page=10)，支持发现预发布版 (Pre-release)
    const apiUrl = `https://api.github.com/repos/${repo}/releases?per_page=10`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      const fetchFn = (Electron.net?.fetch as typeof fetch) || globalThis.fetch;
      const response = await fetchFn(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'NexLink-Desktop-Client',
          Accept: 'application/vnd.github.v3+json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 404 说明仓库暂未发布 Release
      if (response.status === 404) {
        const notFoundInfo: UpdateInfo = {
          hasUpdate: false,
          currentVersion: currentVer,
          latestVersion: currentVer,
          releaseNotes: '当前已是最新版本，暂无新版本发布。',
          htmlUrl: `https://github.com/${repo}/releases`,
        };
        this.latestUpdateInfo = notFoundInfo;
        return notFoundInfo;
      }

      if (!response.ok) {
        throw new Error(`GitHub API 响应异常: HTTP ${response.status} ${response.statusText}`);
      }

      const rawData = await response.json();
      const releaseList = (Array.isArray(rawData) ? rawData : [rawData]) as any[];

      // 过滤掉草稿 (draft)
      const validReleases = releaseList.filter((r) => !r.draft);

      if (validReleases.length === 0) {
        const notFoundInfo: UpdateInfo = {
          hasUpdate: false,
          currentVersion: currentVer,
          latestVersion: currentVer,
          releaseNotes: '当前已是最新版本，暂无新版本发布。',
          htmlUrl: `https://github.com/${repo}/releases`,
        };
        this.latestUpdateInfo = notFoundInfo;
        return notFoundInfo;
      }

      // 寻找版本号最高且大于当前版本的 release
      let bestRelease: any = null;
      let highestVer = currentVer;

      for (const rel of validReleases) {
        const tag = String(rel.tag_name || rel.name || '').trim();
        const ver = tag.replace(/^[vV]/, '');
        if (this.compareVersions(ver, highestVer) > 0) {
          highestVer = ver;
          bestRelease = rel;
        }
      }

      const hasUpdate = Boolean(bestRelease);
      const targetRelease = bestRelease || validReleases[0];
      const remoteTag = String(targetRelease.tag_name || targetRelease.name || '').trim();
      const latestVer = remoteTag.replace(/^[vV]/, '');

      // 依据当前运行形态（便携版 vs 标准安装版）智能匹配对应的安装包资产
      const assets = Array.isArray(targetRelease.assets) ? targetRelease.assets : [];
      const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
      const exeAssets = assets.filter(
        (a: any) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.exe')
      );
      const isPortableName = (n: string) => {
        const lower = n.toLowerCase();
        return lower.includes('portable') || n.includes('便携');
      };
      const isSetupName = (n: string) => {
        const lower = n.toLowerCase();
        return lower.includes('setup') || n.includes('安装');
      };
      const exeAsset = isPortable
        ? exeAssets.find((a: any) => isPortableName(a.name)) ||
          exeAssets.find((a: any) => !isSetupName(a.name))
        : exeAssets.find((a: any) => isSetupName(a.name) && !isPortableName(a.name)) ||
          exeAssets.find((a: any) => !isPortableName(a.name));

      const assetName = exeAsset?.name || '';

      // 提取预期的 SHA256 完整性哈希（优先 GitHub asset.digest，其次 Release 正文与校验文件）
      let expectedSha256: string | undefined;
      if (typeof exeAsset?.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/i.test(exeAsset.digest.trim())) {
        expectedSha256 = exeAsset.digest.trim().slice(7).toLowerCase();
      }
      if (!expectedSha256) {
        expectedSha256 = extractSha256FromText(targetRelease.body || '', assetName);
      }

      // 若 body 中未声明，尝试检查 assets 中是否存在 .sha256 文件
      if (!expectedSha256) {
        const shaAsset = assets.find(
          (a: any) =>
            typeof a.name === 'string' &&
            (a.name.toLowerCase().endsWith('.sha256') ||
              a.name.toLowerCase().endsWith('.sha256.txt') ||
              a.name.toLowerCase() === 'shasums256.txt')
        );
        if (shaAsset?.browser_download_url && isValidGithubReleaseUrl(shaAsset.browser_download_url)) {
          try {
            const shaRes = await fetchFn(shaAsset.browser_download_url, {
              headers: { 'User-Agent': 'NexLink-Desktop-Client' },
            });
            if (shaRes.ok) {
              const shaContent = await shaRes.text();
              expectedSha256 = extractSha256FromText(shaContent, assetName);
            }
          } catch (_err) {
            void _err;
          }
        }
      }

      const updateInfo: UpdateInfo = {
        hasUpdate,
        currentVersion: currentVer,
        latestVersion: latestVer,
        releaseName: targetRelease.name || `NexLink ${remoteTag}`,
        releaseDate: targetRelease.published_at ? targetRelease.published_at.split('T')[0] : undefined,
        releaseNotes: targetRelease.body || '无详细更新说明。',
        downloadUrl: exeAsset?.browser_download_url || undefined,
        assetName,
        assetSize: exeAsset?.size || 0,
        expectedSha256,
        htmlUrl: targetRelease.html_url || `https://github.com/${repo}/releases`,
        isPrerelease: Boolean(targetRelease.prerelease),
      };

      this.latestUpdateInfo = updateInfo;
      return updateInfo;
    } catch (err: any) {
      console.warn('[UpdateService] 检查更新遇到网络或 API 限制:', err.message);
      const errorInfo: UpdateInfo = {
        hasUpdate: false,
        currentVersion: currentVer,
        error: err.name === 'AbortError' ? '连接更新服务器超时，请检查网络设置' : (err.message || '网络连接异常'),
        htmlUrl: `https://github.com/${repo}/releases`,
      };
      this.latestUpdateInfo = errorInfo;
      return errorInfo;
    }
  }

  /**
   * 下载更新包，包含官方域名白名单拦截、流式进度回调与 SHA256 完整性校验
   */
  public async downloadUpdate(
    downloadUrl?: string,
    onProgress?: (progress: UpdateDownloadProgress) => void
  ): Promise<{ success: boolean; filePath?: string; actualSha256?: string; error?: string }> {
    // 安全防护：优先使用主进程 checkUpdate 校验并缓存的下载地址
    const targetUrl = this.latestUpdateInfo?.downloadUrl || downloadUrl;
    if (!targetUrl) {
      return { success: false, error: '未找到有效的更新下载链接' };
    }

    // 强校验下载地址域名安全白名单，拒绝任何来自非官方 GitHub 域名的下载请求
    if (!isValidGithubReleaseUrl(targetUrl)) {
      return {
        success: false,
        error: `不安全的更新下载地址：仅允许来自 GitHub 官方安全域名的更新包 (${targetUrl})`,
      };
    }

    if (this.isDownloading) {
      return { success: false, error: '已有更新正在下载中，请勿重复操作' };
    }

    this.isDownloading = true;
    this.downloadedFileVerified = false;
    this.abortController = new AbortController();

    const tempDir = Electron.app?.getPath ? Electron.app.getPath('temp') : os.tmpdir();
    const rawFileName =
      this.latestUpdateInfo?.assetName || `NexLink-Update-${Date.now()}.exe`;
    const safeFileName = path.basename(rawFileName).replace(/[^a-zA-Z0-9._-]/g, '_') || `NexLink-Update-${Date.now()}.exe`;
    const tempFilePath = path.join(tempDir, safeFileName);

    try {
      onProgress?.({
        status: 'downloading',
        percent: 0,
        transferred: 0,
        total: this.latestUpdateInfo?.assetSize || 0,
        speed: 0,
        updateInfo: this.latestUpdateInfo || undefined,
      });

      const fetchFn = (Electron.net?.fetch as typeof fetch) || globalThis.fetch;
      const response = await fetchFn(targetUrl, {
        headers: {
          'User-Agent': 'NexLink-Desktop-Client',
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`下载更新文件失败: HTTP ${response.status} ${response.statusText}`);
      }

      const totalBytes =
        Number(response.headers.get('content-length')) || this.latestUpdateInfo?.assetSize || 0;
      const fileStream = fs.createWriteStream(tempFilePath);
      let streamError: Error | null = null;
      fileStream.on('error', (err) => {
        streamError = err;
      });
      const sha256Hash = crypto.createHash('sha256');

      if (!response.body) {
        throw new Error('响应未包含可读文件流');
      }

      const reader = response.body.getReader();
      let transferred = 0;
      let lastTime = Date.now();
      let lastTransferred = 0;
      let currentSpeed = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (streamError) throw streamError;
        const buffer = Buffer.from(value);
        if (!fileStream.write(buffer)) {
          await new Promise<void>((resolve, reject) => {
            fileStream.once('drain', resolve);
            fileStream.once('error', reject);
          });
        }
        sha256Hash.update(buffer);
        transferred += buffer.length;

        const now = Date.now();
        if (now - lastTime >= 400) {
          const deltaBytes = transferred - lastTransferred;
          const deltaTime = (now - lastTime) / 1000;
          currentSpeed = Math.round(deltaBytes / deltaTime);
          lastTime = now;
          lastTransferred = transferred;

          const percent = totalBytes > 0 ? Math.min(100, Math.round((transferred / totalBytes) * 100)) : 0;
          onProgress?.({
            status: 'downloading',
            percent,
            transferred,
            total: totalBytes,
            speed: currentSpeed,
            updateInfo: this.latestUpdateInfo || undefined,
          });
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => resolve());
        fileStream.on('error', reject);
      });

      // 计算下载所得文件的真实 SHA256 哈希
      const actualSha256 = sha256Hash.digest('hex').toLowerCase();

      // 安装包完整性强校验：若 Release 提供了 expectedSha256，严格校验是否完全一致
      const expectedSha256 = this.latestUpdateInfo?.expectedSha256?.toLowerCase();
      if (expectedSha256) {
        if (actualSha256 !== expectedSha256) {
          try {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          } catch (_e) {
            void _e;
          }
          this.downloadedFilePath = null;
          this.downloadedFileVerified = false;
          this.isDownloading = false;

          const hashMismatchError = `更新包完整性校验失败：文件 SHA256 散列值不匹配 (预期: ${expectedSha256.slice(0, 10)}..., 实际: ${actualSha256.slice(0, 10)}...)，文件可能已损坏或遭遇恶意篡改。`;
          onProgress?.({
            status: 'error',
            error: hashMismatchError,
            updateInfo: this.latestUpdateInfo || undefined,
          });
          return { success: false, error: hashMismatchError };
        }
      }

      // 校验通过，锁定受信任的下载包路径
      this.downloadedFilePath = tempFilePath;
      this.downloadedFileVerified = true;
      this.isDownloading = false;

      if (this.latestUpdateInfo) {
        this.latestUpdateInfo.actualSha256 = actualSha256;
      }

      onProgress?.({
        status: 'downloaded',
        percent: 100,
        transferred,
        total: transferred,
        speed: 0,
        savePath: tempFilePath,
        updateInfo: this.latestUpdateInfo || undefined,
      });

      return { success: true, filePath: tempFilePath, actualSha256 };
    } catch (err: any) {
      this.isDownloading = false;
      this.downloadedFileVerified = false;
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch (_e) {
        void _e;
      }

      const errorMsg =
        err.name === 'AbortError' ? '用户已取消下载' : (err.message || '更新下载失败');

      onProgress?.({
        status: 'error',
        error: errorMsg,
        updateInfo: this.latestUpdateInfo || undefined,
      });

      return { success: false, error: errorMsg };
    }
  }

  /**
   * 取消当前下载
   */
  public cancelDownload(): boolean {
    if (this.abortController && this.isDownloading) {
      this.abortController.abort();
      this.isDownloading = false;
      return true;
    }
    return false;
  }

  /**
   * 安装更新并安全退出程序
   * 严格仅执行主进程内部已通过完整性校验的下载包，拒绝执行任何外界任意路径
   * 先确认安装程序拉起成功，再停止核心并退出；启动失败时安全回滚且不退出
   */
  public async installUpdate(
    _filePathIgnored?: string
  ): Promise<{ success: boolean; error?: string }> {
    // 强制使用主进程验证通过的安装包路径，彻底阻断任何传入外部任意路径的提权利用
    const targetPath = this.getDownloadedFilePath();
    if (!targetPath || !fs.existsSync(targetPath)) {
      return { success: false, error: '更新安装包未找到或未通过完整性校验，请重新下载' };
    }

    try {
      // 安装前复核 SHA256 防范 %TEMP% TOCTOU 替换
      const recordedSha256 = this.latestUpdateInfo?.actualSha256?.toLowerCase();
      if (recordedSha256) {
        const currentSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex').toLowerCase();
        if (currentSha256 !== recordedSha256) {
          this.downloadedFileVerified = false;
          return { success: false, error: '安装包在启动前发生变化，完整性复核失败，请重新下载' };
        }
      }
      console.log(`[UpdateService] 准备安全启动更新包: ${targetPath}`);

      if (process.platform === 'win32' && targetPath.toLowerCase().endsWith('.exe')) {
        // 便携版自更新：等待当前进程退出后，将已校验的新版 .exe 覆盖到原便携版位置并重新启动
        const portableExePath = process.env.PORTABLE_EXECUTABLE_FILE;
        if (portableExePath && fs.existsSync(portableExePath)) {
          if (this.beforeQuitCallback) {
            try { await this.beforeQuitCallback(); } catch { /* ignore */ }
          }
          const escSrc = targetPath.replace(/'/g, "''");
          const escDst = portableExePath.replace(/'/g, "''");
          const psReplace = [
            `$pidToWait = ${process.pid}`,
            `for ($i = 0; $i -lt 50; $i++) { if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 200 }`,
            `$copied = $false`,
            `for ($r = 0; $r -lt 4; $r++) { try { Copy-Item -LiteralPath '${escSrc}' -Destination '${escDst}' -Force; $copied = $true; break } catch { Start-Sleep -Milliseconds 350 } }`,
            `if ($copied) { Remove-Item -LiteralPath '${escSrc}' -Force -ErrorAction SilentlyContinue; Start-Process -FilePath '${escDst}' } else { Start-Process -FilePath '${escSrc}' }`,
          ].join('; ');
          const encoded = Buffer.from(psReplace, 'utf16le').toString('base64');
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
          setTimeout(() => { Electron.app?.quit?.(); }, 300);
          return { success: true };
        }

        if (Electron.shell?.openPath) {
          const openErr = await Electron.shell.openPath(targetPath);
          if (!openErr) {
            if (this.beforeQuitCallback) {
              try { await this.beforeQuitCallback(); } catch { /* ignore */ }
            }
            setTimeout(() => { Electron.app?.quit?.(); }, 400);
            return { success: true };
          }
          console.warn('[UpdateService] shell.openPath 失败，尝试回退 spawn:', openErr);
        }
        // 1. 回退拉起新安装程序 (Windows NSIS / InnoSetup)
        const child = spawn(targetPath, [], {
          detached: true,
          stdio: 'ignore',
        });

        // 2. 监听子进程启动状态，设置 1000ms 观察窗口，捕获 UAC 拒绝或杀毒软件拦截
        const launchSuccess = await new Promise<boolean>((resolve) => {
          let settled = false;

          child.once('error', (err) => {
            if (!settled) {
              settled = true;
              console.error('[UpdateService] 安装程序启动被拦截或失败:', err);
              resolve(false);
            }
          });

          setTimeout(() => {
            if (!settled) {
              settled = true;
              // 若未发生 error 且成功生成系统 PID，判定操作系统已成功拉起安装程序
              resolve(typeof child.pid === 'number' && child.pid > 0);
            }
          }, 1000);
        });

        // 3. 安装包启动失败时安全善后：保持 NexLink 主程序正常运行，不退出亦不关核心与代理
        if (!launchSuccess) {
          return {
            success: false,
            error: '安装程序启动失败或被系统安全机制取消（若弹出 Windows 账户控制请点击“是”允许运行），NexLink 已保持正常运行。',
          };
        }

        // 4. 确认安装程序已成功运行后，再平滑停止核心与恢复系统代理
        try {
          const currentSettings = storageManager.getSettings();
          systemProxyManager.restoreProxySync(currentSettings?.mixedPort || 7890);
        } catch (_err) {
          void _err;
        }

        try {
          await mihomoManager.stop();
        } catch (_err) {
          void _err;
        }

        child.unref();

        // 5. 退出主程序
        if (Electron.app?.quit) {
          Electron.app.quit();
        }
        return { success: true };
      } else {
        // macOS / Linux 或非直接可执行文件，在文件夹中打开
        await Electron.shell.openPath(targetPath);
        return { success: true };
      }
    } catch (err: any) {
      console.error('[UpdateService] 启动安装程序发生异常:', err);
      return { success: false, error: err.message || '无法运行安装包' };
    }
  }

  /**
   * 打开外部链接 (严格校验 https / http 协议)
   */
  public async openUrl(url: string): Promise<boolean> {
    try {
      if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        await Electron.shell.openExternal(url);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[UpdateService] 打开外部链接异常:', err);
      return false;
    }
  }

  /**
   * 启动后台自动检测调度器
   */
  public startAutoCheck(mainWindow: Electron.BrowserWindow, delayMs = 3500): void {
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }

    // 启动延时自检，避开核心与 UI 首屏渲染峰值
    this.autoCheckTimer = setTimeout(async () => {
      const settings = storageManager.getSettings();
      const isAutoUpdateEnabled = settings.autoUpdate !== false && settings.autoCheckUpdate !== false;
      if (!isAutoUpdateEnabled) {
        console.log('[UpdateService] 用户已关闭自动更新，跳过后台自动检测与下载');
        return;
      }

      console.log('[UpdateService] 正在执行启动后台版本自检...');
      try {
        const info = await this.checkUpdate();
        if (info.hasUpdate && !mainWindow.isDestroyed()) {
          console.log(`[UpdateService] 检测到新版本发布: v${info.latestVersion}，自动在后台静默下载安装包...`);
          mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_STATUS, {
            status: 'available',
            updateInfo: info,
          });

          // 自动更新模式下，后台静默下载更新包；下载完成后前端接收 'downloaded' 状态自动弹窗提醒用户安装
          await this.downloadUpdate(info.downloadUrl, (progress) => {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_STATUS, progress);
            }
          });
        }
      } catch (err: any) {
        console.warn('[UpdateService] 后台自动更新流程提示:', err.message);
      }
    }, delayMs);
  }

  /**
   * 停止调度器
   */
  public stopAutoCheck(): void {
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
  }
}

export const updateService = new UpdateService();
