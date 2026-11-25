import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const mihomoPath = path.join(rootDir, 'resources', 'mihomo', 'mihomo.exe');
const serviceManagerPath = path.join(rootDir, 'src', 'main', 'network', 'service-manager.ts');

if (!fs.existsSync(mihomoPath)) {
  console.warn(`[update-mihomo-hash] Warning: ${mihomoPath} not found. Skipping hash injection.`);
  process.exit(0);
}

const fileBuffer = fs.readFileSync(mihomoPath);
const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex').toUpperCase();
console.log(`[update-mihomo-hash] resources/mihomo/mihomo.exe SHA-256: ${sha256}`);

let code = fs.readFileSync(serviceManagerPath, 'utf8');
const regex = /export const TRUSTED_MIHOMO_BUILTIN_HASHES:\s*Readonly<Record<string,\s*string>>\s*=\s*Object\.freeze\(\{[\s\S]*?\}\);/;

const replacement = `export const TRUSTED_MIHOMO_BUILTIN_HASHES: Readonly<Record<string, string>> = Object.freeze({\n  'v1.19.29-windows-amd64': '${sha256}',\n});`;

if (!regex.test(code)) {
  console.error('[update-mihomo-hash] Error: Could not locate TRUSTED_MIHOMO_BUILTIN_HASHES in service-manager.ts');
  process.exit(1);
}

const newCode = code.replace(regex, replacement);
if (newCode !== code) {
  fs.writeFileSync(serviceManagerPath, newCode, 'utf8');
  console.log('[update-mihomo-hash] Updated TRUSTED_MIHOMO_BUILTIN_HASHES in service-manager.ts');
} else {
  console.log('[update-mihomo-hash] TRUSTED_MIHOMO_BUILTIN_HASHES is already up to date.');
}
