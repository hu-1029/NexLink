/* global process, console, Buffer, URL, fetch */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const targetDir = path.join(rootDir, 'resources', 'mihomo');
const targetExe = path.join(targetDir, 'mihomo.exe');

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'raw.githubusercontent.com',
]);

function assertSafeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Blocked unsafe URL: ${rawUrl}`);
  }
}

async function fetchWithSafeRedirects(initialUrl, headers = {}) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= 6; hop++) {
    assertSafeUrl(currentUrl);
    const res = await fetch(currentUrl, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(`Redirect response ${res.status} missing Location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects while fetching Mihomo release');
}

function selectWindowsAmd64Zip(assets) {
  const zipAssets = (assets || []).filter(
    (a) =>
      typeof a?.name === 'string' &&
      a.name.startsWith('mihomo-windows-amd64') &&
      a.name.endsWith('.zip') &&
      !a.name.includes('alpha')
  );
  return (
    zipAssets.find((a) => /^mihomo-windows-amd64-v\d+\.\d+\.\d+\.zip$/i.test(a.name)) ||
    zipAssets.find((a) => a.name.toLowerCase().includes('-v1-')) ||
    zipAssets.find((a) => a.name.toLowerCase().includes('compatible')) ||
    zipAssets[0] ||
    null
  );
}

async function resolveExpectedSha256(assets, asset, headers) {
  if (typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest.trim())) {
    return asset.digest.trim().slice(7).toLowerCase();
  }
  const exactSha = (assets || []).find(
    (a) => typeof a?.name === 'string' && a.name.toLowerCase() === `${asset.name.toLowerCase()}.sha256`
  );
  const checksumAsset =
    exactSha ||
    (assets || []).find(
      (a) =>
        typeof a?.name === 'string' &&
        (a.name.toLowerCase().endsWith('.sha256') || a.name.toLowerCase() === 'sha256sum')
    );
  if (!checksumAsset?.browser_download_url) return null;
  const res = await fetchWithSafeRedirects(checksumAsset.browser_download_url, headers);
  if (!res.ok) {
    throw new Error(`Failed to fetch checksum file: HTTP ${res.status}`);
  }
  const text = await res.text();
  const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fileMatch = text.match(new RegExp(`([a-f0-9]{64})\\s+[*]?${escaped}`, 'i'));
  if (fileMatch) return fileMatch[1].toLowerCase();
  const genericMatch = text.match(/\b([a-f0-9]{64})\b/i);
  return genericMatch ? genericMatch[1].toLowerCase() : null;
}

async function main() {
  if (fs.existsSync(targetExe) && fs.statSync(targetExe).size > 1024 * 1024) {
    console.log(`[prepare-mihomo] Existing binary found at ${targetExe}, skipping download.`);
    return;
  }

  const versionTag = (process.env.MIHOMO_VERSION || '').trim();
  const releaseApiUrl = versionTag
    ? `https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${encodeURIComponent(versionTag)}`
    : 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

  const headers = {
    'User-Agent': 'NexLink-Build-Script',
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  console.log(`[prepare-mihomo] Querying ${releaseApiUrl}`);
  const relRes = await fetchWithSafeRedirects(releaseApiUrl, headers);
  if (!relRes.ok) {
    throw new Error(`Failed to query Mihomo release metadata: HTTP ${relRes.status}`);
  }
  const release = await relRes.json();
  const asset = selectWindowsAmd64Zip(release.assets);
  if (!asset?.browser_download_url) {
    throw new Error('Could not find a suitable mihomo-windows-amd64 zip asset');
  }

  const expectedSha256 = await resolveExpectedSha256(release.assets, asset, headers);
  if (!expectedSha256) {
    throw new Error(`Missing SHA-256 checksum for ${asset.name}; aborting fail-closed`);
  }

  console.log(`[prepare-mihomo] Downloading ${asset.name}...`);
  const zipRes = await fetchWithSafeRedirects(asset.browser_download_url, headers);
  if (!zipRes.ok) {
    throw new Error(`Failed to download ${asset.name}: HTTP ${zipRes.status}`);
  }
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const actualSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expectedSha256}, got ${actualSha256}`);
  }
  console.log(`[prepare-mihomo] Verified SHA-256: ${actualSha256}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink-prepare-mihomo-'));
  try {
    const zipPath = path.join(tmpDir, 'mihomo.zip');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.writeFileSync(zipPath, zipBuf);
    fs.mkdirSync(extractDir, { recursive: true });

    const escZip = zipPath.replace(/'/g, "''");
    const escOut = extractDir.replace(/'/g, "''");
    const psScript = [
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$destDir = [System.IO.Path]::GetFullPath('${escOut}')`,
      `$destPrefix = if ($destDir.EndsWith('\\')) { $destDir } else { $destDir + '\\' }`,
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escZip}')`,
      'try {',
      '  foreach ($entry in $zip.Entries) {',
      '    $name = $entry.FullName',
      "    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.StartsWith('\\') -or ($name -match '^[a-zA-Z]:')) { throw ('Unsafe zip path: ' + $name) }",
      "    if ($name.Split(@('/', '\\'), [System.StringSplitOptions]::RemoveEmptyEntries) -contains '..') { throw ('Zip traversal rejected: ' + $name) }",
      '    $target = [System.IO.Path]::GetFullPath((Join-Path $destDir $name))',
      '    if (-not $target.StartsWith($destPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw ("Zip escape rejected: " + $name) }',
      "    if ($name.EndsWith('/') -or $name.EndsWith('\\')) {",
      '      [System.IO.Directory]::CreateDirectory($target) | Out-Null',
      '    } else {',
      '      $parent = [System.IO.Path]::GetDirectoryName($target)',
      '      if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }',
      '      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)',
      '    }',
      '  }',
      '} finally {',
      '  $zip.Dispose()',
      '}',
    ].join('\r\n');

    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psScript, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'inherit' }
    );

    const exeFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.toLowerCase().endsWith('.exe')) exeFiles.push(full);
      }
    };
    walk(extractDir);
    if (exeFiles.length === 0) {
      throw new Error('No .exe file found inside downloaded Mihomo archive');
    }

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(exeFiles[0], targetExe);
    console.log(`[prepare-mihomo] Installed ${path.basename(exeFiles[0])} -> ${targetExe}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[prepare-mihomo] Failed:', err?.message || err);
  process.exit(1);
});
