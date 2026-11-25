import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import tls from 'tls';
import https from 'https';
import crypto from 'crypto';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

export const WINTUN_DOWNLOAD_URL = 'https://www.wintun.net/builds/wintun-0.14.1.zip';
export const WINTUN_ZIP_SHA256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51';
const MIN_VALID_DLL_SIZE = 100 * 1024; // 100 KB

export interface WintunDriverStatus {
  ready: boolean;
  dllPath: string;
  size: number;
  arch: string;
}

/**
 * 校验目标文件是否为合法的 Windows PE DLL 文件（体积 >= 100KB 且头部为 MZ 魔数）
 */
export function isValidPeDll(filePath: string): { valid: boolean; size: number } {
  try {
    if (!fs.existsSync(filePath)) return { valid: false, size: 0 };
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_VALID_DLL_SIZE) return { valid: false, size: stat.size };
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(2);
      const bytesRead = fs.readSync(fd, header, 0, 2, 0);
      if (bytesRead < 2) return { valid: false, size: stat.size };
      // 严格校验 Windows PE 文件头 'MZ' (0x4D, 0x5A)
      const isMz = header[0] === 0x4d && header[1] === 0x5a;
      return { valid: isMz, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { valid: false, size: 0 };
  }
}

export function getWintunArchSubDir(): string {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm') return 'arm';
  return 'amd64';
}

/**
 * 查询本地 wintun.dll 驱动是否已就绪
 */
export function getWintunStatus(runtimeDir: string, resourcesDir: string): WintunDriverStatus {
  const arch = getWintunArchSubDir();
  const runtimeDll = path.join(runtimeDir, 'wintun.dll');
  const runtimeCheck = isValidPeDll(runtimeDll);
  if (runtimeCheck.valid) {
    return { ready: true, dllPath: runtimeDll, size: runtimeCheck.size, arch };
  }

  const resourcesDll = path.join(resourcesDir, 'mihomo/wintun.dll');
  const resCheck = isValidPeDll(resourcesDll);
  if (resCheck.valid) {
    return { ready: true, dllPath: resourcesDll, size: resCheck.size, arch };
  }

  return { ready: false, dllPath: '', size: 0, arch };
}

/**
 * 通过本地 HTTP 代理 (HTTP CONNECT 隧道) 创建到目标 HTTPS 主机的 TLS Socket
 */
