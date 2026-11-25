/**
 * Mihomo (Clash Meta) 内核在线更新与服务指纹同步管理器
 * 负责从官方 MetaCubeX/mihomo Releases 检查最新版本、下载校验、提取验证、替换本地内核，
 * 并同步更新系统特权服务目录 (ProgramData\NexLink\service\mihomo-manifest.json) 的 SHA-256 指纹。
 */

import * as Electron from 'electron';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { mihomoManager } from '../core/mihomo-process';
import { tunServiceManager, verifyMihomoInstallSource } from '../network/service-manager';
import { isCurrentProcessAdmin } from '../network/tun-checker';
import { createProxyTlsSocket } from '../network/wintun-manager';
import { storageManager } from '../storage/store';
import { extractSha256FromText, isValidGithubReleaseUrl, updateService } from './updater';

export interface CoreUpdateResult {
  success: boolean;
  updated: boolean;
  currentVersion: string;
  latestVersion?: string;
  sha256?: string;
  serviceSynced?: boolean;
  syncError?: string;
  message: string;
}

/**
 * 从 GitHub Release assets 中筛选匹配当前 Windows 架构的 Mihomo 核心压缩包
 */
export function selectMihomoWindowsAsset(assets: any[], arch: string = process.arch): any | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const targetArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const zipAssets = assets.filter((a) => {
    const name = String(a?.name || '').toLowerCase();
    return name.startsWith(`mihomo-windows-${targetArch}`) && name.endsWith('.zip') && !name.includes('alpha');
  });
  if (zipAssets.length === 0) return null;

  // 优先标准版 (mihomo-windows-amd64-vX.Y.Z.zip)，其次 v1 / compatible
  const exact = zipAssets.find((a) => new RegExp(`^mihomo-windows-${targetArch}-v\\d+\\.\\d+\\.\\d+\\.zip$`, 'i').test(String(a.name)));
  if (exact) return exact;
  const v1 = zipAssets.find((a) => String(a.name).toLowerCase().includes('-v1-'));
  if (v1) return v1;
  const compat = zipAssets.find((a) => String(a.name).toLowerCase().includes('compatible'));
  return compat || zipAssets[0];
}

/**
 * 使用 Node https（支持本地 HTTP CONNECT 代理隧道与 301/302 重定向）下载数据
 */
function httpsGetBuffer(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  proxyPort?: number,
  redirectCount: number = 0,
  onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) {
      return reject(new Error('请求重定向次数过多'));
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return reject(new Error(`仅支持 HTTPS 请求: ${parsed.protocol}`));
    }

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'NexLink-Desktop-Client',
        ...headers,
      },
    };

    const doRequest = async () => {
      if (proxyPort && proxyPort > 0) {
        try {
          const tlsSocket = await createProxyTlsSocket(
            parsed.hostname,
            Number(reqOptions.port || 443),
            proxyPort,
            timeoutMs
          );
          reqOptions.createConnection = () => tlsSocket;
        } catch (err) {
          return reject(err);
        }
      }

      const req = https.request(reqOptions, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          httpsGetBuffer(nextUrl, headers, timeoutMs, proxyPort, redirectCount + 1, onDownloadProgress)
            .then(resolve)
            .catch(reject);
          return;
        }

        const totalBytes = Number(res.headers['content-length'] || 0);
        let receivedBytes = 0;
        let lastNotify = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          receivedBytes += chunk.length;
          if (onDownloadProgress) {
            const now = Date.now();
            if (now - lastNotify >= 250 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
              lastNotify = now;
              onDownloadProgress(receivedBytes, totalBytes);
            }
          }
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy(new Error('请求超时'));
      });
      req.on('error', reject);
      req.end();
    };

    doRequest().catch(reject);
  });
}

async function fetchBufferSmart(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = 15000,
  onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void
): Promise<Buffer> {
  const status = mihomoManager.getStatus();
  const proxyPort = status.running && status.mixedPort > 0 ? status.mixedPort : 0;

  // 若本地代理正在运行，优先走代理隧道（避免国内直连 GitHub 被重置 net::ERR_CONNECTION_ABORTED）
  if (proxyPort > 0) {
    try {
      const res = await httpsGetBuffer(url, headers, timeoutMs, proxyPort, 0, onDownloadProgress);
      if (res.status >= 200 && res.status < 300) {
        return res.body;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (proxyErr: any) {
      // 代理失败时回退直连尝试一次
      const directRes = await httpsGetBuffer(url, headers, timeoutMs, 0, 0, onDownloadProgress);
      if (directRes.status >= 200 && directRes.status < 300) {
        return directRes.body;
      }
      throw new Error(proxyErr?.message || `HTTP ${directRes.status}`);
    }
  }

  // 未运行代理时尝试直连
  try {
    const directRes = await httpsGetBuffer(url, headers, timeoutMs, 0, 0, onDownloadProgress);
    if (directRes.status >= 200 && directRes.status < 300) {
      return directRes.body;
    }
    throw new Error(`HTTP ${directRes.status}`);
  } catch (err: any) {
    // 兼容系统代理已开启的场景
    if (Electron.net?.fetch) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await Electron.net.fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'NexLink-Desktop-Client', ...headers },
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
      } finally {
        clearTimeout(tid);
      }
    }
    throw err;
  }
}

