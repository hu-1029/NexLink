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
import {
  extractSha256FromText,
  fetchWithSafeRedirects,
  isValidGithubReleaseUrl,
  updateService,
} from './updater';

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
 * 校验 ZIP 归档条目路径是否存在 Zip Slip 路径穿越或绝对路径逃逸风险
 */
export function isSafeZipEntryPath(entryFullName: string): boolean {
  if (typeof entryFullName !== 'string' || !entryFullName.trim()) return false;
  if (entryFullName.includes('\0')) return false;
  if (/^[\\/]/.test(entryFullName) || /^[a-zA-Z]:/.test(entryFullName)) return false;
  const segments = entryFullName.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some((seg) => seg === '..');
}

/**
 * 使用 Node https（支持本地 HTTP CONNECT 代理隧道、3xx 重定向域名白名单二次校验与响应大小上限）下载数据
 */
export function httpsGetBuffer(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  proxyPort?: number,
  redirectCount: number = 0,
  onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void,
  maxBytes: number = 100 * 1024 * 1024,
  validateUrl: (u: string) => boolean = isValidGithubReleaseUrl
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) {
      return reject(new Error('请求重定向次数过多'));
    }
    if (!validateUrl(url)) {
      return reject(new Error(`安全拦截: 请求地址不在官方白名单内 (${url})`));
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
          const nextUrl = new URL(res.headers.location, url).toString();
          if (!validateUrl(nextUrl)) {
            return reject(new Error(`安全拦截: 重定向目标域名不在官方白名单内 (${nextUrl})`));
          }
          httpsGetBuffer(
            nextUrl,
            headers,
            timeoutMs,
            proxyPort,
            redirectCount + 1,
            onDownloadProgress,
            maxBytes,
            validateUrl
          )
            .then(resolve)
            .catch(reject);
          return;
        }

        const totalBytes = Number(res.headers['content-length'] || 0);
        if (totalBytes > maxBytes) {
          res.resume();
          return reject(
            new Error(`响应体过大 (${Math.round(totalBytes / 1024 / 1024)}MB)，超出安全上限`)
          );
        }

        let receivedBytes = 0;
        let lastNotify = 0;
        let settled = false;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) {
            settled = true;
            const sizeErr = new Error(`响应数据体积超过安全上限 (${Math.round(maxBytes / 1024 / 1024)}MB)，已中止下载`);
            req.destroy(sizeErr);
            reject(sizeErr);
            return;
          }
          chunks.push(chunk);
          if (onDownloadProgress) {
            const now = Date.now();
            if (now - lastNotify >= 250 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
              lastNotify = now;
              onDownloadProgress(receivedBytes, totalBytes);
            }
          }
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
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
  onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void,
  maxBytes: number = 100 * 1024 * 1024,
  validateUrl: (u: string) => boolean = isValidGithubReleaseUrl
): Promise<Buffer> {
  const status = mihomoManager.getStatus();
  const proxyPort = status.running && status.mixedPort > 0 ? status.mixedPort : 0;

  // 若本地代理正在运行，优先走代理隧道（避免国内直连 GitHub 被重置 net::ERR_CONNECTION_ABORTED）
  if (proxyPort > 0) {
    try {
      const res = await httpsGetBuffer(
        url,
        headers,
        timeoutMs,
        proxyPort,
        0,
        onDownloadProgress,
        maxBytes,
        validateUrl
      );
      if (res.status >= 200 && res.status < 300) {
        return res.body;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (proxyErr: any) {
      const pMsg = String(proxyErr?.message || '');
      if (pMsg.includes('安全拦截') || pMsg.includes('安全上限') || pMsg.includes('响应体过大') || pMsg.includes('重定向次数过多')) {
        throw proxyErr;
      }
      // 代理失败时回退直连尝试一次
      const directRes = await httpsGetBuffer(
        url,
        headers,
        timeoutMs,
        0,
        0,
        onDownloadProgress,
        maxBytes,
        validateUrl
      );
      if (directRes.status >= 200 && directRes.status < 300) {
        return directRes.body;
      }
      throw new Error(proxyErr?.message || `HTTP ${directRes.status}`);
    }
  }

  // 未运行代理时尝试直连
  try {
    const directRes = await httpsGetBuffer(
      url,
      headers,
      timeoutMs,
      0,
      0,
      onDownloadProgress,
      maxBytes,
      validateUrl
    );
    if (directRes.status >= 200 && directRes.status < 300) {
      return directRes.body;
    }
    throw new Error(`HTTP ${directRes.status}`);
  } catch (err: any) {
    const dMsg = String(err?.message || '');
    if (dMsg.includes('安全拦截') || dMsg.includes('安全上限') || dMsg.includes('响应体过大') || dMsg.includes('重定向次数过多')) {
      throw err;
    }
    // 兼容系统代理已开启的场景（同样走手动重定向白名单与响应大小限制）
    if (typeof Electron.net?.fetch === 'function') {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetchWithSafeRedirects(
          url,
          {
            method: 'GET',
            headers: { 'User-Agent': 'NexLink-Desktop-Client', ...headers },
            signal: controller.signal,
          },
          { validateUrl }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const contentLen = Number(resp.headers.get('content-length') || 0);
        if (contentLen > maxBytes) {
          await resp.body?.cancel().catch(() => {});
          throw new Error(`响应体过大 (${Math.round(contentLen / 1024 / 1024)}MB)，超出安全上限`);
        }
        if (!resp.body) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > maxBytes) throw new Error('响应数据体积超过安全上限');
          return buf;
        }
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            got += value.length;
            if (got > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new Error('响应数据体积超过安全上限，已中止下载');
            }
            chunks.push(value);
          }
        }
        return Buffer.concat(chunks);
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
    fetchBuffer?: (
      url: string,
      headers?: Record<string, string>,
      timeoutMs?: number,
      onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void,
      maxBytes?: number
    ) => Promise<Buffer>;
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
    const fetchBuf = options?.fetchBuffer ?? fetchBufferSmart;
    const tmpDir = path.join(os.tmpdir(), `nexlink-core-update-${Date.now()}`);

    try {
      const currentVersion = mihomoManager.getInstalledCoreVersion() || 'v0.0.0';

      // 1. 查询 MetaCubeX/mihomo 最新稳定版本
      emit('正在连接 GitHub 查询最新 Mihomo 版本...');
      const apiBuf = await fetchBuf(
        'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest',
        { Accept: 'application/vnd.github.v3+json' },
        15000,
        undefined,
        2 * 1024 * 1024
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
            const cBuf = await fetchBuf(
              checksumAsset.browser_download_url,
              {},
              12000,
              undefined,
              2 * 1024 * 1024
            );
            expectedZipSha256 = extractSha256FromText(cBuf.toString('utf8'), targetAsset.name);
          } catch (checksumErr: any) {
            throw new Error(
              `拉取内核 SHA-256 校验文件失败，已中止更新，请重试: ${checksumErr?.message || checksumErr}`
            );
          }
        }
      }

      // Fail-Closed (P0-4)：必须获取到有效的预期 SHA-256，绝不允许在无校验值时继续下载和执行
      if (!expectedZipSha256 || !/^[a-f0-9]{64}$/i.test(expectedZipSha256)) {
        throw new Error('未在官方 Release 中获取到内核压缩包的 SHA-256 校验值，已拒绝下载并中止更新，请稍后重试');
      }

      // 2. 下载核心压缩包到临时目录
      fs.mkdirSync(tmpDir, { recursive: true });
      const zipPath = path.join(tmpDir, String(targetAsset.name || 'mihomo.zip'));
      const totalAssetBytes = Number(targetAsset.size || 0);
      emit(`正在下载 ${latestTag} 核心包...`);
      const zipBuf = await fetchBuf(downloadUrl, {}, 120000, (got, total) => {
        const denom = total > 0 ? total : totalAssetBytes;
        const gotMb = (got / (1024 * 1024)).toFixed(1);
        if (denom > 0) {
          const pct = Math.min(100, Math.round((got / denom) * 100));
          const totMb = (denom / (1024 * 1024)).toFixed(1);
          emit(`正在下载 ${latestTag}（${pct}% · ${gotMb} / ${totMb} MB）...`);
        } else {
          emit(`正在下载 ${latestTag}（已下载 ${gotMb} MB）...`);
        }
      }, 100 * 1024 * 1024);
      fs.writeFileSync(zipPath, zipBuf);

      emit('正在校验压缩包完整性并解压...');
      const actualZipSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
      if (actualZipSha256 !== expectedZipSha256.toLowerCase()) {
        throw new Error(`内核压缩包 SHA-256 校验失败 (预期 ${expectedZipSha256.slice(0, 12)}..., 实际 ${actualZipSha256.slice(0, 12)}...)`);
      }

      // 3. 安全解压并提取新 mihomo.exe（使用 .NET ZipFile 逐条检查 Zip Slip 与解压总大小上限）
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      const escapedZip = zipPath.replace(/'/g, "''");
      const escapedExtract = extractDir.replace(/'/g, "''");
      const safeExtractPs = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$zipPath = '${escapedZip}'`,
        `$destDir = [System.IO.Path]::GetFullPath('${escapedExtract}')`,
        "$destPrefix = if ($destDir.EndsWith('\\')) { $destDir } else { $destDir + '\\' }",
        "$maxUncompressed = 200 * 1024 * 1024",
        "$maxEntries = 100",
        "$entryCount = 0",
        "$totalUncompressed = 0L",
        "$buffer = New-Object byte[] 65536",
        "$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)",
        "try {",
        "    foreach ($entry in $zip.Entries) {",
        "        $entryCount++",
        "        if ($entryCount -gt $maxEntries) { throw 'Zip archive exceeds entry count safety limit' }",
        "        $name = $entry.FullName",
        "        if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.StartsWith('\\') -or ($name -match '^[a-zA-Z]:')) {",
        "            throw ('Zip Slip unsafe entry path rejected: ' + $name)",
        "        }",
        "        $segs = $name.Split(@('/', '\\'), [System.StringSplitOptions]::RemoveEmptyEntries)",
        "        if ($segs -contains '..') { throw ('Zip Slip traversal rejected: ' + $name) }",
        "        $targetPath = [System.IO.Path]::GetFullPath((Join-Path $destDir $name))",
        "        if (-not $targetPath.StartsWith($destPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {",
        "            throw ('Zip Slip escaped destination dir: ' + $name)",
        "        }",
        "        if ($name.EndsWith('/') -or $name.EndsWith('\\')) {",
        "            [System.IO.Directory]::CreateDirectory($targetPath) | Out-Null",
        "        } else {",
        "            $parentDir = [System.IO.Path]::GetDirectoryName($targetPath)",
        "            if ($parentDir) { [System.IO.Directory]::CreateDirectory($parentDir) | Out-Null }",
        "            $inStream = $entry.Open()",
        "            $outStream = [System.IO.File]::Create($targetPath)",
        "            try {",
        "                while (($read = $inStream.Read($buffer, 0, $buffer.Length)) -gt 0) {",
        "                    $totalUncompressed += $read",
        "                    if ($totalUncompressed -gt $maxUncompressed) {",
        "                        throw 'Zip archive exceeds uncompressed size safety limit'",
        "                    }",
        "                    $outStream.Write($buffer, 0, $read)",
        "                }",
        "            } finally {",
        "                $outStream.Dispose()",
        "                $inStream.Dispose()",
        "            }",
        "        }",
        "    }",
        "} finally {",
        "    $zip.Dispose()",
        "}",
      ].join('\r\n');
      const encodedExtractPs = Buffer.from(safeExtractPs, 'utf16le').toString('base64');
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedExtractPs],
        { windowsHide: true, timeout: 25000 }
      );

      const extractedFiles = fs.readdirSync(extractDir);
      const exeName = extractedFiles.find((f) => f.toLowerCase().endsWith('.exe'));
      if (!exeName) {
        throw new Error('压缩包内未找到可执行文件 (.exe)');
      }
      const newExeTmpPath = path.join(extractDir, exeName);
      const exeLstat = fs.lstatSync(newExeTmpPath);
      const realExtractDir = fs.realpathSync(extractDir);
      const realExeTmpPath = fs.realpathSync(newExeTmpPath);
      const relExe = path.relative(realExtractDir.toLowerCase(), realExeTmpPath.toLowerCase());
      if (
        !exeLstat.isFile() ||
        exeLstat.isSymbolicLink() ||
        !relExe ||
        relExe.startsWith('..') ||
        path.isAbsolute(relExe)
      ) {
        throw new Error('提取的内核文件路径异常或为符号链接，已拒绝执行');
      }
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
      if (!/mihomo|clash\.meta/i.test(verOut)) {
        throw new Error('提取的可执行文件未通过 Mihomo -v 身份校验');
      }
      const verMatch = verOut.match(/v?\d+\.\d+\.\d+(?:-[\w.]+)?/i);
      const verifiedVersion = verMatch ? (verMatch[0].startsWith('v') ? verMatch[0] : `v${verMatch[0]}`) : latestTag;
      const newSha256 = crypto.createHash('sha256').update(exeBytes).digest('hex').toUpperCase();

      // 5. 若本地核心正在运行，先暂停以便替换文件
      const wasRunning = mihomoManager.getStatus().running;
      if (wasRunning) {
        await mihomoManager.stop();
      }

      // 6. 自动备份旧版 (mihomo.exe.bak) 后写入可写的 userData/mihomo/mihomo.exe 并切换路径
      const userMihomoDir = mihomoManager.getUserMihomoDir();
      fs.mkdirSync(userMihomoDir, { recursive: true });
      const targetExePath = path.join(userMihomoDir, 'mihomo.exe');
      const backupExePath = path.join(userMihomoDir, 'mihomo.exe.bak');
      if (fs.existsSync(targetExePath)) {
        try {
          const st = fs.statSync(targetExePath);
          if (st.isFile() && st.size >= 1024 * 1024) {
            fs.copyFileSync(targetExePath, backupExePath);
          }
        } catch {
          // ignore backup failure
        }
      }
      fs.copyFileSync(newExeTmpPath, targetExePath);
      mihomoManager.setMihomoExePath(targetExePath);

      // 7. 同步新内核 SHA-256 指纹到特权服务目录 (ProgramData\NexLink\mihomo-manifest.json)
      emit('正在同步服务指纹（请在弹出窗口确认管理员授权）...');
      const syncRes = await tunServiceManager.syncUpdatedCoreToService(
        targetExePath,
        verifiedVersion,
        newSha256,
        isCurrentProcessAdmin(),
        {
          verifiedUpdate: {
            kind: 'github-release',
            downloadUrl,
            allowedSourceDirs: [userMihomoDir],
          },
        }
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

  /**
   * 获取当前内核状态：是否正在使用在线更新版、是否存在上一版备份、内置版本等
   */
  public getCoreState(): {
    currentVersion: string;
    isUsingCustomCore: boolean;
    hasBackup: boolean;
    backupVersion?: string;
    bundledVersion: string;
  } {
    const userMihomoDir = mihomoManager.getUserMihomoDir();
    const userExe = path.join(userMihomoDir, 'mihomo.exe');
    const backupExe = path.join(userMihomoDir, 'mihomo.exe.bak');
    const bundledExe = mihomoManager.getBundledMihomoExePath();

    const isUsingCustomCore =
      fs.existsSync(userExe) &&
      path.resolve(mihomoManager.getMihomoExePath()).toLowerCase() === path.resolve(userExe).toLowerCase();
    const hasBackup = fs.existsSync(backupExe) && fs.statSync(backupExe).size >= 1024 * 1024;
    const backupVersion = hasBackup ? mihomoManager.getInstalledCoreVersion(backupExe) || undefined : undefined;

    return {
      currentVersion: mihomoManager.getInstalledCoreVersion() || 'v1.19.29',
      isUsingCustomCore,
      hasBackup,
      backupVersion,
      bundledVersion: mihomoManager.getInstalledCoreVersion(bundledExe) || 'v1.19.29',
    };
  }

  /**
   * 一键回退到上一版备份内核；若无备份则还原为软件内置稳定内核，并同步服务状态
   */
  public async rollbackCore(): Promise<CoreUpdateResult> {
    if (this.isUpdating) {
      return {
        success: false,
        updated: false,
        currentVersion: mihomoManager.getInstalledCoreVersion() || 'unknown',
        message: '正在执行内核操作，请稍候...',
      };
    }

    this.isUpdating = true;
    try {
      const userMihomoDir = mihomoManager.getUserMihomoDir();
      const userExe = path.join(userMihomoDir, 'mihomo.exe');
      const backupExe = path.join(userMihomoDir, 'mihomo.exe.bak');
      const bundledExe = mihomoManager.getBundledMihomoExePath();

      const hasBackup = fs.existsSync(backupExe) && fs.statSync(backupExe).size >= 1024 * 1024;
      const hasCustom = fs.existsSync(userExe);

      if (!hasBackup && !hasCustom) {
        return {
          success: true,
          updated: false,
          currentVersion: mihomoManager.getInstalledCoreVersion() || 'v1.19.29',
          message: '当前已是内置稳定内核，无需回退',
        };
      }

      if (hasBackup) {
        const backupTrust = verifyMihomoInstallSource(backupExe);
        if (!backupTrust.trusted) {
          return {
            success: false,
            updated: false,
            currentVersion: mihomoManager.getInstalledCoreVersion() || 'unknown',
            message: `安全拦截: 备份内核未通过可信来源校验，已拒绝回退并保留现状 (${backupTrust.error || 'untrusted backup'})`,
          };
        }
      }

      const wasRunning = mihomoManager.getStatus().running;
      if (wasRunning) {
        await mihomoManager.stop();
      }

      let restoredPath = bundledExe;
      let label = '内置稳定版';
      if (hasBackup) {
        fs.copyFileSync(backupExe, userExe);
        fs.unlinkSync(backupExe);
        restoredPath = userExe;
        label = '上一版备份';
      } else if (hasCustom) {
        fs.unlinkSync(userExe);
        restoredPath = bundledExe;
        label = '内置稳定版';
      }

      mihomoManager.setMihomoExePath(restoredPath);
      const restoredVer = mihomoManager.getInstalledCoreVersion(restoredPath) || 'v1.19.29';
      const bytes = fs.readFileSync(restoredPath);
      const restoredSha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

      let serviceSynced = true;
      let syncError: string | undefined;
      const svcStatus = await tunServiceManager.getServiceStatus();
      if (svcStatus.installed || restoredPath === userExe) {
        const syncRes = await tunServiceManager.syncUpdatedCoreToService(
          restoredPath,
          restoredVer,
          restoredSha256,
          isCurrentProcessAdmin()
        );
        serviceSynced = syncRes.success;
        syncError = syncRes.error;
      }

      if (wasRunning) {
        try {
          const settings = storageManager.getSettings();
          const nodes = storageManager.getNodes();
          const state = storageManager.getState();
          const selectedNodeName =
            state.selectedNodeName ||
            (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);
          await mihomoManager.start({ nodes, settings, selectedNodeName });
        } catch (restartErr: any) {
          console.warn('[CoreUpdater] 回退后重启核心失败:', restartErr?.message || restartErr);
        }
      }

      return {
        success: true,
        updated: true,
        currentVersion: restoredVer,
        sha256: restoredSha256,
        serviceSynced,
        syncError,
        message: serviceSynced
          ? `已回退至${label} (${restoredVer})，服务已同步`
          : `已回退至${label} (${restoredVer})（服务未同步: ${syncError || '未授权'}）`,
      };
    } catch (err: any) {
      return {
        success: false,
        updated: false,
        currentVersion: mihomoManager.getInstalledCoreVersion() || 'unknown',
        message: err?.message || '回退内核失败',
      };
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * 更新 GeoIP / GeoSite 规则库：核心运行时优先走 Mihomo 热更新 API（免重启）；未运行时直接拉取 geoip.metadb
   */
  public async updateGeoDatabases(options?: {
    fetchBuffer?: (url: string) => Promise<Buffer>;
  }): Promise<{ success: boolean; message: string }> {
    try {
      const status = mihomoManager.getStatus();
      if (status.running && !options?.fetchBuffer) {
        const apiRes = await mihomoManager.getApiClient().updateGeoDatabases();
        if (apiRes.ok) {
          return {
            success: true,
            message: 'GeoIP / GeoSite 规则库热更新完成（无需重启核心）',
          };
        }
        throw new Error(apiRes.error || 'Mihomo 热更新 Geo 数据库失败');
      }

      // 核心未运行时，直接下载最新 geoip.metadb 到运行时目录
      const runtimeDir = mihomoManager.getRuntimeDir();
      if (!runtimeDir) {
        throw new Error('运行时目录未初始化');
      }
      const geoUrl = 'https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.metadb';
      const buf = options?.fetchBuffer
        ? await options.fetchBuffer(geoUrl)
        : await fetchBufferSmart(geoUrl, {}, 45000, undefined, 64 * 1024 * 1024);
      if (buf.length < 100 * 1024) {
        throw new Error('下载的 geoip.metadb 文件大小异常，已放弃覆盖');
      }
      const mmdbMarker = Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1');
      if (buf.lastIndexOf(mmdbMarker) < 0) {
        throw new Error('下载的 geoip.metadb 格式校验失败（缺少 MaxMind 元数据标记）');
      }
      fs.mkdirSync(runtimeDir, { recursive: true });
      const geoPath = path.join(runtimeDir, 'geoip.metadb');
      if (fs.existsSync(geoPath) && fs.lstatSync(geoPath).isSymbolicLink()) {
        throw new Error('geoip.metadb 目标路径为符号链接，已拒绝覆盖');
      }
      const tmpGeoPath = path.join(runtimeDir, `geoip.metadb.tmp.${process.pid}.${Date.now()}`);
      try {
        fs.writeFileSync(tmpGeoPath, buf);
        fs.renameSync(tmpGeoPath, geoPath);
      } finally {
        if (fs.existsSync(tmpGeoPath)) {
          try {
            fs.unlinkSync(tmpGeoPath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
      return {
        success: true,
        message: `GeoIP 规则库已更新至最新版 (${(buf.length / (1024 * 1024)).toFixed(1)} MB)`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err?.message || '更新 Geo 规则库失败，请确认网络或先开启代理后重试',
      };
    }
  }
}

export const coreUpdaterService = new CoreUpdaterService();