export function createProxyTlsSocket(
  targetHost: string,
  targetPort: number,
  proxyPort: number,
  timeoutMs: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxySocket = net.connect(proxyPort, '127.0.0.1');
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proxySocket.destroy();
        reject(new Error(`本地代理连接超时 (127.0.0.1:${proxyPort})`));
      }
    }, timeoutMs);

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proxySocket.destroy();
        reject(err);
      }
    };

    proxySocket.once('error', fail);
    proxySocket.once('close', () => fail(new Error('代理连接提前关闭')));
    proxySocket.once('end', () => fail(new Error('代理连接提前结束')));
    proxySocket.once('connect', () => {
      proxySocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: keep-alive\r\n\r\n`
      );
    });

    let headerBuf = '';
    proxySocket.on('data', (chunk) => {
      headerBuf += chunk.toString('latin1');
      if (headerBuf.includes('\r\n\r\n')) {
        proxySocket.removeAllListeners('data');
        const statusLine = headerBuf.split('\r\n')[0] || '';
        if (!statusLine.includes('200')) {
          return fail(new Error(`代理 CONNECT 握手失败: ${statusLine}`));
        }
        const tlsSocket = tls.connect({
          socket: proxySocket,
          servername: targetHost,
        });
        tlsSocket.once('secureConnect', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(tlsSocket);
          }
        });
        tlsSocket.once('error', fail);
      }
    });
  });
}

/**
 * 原生 HTTPS 下载文件（支持 HTTP 301/302 重定向、超时控制与可选本地代理隧道）
 */
function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number = 15000,
  proxyPort?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;

    const cleanupAndReject = (err: Error) => {
      if (!settled) {
        settled = true;
        file.close(() => {
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {
            // ignore
          }
          reject(err);
        });
      }
    };

    const handleRequest = async (currentUrl: string, redirectCount: number = 0) => {
      if (redirectCount > 5) {
        return cleanupAndReject(new Error('下载 wintun.dll 重定向次数过多'));
      }

      const parsed = new URL(currentUrl);
      if (parsed.protocol !== 'https:') {
        return cleanupAndReject(new Error(`拒绝不安全的非 HTTPS 下载地址: ${parsed.protocol}`));
      }
      const client = https;

      const reqOptions: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'NexLink-WintunManager/1.0',
        },
      };

      if (proxyPort && proxyPort > 0) {
        try {
          const tlsSocket = await createProxyTlsSocket(
            parsed.hostname,
            Number(reqOptions.port || 443),
            proxyPort,
            timeoutMs
          );
          reqOptions.createConnection = () => tlsSocket;
        } catch (proxyErr: any) {
          return cleanupAndReject(proxyErr);
        }
      }

      const req = client.request(reqOptions, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, currentUrl).toString();
          res.resume();
          return handleRequest(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return cleanupAndReject(
            new Error(`下载 wintun.dll 失败，服务器返回 HTTP ${res.statusCode}`)
          );
        }

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        cleanupAndReject(new Error(`下载 wintun.dll 超时 (${timeoutMs}ms)`));
      });

      req.on('error', (err) => {
        cleanupAndReject(err);
      });

      req.end();
    };

    file.on('error', (err) => {
      cleanupAndReject(err);
    });

    handleRequest(url);
  });
}

/**
 * 确保 TUN 虚拟网卡底层驱动 (wintun.dll) 完整可用
 *
 * 1. 检查 runtimeDir/wintun.dll 是否存在且通过合法性校验
 * 2. 检查 resourcesDir/mihomo/wintun.dll 是否存在并自动拷贝
 * 3. 若均不存在，自动从官方源下载 zip 压缩包（优先直连，若提供 proxyPort 则支持本地代理隧道兜底）并静默解压适配当前 CPU 架构的驱动
 */
export async function ensureWintunDriver(
  runtimeDir: string,
  resourcesDir: string,
  proxyPort?: number
): Promise<{ ok: boolean; dllPath: string; error?: string }> {
  const runtimeDll = path.join(runtimeDir, 'wintun.dll');
  const resourcesDll = path.join(resourcesDir, 'mihomo/wintun.dll');

  // 1. 检查 runtime 工作目录下是否已存在合法的 wintun.dll
  if (isValidPeDll(runtimeDll).valid) {
    return { ok: true, dllPath: runtimeDll };
  }

  // 2. 检查 resources 预置资源目录下是否存在合法的 wintun.dll
  try {
    if (isValidPeDll(resourcesDll).valid) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.copyFileSync(resourcesDll, runtimeDll);
      console.log(`[WintunManager] 已成功从 resources 恢复 wintun.dll 至运行时: ${runtimeDll}`);
      return { ok: true, dllPath: runtimeDll };
    }
  } catch (err: any) {
    console.warn('[WintunManager] 从 resources 拷贝 wintun.dll 发生警告:', err.message);
  }

  // 3. 缺失时自动从官方安全源下载驱动压缩包并提取（支持本地代理隧道自动兜底）
  console.log('[WintunManager] 检测到缺少 wintun.dll 虚拟网卡驱动，准备自动下载并解压配置...');
  const tmpDir = path.join(os.tmpdir(), `nexlink-wintun-${Date.now()}`);
  const zipPath = path.join(tmpDir, 'wintun-0.14.1.zip');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      await downloadFile(WINTUN_DOWNLOAD_URL, zipPath, 15000);
    } catch (directErr: any) {
      if (proxyPort && proxyPort > 0) {
        console.warn(
          `[WintunManager] 直连下载 wintun.dll 失败 (${directErr.message})，正在通过本地代理 127.0.0.1:${proxyPort} 重试...`
        );
        await downloadFile(WINTUN_DOWNLOAD_URL, zipPath, 20000, proxyPort);
      } else {
        throw directErr;
      }
    }

    // 强制校验官方 wintun-0.14.1.zip SHA-256，防止 MITM / 代理篡改
    const zipBuf = fs.readFileSync(zipPath);
    const actualZipSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
    if (actualZipSha256 !== WINTUN_ZIP_SHA256) {
      throw new Error(`wintun-0.14.1.zip SHA-256 校验失败: 期望 ${WINTUN_ZIP_SHA256}，实际 ${actualZipSha256}`);
    }

    // 调用 Windows 原生静默解压（必须包含 windowsHide: true）
    await execFileAsync('tar.exe', ['-xf', zipPath, '-C', tmpDir], {
      windowsHide: true,
      timeout: 15000,
    });

    const archSubDir = getWintunArchSubDir();
    const extractedDll = path.join(tmpDir, 'wintun', 'bin', archSubDir, 'wintun.dll');
    if (!fs.existsSync(extractedDll)) {
      throw new Error(`解压完成但在路径中未找到目标驱动: ${extractedDll}`);
    }

    const check = isValidPeDll(extractedDll);
    if (!check.valid) {
      throw new Error(`下载解压的 wintun.dll 文件损坏或非法 (大小 ${check.size} 字节)`);
    }

    // 原子部署到 runtimeDir
    fs.mkdirSync(runtimeDir, { recursive: true });
    const tmpRuntimeDll = `${runtimeDll}.tmp_${Date.now()}`;
    fs.copyFileSync(extractedDll, tmpRuntimeDll);
    fs.renameSync(tmpRuntimeDll, runtimeDll);

    // 尝试同步到 resources 目录备份（若 resources/mihomo 目录存在且可写）
    try {
      const resMihomoDir = path.join(resourcesDir, 'mihomo');
      if (fs.existsSync(resMihomoDir)) {
        fs.copyFileSync(extractedDll, resourcesDll);
      }
    } catch {
      // 忽略 Program Files 只读保护
    }

    console.log(`[WintunManager] wintun.dll (${archSubDir}) 驱动自动安装并配置成功！`);
    return { ok: true, dllPath: runtimeDll };
  } catch (err: any) {
    const errorMsg = `wintun.dll 驱动自动部署失败: ${err.message}`;
    console.error(`[WintunManager] ${errorMsg}`);
    return { ok: false, dllPath: '', error: errorMsg };
  } finally {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
