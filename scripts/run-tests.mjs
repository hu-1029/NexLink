/* global process, console */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

function collectTestFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      result.push(path.relative(rootDir, fullPath));
    }
  }
  return result;
}

const extraArgs = process.argv.slice(2);
const testFiles = extraArgs.length > 0 ? extraArgs : collectTestFiles(testsDir).sort();

if (testFiles.length === 0) {
  console.error('[run-tests] No .test.ts files found under tests/');
  process.exit(1);
}

const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const childEnv = { ...process.env };
delete childEnv.PSModulePath;
const res = spawnSync(
  process.execPath,
  [tsxCli, '--test', '--test-concurrency=1', ...testFiles],
  { cwd: rootDir, stdio: 'inherit', env: childEnv }
);

process.exit(res.status ?? 1);
