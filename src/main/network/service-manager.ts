/**
 * NexLink Windows 虚拟网卡特权服务管理器 (对标 Clash Verge Rev Service Mode)
 *
 * 架构原理：
 * 1. Windows 创建 Wintun 虚拟网卡与修改系统路由表在内核层必须具备高权限，
 *    Clash Verge Rev 通过一次性安装 LocalSystem 后台服务 (Service Mode) 托管内核，
 *    使普通用户权限运行的 GUI 客户端无需管理员重启、无需重复 UAC 弹窗即可随时秒开/关 TUN。
 * 2. 本模块零外部二进制依赖：首次点击“安装服务”时，利用 Windows 10/11 系统自带的
 *    .NET Framework 4.x 编译器 (csc.exe) 现场编译原生 Windows Service 可执行文件
 *    `NexLinkService.exe` 并注册为 `NexLinkCoreService` 系统服务（LocalSystem + 开机自启）。
 * 3. 服务仅监听 127.0.0.1:33211 本地回环端口，并通过随机 32 字节 X-NexLink-Token 鉴权，
 *    严格校验仅允许拉起 mihomo.exe，确保本地提权边界安全可靠。
 */

import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';

const execFileAsync = util.promisify(execFile);

export const SERVICE_NAME = 'NexLinkCoreService';
export const SERVICE_DISPLAY_NAME = 'NexLink TUN Core Service';
export const SERVICE_PORT = 33211;
export const SERVICE_VERSION = '1.0.0';

export interface TunServiceStatus {
  installed: boolean;
  running: boolean;
  reachable: boolean;
  version?: string;
  coreRunning?: boolean;
  corePid?: number;
  error?: string;
}

export interface ServiceStartCoreParams {
  binPath?: string;
  configDir?: string;
  configPath?: string;
  configContent?: string;
  apiPort: number;
  secret: string;
  logPath?: string;
}

/**
 * 获取服务安装目录 (Windows: C:\ProgramData\NexLink\service)
 */
export function getServiceInstallDir(): string {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(programData, 'NexLink', 'service');
}

/**
 * 编码为 PowerShell -EncodedCommand (UTF-16LE Base64)，彻底消除命令行引号与中文路径转义问题
 */
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export const TRUSTED_MIHOMO_MANIFEST_FILENAME = 'mihomo-manifest.json';

export const ALLOWED_RULE_EXTENSIONS = new Set<string>([
  '.mrs',
  '.dat',
  '.mmdb',
  '.metadb',
  '.yaml',
  '.yml',
  '.list',
  '.txt',
]);

export function isAllowedRuleFileName(fileName: string): boolean {
  if (!fileName || typeof fileName !== 'string') return false;
  const ext = path.extname(fileName.trim()).toLowerCase();
  return ALLOWED_RULE_EXTENSIONS.has(ext);
}

export const TRUSTED_WRITE_SIDS = new Set<string>([
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-32-544', // BUILTIN\Administrators
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // NT SERVICE\TrustedInstaller
]);

/**
 * 内置可信 Mihomo 版本 SHA-256 清单（可在构建阶段注入，同时支持由管理员保护的 mihomo-manifest.json 平滑升级）
 */
export const TRUSTED_MIHOMO_BUILTIN_HASHES: Readonly<Record<string, string>> = Object.freeze({
  'v1.19.29-windows-amd64': '4316FF91FECEC2FCA9ACB5612D7400BA228C069FFD325B1F17F46F1D4EF7E0CD',
});

export interface TrustedMihomoManifestEntry {
  version: string;
  arch?: string;
  sha256: string;
}

export interface TrustedMihomoManifest {
  schemaVersion: number;
  entries: TrustedMihomoManifestEntry[];
}

export interface AclCheckResult {
  locked: boolean;
  reason?: string;
  unsafePath?: string;
  unsafeSid?: string;
}

export interface AuthenticodeCheckResult {
  valid: boolean;
  subject?: string;
  thumbprint?: string;
  reason?: string;
}

export interface MihomoSourceTrustResult {
  trusted: boolean;
  sha256?: string;
  matchedVersion?: string;
  trustMethod?: 'builtin-manifest' | 'external-manifest' | 'authenticode';
  manifestPath?: string;
  error?: string;
}

export interface VerifyMihomoSourceOptions {
  manifestPath?: string;
  builtinHashes?: Readonly<Record<string, string>>;
  checkAcl?: (targetPath: string) => AclCheckResult;
  checkSignature?: (filePath: string) => AuthenticodeCheckResult;
}

/**
 * 严格解析可信 Mihomo 版本清单 (mihomo-manifest.json)
 */
export function parseTrustedMihomoManifest(raw: string): TrustedMihomoManifest | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      return null;
    }
    const entries: TrustedMihomoManifestEntry[] = [];
    for (const item of parsed.entries) {
      if (!item || typeof item !== 'object') return null;
      const version = typeof item.version === 'string' ? item.version.trim() : '';
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toUpperCase() : '';
      const arch = typeof item.arch === 'string' ? item.arch.trim().toLowerCase() : undefined;
      if (!/^v?\d+\.\d+\.\d+([-.][a-zA-Z0-9._]+)?$/.test(version)) return null;
      if (!/^[0-9A-F]{64}$/.test(sha256)) return null;
      entries.push({ version, arch, sha256 });
    }
    return { schemaVersion: 1, entries };
  } catch {
    return null;
  }
}

/**
 * 检查 Windows 文件及完整父目录链的 ACL 与重解析点（严格 fail-closed）：
 * 拒绝任何普通用户可写、可修改、可删除、可篡改权限的目录或文件，防止验证后替换安装源。
 */