export class CoreUpdaterService {
  private isUpdating = false;

  public async checkAndUpdateCore(options?: {
    force?: boolean;
    onProgress?: (msg: string) => void;
  }): Promise<CoreUpdateResult> {
    if (this.isUpdating) {
      return {
        success: false,
        updated: false,
        currentVersion: mihomoManager.getInstalledCoreVersion() || 'unknown',
        message: '内核更新正在进行中，请稍候...',
      };
    }

    this.isUpdating = true;
    const emit = (msg: string) => {
      try {
        options?.onProgress?.(msg);
      } catch {
        // ignore
      }
    };
    const tmpDir = path.join(os.tmpdir(), `nexlink-core-update-${Date.now()}`);

    try {
      const currentVersion = mihomoManager.getInstalledCoreVersion() || 'v0.0.0';

      // 1. 查询 MetaCubeX/mihomo 最新稳定版本
      emit('正在连接 GitHub 查询最新 Mihomo 版本...');
      const apiBuf = await fetchBufferSmart(
        'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest',
        { Accept: 'application/vnd.github.v3+json' },
        15000
      );
      const rel = JSON.parse(apiBuf.toString('utf8')) as any;
      const latestTag = String(rel?.tag_name || '').trim();
      if (!latestTag) {
        throw new Error('未能解析到最新的 Mihomo 版本号');
      }

      const isAlreadyTrusted = verifyMihomoInstallSource(mihomoManager.getMihomoExePath()).trusted;
      if (!options?.force && updateService.compareVersions(latestTag, currentVersion) <= 0 && isAlreadyTrusted) {
        return {
          success: true,
          updated: false,
          currentVersion,
          latestVersion: latestTag,
          message: `当前内核 (${currentVersion}) 已是最新版本`,
        };
      }

      const assets = Array.isArray(rel?.assets) ? rel.assets : [];
      const targetAsset = selectMihomoWindowsAsset(assets, process.arch);
      if (!targetAsset || !targetAsset.browser_download_url) {
        throw new Error('未在 Release 中找到适配当前 Windows 架构的 Mihomo 核心压缩包');
      }

      const downloadUrl = String(targetAsset.browser_download_url);
      if (!isValidGithubReleaseUrl(downloadUrl)) {
        throw new Error('内核下载地址未通过官方 GitHub 安全域名校验');
      }

      // 尝试提取官方发布的压缩包 SHA-256 校验值（优先 GitHub asset.digest，其次 Release 正文与校验文件）
      let expectedZipSha256: string | undefined;
      if (typeof targetAsset?.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/i.test(targetAsset.digest.trim())) {
        expectedZipSha256 = targetAsset.digest.trim().slice(7).toLowerCase();
      }
      if (!expectedZipSha256) {
        expectedZipSha256 = extractSha256FromText(String(rel?.body || ''), targetAsset.name);
      }
      if (!expectedZipSha256) {
        const checksumAsset = assets.find((a: any) => {
          const n = String(a?.name || '').toLowerCase();
          return n.includes('sha256') || n.includes('checksum');
        });
        if (checksumAsset?.browser_download_url && isValidGithubReleaseUrl(checksumAsset.browser_download_url)) {
          try {
            const cBuf = await fetchBufferSmart(checksumAsset.browser_download_url, {}, 12000);
            expectedZipSha256 = extractSha256FromText(cBuf.toString('utf8'), targetAsset.name);
          } catch {
            // 校验文件拉取失败不阻塞，后续仍严格校验 PE 与 -v 执行
          }
        }
      }

      // 2. 下载核心压缩包到临时目录
      fs.mkdirSync(tmpDir, { recursive: true });
      const zipPath = path.join(tmpDir, String(targetAsset.name || 'mihomo.zip'));
      const totalAssetBytes = Number(targetAsset.size || 0);
      emit(`正在下载 ${latestTag} 核心包...`);
      const zipBuf = await fetchBufferSmart(downloadUrl, {}, 120000, (got, total) => {
        const denom = total > 0 ? total : totalAssetBytes;
        const gotMb = (got / (1024 * 1024)).toFixed(1);
        if (denom > 0) {
          const pct = Math.min(100, Math.round((got / denom) * 100));
          const totMb = (denom / (1024 * 1024)).toFixed(1);
          emit(`正在下载 ${latestTag}（${pct}% · ${gotMb} / ${totMb} MB）...`);
        } else {
          emit(`正在下载 ${latestTag}（已下载 ${gotMb} MB）...`);
        }
      });
      fs.writeFileSync(zipPath, zipBuf);

      if (expectedZipSha256) {
        emit('正在校验压缩包完整性并解压...');
        const actualZipSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
        if (actualZipSha256 !== expectedZipSha256.toLowerCase()) {
          throw new Error(`内核压缩包 SHA-256 校验失败 (预期 ${expectedZipSha256.slice(0, 12)}..., 实际 ${actualZipSha256.slice(0, 12)}...)`);
        }
      }

      // 3. 解压并提取新 mihomo.exe
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      const escapedZip = zipPath.replace(/'/g, "''");
      const escapedExtract = extractDir.replace(/'/g, "''");
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedExtract}' -Force`],
        { windowsHide: true, timeout: 25000 }
      );

      const extractedFiles = fs.readdirSync(extractDir);
      const exeName = extractedFiles.find((f) => f.toLowerCase().endsWith('.exe'));
      if (!exeName) {
        throw new Error('压缩包内未找到可执行文件 (.exe)');
      }
      const newExeTmpPath = path.join(extractDir, exeName);
      const exeBytes = fs.readFileSync(newExeTmpPath);
      if (exeBytes.length < 1024 * 1024 || exeBytes[0] !== 0x4d || exeBytes[1] !== 0x5a) {
        throw new Error('提取的内核文件非有效 Windows PE 可执行程序');
      }

      // 4. 运行 -v 验证可执行性并提取真实版本
      const verOut = execFileSync(newExeTmpPath, ['-v'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      });
      const verMatch = verOut.match(/v?\d+\.\d+\.\d+(?:-[\w.]+)?/i);
      const verifiedVersion = verMatch ? (verMatch[0].startsWith('v') ? verMatch[0] : `v${verMatch[0]}`) : latestTag;
      const newSha256 = crypto.createHash('sha256').update(exeBytes).digest('hex').toUpperCase();

      // 5. 若本地核心正在运行，先暂停以便替换文件
      const wasRunning = mihomoManager.getStatus().running;
      if (wasRunning) {
        await mihomoManager.stop();
      }

      // 6. 写入可写的 userData/mihomo/mihomo.exe 并切换 mihomoManager 路径
      const userMihomoDir = mihomoManager.getUserMihomoDir();
      fs.mkdirSync(userMihomoDir, { recursive: true });
      const targetExePath = path.join(userMihomoDir, 'mihomo.exe');
      fs.copyFileSync(newExeTmpPath, targetExePath);
      mihomoManager.setMihomoExePath(targetExePath);

      // 7. 同步新内核 SHA-256 指纹到特权服务目录 (ProgramData\NexLink\mihomo-manifest.json)
      emit('正在同步服务指纹（请在弹出窗口确认管理员授权）...');
      const syncRes = await tunServiceManager.syncUpdatedCoreToService(
        targetExePath,
        verifiedVersion,
        newSha256,
        isCurrentProcessAdmin()
      );

      // 8. 若之前处于运行状态，自动用新核心重启恢复连接
      if (wasRunning) {
        try {
          const settings = storageManager.getSettings();
          const nodes = storageManager.getNodes();
          const state = storageManager.getState();
          const selectedNodeName =
            state.selectedNodeName ||
            (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);
          await mihomoManager.start({
            nodes,
            settings,
            selectedNodeName,
          });
        } catch (restartErr: any) {
          console.warn('[CoreUpdater] 重启核心失败:', restartErr?.message || restartErr);
        }
      }

      return {
        success: true,
        updated: true,
        currentVersion: verifiedVersion,
        latestVersion: latestTag,
        sha256: newSha256,
        serviceSynced: syncRes.success,
        syncError: syncRes.error,
        message: syncRes.success
          ? `内核已更新至 ${verifiedVersion}，服务指纹已同步更新`
          : `内核已更新至 ${verifiedVersion}（普通模式已生效；服务指纹未同步: ${syncRes.error || '未授权'}）`,
      };
    } catch (err: any) {
      return {
        success: false,
        updated: false,
        currentVersion: mihomoManager.getInstalledCoreVersion() || 'unknown',
        message: err?.message || '更新内核失败，请检查网络连接（如无法直连 GitHub 请先开启代理）',
      };
    } finally {
      this.isUpdating = false;
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  }
}

export const coreUpdaterService = new CoreUpdaterService();