export function verifyWindowsPathAclChainSync(targetPath: string): AclCheckResult {
  if (process.platform !== 'win32') {
    return { locked: false, reason: 'Non-Windows platform cannot verify Windows ACL' };
  }
  const escaped = path.resolve(targetPath).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$cur = '${escaped}'.TrimEnd('\\', '/')`,
    "$root = [System.IO.Path]::GetPathRoot($cur)",
    "$programData = [System.Environment]::GetFolderPath('CommonApplicationData').TrimEnd('\\', '/')",
    "$trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')",
    "$dangerous = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)",
    "while ($cur -and ($cur -ne $root)) {",
    "    if (-not (Test-Path -LiteralPath $cur)) { [PSCustomObject]@{ locked=$false; reason='Path does not exist'; unsafePath=$cur } | ConvertTo-Json -Compress; exit 0 }",
    "    $it = Get-Item -LiteralPath $cur -Force",
    "    if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { [PSCustomObject]@{ locked=$false; reason='Reparse point detected'; unsafePath=$cur } | ConvertTo-Json -Compress; exit 0 }",
    "    if ($programData -and [string]::Equals($cur, $programData, [System.StringComparison]::OrdinalIgnoreCase)) { break }",
    "    $acl = Get-Acl -LiteralPath $cur",
    "    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "    if ($trusted -notcontains $ownerSid) {",
    "        [PSCustomObject]@{ locked=$false; reason='Untrusted NTFS owner SID'; unsafePath=$cur; unsafeSid=$ownerSid } | ConvertTo-Json -Compress; exit 0",
    "    }",
    "    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {",
    "        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }",
    "        if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }",
    "        $sid = $rule.IdentityReference.Value",
    "        if ($trusted -contains $sid) { continue }",
    "        if (([int]$rule.FileSystemRights -band $dangerous) -ne 0) {",
    "            [PSCustomObject]@{ locked=$false; reason='Writable by non-admin SID'; unsafePath=$cur; unsafeSid=$sid } | ConvertTo-Json -Compress; exit 0",
    "        }",
    "    }",
    "    $parent = [System.IO.Path]::GetDirectoryName($cur)",
    "    if (-not $parent -or $parent -eq $cur) { break }",
    "    $cur = $parent",
    "}",
    "[PSCustomObject]@{ locked=$true } | ConvertTo-Json -Compress",
  ].join('\r\n');

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    ).trim();
    if (!out) return { locked: false, reason: 'Empty ACL verification result' };
    const parsed = JSON.parse(out) as AclCheckResult;
    return {
      locked: Boolean(parsed?.locked),
      reason: parsed?.reason,
      unsafePath: parsed?.unsafePath,
      unsafeSid: parsed?.unsafeSid,
    };
  } catch (err: any) {
    return { locked: false, reason: `ACL verification error: ${err?.message || err}` };
  }
}

/**
 * 检查 Windows Authenticode 数字签名（严格要求 Status === Valid）
 */
export function verifyWindowsAuthenticodeSync(filePath: string): AuthenticodeCheckResult {
  if (process.platform !== 'win32') {
    return { valid: false, reason: 'Authenticode verification requires Windows' };
  }
  const escaped = path.resolve(filePath).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$sig = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    "$valid = ($sig -and $sig.Status -eq 'Valid' -and $sig.SignerCertificate -ne $null)",
    "[PSCustomObject]@{ valid=$valid; subject=$(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }); thumbprint=$(if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { '' }); reason=[string]$sig.Status } | ConvertTo-Json -Compress",
  ].join('\r\n');

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    ).trim();
    if (!out) return { valid: false, reason: 'Empty Authenticode result' };
    const parsed = JSON.parse(out) as AuthenticodeCheckResult;
    return {
      valid: Boolean(parsed?.valid),
      subject: parsed?.subject,
      thumbprint: parsed?.thumbprint,
      reason: parsed?.reason,
    };
  } catch (err: any) {
    return { valid: false, reason: `Authenticode error: ${err?.message || err}` };
  }
}

/**
 * 建立 Mihomo 安装源信任机制（严格 fail-closed，兼容合法版本升级）：
 * 1. 验证文件存在、名称为 mihomo.exe、普通文件非符号链接、>=1MB、合法 PE MZ 文件头。
 * 2. 检查安装源文件及父目录链 ACL，确保普通用户无法在验证前/后替换安装源。
 * 3. 验证来源可信性（三选一，全部失败则拒绝以 SYSTEM 权限安装或启动）：
 *    - 内置可信版本 SHA-256 清单；
 *    - 管理员权限保护的外部升级清单 mihomo-manifest.json（同样强制校验清单文件及父目录 ACL）；
 *    - 有效的 Windows Authenticode 数字签名。
 */
export function verifyMihomoInstallSource(
  binPath: string,
  options?: VerifyMihomoSourceOptions
): MihomoSourceTrustResult {
  if (!binPath) {
    return { trusted: false, error: '未提供可信 mihomo.exe 核心路径，拒绝安装特权服务' };
  }
  const resolvedBin = path.resolve(binPath);
  if (path.basename(resolvedBin).toLowerCase() !== 'mihomo.exe') {
    return { trusted: false, error: '可信核心文件名必须为 mihomo.exe' };
  }
  if (!fs.existsSync(resolvedBin)) {
    return { trusted: false, error: `未找到可信核心文件: ${resolvedBin}` };
  }
  const binLstat = fs.lstatSync(resolvedBin);
  if (!binLstat.isFile() || binLstat.isSymbolicLink() || binLstat.size < 1024 * 1024) {
    return { trusted: false, error: 'mihomo.exe 安装源非法（非普通可执行文件或为符号链接）' };
  }
  const binBytes = fs.readFileSync(resolvedBin);
  if (binBytes.length < 2 || binBytes[0] !== 0x4d || binBytes[1] !== 0x5a) {
    return { trusted: false, error: 'mihomo.exe 安装源缺少合法 PE MZ 文件头' };
  }

  const actualSha256 = crypto.createHash('sha256').update(binBytes).digest('hex').toUpperCase();

  // 1. 优先匹配内置可信版本 SHA-256 清单（硬编码于应用包内，复制至受保护目录后仍会二次校验哈希，防 TOCTOU）
  //    因此便携版（Temp 解压）、绿色版或安装到 D 盘等用户可写目录时也能安全安装系统服务
  const builtin = options?.builtinHashes ?? TRUSTED_MIHOMO_BUILTIN_HASHES;
  for (const [ver, hash] of Object.entries(builtin)) {
    if (typeof hash === 'string' && hash.trim().toUpperCase() === actualSha256) {
      return {
        trusted: true,
        sha256: actualSha256,
        matchedVersion: ver,
        trustMethod: 'builtin-manifest',
      };
    }
  }

  // 2. 检查 Windows Authenticode 数字签名（密码学防篡改，复制到受保护目录后二次验签）
  const checkSigFn = options?.checkSignature ?? verifyWindowsAuthenticodeSync;
  const sigRes = checkSigFn(resolvedBin);
  if (sigRes.valid) {
    return {
      trusted: true,
      sha256: actualSha256,
      trustMethod: 'authenticode',
    };
  }

  // 3. 回退到外部升级清单 mihomo-manifest.json：外部文件非硬编码，必须强制校验清单目录 ACL 已锁定
  const checkAclFn = options?.checkAcl ?? verifyWindowsPathAclChainSync;
  const candidateManifest = options?.manifestPath
    ? path.resolve(options.manifestPath)
    : path.join(path.dirname(resolvedBin), TRUSTED_MIHOMO_MANIFEST_FILENAME);

  const tryVerifyManifestFile = (manifestFilePath: string, requireBinAcl: boolean): MihomoSourceTrustResult | null => {
    if (!fs.existsSync(manifestFilePath)) return null;
    const manifestStat = fs.lstatSync(manifestFilePath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return {
        trusted: false,
        sha256: actualSha256,
        error: 'mihomo-manifest.json 非法（非普通文件或为符号链接）',
      };
    }
    if (requireBinAcl) {
      const binAcl = checkAclFn(resolvedBin);
      if (!binAcl.locked) {
        return {
          trusted: false,
          error: `mihomo.exe 安装源或其父目录 ACL 不安全（普通用户可写，拒绝信任）: ${binAcl.unsafePath || resolvedBin} (${binAcl.reason || 'ACL unlocked'})`,
        };
      }
    }
    const manifestAcl = checkAclFn(manifestFilePath);
    if (!manifestAcl.locked) {
      return {
        trusted: false,
        sha256: actualSha256,
        error: `mihomo-manifest.json 或其父目录 ACL 不安全（普通用户可写，拒绝信任清单）: ${manifestAcl.unsafePath || manifestFilePath}`,
      };
    }
    const manifest = parseTrustedMihomoManifest(fs.readFileSync(manifestFilePath, 'utf8'));
    if (!manifest) {
      return {
        trusted: false,
        sha256: actualSha256,
        error: 'mihomo-manifest.json 格式无效，无法验证安装源可信性',
      };
    }
    const matched = manifest.entries.find((e) => e.sha256 === actualSha256);
    if (matched) {
      return {
        trusted: true,
        sha256: actualSha256,
        matchedVersion: matched.version,
        trustMethod: 'external-manifest',
        manifestPath: manifestFilePath,
      };
    }
    return null;
  };

  // 3a. 优先检查应用内更新内核后同步到系统特权目录的 ACL 锁定清单 (ProgramData\NexLink\mihomo-manifest.json 及 service\mihomo-manifest.json)
  if (!options?.manifestPath) {
    const svcDir = getServiceInstallDir();
    const lockedManifestCandidates = [
      path.join(path.dirname(svcDir), TRUSTED_MIHOMO_MANIFEST_FILENAME),
      path.join(svcDir, TRUSTED_MIHOMO_MANIFEST_FILENAME),
    ];
    for (const lockedManifestPath of lockedManifestCandidates) {
      if (path.resolve(lockedManifestPath).toLowerCase() !== candidateManifest.toLowerCase()) {
        const serviceManifestRes = tryVerifyManifestFile(lockedManifestPath, false);
        if (serviceManifestRes) return serviceManifestRes;
      }
    }
  }

  // 3b. 检查安装源同目录下的外部升级清单（要求安装源与清单父目录均具备管理员 ACL 锁定）
  const localManifestRes = tryVerifyManifestFile(candidateManifest, true);
  if (localManifestRes) return localManifestRes;

  // 若两者均未命中但同目录本身处于不安全 ACL，仍保留明确错误提示
  if (!fs.existsSync(candidateManifest)) {
    const binAcl = checkAclFn(resolvedBin);
    if (!binAcl.locked) {
      return {
        trusted: false,
        error: `mihomo.exe 安装源或其父目录 ACL 不安全（普通用户可写，拒绝信任）: ${binAcl.unsafePath || resolvedBin} (${binAcl.reason || 'ACL unlocked'})`,
      };
    }
  }

  return {
    trusted: false,
    sha256: actualSha256,
    error: `mihomo.exe 未通过可信来源验证（SHA-256 ${actualSha256.slice(0, 12)}... 不在可信版本清单中且无有效数字签名），禁止以 SYSTEM 权限安装或启动`,
  };
}

/**
 * 生成原生 Windows Service C# 源码 (严格纯 ASCII + C# 5.0 语法，兼容所有 Windows 10/11 内置 csc.exe)
 */
export function generateServiceCSharpSource(port: number = SERVICE_PORT): string {
  const allowedMihomoInit = Object.values(TRUSTED_MIHOMO_BUILTIN_HASHES)
    .map((h) => `\n            "${h.trim().toUpperCase()}"`)
    .join(',');
  return `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace NexLinkServiceHost
{
    public class NexLinkCoreService : ServiceBase
    {
        private HttpListener _listener;
        private Thread _listenThread;
        private volatile bool _stopping = false;
        private readonly object _procLock = new object();
        private readonly object _logLock = new object();
        private readonly object _coreLogLock = new object();
        private Process _coreProcess = null;
        private StreamWriter _coreLogWriter = null;
        private long _coreLogBytesWritten = 0;
        private const long MaxCoreLogBytes = 5 * 1024 * 1024;
        private string _authToken = "";
        private bool _tunWasEnabled = false;
        private readonly string _serviceDir;
        private readonly string _lockedBinDir;
        private readonly string _lockedBinPath;
        private readonly string _lockedRuntimeDir;
        private readonly string _lockedConfigPath;
        private readonly string _lockedBinHashPath;
        private readonly string _lockedManifestPath;
        private readonly string _lockedCoreLogPath;
        private readonly string _serviceLogPath;
        // Official Wintun 0.14.1 SHA-256 allowlist (amd64, arm64, x86, arm)
        private static readonly HashSet<string> AllowedWintunSha256 = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "E5DA8447DC2C320EDC0FC52FA01885C103DE8C118481F683643CACC3220DAFCE",
            "F7BA89005544BE9D85231A9E0D5F23B2D15B3311667E2DAD0DEBD344918A3F80",
            "D694FA46AB4CFEBCB2632D094C7AA97278EEF2F8052438621766D863AE98A931",
            "DAAD267411ECDC70A0535E274D2C3E9DA3D0084BDAC7662CB8424DD4A031B4D9"
        };
        private static readonly HashSet<string> AllowedMihomoSha256 = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {${allowedMihomoInit}
        };
        private static readonly HashSet<string> TrustedWriteSids = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
        };

        public NexLinkCoreService()
        {
            ServiceName = "${SERVICE_NAME}";
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            _serviceDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\', '/');
            _lockedBinDir = Path.Combine(_serviceDir, "bin");
            _lockedBinPath = Path.Combine(_lockedBinDir, "mihomo.exe");
            _lockedRuntimeDir = Path.Combine(_serviceDir, "runtime");
            _lockedConfigPath = Path.Combine(_lockedRuntimeDir, "config.yaml");
            _lockedBinHashPath = Path.Combine(_serviceDir, "mihomo.sha256");
            _lockedManifestPath = Path.Combine(_serviceDir, "mihomo-manifest.json");
            _lockedCoreLogPath = Path.Combine(_serviceDir, "mihomo-service.log");
            _serviceLogPath = Path.Combine(_serviceDir, "service.log");
        }

        private void Log(string msg)
        {
            lock (_logLock)
            {
                try
                {
                    if (File.Exists(_serviceLogPath) && new FileInfo(_serviceLogPath).Length > 2 * 1024 * 1024)
                    {
                        File.WriteAllText(_serviceLogPath, "", Encoding.UTF8);
                    }
                    File.AppendAllText(
                        _serviceLogPath,
                        "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + msg + Environment.NewLine,
                        Encoding.UTF8
                    );
                }
                catch { }
            }
        }

        private static string ComputeFileSha256(string filePath)
        {
            using (var sha = SHA256.Create())
            using (var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] hash = sha.ComputeHash(fs);
                return BitConverter.ToString(hash).Replace("-", "").ToUpperInvariant();
            }
        }

        private static void VerifyNotReparsePointChain(string targetPath)
        {
            string current = Path.GetFullPath(targetPath).TrimEnd('\\\\', '/');
            string root = Path.GetPathRoot(current);
            while (!string.IsNullOrEmpty(current) && !string.Equals(current, root, StringComparison.OrdinalIgnoreCase))
            {
                if (Directory.Exists(current) || File.Exists(current))
                {
                    FileAttributes attrs = File.GetAttributes(current);
                    if ((attrs & FileAttributes.ReparsePoint) != 0)
                    {
                        throw new UnauthorizedAccessException("Reparse point (junction/symlink) rejected in path chain: " + current);
                    }
                }
                string parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
        }

        private static void VerifyDirectoryAclLocked(string dirPath)
        {
            if (!Directory.Exists(dirPath))
            {
                throw new InvalidOperationException("Required locked directory missing: " + dirPath);
            }
            VerifyNotReparsePointChain(dirPath);
            DirectorySecurity ds = Directory.GetAccessControl(dirPath);
            IdentityReference ownerRef = ds.GetOwner(typeof(SecurityIdentifier));
            string ownerSid = ownerRef != null ? ownerRef.Value : "";
            if (!TrustedWriteSids.Contains(ownerSid))
            {
                throw new UnauthorizedAccessException("Directory owner unsafe (untrusted owner SID " + ownerSid + "): " + dirPath);
            }
            AuthorizationRuleCollection rules = ds.GetAccessRules(true, true, typeof(SecurityIdentifier));
            FileSystemRights dangerousRights =
                FileSystemRights.WriteData |
                FileSystemRights.AppendData |
                FileSystemRights.CreateFiles |
                FileSystemRights.CreateDirectories |
                FileSystemRights.WriteAttributes |
                FileSystemRights.WriteExtendedAttributes |
                FileSystemRights.Delete |
                FileSystemRights.DeleteSubdirectoriesAndFiles |
                FileSystemRights.ChangePermissions |
                FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                string sid = rule.IdentityReference != null ? rule.IdentityReference.Value : "";
                if (TrustedWriteSids.Contains(sid)) continue;
                if ((rule.FileSystemRights & dangerousRights) != 0)
                {
                    throw new UnauthorizedAccessException("Directory ACL unsafe (writable by non-admin SID " + sid + "): " + dirPath);
                }
            }
        }

        private static void VerifyFileAclLocked(string filePath)
        {
            if (!File.Exists(filePath))
            {
                throw new FileNotFoundException("Required locked file missing: " + filePath);
            }
            VerifyNotReparsePointChain(filePath);
            FileSecurity fs = File.GetAccessControl(filePath);
            IdentityReference ownerRef = fs.GetOwner(typeof(SecurityIdentifier));
            string ownerSid = ownerRef != null ? ownerRef.Value : "";
            if (!TrustedWriteSids.Contains(ownerSid))
            {
                throw new UnauthorizedAccessException("File owner unsafe (untrusted owner SID " + ownerSid + "): " + filePath);
            }
            AuthorizationRuleCollection rules = fs.GetAccessRules(true, true, typeof(SecurityIdentifier));
            FileSystemRights dangerousRights =
                FileSystemRights.WriteData |
                FileSystemRights.AppendData |
                FileSystemRights.CreateFiles |
                FileSystemRights.CreateDirectories |
                FileSystemRights.WriteAttributes |
                FileSystemRights.WriteExtendedAttributes |
                FileSystemRights.Delete |
                FileSystemRights.DeleteSubdirectoriesAndFiles |
                FileSystemRights.ChangePermissions |
                FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                string sid = rule.IdentityReference != null ? rule.IdentityReference.Value : "";
                if (TrustedWriteSids.Contains(sid)) continue;
                if ((rule.FileSystemRights & dangerousRights) != 0)
                {
                    throw new UnauthorizedAccessException("File ACL unsafe (writable by non-admin SID " + sid + "): " + filePath);
                }
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public string pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]
        private static extern uint WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID, ref WINTRUST_DATA pWVTData);

        private static bool VerifyAuthenticodeSignature(string filePath)
        {
            IntPtr fileInfoPtr = IntPtr.Zero;
            try
            {
                var fileInfo = new WINTRUST_FILE_INFO
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)),
                    pcwszFilePath = filePath,
                    hFile = IntPtr.Zero,
                    pgKnownSubject = IntPtr.Zero
                };
                fileInfoPtr = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
                Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);

                var wvt = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    dwUIChoice = 2, // WTD_UI_NONE
                    fdwRevocationChecks = 0, // WTD_REVOKE_NONE
                    dwUnionChoice = 1, // WTD_CHOICE_FILE
                    pFile = fileInfoPtr,
                    dwStateAction = 1, // WTD_STATEACTION_VERIFY
                    dwProvFlags = 0x00000010 // WTD_SAFER_FLAG
                };
                Guid action = new Guid("{00AAC56B-CD44-11d0-8CC2-00C04FC295EE}");
                uint status = WinVerifyTrust(IntPtr.Zero, action, ref wvt);
                wvt.dwStateAction = 2; // WTD_STATEACTION_CLOSE
                WinVerifyTrust(IntPtr.Zero, action, ref wvt);
                return status == 0;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (fileInfoPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(fileInfoPtr);
            }
        }

        private void VerifyTrustedMihomoSource(string binPath, string actualBinHash)
        {
            if (AllowedMihomoSha256.Contains(actualBinHash))
            {
                return;
            }
            if (File.Exists(_lockedManifestPath))
            {
                VerifyFileAclLocked(_lockedManifestPath);
                string rawManifest = File.ReadAllText(_lockedManifestPath, Encoding.UTF8);
                var ser = new JavaScriptSerializer();
                var root = ser.Deserialize<Dictionary<string, object>>(rawManifest);
                if (root != null && root.ContainsKey("entries") && root["entries"] is System.Collections.ArrayList)
                {
                    var entries = (System.Collections.ArrayList)root["entries"];
                    foreach (object itemObj in entries)
                    {
                        var entry = itemObj as Dictionary<string, object>;
                        if (entry != null && entry.ContainsKey("sha256"))
                        {
                            string entryHash = Convert.ToString(entry["sha256"]).Trim().ToUpperInvariant();
                            if (string.Equals(entryHash, actualBinHash, StringComparison.OrdinalIgnoreCase))
                            {
                                return;
                            }
                        }
                    }
                }
            }
            if (VerifyAuthenticodeSignature(binPath))
            {
                return;
            }
            throw new UnauthorizedAccessException("Untrusted mihomo.exe source rejected by SYSTEM service (not in verified manifest and no valid Authenticode signature)");
        }

        private static void VerifyDirectoryDlls(string dirPath, bool requireWintun)
        {
            string[] dlls = Directory.GetFiles(dirPath, "*.dll", SearchOption.TopDirectoryOnly);
            bool foundValidWintun = false;
            foreach (string dll in dlls)
            {
                string name = Path.GetFileName(dll).ToLowerInvariant();
                if (name != "wintun.dll")
                {
                    throw new UnauthorizedAccessException("Unexpected DLL found in locked directory: " + dll);
                }
                string actualHash = ComputeFileSha256(dll);
                if (!AllowedWintunSha256.Contains(actualHash))
                {
                    throw new UnauthorizedAccessException("wintun.dll SHA-256 verification failed: " + actualHash);
                }
                foundValidWintun = true;
            }
            if (requireWintun && !foundValidWintun)
            {
                throw new FileNotFoundException("Verified wintun.dll is required in locked runtime directory: " + dirPath);
            }
        }

        protected override void OnStart(string[] args)
        {
            _stopping = false;
            LoadToken();
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://127.0.0.1:${port}/");
            _listener.Start();
            _listenThread = new Thread(ListenLoop);
            _listenThread.IsBackground = true;
            _listenThread.Start();
            Log("NexLinkCoreService started on 127.0.0.1:${port}");
        }

        protected override void OnStop()
        {
            ShutdownInternal();
        }

        protected override void OnShutdown()
        {
            ShutdownInternal();
        }

        private void ShutdownInternal()
        {
            _stopping = true;
            try { StopCoreProcess(); } catch { }
            try { if (_listener != null && _listener.IsListening) _listener.Stop(); } catch { }
            try { if (_listener != null) _listener.Close(); } catch { }
            Log("NexLinkCoreService stopped.");
        }

        private void LoadToken()
        {
            string tokenPath = Path.Combine(_serviceDir, "service.token");
            if (File.Exists(tokenPath))
            {
                _authToken = File.ReadAllText(tokenPath, Encoding.UTF8).Trim().TrimStart('\\uFEFF');
            }
        }

        private void ListenLoop()
        {
            while (!_stopping && _listener != null && _listener.IsListening)
            {
                try
                {
                    HttpListenerContext ctx = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(delegate { HandleRequest(ctx); });
                }
                catch (HttpListenerException)
                {
                    if (_stopping) break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log("ListenLoop error: " + ex.Message);
                }
            }
        }

        private void WriteJson(HttpListenerResponse res, int statusCode, object payload)
        {
            try
            {
                res.StatusCode = statusCode;
                res.ContentType = "application/json; charset=utf-8";
                byte[] buf = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(payload));
                res.ContentLength64 = buf.Length;
                res.OutputStream.Write(buf, 0, buf.Length);
                res.OutputStream.Close();
            }
            catch { }
        }

        private static bool ConstantTimeEquals(string a, string b)
        {
            if (a == null || b == null) return false;
            byte[] ba = Encoding.UTF8.GetBytes(a);
            byte[] bb = Encoding.UTF8.GetBytes(b);
            int diff = ba.Length ^ bb.Length;
            int maxLen = Math.Max(ba.Length, bb.Length);
            for (int i = 0; i < maxLen; i++)
            {
                byte x = i < ba.Length ? ba[i] : (byte)0;
                byte y = i < bb.Length ? bb[i] : (byte)0;
                diff |= (x ^ y);
            }
            return diff == 0;
        }

        private static void ValidateConfigContentSafety(string configContent)
        {
            if (Regex.IsMatch(configContent, @"^\\s*external-controller-(tls|unix|pipe)\\s*:", RegexOptions.IgnoreCase | RegexOptions.Multiline))
            {
                throw new UnauthorizedAccessException("Unsupported external-controller transport rejected by service");
            }
            MatchCollection matches = Regex.Matches(configContent, @"^\\s*external-controller\\s*:\\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.Multiline);
            foreach (Match m in matches)
            {
                string rawVal = m.Groups[1].Value;
                rawVal = Regex.Replace(rawVal, @"\\s+#.*$", "").Trim();
                if ((rawVal.StartsWith("'") && rawVal.EndsWith("'")) || (rawVal.StartsWith("\\"") && rawVal.EndsWith("\\"")))
                {
                    if (rawVal.Length >= 2) rawVal = rawVal.Substring(1, rawVal.Length - 2).Trim();
                }
                if (string.IsNullOrEmpty(rawVal)) continue;
                Match hostPort = Regex.Match(rawVal, @"^(127\\.0\\.0\\.1|localhost|\\[::1\\]):([1-9]\\d{0,4})$", RegexOptions.IgnoreCase);
                if (!hostPort.Success)
                {
                    throw new UnauthorizedAccessException("external-controller must bind strictly to loopback (127.0.0.1): " + rawVal);
                }
                int ctlPort;
                if (!int.TryParse(hostPort.Groups[2].Value, out ctlPort) || ctlPort < 1 || ctlPort > 65535)
                {
                    throw new UnauthorizedAccessException("Invalid external-controller port: " + rawVal);
                }
            }
        }

        private static bool IsTunEnabledInYaml(string configContent)
        {
            if (string.IsNullOrEmpty(configContent)) return false;
            bool inTunSection = false;
            using (var sr = new StringReader(configContent))
            {
                string rawLine;
                while ((rawLine = sr.ReadLine()) != null)
                {
                    string trimmed = rawLine.Trim();
                    if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("#")) continue;
                    bool isTopLevel = rawLine.Length > 0 && !char.IsWhiteSpace(rawLine[0]) && !trimmed.StartsWith("-");
                    if (isTopLevel)
                    {
                        if (Regex.IsMatch(trimmed, @"^tun\\s*:\\s*(#.*)?$", RegexOptions.IgnoreCase))
                        {
                            inTunSection = true;
                            continue;
                        }
                        if (Regex.IsMatch(trimmed, @"^tun\\s*:\\s*\\{.*\\}", RegexOptions.IgnoreCase))
                        {
                            if (Regex.IsMatch(trimmed, @"\\benable\\s*:\\s*true\\b", RegexOptions.IgnoreCase)) return true;
                            inTunSection = false;
                            continue;
                        }
                        inTunSection = false;
                        continue;
                    }
                    if (inTunSection)
                    {
                        string noComment = Regex.Replace(trimmed, @"\\s+#.*$", "").Trim();
                        if (Regex.IsMatch(noComment, @"^enable\\s*:\\s*true$", RegexOptions.IgnoreCase)) return true;
                        if (Regex.IsMatch(noComment, @"^enable\\s*:\\s*false$", RegexOptions.IgnoreCase)) return false;
                    }
                }
            }
            return false;
        }

        private void RotateCoreLogLockedIfNeeded(long incomingBytes)
        {
            if (string.IsNullOrEmpty(_lockedCoreLogPath)) return;
            if (_coreLogBytesWritten + incomingBytes < MaxCoreLogBytes) return;
            if (_coreLogWriter != null)
            {
                try { _coreLogWriter.Flush(); _coreLogWriter.Close(); _coreLogWriter.Dispose(); } catch { }
                _coreLogWriter = null;
            }
            string backupLog = _lockedCoreLogPath + ".1";
            try
            {
                if (File.Exists(backupLog)) File.Delete(backupLog);
                if (File.Exists(_lockedCoreLogPath)) File.Move(_lockedCoreLogPath, backupLog);
            }
            catch
            {
                try { File.WriteAllText(_lockedCoreLogPath, "", Encoding.UTF8); } catch { }
            }
            _coreLogBytesWritten = 0;
            try
            {
                _coreLogWriter = new StreamWriter(
                    new FileStream(_lockedCoreLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                    Encoding.UTF8
                )
                {
                    AutoFlush = true
                };
            }
            catch { _coreLogWriter = null; }
        }

        private void WriteCoreLogLine(string line)
        {
            if (line == null) return;
            lock (_coreLogLock)
            {
                if (_coreLogWriter == null) return;
                try
                {
                    long bytes = Encoding.UTF8.GetByteCount(line) + 2;
                    RotateCoreLogLockedIfNeeded(bytes);
                    if (_coreLogWriter != null)
                    {
                        _coreLogWriter.WriteLine(line);
                        _coreLogBytesWritten += bytes;
                    }
                }
                catch { }
            }
        }

        private void HandleRequest(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            try
            {
                string token = req.Headers["X-NexLink-Token"] ?? "";
                if (string.IsNullOrEmpty(_authToken) || !ConstantTimeEquals(token, _authToken))
                {
                    WriteJson(res, 403, new { ok = false, error = "Forbidden: invalid service token" });
                    return;
                }

                string path = (req.Url != null ? req.Url.AbsolutePath : "/").TrimEnd('/').ToLowerInvariant();
                if (string.IsNullOrEmpty(path)) path = "/";

                if (req.HttpMethod == "GET" && path == "/ping")
                {
                    bool running = false;
                    int pid = 0;
                    lock (_procLock)
                    {
                        if (_coreProcess != null && !_coreProcess.HasExited)
                        {
                            running = true;
                            pid = _coreProcess.Id;
                        }
                    }
                    WriteJson(res, 200, new { ok = true, version = "${SERVICE_VERSION}", coreRunning = running, corePid = pid });
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/start")
                {
                    const int MaxBodyBytes = 5 * 1024 * 1024;
                    if (req.ContentLength64 > MaxBodyBytes)
                    {
                        WriteJson(res, 413, new { ok = false, error = "Request body exceeds 5MB limit" });
                        return;
                    }
                    byte[] bodyBytes;
                    using (var ms = new MemoryStream())
                    {
                        byte[] chunk = new byte[8192];
                        int totalRead = 0;
                        int n;
                        while ((n = req.InputStream.Read(chunk, 0, chunk.Length)) > 0)
                        {
                            totalRead += n;
                            if (totalRead > MaxBodyBytes)
                            {
                                WriteJson(res, 413, new { ok = false, error = "Request body exceeds 5MB limit" });
                                return;
                            }
                            ms.Write(chunk, 0, n);
                        }
                        bodyBytes = ms.ToArray();
                    }
                    string body = Encoding.UTF8.GetString(bodyBytes);
                    var serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = MaxBodyBytes + 65536;
                    var data = serializer.Deserialize<Dictionary<string, object>>(body);
                    string configContent = data != null && data.ContainsKey("configContent") ? Convert.ToString(data["configContent"]) : "";
                    int apiPort = data != null && data.ContainsKey("apiPort") ? Convert.ToInt32(data["apiPort"]) : 9097;

                    // Security boundary: ignore caller binPath/configDir/configPath/logPath completely;
                    // SYSTEM only executes pinned _lockedBinPath with pinned _lockedRuntimeDir.
                    if (string.IsNullOrEmpty(configContent) || configContent.Length > MaxBodyBytes)
                    {
                        WriteJson(res, 400, new { ok = false, error = "Missing or oversized configContent" });
                        return;
                    }
                    if (apiPort < 1024 || apiPort > 65535)
                    {
                        WriteJson(res, 400, new { ok = false, error = "Invalid apiPort" });
                        return;
                    }

                    int pid = StartCoreProcess(configContent, apiPort);
                    WriteJson(res, 200, new { ok = true, pid = pid });
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/stop")
                {
                    StopCoreProcess();
                    WriteJson(res, 200, new { ok = true });
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/cleanup-routes")
                {
                    CleanupTunRoutes();
                    WriteJson(res, 200, new { ok = true });
                    return;
                }

                WriteJson(res, 404, new { ok = false, error = "Not Found" });
            }
            catch (Exception ex)
            {
                Log("HandleRequest error: " + ex.Message);
                WriteJson(res, 500, new { ok = false, error = ex.Message });
            }
        }

        private int StartCoreProcess(string configContent, int apiPort)
        {
            lock (_procLock)
            {
                StopCoreProcessLocked();

                // 1. Verify parent app dir + serviceDir + bin + runtime ACL and full parent reparse-point chain
                string appParentDir = Path.GetDirectoryName(_serviceDir);
                if (!string.IsNullOrEmpty(appParentDir)) VerifyDirectoryAclLocked(appParentDir);
                VerifyDirectoryAclLocked(_serviceDir);
                VerifyDirectoryAclLocked(_lockedBinDir);
                VerifyDirectoryAclLocked(_lockedRuntimeDir);

                VerifyFileAclLocked(_lockedBinPath);
                VerifyFileAclLocked(_lockedBinHashPath);
                string expectedBinHash = File.ReadAllText(_lockedBinHashPath, Encoding.UTF8).Trim().ToUpperInvariant();
                string actualBinHash = ComputeFileSha256(_lockedBinPath);
                if (string.IsNullOrEmpty(expectedBinHash) || !string.Equals(expectedBinHash, actualBinHash, StringComparison.OrdinalIgnoreCase))
                {
                    throw new UnauthorizedAccessException("Pinned mihomo.exe SHA-256 verification failed");
                }
                VerifyTrustedMihomoSource(_lockedBinPath, actualBinHash);

                // 2. Validate configContent loopback controller & write atomically into locked runtime dir (never trust user-writable configDir)
                ValidateConfigContentSafety(configContent);
                string tmpCfg = _lockedConfigPath + ".tmp";
                File.WriteAllText(tmpCfg, configContent, new UTF8Encoding(false));
                if (File.Exists(_lockedConfigPath)) File.Delete(_lockedConfigPath);
                File.Move(tmpCfg, _lockedConfigPath);

                bool configUsesTun = IsTunEnabledInYaml(configContent);

                // 3. Verify no untrusted DLLs exist in locked bin/runtime dirs and verify wintun.dll SHA-256
                VerifyDirectoryDlls(_lockedBinDir, false);
                VerifyDirectoryDlls(_lockedRuntimeDir, configUsesTun);

                _tunWasEnabled = configUsesTun;
                // API secret is embedded inside config.yaml; omit -secret from process command line
                string args = string.Format(
                    "-d \\"{0}\\" -f \\"{1}\\" -ext-ctl 127.0.0.1:{2}",
                    _lockedRuntimeDir, _lockedConfigPath, apiPort
                );

                var psi = new ProcessStartInfo
                {
                    FileName = _lockedBinPath,
                    Arguments = args,
                    WorkingDirectory = _lockedRuntimeDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                // Sanitize PATH so SYSTEM cannot resolve DLLs from any user-writable directory
                psi.EnvironmentVariables["PATH"] = Environment.SystemDirectory + ";" + Environment.GetFolderPath(Environment.SpecialFolder.Windows);

                if (!string.IsNullOrEmpty(_lockedCoreLogPath))
                {
                    lock (_coreLogLock)
                    {
                        try
                        {
                            if (File.Exists(_lockedCoreLogPath))
                            {
                                long existingLen = new FileInfo(_lockedCoreLogPath).Length;
                                if (existingLen >= MaxCoreLogBytes)
                                {
                                    string backupLog = _lockedCoreLogPath + ".1";
                                    if (File.Exists(backupLog)) File.Delete(backupLog);
                                    File.Move(_lockedCoreLogPath, backupLog);
                                    _coreLogBytesWritten = 0;
                                }
                                else
                                {
                                    _coreLogBytesWritten = existingLen;
                                }
                            }
                            else
                            {
                                _coreLogBytesWritten = 0;
                            }
                            _coreLogWriter = new StreamWriter(
                                new FileStream(_lockedCoreLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                                Encoding.UTF8
                            )
                            {
                                AutoFlush = true
                            };
                        }
                        catch { _coreLogWriter = null; }
                    }
                    WriteCoreLogLine(Environment.NewLine + "--- NexLink Service Mihomo Core Starting at " + DateTime.UtcNow.ToString("o") + " ---");
                }

                var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        WriteCoreLogLine(e.Data);
                    }
                };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        WriteCoreLogLine(e.Data);
                    }
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                _coreProcess = proc;
                Log("Started mihomo.exe PID=" + proc.Id + " apiPort=" + apiPort);
                return proc.Id;
            }
        }

        private void StopCoreProcess()
        {
            lock (_procLock)
            {
                StopCoreProcessLocked();
            }
        }

        private void StopCoreProcessLocked()
        {
            if (_coreProcess != null)
            {
                try
                {
                    if (!_coreProcess.HasExited)
                    {
                        _coreProcess.Kill();
                        _coreProcess.WaitForExit(3000);
                    }
                }
                catch { }
                try { _coreProcess.Dispose(); } catch { }
                _coreProcess = null;
            }

            lock (_coreLogLock)
            {
                if (_coreLogWriter != null)
                {
                    try { _coreLogWriter.Flush(); _coreLogWriter.Close(); _coreLogWriter.Dispose(); } catch { }
                    _coreLogWriter = null;
                }
            }

            if (_tunWasEnabled)
            {
                CleanupTunRoutes();
                _tunWasEnabled = false;
            }
        }

        private void CleanupTunRoutes()
        {
            try
            {
                var psi1 = new ProcessStartInfo
                {
                    FileName = "route.exe",
                    Arguments = "delete 0.0.0.0 198.18.0.2",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi1))
                {
                    if (p != null) p.WaitForExit(1500);
                }
            }
            catch { }

            try
            {
                var psi2 = new ProcessStartInfo
                {
                    FileName = "route.exe",
                    Arguments = "delete 198.18.0.0",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi2))
                {
                    if (p != null) p.WaitForExit(1500);
                }
            }
            catch { }

            try
            {
                var psiDns = new ProcessStartInfo
                {
                    FileName = "ipconfig.exe",
                    Arguments = "/flushdns",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psiDns))
                {
                    if (p != null) p.WaitForExit(2000);
                }
            }
            catch { }
        }

        public static void Main()
        {
            ServiceBase.Run(new NexLinkCoreService());
        }
    }
}
`;
}

export class TunServiceManager {
  private readonly serviceDir: string;
  private readonly tokenPath: string;
  private readonly baseUrl: string;

  constructor(serviceDir?: string, port: number = SERVICE_PORT) {
    this.serviceDir = serviceDir || getServiceInstallDir();
    this.tokenPath = path.join(this.serviceDir, 'service.token');
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  public getServiceDir(): string {
    return this.serviceDir;
  }

  private readToken(): string {
    try {
      if (fs.existsSync(this.tokenPath)) {
        return fs.readFileSync(this.tokenPath, 'utf8').replace(/^\uFEFF/, '').trim();
      }
    } catch {
      // ignore
    }
    return '';
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, any>,
    timeoutMs: number = 1500
  ): Promise<T> {
    const token = this.readToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-NexLink-Token': token,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 毫秒级探测虚拟网卡特权服务状态
   */
  public async getServiceStatus(): Promise<TunServiceStatus> {
    if (process.platform !== 'win32') {
      return { installed: false, running: false, reachable: false };
    }

    // 1. 优先直接本地回环 Ping (<5ms，零子进程开销)
    const token = this.readToken();
    if (token) {
      try {
        const res = await this.request<{
          ok: boolean;
          version?: string;
          coreRunning?: boolean;
          corePid?: number;
        }>('GET', '/ping', undefined, 700);
        if (res?.ok) {
          return {
            installed: true,
            running: true,
            reachable: true,
            version: res.version || SERVICE_VERSION,
            coreRunning: Boolean(res.coreRunning),
            corePid: res.corePid || undefined,
          };
        }
      } catch {
        // 不可达时降级查询 Windows SCM 服务状态
      }
    }

    // 2. 通过原生 sc.exe query 异步查询服务安装与运行状态（不阻塞主进程事件循环）
    try {
      const { stdout: out } = await execFileAsync('sc.exe', ['query', SERVICE_NAME], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500,
      });
      const isRunning = /RUNNING/i.test(out);
      return {
        installed: true,
        running: isRunning,
        reachable: false,
      };
    } catch {
      return {
        installed: false,
        running: false,
        reachable: false,
      };
    }
  }

  /**
   * 快速判断特权服务是否已就绪可用
   */
  public async isServiceReady(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const status = await this.getServiceStatus();
    return status.reachable;
  }

  /**
   * 一键安装并启动 Windows 虚拟网卡特权服务（仅需一次 UAC 授权，后续永久免管理员）
   * 关键兼容保障：
   * - 生成的 .ps1 与 .cs 全部为纯 ASCII 并附带 UTF-8 BOM，杜绝中文 Windows PowerShell 5.1 GBK 编码解析崩溃
   * - 通过 -EncodedCommand 启动 UAC 提权，杜绝含空格或中文用户名路径的参数截断
   * - 通过 .NET Process 直接调用 sc.exe，杜绝 PowerShell 5.1 引号吞噬
   */
  public async installService(
    isAlreadyAdmin: boolean = false,
    trustedMihomoPath?: string,
    sourceOptions?: VerifyMihomoSourceOptions
  ): Promise<{ success: boolean; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅 Windows 系统支持虚拟网卡服务模式' };
    }

    // 获取当前登录用户 SID，仅向当前用户授予 service.token 只读权限（拒绝其他本地用户读取）
    let currentUserPrincipal = '';
    try {
      const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000,
      });
      const sidMatch = stdout.match(/S-1-5-[0-9-]+/);
      if (sidMatch) currentUserPrincipal = `*${sidMatch[0]}`;
    } catch {
      // ignore
    }
    if (!currentUserPrincipal) {
      try {
        const uname = os.userInfo().username;
        if (uname && /^[a-zA-Z0-9._-]+$/.test(uname)) currentUserPrincipal = uname;
      } catch {
        // ignore
      }
    }

    const tmpDir = path.join(os.tmpdir(), `nexlink-svc-install-${Date.now()}`);
    const csPath = path.join(tmpDir, 'NexLinkService.cs');
    const psPath = path.join(tmpDir, 'install-service.ps1');
    const resultLogPath = path.join(tmpDir, 'install-result.txt');
    const token = crypto.randomBytes(32).toString('hex');

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const csContent = '\uFEFF' + generateServiceCSharpSource(SERVICE_PORT);
      fs.writeFileSync(csPath, csContent, 'utf8');
      const csSha256 = crypto.createHash('sha256').update(fs.readFileSync(csPath)).digest('hex').toUpperCase();

      const trustRes = verifyMihomoInstallSource(trustedMihomoPath || '', sourceOptions);
      if (!trustRes.trusted || !trustRes.sha256) {
        return { success: false, error: trustRes.error || 'mihomo.exe 未通过可信来源验证，拒绝安装特权服务' };
      }
      const resolvedTrustedBin = path.resolve(trustedMihomoPath!);
      const expectedMihomoSha256 = trustRes.sha256;
      const escapedTrustedManifest = (trustRes.manifestPath || '').replace(/'/g, "''");

      const escapedServiceDir = this.serviceDir.replace(/'/g, "''");
      const escapedCsPath = csPath.replace(/'/g, "''");
      const escapedResultLog = resultLogPath.replace(/'/g, "''");
      const escapedUserPrincipal = currentUserPrincipal.replace(/'/g, "''");
      const escapedTrustedBin = resolvedTrustedBin.replace(/'/g, "''");

      // 严格纯 ASCII PowerShell 脚本（杜绝中文 Windows GBK 编码解析引号报错）
      const installScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$serviceDir = '${escapedServiceDir}'`,
        `$csSrc = '${escapedCsPath}'`,
        `$expectedCsHash = '${csSha256}'`,
        `$resultLog = '${escapedResultLog}'`,
        `$serviceName = '${SERVICE_NAME}'`,
        `$displayName = '${SERVICE_DISPLAY_NAME}'`,
        `$tokenValue = '${token}'`,
        `$tokenReader = '${escapedUserPrincipal}'`,
        `$trustedBin = '${escapedTrustedBin}'`,
        `$trustedManifest = '${escapedTrustedManifest}'`,
        `$expectedMihomoHash = '${expectedMihomoSha256}'`,
        "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
        "$appParentDir = Split-Path -Parent $serviceDir",
        "$binDir = Join-Path $serviceDir 'bin'",
        "$runtimeDir = Join-Path $serviceDir 'runtime'",
        "$lockedBinPath = Join-Path $binDir 'mihomo.exe'",
        "$lockedBinHashPath = Join-Path $serviceDir 'mihomo.sha256'",
        "$persistentManifestPath = Join-Path $appParentDir 'mihomo-manifest.json'",
        "$lockedManifestPath = Join-Path $serviceDir 'mihomo-manifest.json'",
        "$lockedWintunPath = Join-Path $runtimeDir 'wintun.dll'",
        "$exePath = Join-Path $serviceDir 'NexLinkService.exe'",
        "$tokenPath = Join-Path $serviceDir 'service.token'",
        "$lockedCsPath = Join-Path $serviceDir 'NexLinkService.cs'",
        "",
        "function Write-Result([string]$msg) {",
        "    [System.IO.File]::WriteAllText($resultLog, $msg, $utf8NoBom)",
        "}",
        "",
        "function Run-Native([string]$file, [string]$argsStr) {",
        "    $psi = New-Object System.Diagnostics.ProcessStartInfo",
        "    $psi.FileName = $file",
        "    $psi.Arguments = $argsStr",
        "    $psi.UseShellExecute = $false",
        "    $psi.CreateNoWindow = $true",
        "    $psi.RedirectStandardOutput = $true",
        "    $psi.RedirectStandardError = $true",
        "    $p = New-Object System.Diagnostics.Process",
        "    $p.StartInfo = $psi",
        "    [void]$p.Start()",
        "    $errTask = $p.StandardError.ReadToEndAsync()",
        "    $out = $p.StandardOutput.ReadToEnd()",
        "    $exited = $p.WaitForExit(20000)",
        "    if (-not $exited) { try { $p.Kill() } catch {}; return @{ Code = -1; Output = 'Process timed out' } }",
        "    $err = $errTask.GetAwaiter().GetResult()",
        "    return @{ Code = $p.ExitCode; Output = ($out + ' ' + $err).Trim() }",
        "}",
        "",
        "function Assert-NoReparseChain([string]$target) {",
        "    $cur = $target.TrimEnd('\\', '/')",
        "    $root = [System.IO.Path]::GetPathRoot($cur)",
        "    while ($cur -and ($cur -ne $root)) {",
        "        if (Test-Path -LiteralPath $cur) {",
        "            $it = Get-Item -LiteralPath $cur -Force",
        "            if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ('Refusing reparse point in path chain: ' + $cur) }",
        "        }",
        "        $parent = [System.IO.Path]::GetDirectoryName($cur)",
        "        if (-not $parent -or $parent -eq $cur) { break }",
        "        $cur = $parent",
        "    }",
        "}",
        "",
        "Write-Result 'STEP:INIT'",
        "try {",
        "    Assert-NoReparseChain $serviceDir",
        "    New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null",
        "    Assert-NoReparseChain $serviceDir",
        "",
        "    # Step 1: Locate Windows built-in .NET Framework 4.x csc.exe",
        "    $fwCandidates = @(",
        "        (Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319'),",
        "        (Join-Path $env:WINDIR 'Microsoft.NET\\Framework\\v4.0.30319')",
        "    )",
        "    $fwDir = $null",
        "    foreach ($cand in $fwCandidates) {",
        "        if (Test-Path (Join-Path $cand 'csc.exe')) { $fwDir = $cand; break }",
        "    }",
        "    if (-not $fwDir) {",
        "        throw 'Cannot find .NET Framework 4.x csc.exe on this Windows machine.'",
        "    }",
        "    $cscPath = Join-Path $fwDir 'csc.exe'",
        "    $svcDll = Join-Path $fwDir 'System.ServiceProcess.dll'",
        "    $webDll = Join-Path $fwDir 'System.Web.Extensions.dll'",
        "",
        "    # Step 2: Stop and delete existing service if present",
        "    Write-Result 'STEP:CLEAN_OLD'",
        "    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue",
        "    if ($existing) {",
        "        try { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue } catch {}",
        "        for ($i = 0; $i -lt 25; $i++) {",
        "            $svcCheck = Get-Service -Name $serviceName -ErrorAction SilentlyContinue",
        "            if (-not $svcCheck -or $svcCheck.Status -eq 'Stopped') { break }",
        "            Start-Sleep -Milliseconds 300",
        "        }",
        "        [void](Run-Native 'sc.exe' ('delete ' + $serviceName))",
        "        for ($i = 0; $i -lt 25; $i++) {",
        "            $qRes = Run-Native 'sc.exe' ('query ' + $serviceName)",
        "            if ($qRes.Code -eq 1060) { break }",
        "            Start-Sleep -Milliseconds 300",
        "        }",
        "    }",
        "",
        "    # Step 3: Reject reparse points (junction/symlink), create locked bin/runtime dirs, enforce owner & ACL with strict exit code checks",
        "    Write-Result 'STEP:TOKEN'",
        "    Assert-NoReparseChain $runtimeDir",
        "    Assert-NoReparseChain $binDir",
        "    New-Item -ItemType Directory -Force -Path $binDir | Out-Null",
        "    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null",
        "    if ($appParentDir -and (Test-Path -LiteralPath $appParentDir)) {",
        "        $ownParentRes = Run-Native 'icacls.exe' ('\"' + $appParentDir + '\" /setowner \"*S-1-5-32-544\" /Q')",
        "        if ($ownParentRes.Code -ne 0) { throw ('icacls parent directory owner lock failed (code ' + $ownParentRes.Code + '): ' + $ownParentRes.Output) }",
        "        $aclParentRes = Run-Native 'icacls.exe' ('\"' + $appParentDir + '\" /inheritance:r /grant:r \"*S-1-5-18:(OI)(CI)F\" /grant:r \"*S-1-5-32-544:(OI)(CI)F\" /Q')",
        "        if ($aclParentRes.Code -ne 0) { throw ('icacls parent directory ACL lock failed (code ' + $aclParentRes.Code + '): ' + $aclParentRes.Output) }",
        "    }",
        "    $ownDirRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\" /setowner \"*S-1-5-32-544\" /Q')",
        "    if ($ownDirRes.Code -ne 0) { throw ('icacls directory owner lock failed (code ' + $ownDirRes.Code + '): ' + $ownDirRes.Output) }",
        "    $aclDirRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\" /inheritance:r /grant:r \"*S-1-5-18:(OI)(CI)F\" /grant:r \"*S-1-5-32-544:(OI)(CI)F\" /Q')",
        "    if ($aclDirRes.Code -ne 0) { throw ('icacls directory ACL lock failed (code ' + $aclDirRes.Code + '): ' + $aclDirRes.Output) }",
        "    Assert-NoReparseChain $runtimeDir",
        "    Assert-NoReparseChain $binDir",
        "    if (Test-Path -LiteralPath ($serviceDir + '\\*')) {",
        "        $ownSubRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\\*\" /setowner \"*S-1-5-32-544\" /T /Q')",
        "        if ($ownSubRes.Code -ne 0) { throw ('icacls subitem owner lock failed (code ' + $ownSubRes.Code + '): ' + $ownSubRes.Output) }",
        "        $aclSubRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\\*\" /grant:r \"*S-1-5-18:F\" \"*S-1-5-32-544:F\" /T /Q')",
        "        if ($aclSubRes.Code -ne 0) { throw ('icacls subitem ACL lock failed (code ' + $aclSubRes.Code + '): ' + $aclSubRes.Output) }",
        "    }",
        "    function Assert-SourceAclLocked([string]$target) {",
        "        $trustedSids = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')",
        "        $danger = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)",
        "        $cur = $target.TrimEnd('\\', '/')",
        "        $root = [System.IO.Path]::GetPathRoot($cur)",
        "        $programData = [System.Environment]::GetFolderPath('CommonApplicationData').TrimEnd('\\', '/')",
        "        while ($cur -and ($cur -ne $root)) {",
        "            if (-not (Test-Path -LiteralPath $cur)) { throw ('Install source path missing: ' + $cur) }",
        "            if ($programData -and [string]::Equals($cur, $programData, [System.StringComparison]::OrdinalIgnoreCase)) { break }",
        "            $acl = Get-Acl -LiteralPath $cur",
        "            $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
        "            if ($trustedSids -notcontains $ownerSid) { throw ('Install source owner unsafe (untrusted owner SID ' + $ownerSid + '): ' + $cur) }",
        "            foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {",
        "                if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }",
        "                if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }",
        "                $sid = $rule.IdentityReference.Value",
        "                if ($trustedSids -contains $sid) { continue }",
        "                if (([int]$rule.FileSystemRights -band $danger) -ne 0) { throw ('Install source ACL unsafe (writable by non-admin SID ' + $sid + '): ' + $cur) }",
        "            }",
        "            $parent = [System.IO.Path]::GetDirectoryName($cur)",
        "            if (-not $parent -or $parent -eq $cur) { break }",
        "            $cur = $parent",
        "        }",
        "    }",
        "    if (-not $trustedBin -or -not (Test-Path -LiteralPath $trustedBin)) { throw 'Trusted mihomo.exe binary path is required for service installation' }",
        "    $persistentManifestPath = Join-Path $appParentDir 'mihomo-manifest.json'",
        "    if ($trustedManifest) {",
        "        $fullTrustedManifest = [System.IO.Path]::GetFullPath($trustedManifest)",
        "        if ([string]::Equals($fullTrustedManifest, [System.IO.Path]::GetFullPath($lockedManifestPath), [System.StringComparison]::OrdinalIgnoreCase)) {",
        "            Assert-NoReparseChain $lockedManifestPath",
        "            Assert-SourceAclLocked $lockedManifestPath",
        "        } elseif ([string]::Equals($fullTrustedManifest, [System.IO.Path]::GetFullPath($persistentManifestPath), [System.StringComparison]::OrdinalIgnoreCase)) {",
        "            Assert-NoReparseChain $persistentManifestPath",
        "            Assert-SourceAclLocked $persistentManifestPath",
        "            Copy-Item -LiteralPath $persistentManifestPath -Destination $lockedManifestPath -Force",
        "        } else {",
        "            Assert-NoReparseChain $trustedBin",
        "            Assert-SourceAclLocked $trustedBin",
        "            Assert-NoReparseChain $trustedManifest",
        "            Assert-SourceAclLocked $trustedManifest",
        "            Copy-Item -LiteralPath $trustedManifest -Destination $lockedManifestPath -Force",
        "        }",
        "    }",
        "    if (Test-Path -LiteralPath $lockedBinPath) { Remove-Item -LiteralPath $lockedBinPath -Force -ErrorAction SilentlyContinue }",
        "    Copy-Item -LiteralPath $trustedBin -Destination $lockedBinPath -Force",
        "    $copiedMihomoHash = (Get-FileHash -LiteralPath $lockedBinPath -Algorithm SHA256).Hash.ToUpperInvariant()",
        "    if ($copiedMihomoHash -ne $expectedMihomoHash) { Remove-Item -LiteralPath $lockedBinPath -Force -ErrorAction SilentlyContinue; throw 'mihomo.exe copy integrity verification failed (SHA-256 mismatch)' }",
        `    $builtinMihomoHashes = @(${Object.values(TRUSTED_MIHOMO_BUILTIN_HASHES)
          .map((h) => `'${h.trim().toUpperCase()}'`)
          .join(',')})`,
        "    $sourceTrusted = ($builtinMihomoHashes -contains $copiedMihomoHash)",
        "    if (-not $sourceTrusted -and $trustedManifest -and (Test-Path -LiteralPath $lockedManifestPath)) {",
        "        $mObj = Get-Content -LiteralPath $lockedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json",
        "        foreach ($entry in $mObj.entries) { if ($entry.sha256 -and ($entry.sha256.ToUpperInvariant() -eq $copiedMihomoHash)) { $sourceTrusted = $true; break } }",
        "    }",
        "    if (-not $sourceTrusted) {",
        "        $sig = Get-AuthenticodeSignature -LiteralPath $lockedBinPath",
        "        if ($sig -and $sig.Status -eq 'Valid' -and $sig.SignerCertificate -ne $null) { $sourceTrusted = $true }",
        "    }",
        "    if (-not $sourceTrusted) { Remove-Item -LiteralPath $lockedBinPath -Force -ErrorAction SilentlyContinue; throw 'Copied mihomo.exe failed post-copy trust verification (manifest/signature)' }",
        "    [System.IO.File]::WriteAllText($lockedBinHashPath, $copiedMihomoHash, $utf8NoBom)",
        "    $srcBinDir = Split-Path -Parent $trustedBin",
        "    $srcWintun = Join-Path $srcBinDir 'wintun.dll'",
        "    if (Test-Path -LiteralPath $srcWintun) {",
        "        Assert-NoReparseChain $srcWintun",
        "        if (Test-Path -LiteralPath $lockedWintunPath) { Remove-Item -LiteralPath $lockedWintunPath -Force -ErrorAction SilentlyContinue }",
        "        Copy-Item -LiteralPath $srcWintun -Destination $lockedWintunPath -Force",
        "        $wHash = (Get-FileHash -LiteralPath $lockedWintunPath -Algorithm SHA256).Hash.ToUpperInvariant()",
        "        $validWintun = @('E5DA8447DC2C320EDC0FC52FA01885C103DE8C118481F683643CACC3220DAFCE','F7BA89005544BE9D85231A9E0D5F23B2D15B3311667E2DAD0DEBD344918A3F80','D694FA46AB4CFEBCB2632D094C7AA97278EEF2F8052438621766D863AE98A931','DAAD267411ECDC70A0535E274D2C3E9DA3D0084BDAC7662CB8424DD4A031B4D9')",
        "        if ($validWintun -notcontains $wHash) { Remove-Item -LiteralPath $lockedWintunPath -Force -ErrorAction SilentlyContinue; throw ('wintun.dll SHA-256 mismatch: ' + $wHash) }",
        "    }",
        "    $allowedRuleExts = @('.mrs', '.dat', '.mmdb', '.metadb', '.yaml', '.yml', '.list', '.txt')",
        "    $srcRulesDir = Join-Path (Split-Path -Parent $srcBinDir) 'rules'",
        "    if (Test-Path -LiteralPath $srcRulesDir) {",
        "        Assert-NoReparseChain $srcRulesDir",
        "        Get-ChildItem -LiteralPath $srcRulesDir -File | Where-Object { (-not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -and ($allowedRuleExts -contains $_.Extension.ToLowerInvariant()) } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeDir $_.Name) -Force }",
        "    }",
        "    [System.IO.File]::WriteAllText($tokenPath, $tokenValue, $utf8NoBom)",
        "    if (-not $tokenReader) { throw 'Cannot determine current user principal for service.token ACL' }",
        "    $aclTokRes = Run-Native 'icacls.exe' ('\"' + $tokenPath + '\" /inheritance:r /grant:r \"*S-1-5-18:(F)\" /grant:r \"*S-1-5-32-544:(F)\" /grant:r \"' + $tokenReader + ':(R)\" /Q')",
        "    if ($aclTokRes.Code -ne 0) { throw ('icacls token ACL lock failed (code ' + $aclTokRes.Code + '): ' + $aclTokRes.Output) }",
        "",
        "    # Step 4: Copy C# source into ACL-locked dir FIRST, then verify SHA-256 before compiling (zero TOCTOU)",
        "    Write-Result 'STEP:COMPILE'",
        "    Copy-Item -LiteralPath $csSrc -Destination $lockedCsPath -Force",
        "    $actualCsHash = (Get-FileHash -Path $lockedCsPath -Algorithm SHA256).Hash.ToUpperInvariant()",
        "    if ($actualCsHash -ne $expectedCsHash) { Remove-Item -LiteralPath $lockedCsPath -Force -ErrorAction SilentlyContinue; throw 'C# source integrity check failed (TOCTOU detected)' }",
        "    $cscArgs = '/nologo /optimize+ /target:exe /r:\"' + $svcDll + '\" /r:\"' + $webDll + '\" /out:\"' + $exePath + '\" \"' + $lockedCsPath + '\"'",
        "    $cRes = Run-Native $cscPath $cscArgs",
        "    if ($cRes.Code -ne 0 -or -not (Test-Path $exePath)) {",
        "        throw ('csc.exe compile failed (code ' + $cRes.Code + '): ' + $cRes.Output)",
        "    }",
        "    $aclPostOwnerRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\\*\" /setowner \"*S-1-5-32-544\" /T /Q')",
        "    if ($aclPostOwnerRes.Code -ne 0) { throw ('icacls subitem owner lock failed (code ' + $aclPostOwnerRes.Code + '): ' + $aclPostOwnerRes.Output) }",
        "",
        "    # Step 5: Register Windows Service (LocalSystem, auto-start)",
        "    Write-Result 'STEP:REGISTER'",
        "    $createArgs = 'create ' + $serviceName + ' binPath= \"\\\"' + $exePath + '\\\"\" start= auto DisplayName= \"' + $displayName + '\"'",
        "    $rRes = Run-Native 'sc.exe' $createArgs",
        "    if ($rRes.Code -ne 0) {",
        "        throw ('sc.exe create failed (code ' + $rRes.Code + '): ' + $rRes.Output)",
        "    }",
        "    [void](Run-Native 'sc.exe' ('description ' + $serviceName + ' \"NexLink TUN Core Privilege Service\"'))",
        "    [void](Run-Native 'sc.exe' ('failure ' + $serviceName + ' reset= 86400 actions= restart/3000/restart/5000/\"\"/0'))",
        "",
        "    # Step 6: Start Windows Service",
        "    Write-Result 'STEP:START'",
        "    $sRes = Run-Native 'sc.exe' ('start ' + $serviceName)",
        "    if ($sRes.Code -ne 0) {",
        "        throw ('sc.exe start failed (code ' + $sRes.Code + '): ' + $sRes.Output)",
        "    }",
        "",
        "    Write-Result 'OK'",
        "} catch {",
        "    Write-Result ('ERROR: ' + $_.Exception.Message)",
        "    exit 1",
        "}",
      ].join('\r\n');

      fs.writeFileSync(psPath, '\uFEFF' + installScript, 'utf8');
      const psSha256 = crypto.createHash('sha256').update(fs.readFileSync(psPath)).digest('hex').toUpperCase();

      if (isAlreadyAdmin) {
        try {
          await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psPath],
            { windowsHide: true, timeout: 35000 }
          );
        } catch (adminErr: any) {
          if (!fs.existsSync(resultLogPath)) {
            throw adminErr;
          }
        }
      } else {
        // 提权后先将 install-service.ps1 读入内存字节，对内存字节校验 SHA-256 后直接执行，彻底消除 TOCTOU
        const escapedPsPath = psPath.replace(/'/g, "''");
        const elevatedBootstrap = [
          "$ErrorActionPreference = 'Stop'",
          `$rawBytes = [System.IO.File]::ReadAllBytes('${escapedPsPath}')`,
          "$sha = [System.Security.Cryptography.SHA256]::Create()",
          "$h = ([System.BitConverter]::ToString($sha.ComputeHash($rawBytes)) -replace '-', '').ToUpperInvariant()",
          `if ($h -ne '${psSha256}') { throw 'Install script integrity check failed (TOCTOU detected)' }`,
          "$scriptText = [System.Text.Encoding]::UTF8.GetString($rawBytes).TrimStart([char]0xFEFF)",
          "Invoke-Expression $scriptText",
        ].join('\n');
        const encodedBootstrap = encodePowerShellCommand(elevatedBootstrap);
        const launcherScript = [
          "$ErrorActionPreference = 'Stop'",
          `$argStr = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodedBootstrap}'`,
          "$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argStr -Verb RunAs -Wait -PassThru -WindowStyle Hidden",
          "exit $proc.ExitCode",
        ].join('\n');

        try {
          await execFileAsync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-EncodedCommand',
              encodePowerShellCommand(launcherScript),
            ],
            { windowsHide: true, timeout: 60000 }
          );
        } catch (elevErr: any) {
          // 若脚本本身退出码为 1，resultLogPath 中已记录真实错误原因，优先读取它
          if (!fs.existsSync(resultLogPath)) {
            throw elevErr;
          }
        }
      }

      // 检查安装脚本输出
      if (fs.existsSync(resultLogPath)) {
        const resText = fs.readFileSync(resultLogPath, 'utf8').replace(/^\uFEFF/, '').trim();
        if (resText.startsWith('ERROR:')) {
          return { success: false, error: resText.replace(/^ERROR:\s*/, '') };
        }
        if (resText !== 'OK') {
          return { success: false, error: `服务安装中断在阶段 [${resText}]，请检查安全软件拦截或重试。` };
        }
      } else {
        return { success: false, error: '未收到管理员授权（UAC 已取消），服务未安装。' };
      }

      // 轮询确认服务 HTTP 控制通道真正就绪
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const st = await this.getServiceStatus();
        if (st.reachable) {
          console.log('[TunServiceManager] NexLinkCoreService 安装并握手就绪！');
          return { success: true };
        }
      }

      return { success: false, error: '服务已注册启动但本地通信通道 (127.0.0.1:33211) 响应超时，请检查安全软件拦截。' };
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || err);
      if (msg.toLowerCase().includes('canceled') || msg.includes('1223') || msg.includes('取消')) {
        return { success: false, error: '已取消管理员授权，服务未安装。' };
      }
      return { success: false, error: `安装虚拟网卡服务失败: ${msg}` };
    } finally {
      try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * 卸载 Windows 虚拟网卡特权服务
   */
  public async uninstallService(isAlreadyAdmin: boolean = false): Promise<{ success: boolean; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 系统' };
    }

    await this.stopCoreViaService().catch(() => {});

    const escapedServiceDir = this.serviceDir.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `Stop-Service -Name '${SERVICE_NAME}' -Force`,
      `for ($i = 0; $i -lt 25; $i++) { $s = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue; if (-not $s -or $s.Status -eq 'Stopped') { break }; Start-Sleep -Milliseconds 300 }`,
      `& sc.exe delete '${SERVICE_NAME}' | Out-Null`,
      `for ($i = 0; $i -lt 20; $i++) { & sc.exe query '${SERVICE_NAME}' | Out-Null; if ($LASTEXITCODE -eq 1060) { break }; Start-Sleep -Milliseconds 300 }`,
      `if (Test-Path '${escapedServiceDir}') { Remove-Item -Path '${escapedServiceDir}' -Recurse -Force }`,
    ].join('\n');
    const encodedUninstall = encodePowerShellCommand(script);

    try {
      // 卸载脚本全程通过 -EncodedCommand 传递，零 %TEMP% 落盘文件，彻底消除 TOCTOU
      if (isAlreadyAdmin) {
        await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedUninstall],
          { windowsHide: true, timeout: 25000 }
        );
      } else {
        const launcherScript = [
          "$ErrorActionPreference = 'Stop'",
          `$argStr = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedUninstall}'`,
          "Start-Process -FilePath 'powershell.exe' -ArgumentList $argStr -Verb RunAs -Wait -WindowStyle Hidden",
        ].join('\n');

        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            encodePowerShellCommand(launcherScript),
          ],
          { windowsHide: true, timeout: 35000 }
        );
      }

      return { success: true };
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || err);
      if (msg.toLowerCase().includes('canceled') || msg.includes('1223') || msg.includes('取消')) {
        return { success: false, error: '已取消管理员授权，服务未卸载。' };
      }
      return { success: false, error: `卸载服务失败: ${msg}` };
    }
  }

  /**
   * 通过特权服务拉起 Mihomo 核心（以 LocalSystem 权限运行，直接支持 Wintun 虚拟网卡）
   */
  public async startCoreViaService(
    params: ServiceStartCoreParams
  ): Promise<{ ok: boolean; pid?: number; error?: string }> {
    try {
      let configContent = params.configContent;
      if (!configContent && params.configPath && fs.existsSync(params.configPath)) {
        configContent = fs.readFileSync(params.configPath, 'utf8');
      }
      const payload = {
        ...params,
        configContent,
      };
      const res = await this.request<{ ok: boolean; pid?: number; error?: string }>(
        'POST',
        '/start',
        payload,
        8000
      );
      return { ok: Boolean(res?.ok), pid: res?.pid, error: res?.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || '调用虚拟网卡服务启动核心失败' };
    }
  }

  /**
   * 通过特权服务停止托管的 Mihomo 核心并清理 TUN 路由
   */
  public async stopCoreViaService(): Promise<boolean> {
    try {
      const res = await this.request<{ ok: boolean }>('POST', '/stop', {}, 4000);
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  /**
   * 通过特权服务触发清理 TUN 路由及刷新 Windows DNS 缓存
   */
  public async cleanupRoutesViaService(): Promise<boolean> {
    try {
      const res = await this.request<{ ok: boolean }>('POST', '/cleanup-routes', {}, 4000);
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  /**
   * 同步更新后的 Mihomo 内核指纹（及已安装服务二进制）到受 SYSTEM/Administrators ACL 保护的特权目录
   * 解决「内置指纹写死，更新内核后服务安装或启动失败」的问题
   */
  public async syncUpdatedCoreToService(
    newBinPath: string,
    version: string,
    expectedSha256: string,
    isAlreadyAdmin: boolean,
    sourceOptions?: VerifyMihomoSourceOptions
  ): Promise<{ success: boolean; serviceRestarted?: boolean; error?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅 Windows 支持同步特权服务核心指纹' };
    }
    const normalizedVersion = (version || '').trim();
    if (!/^v?\d+\.\d+\.\d+([-.][a-zA-Z0-9._]+)?$/.test(normalizedVersion)) {
      return { success: false, error: '无效的版本号格式，拒绝同步特权服务核心指纹' };
    }
    const resolvedBin = path.resolve(newBinPath);
    const normalizedHash = (expectedSha256 || '').trim().toUpperCase();
    if (!fs.existsSync(resolvedBin) || !/^[A-F0-9]{64}$/.test(normalizedHash)) {
      return { success: false, error: '无效的新内核路径或 SHA-256 指纹' };
    }

    // 强制校验新内核安装源可信性（与 installService 同口径：文件名/非符号链接/PE头/ACL或数字签名或可信清单），绝不允许将任意不可信二进制写入 SYSTEM 清单
    const trustRes = verifyMihomoInstallSource(resolvedBin, sourceOptions);
    if (!trustRes.trusted || !trustRes.sha256) {
      return {
        success: false,
        error: trustRes.error || '新内核未通过可信来源验证，拒绝同步至特权服务清单',
      };
    }
    if (trustRes.sha256.toUpperCase() !== normalizedHash) {
      return {
        success: false,
        error: '新内核文件实际 SHA-256 与预期指纹不一致，拒绝同步',
      };
    }

    const tmpDir = path.join(os.tmpdir(), `nexlink-core-sync-${Date.now()}`);
    const psPath = path.join(tmpDir, 'sync-core.ps1');
    const resultLogPath = path.join(tmpDir, 'sync-result.txt');

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const escapedServiceDir = this.serviceDir.replace(/'/g, "''");
      const escapedNewBin = resolvedBin.replace(/'/g, "''");
      const escapedVersion = normalizedVersion.replace(/'/g, "''");
      const escapedResultLog = resultLogPath.replace(/'/g, "''");
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

      const syncScript = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$serviceDir = '${escapedServiceDir}'`,
        `$newBin = '${escapedNewBin}'`,
        `$expectedHash = '${normalizedHash}'`,
        `$coreVer = '${escapedVersion}'`,
        `$coreArch = '${arch}'`,
        `$serviceName = '${SERVICE_NAME}'`,
        `$resultLog = '${escapedResultLog}'`,
        "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
        "$appParentDir = Split-Path -Parent $serviceDir",
        "$binDir = Join-Path $serviceDir 'bin'",
        "$runtimeDir = Join-Path $serviceDir 'runtime'",
        "$lockedBinPath = Join-Path $binDir 'mihomo.exe'",
        "$lockedBinHashPath = Join-Path $serviceDir 'mihomo.sha256'",
        "$persistentManifestPath = Join-Path $appParentDir 'mihomo-manifest.json'",
        "$lockedManifestPath = Join-Path $serviceDir 'mihomo-manifest.json'",
        "function Write-Result([string]$msg) { [System.IO.File]::WriteAllText($resultLog, $msg, $utf8NoBom) }",
        "function Assert-NoReparseChain([string]$target) {",
        "    $cur = $target.TrimEnd('\\', '/')",
        "    $root = [System.IO.Path]::GetPathRoot($cur)",
        "    while ($cur -and ($cur -ne $root)) {",
        "        if (Test-Path -LiteralPath $cur) {",
        "            $it = Get-Item -LiteralPath $cur -Force",
        "            if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ('Refusing reparse point in path chain: ' + $cur) }",
        "        }",
        "        $parent = [System.IO.Path]::GetDirectoryName($cur)",
        "        if (-not $parent -or $parent -eq $cur) { break }",
        "        $cur = $parent",
        "    }",
        "}",
        "function Run-Native([string]$exe, [string]$argLine) {",
        "    $psi = New-Object System.Diagnostics.ProcessStartInfo",
        "    $psi.FileName = $exe",
        "    $psi.Arguments = $argLine",
        "    $psi.UseShellExecute = $false",
        "    $psi.RedirectStandardOutput = $true",
        "    $psi.RedirectStandardError = $true",
        "    $psi.CreateNoWindow = $true",
        "    $p = [System.Diagnostics.Process]::Start($psi)",
        "    $out = $p.StandardOutput.ReadToEnd()",
        "    $err = $p.StandardError.ReadToEnd()",
        "    $p.WaitForExit()",
        "    return @{ Code = $p.ExitCode; Output = ($out + \"`n\" + $err).Trim() }",
        "}",
        "try {",
        "    Assert-NoReparseChain $newBin",
        "    Assert-NoReparseChain $serviceDir",
        "    Assert-NoReparseChain $binDir",
        "    Assert-NoReparseChain $runtimeDir",
        "    if (-not (Test-Path -LiteralPath $appParentDir)) { New-Item -ItemType Directory -Path $appParentDir -Force | Out-Null }",
        "    if (-not (Test-Path -LiteralPath $serviceDir)) { New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null }",
        "    if (-not (Test-Path -LiteralPath $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }",
        "    if (-not (Test-Path -LiteralPath $runtimeDir)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null }",
        "    $ownAppRes = Run-Native 'icacls.exe' ('\"' + $appParentDir + '\" /setowner \"*S-1-5-32-544\" /Q')",
        "    if ($ownAppRes.Code -ne 0) { throw ('icacls appParentDir owner lock failed: ' + $ownAppRes.Output) }",
        "    $aclAppRes = Run-Native 'icacls.exe' ('\"' + $appParentDir + '\" /inheritance:r /grant:r \"*S-1-5-18:(OI)(CI)(F)\" /grant:r \"*S-1-5-32-544:(OI)(CI)(F)\" /Q')",
        "    if ($aclAppRes.Code -ne 0) { throw ('icacls appParentDir lock failed: ' + $aclAppRes.Output) }",
        "    $ownDirRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\" /setowner \"*S-1-5-32-544\" /Q')",
        "    if ($ownDirRes.Code -ne 0) { throw ('icacls serviceDir owner lock failed: ' + $ownDirRes.Output) }",
        "    $aclDirRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\" /inheritance:r /grant:r \"*S-1-5-18:(OI)(CI)(F)\" /grant:r \"*S-1-5-32-544:(OI)(CI)(F)\" /Q')",
        "    if ($aclDirRes.Code -ne 0) { throw ('icacls serviceDir lock failed: ' + $aclDirRes.Output) }",
        "    Assert-NoReparseChain $binDir",
        "    Assert-NoReparseChain $runtimeDir",
        "    $entriesList = New-Object System.Collections.ArrayList",
        "    $readManifestSrc = $null",
        "    if (Test-Path -LiteralPath $persistentManifestPath) { $readManifestSrc = $persistentManifestPath }",
        "    elseif (Test-Path -LiteralPath $lockedManifestPath) { $readManifestSrc = $lockedManifestPath }",
        "    if ($readManifestSrc) {",
        "        try {",
        "            $oldObj = Get-Content -LiteralPath $readManifestSrc -Raw -Encoding UTF8 | ConvertFrom-Json",
        "            if ($oldObj -and $oldObj.entries) {",
        "                foreach ($e in $oldObj.entries) {",
        "                    if ($e -and $e.sha256 -and ($e.sha256.ToUpperInvariant() -ne $expectedHash)) {",
        "                        [void]$entriesList.Add(@{ version = [string]$e.version; arch = [string]$e.arch; sha256 = ([string]$e.sha256).ToUpperInvariant() })",
        "                    }",
        "                }",
        "            }",
        "        } catch {}",
        "    }",
        "    [void]$entriesList.Add(@{ version = $coreVer; arch = $coreArch; sha256 = $expectedHash })",
        "    $manifestJson = (@{ schemaVersion = 1; entries = $entriesList } | ConvertTo-Json -Depth 4)",
        "    [System.IO.File]::WriteAllText($persistentManifestPath, $manifestJson, $utf8NoBom)",
        "    $ownPmRes = Run-Native 'icacls.exe' ('\"' + $persistentManifestPath + '\" /setowner \"*S-1-5-32-544\" /Q')",
        "    if ($ownPmRes.Code -ne 0) { throw ('icacls persistent manifest owner lock failed: ' + $ownPmRes.Output) }",
        "    $aclPmRes = Run-Native 'icacls.exe' ('\"' + $persistentManifestPath + '\" /inheritance:r /grant:r \"*S-1-5-18:F\" \"*S-1-5-32-544:F\" /Q')",
        "    if ($aclPmRes.Code -ne 0) { throw ('icacls persistent manifest lock failed: ' + $aclPmRes.Output) }",
        "    [System.IO.File]::WriteAllText($lockedManifestPath, $manifestJson, $utf8NoBom)",
        "    $qRes = Run-Native 'sc.exe' ('query ' + $serviceName)",
        "    $wasRunning = ($qRes.Code -eq 0 -and $qRes.Output -match 'RUNNING')",
        "    $serviceRestarted = $false",
        "    if ($qRes.Code -eq 0) {",
        "        if ($wasRunning) {",
        "            [void](Run-Native 'sc.exe' ('stop ' + $serviceName))",
        "            for ($i = 0; $i -lt 25; $i++) {",
        "                Start-Sleep -Milliseconds 200",
        "                $qr = Run-Native 'sc.exe' ('query ' + $serviceName)",
        "                if ($qr.Output -match 'STOPPED') { break }",
        "            }",
        "        }",
        "        Copy-Item -LiteralPath $newBin -Destination $lockedBinPath -Force",
        "        $copiedHash = (Get-FileHash -LiteralPath $lockedBinPath -Algorithm SHA256).Hash.ToUpperInvariant()",
        "        if ($copiedHash -ne $expectedHash) { Remove-Item -LiteralPath $lockedBinPath -Force -ErrorAction SilentlyContinue; throw 'Copied mihomo.exe SHA-256 mismatch' }",
        "        [System.IO.File]::WriteAllText($lockedBinHashPath, $copiedHash, $utf8NoBom)",
        "        if ($wasRunning) {",
        "            $sRes = Run-Native 'sc.exe' ('start ' + $serviceName)",
        "            if ($sRes.Code -ne 0) { throw ('sc start failed: ' + $sRes.Output) }",
        "            $serviceRestarted = $true",
        "        }",
        "    }",
        "    if (Test-Path -LiteralPath ($serviceDir + '\\*')) {",
        "        $ownSubRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\\*\" /setowner \"*S-1-5-32-544\" /T /Q')",
        "        if ($ownSubRes.Code -ne 0) { throw ('icacls subitem owner lock failed: ' + $ownSubRes.Output) }",
        "        $aclSubRes = Run-Native 'icacls.exe' ('\"' + $serviceDir + '\\*\" /grant:r \"*S-1-5-18:F\" \"*S-1-5-32-544:F\" /T /Q')",
        "        if ($aclSubRes.Code -ne 0) { throw ('icacls subitem lock failed: ' + $aclSubRes.Output) }",
        "    }",
        "    if ($serviceRestarted) { Write-Result 'OK:RESTARTED' } else { Write-Result 'OK:SYNCED' }",
        "} catch {",
        "    Write-Result ('ERROR: ' + $_.Exception.Message)",
        "    exit 1",
        "}",
      ].join('\r\n');

      fs.writeFileSync(psPath, '\uFEFF' + syncScript, 'utf8');
      const psSha256 = crypto.createHash('sha256').update(fs.readFileSync(psPath)).digest('hex').toUpperCase();

      if (isAlreadyAdmin) {
        await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psPath],
          { windowsHide: true, timeout: 30000 }
        );
      } else {
        const escapedPsPath = psPath.replace(/'/g, "''");
        const elevatedBootstrap = [
          "$ErrorActionPreference = 'Stop'",
          `$rawBytes = [System.IO.File]::ReadAllBytes('${escapedPsPath}')`,
          "$sha = [System.Security.Cryptography.SHA256]::Create()",
          "$h = ([System.BitConverter]::ToString($sha.ComputeHash($rawBytes)) -replace '-', '').ToUpperInvariant()",
          `if ($h -ne '${psSha256}') { throw 'Sync script integrity check failed (TOCTOU detected)' }`,
          "$scriptText = [System.Text.Encoding]::UTF8.GetString($rawBytes).TrimStart([char]0xFEFF)",
          "Invoke-Expression $scriptText",
        ].join('\n');
        const launcherScript = [
          "$ErrorActionPreference = 'Stop'",
          `$argStr = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodePowerShellCommand(elevatedBootstrap)}'`,
          "$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argStr -Verb RunAs -Wait -PassThru -WindowStyle Hidden",
          "exit $proc.ExitCode",
        ].join('\n');
        await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellCommand(launcherScript)],
          { windowsHide: true, timeout: 45000 }
        );
      }

      const logContent = fs.existsSync(resultLogPath) ? fs.readFileSync(resultLogPath, 'utf8').trim() : '';
      if (logContent.startsWith('OK:')) {
        return { success: true, serviceRestarted: logContent === 'OK:RESTARTED' };
      }
      return { success: false, error: logContent || '服务核心指纹同步未返回确认结果' };
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('canceled by the user') || msg.includes('1223')) {
        return { success: false, error: '用户取消了管理员 UAC 授权，服务指纹未同步' };
      }
      return { success: false, error: msg || '同步服务指纹失败' };
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
}

export const tunServiceManager = new TunServiceManager();