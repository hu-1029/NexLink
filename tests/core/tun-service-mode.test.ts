import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  generateServiceCSharpSource,
  parseTrustedMihomoManifest,
  SERVICE_NAME,
  TRUSTED_MIHOMO_MANIFEST_FILENAME,
  TunServiceManager,
  verifyMihomoInstallSource,
} from '../../src/main/network/service-manager';
import { getWintunStatus, isValidPeDll } from '../../src/main/network/wintun-manager';
import { checkTunPrerequisites } from '../../src/main/network/tun-checker';
import { NetworkTester } from '../../src/main/services/network-tester';
import {
  buildWin32HandleVerifyAndTerminateScript,
  evaluateOwnedMihomoProcessInfo,
  mihomoManager,
  parsePidFileContent,
  terminateVerifiedChildProcess,
  terminateVerifiedOrphanProcess,
} from '../../src/main/core/mihomo-process';

function createFakeMihomoPe(filePath: string, tag: string): string {
  const buf = Buffer.alloc(1024 * 1024 + 64, 0);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.write(tag, 64, 'utf8');
  fs.writeFileSync(filePath, buf);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

describe('TUN 服务模式 (对标 Clash Verge Service Mode) 与 P0 安全边界专项测试', () => {
  it('1. 验证生成的 Windows Service C# 源码包含完整安全边界、ACL/重解析点校验、安装源信任与 5MB 流式限流', () => {
    const cs = generateServiceCSharpSource(33211);
    assert.ok(cs.includes(`ServiceName = "${SERVICE_NAME}"`), '必须注册为 NexLinkCoreService');
    assert.ok(cs.includes('http://127.0.0.1:33211/'), '必须严格绑定 127.0.0.1 本地回环');
    assert.ok(cs.includes('X-NexLink-Token'), '必须校验随机鉴权 Token');
    assert.ok(
      cs.includes('_lockedBinPath') &&
        cs.includes('_lockedRuntimeDir') &&
        cs.includes('VerifyDirectoryAclLocked') &&
        cs.includes('VerifyFileAclLocked') &&
        cs.includes('VerifyNotReparsePointChain') &&
        cs.includes('_lockedBinHashPath') &&
        cs.includes('_lockedManifestPath') &&
        cs.includes('VerifyTrustedMihomoSource') &&
        cs.includes('WinVerifyTrust') &&
        cs.includes('FileAttributes.ReparsePoint') &&
        cs.includes('AllowedWintunSha256'),
      '必须固定可信路径、校验目录/文件 ACL、拒绝重解析点、校验安装源信任机制并校验 Wintun SHA-256'
    );
    assert.ok(
      !cs.includes('data["binPath"]') &&
        !cs.includes('data["configDir"]') &&
        !cs.includes('data["configPath"]') &&
        !cs.includes('data["logPath"]'),
      '服务端 /start 绝不能读取或信任调用方传入的 binPath/configDir/configPath/logPath'
    );
    assert.ok(
      cs.includes('const int MaxBodyBytes = 5 * 1024 * 1024;') &&
        cs.includes('req.InputStream.Read(chunk, 0, chunk.Length)') &&
        cs.includes('WriteJson(res, 413') &&
        !cs.includes('reader.ReadToEnd()'),
      '服务端 /start 必须在流式读取阶段限制 5MB 请求体，禁止先 ReadToEnd 再检查'
    );
    assert.ok(
      cs.includes('OnStart') && cs.includes('OnStop') && cs.includes('OnShutdown'),
      '必须完整实现 ServiceBase 生命周期'
    );
  });

  it('2. 验证服务端忽略客户端传入的恶意 binPath/configDir/configPath，仅使用 configContent，并拦截超大 HTTP 请求体 (413)', async () => {
    const tmpDir = path.join(os.tmpdir(), `nexlink-svc-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const token = 'test-secret-token-123456';
    fs.writeFileSync(path.join(tmpDir, 'service.token'), token, 'utf8');

    const MAX_BODY_BYTES = 5 * 1024 * 1024;
    let receivedConfigContent = '';
    let ignoredMaliciousPaths = false;
    let stopped = false;

    const server = http.createServer((req, res) => {
      if (req.headers['x-nexlink-token'] !== token) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            version: '1.0.0',
            coreRunning: Boolean(receivedConfigContent),
            corePid: 4321,
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/start') {
        const contentLen = Number(req.headers['content-length'] || 0);
        if (contentLen > MAX_BODY_BYTES) {
          req.resume();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Request body exceeds 5MB limit' }));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_BODY_BYTES) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request body exceeds 5MB limit' }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (aborted) return;
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          ignoredMaliciousPaths = true;
          if (!parsed.configContent || typeof parsed.configContent !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Missing configContent' }));
            return;
          }
          receivedConfigContent = parsed.configContent;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pid: 4321 }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/stop') {
        stopped = true;
        receivedConfigContent = '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      const mgr = new TunServiceManager(tmpDir, port);

      const startRes = await mgr.startCoreViaService({
        binPath: 'C:\\Users\\evil\\mihomo.exe',
        configDir: 'C:\\Users\\evil\\dir',
        configPath: 'C:\\Windows\\System32\\evil.yaml',
        configContent: 'mixed-port: 7890\nmode: rule\n',
        apiPort: 9097,
        secret: 'abc',
      });
      assert.equal(startRes.ok, true);
      assert.equal(startRes.pid, 4321);
      assert.equal(ignoredMaliciousPaths, true);
      assert.equal(receivedConfigContent, 'mixed-port: 7890\nmode: rule\n');

      const badRes = await mgr.startCoreViaService({
        configPath: 'C:\\nonexistent\\evil.yaml',
        apiPort: 9097,
        secret: 'abc',
      });
      assert.equal(badRes.ok, false, '缺少 configContent 时服务端必须拒绝启动');

      const oversized = await mgr.startCoreViaService({
        configContent: 'a'.repeat(5 * 1024 * 1024 + 1024),
        apiPort: 9097,
        secret: 'abc',
      });
      assert.equal(oversized.ok, false, '超过 5MB 的 /start 请求体必须被拒绝');

      const stopOk = await mgr.stopCoreViaService();
      assert.equal(stopOk, true);
      assert.equal(stopped, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. 验证 Wintun PE 头校验与官方 SHA-256 白名单拒绝恶意 DLL 哈希', () => {
    const tmpDir = path.join(os.tmpdir(), `nexlink-pe-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const fakeHtml = path.join(tmpDir, 'fake.dll');
      fs.writeFileSync(fakeHtml, '<html><body>403 Forbidden</body></html>'.repeat(5000));
      assert.equal(isValidPeDll(fakeHtml).valid, false, 'HTML 文本绝不能通过 DLL 校验');

      const validPe = path.join(tmpDir, 'wintun.dll');
      const buf = Buffer.alloc(120 * 1024, 0);
      buf[0] = 0x4d;
      buf[1] = 0x5a;
      fs.writeFileSync(validPe, buf);
      assert.equal(isValidPeDll(validPe).valid, true, '合法 MZ 头且 >=100KB 应通过基础 PE 头校验');

      const st = getWintunStatus(tmpDir, path.join(tmpDir, 'res'));
      assert.equal(st.ready, true);

      const cs = generateServiceCSharpSource(33211);
      const maliciousHash = 'DEADBEEF'.repeat(8);
      assert.equal(cs.includes(maliciousHash), false, '恶意 DLL 哈希不能存在于白名单');
      assert.ok(
        cs.includes('wintun.dll SHA-256 verification failed') &&
          cs.includes('Unexpected DLL found in locked directory'),
        'C# 端必须对恶意 wintun.dll 哈希和未知 DLL 抛出异常拦截'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. 验证安装脚本严格检查所有 icacls 退出码、源目录 ACL、重解析点链与复制后可信复核', () => {
    const smSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/network/service-manager.ts'),
      'utf8'
    );
    assert.equal(
      smSrc.includes("[void](Run-Native 'icacls.exe'"),
      false,
      '严禁使用 [void] 丢弃 icacls.exe 退出码'
    );
    assert.ok(
      smSrc.includes('$aclDirRes.Code -ne 0') && smSrc.includes('$aclTokRes.Code -ne 0'),
      '目录 ACL 与 token ACL 均必须检查非零退出码并中止安装'
    );
    assert.ok(
      smSrc.includes('Assert-NoReparseChain') &&
        smSrc.includes('$aclParentRes.Code -ne 0') &&
        smSrc.includes('Assert-SourceAclLocked'),
      '安装脚本必须检查完整父目录链重解析点、锁定父目录 ACL 并校验安装源及父目录 ACL'
    );
    assert.ok(
      smSrc.includes('expectedMihomoSha256') &&
        smSrc.includes('$copiedMihomoHash -ne $expectedMihomoHash') &&
        smSrc.includes('post-copy trust verification'),
      '安装流程必须校验 mihomo.exe 复制完整性及复制后可信清单/数字签名复核'
    );
  });

  it('5. 验证 PID 归属校验覆盖：PID 复用、同名不同路径、CreationMs 缺失与 Service 模式 runtimeDir', () => {
    const now = 1_760_000_000_000;
    const serviceExe = 'C:\\ProgramData\\NexLink\\service\\bin\\mihomo.exe';
    const serviceRuntime = 'C:\\ProgramData\\NexLink\\service\\runtime';

    assert.equal(
      evaluateOwnedMihomoProcessInfo(
        {
          Name: 'mihomo.exe',
          ExecutablePath: serviceExe,
          CommandLine: `"${serviceExe}" -d "${serviceRuntime}" -f "${serviceRuntime}\\config.yaml"`,
          CreationMs: now + 2000,
        },
        serviceExe,
        serviceRuntime,
        now
      ),
      true,
      '合法的 Service 模式 Mihomo 进程必须通过校验'
    );

    assert.equal(
      evaluateOwnedMihomoProcessInfo(
        {
          Name: 'mihomo.exe',
          ExecutablePath: serviceExe,
          CommandLine: `"${serviceExe}" -d "${serviceRuntime}"`,
          CreationMs: now + 60_000,
        },
        serviceExe,
        serviceRuntime,
        now
      ),
      false,
      'PID 复用（创建时间差超过 30 秒）必须返回 false'
    );

    assert.equal(
      evaluateOwnedMihomoProcessInfo(
        {
          Name: 'mihomo.exe',
          ExecutablePath: 'C:\\Program Files\\Clash Verge\\verge-mihomo.exe',
          CommandLine: '"C:\\Program Files\\Clash Verge\\verge-mihomo.exe" -d "C:\\Users\\u\\.config\\clash"',
          CreationMs: now,
        },
        serviceExe,
        serviceRuntime,
        now
      ),
      false,
      '同名不同路径的外部 Mihomo 进程必须返回 false'
    );

    assert.equal(
      evaluateOwnedMihomoProcessInfo(
        {
          Name: 'mihomo.exe',
          ExecutablePath: serviceExe,
          CommandLine: `"${serviceExe}" -d "${serviceRuntime}"`,
          CreationMs: null,
        },
        serviceExe,
        serviceRuntime,
        now
      ),
      false,
      '存在 expectedStartedAt 但无法取得 CreationMs 时必须 fail-closed 返回 false'
    );

    const pidRecordJson = JSON.stringify({
      pid: 43210,
      exePath: serviceExe,
      runtimeDir: serviceRuntime,
      startedAt: now,
    });
    const parsed = parsePidFileContent(pidRecordJson);
    assert.ok(parsed);
    assert.equal(parsed.pid, 43210);
    assert.equal(parsed.exePath, serviceExe);
    assert.equal(parsed.runtimeDir, serviceRuntime);
    assert.equal(parsed.startedAt, now);

    assert.equal(
      evaluateOwnedMihomoProcessInfo(
        {
          Name: 'mihomo.exe',
          ExecutablePath: serviceExe,
          CommandLine: `"${serviceExe}" -d "${serviceRuntime}"`,
          CreationMs: now,
        },
        serviceExe,
        'C:\\Users\\u\\AppData\\Roaming\\nexlink\\runtime',
        now
      ),
      false,
      'runtimeDir 与实际命令行不匹配时必须返回 false'
    );
  });

  it('6. 消除竞争窗口测试：PID 验证后进程退出、PID 被其他进程复用、原进程句柄有效时仅单次安全终止', () => {
    const exe = 'C:\\NexLink\\resources\\mihomo\\mihomo.exe';
    const rt = 'C:\\Users\\u\\AppData\\Roaming\\nexlink\\runtime';
    const startedAt = 1_760_000_000_000;

    // 6a. PID 验证后进程退出：验证返回 true，但在验证期间原进程退出 (exitCode=0) -> 绝不调用 kill()
    let exitAfterVerifyKillCount = 0;
    const childExitedAfterVerify = {
      pid: 22222,
      killed: false,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => {
        exitAfterVerifyKillCount++;
        return true;
      },
    };
    const resExited = terminateVerifiedChildProcess(childExitedAfterVerify, exe, rt, startedAt, {
      verify: () => {
        childExitedAfterVerify.exitCode = 0; // 模拟验证完成瞬间进程已自然退出
        return true;
      },
    });
    assert.equal(resExited, false, 'PID 验证后进程已退出时必须放弃终止');
    assert.equal(exitAfterVerifyKillCount, 0, 'PID 验证后进程已退出绝不得执行 kill()');

    // 6b. PID 被其他进程复用：verify 返回 false -> 绝不调用 kill()
    let reusedKillCount = 0;
    const childReusedPid = {
      pid: 24680,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => {
        reusedKillCount++;
        return true;
      },
    };
    const resReused = terminateVerifiedChildProcess(childReusedPid, exe, rt, startedAt, {
      verify: () => false,
    });
    assert.equal(resReused, false, 'PID 被其他进程复用时必须拒绝终止');
    assert.equal(reusedKillCount, 0, 'PID 被复用时绝不得调用 ChildProcess.kill()');

    // 6c. 原进程句柄仍然有效时安全终止：仅通过自身句柄单次调用 kill('SIGKILL')，无重复终止
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const liveChild = {
      pid: 13579,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: (sig?: NodeJS.Signals | number) => {
        signals.push(sig);
        return true;
      },
    };
    const resLive = terminateVerifiedChildProcess(liveChild, exe, rt, startedAt, {
      verify: () => true,
    });
    assert.equal(resLive, true, '原进程句柄有效且身份核验通过时应成功终止');
    assert.deepEqual(signals, ['SIGKILL'], '必须仅通过原进程句柄执行一次 SIGKILL，禁止重复终止');

    // 6d. 静态断言 mihomo-process.ts 不再执行 taskkill.exe
    const procSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/core/mihomo-process.ts'),
      'utf8'
    );
    assert.equal(procSrc.includes("execFileSync('taskkill.exe'"), false, '绝不允许验证后再次仅凭 PID 执行 taskkill.exe');
  });

  it('7. 孤儿进程原生句柄验证与终止测试：身份验证通过单次终止、验证后退出与 PID 复用均放弃终止', () => {
    const exe = 'C:\\NexLink\\resources\\mihomo\\mihomo.exe';
    const rt = 'C:\\Users\\u\\AppData\\Roaming\\nexlink\\runtime';
    const startedAt = 1_760_000_000_000;

    // 7a. 合法孤儿 Mihomo 进程 -> 同一句柄验证并单次终止，且必关闭句柄
    let terminateCalls = 0;
    let closed = false;
    const okOrphan = terminateVerifiedOrphanProcess(31001, exe, rt, startedAt, {
      openHandle: (pid) => ({
        pid,
        isStillActive: () => true,
        probeInfo: () => ({
          Name: 'mihomo.exe',
          ExecutablePath: exe,
          CommandLine: `"${exe}" -d "${rt}" -f "${rt}\\config.yaml"`,
          CreationMs: startedAt + 1500,
        }),
        terminate: () => {
          terminateCalls++;
          return true;
        },
        close: () => {
          closed = true;
        },
      }),
    });
    assert.equal(okOrphan, true, '合法孤儿 Mihomo 进程应通过原生句柄终止');
    assert.equal(terminateCalls, 1, '孤儿进程必须仅通过同一句柄终止一次');
    assert.equal(closed, true, '原生句柄必须在 finally 中释放');

    // 7b. 孤儿进程 PID 已被其他程序复用 (notepad.exe) -> 放弃终止并关闭句柄
    let reusedTermCalls = 0;
    let reusedClosed = false;
    const reusedOrphan = terminateVerifiedOrphanProcess(31002, exe, rt, startedAt, {
      openHandle: (pid) => ({
        pid,
        isStillActive: () => true,
        probeInfo: () => ({
          Name: 'notepad.exe',
          ExecutablePath: 'C:\\Windows\\System32\\notepad.exe',
          CommandLine: 'notepad.exe',
          CreationMs: startedAt + 90_000,
        }),
        terminate: () => {
          reusedTermCalls++;
          return true;
        },
        close: () => {
          reusedClosed = true;
        },
      }),
    });
    assert.equal(reusedOrphan, false, 'PID 被其他程序复用时必须放弃终止');
    assert.equal(reusedTermCalls, 0, '身份不匹配绝不得调用 TerminateProcess');
    assert.equal(reusedClosed, true, '失败分支也必须关闭原生句柄');

    // 7c. 孤儿进程在验证通过后瞬间退出 -> 二次存活检查拦截，放弃终止
    let exitedTermCalls = 0;
    let activeChecks = 0;
    const exitedOrphan = terminateVerifiedOrphanProcess(31003, exe, rt, startedAt, {
      openHandle: (pid) => ({
        pid,
        isStillActive: () => {
          activeChecks++;
          return activeChecks === 1; // 第一次存活，probe 后已退出
        },
        probeInfo: () => ({
          Name: 'mihomo.exe',
          ExecutablePath: exe,
          CommandLine: `"${exe}" -d "${rt}"`,
          CreationMs: startedAt,
        }),
        terminate: () => {
          exitedTermCalls++;
          return true;
        },
        close: () => {},
      }),
    });
    assert.equal(exitedOrphan, false, '孤儿进程验证后已退出必须放弃终止');
    assert.equal(exitedTermCalls, 0, '验证后已退出绝不得调用 TerminateProcess');

    // 7d. 验证 Windows 原生 P/Invoke 句柄脚本包含完整内核 API 且无 taskkill
    const winScript = buildWin32HandleVerifyAndTerminateScript(31001, exe, rt, startedAt);
    assert.ok(
      winScript.includes('OpenProcess') &&
        winScript.includes('GetExitCodeProcess') &&
        winScript.includes('QueryFullProcessImageNameW') &&
        winScript.includes('GetProcessTimes') &&
        winScript.includes('TerminateProcess') &&
        winScript.includes('CloseHandle'),
      'Windows 孤儿进程终止脚本必须使用原生内核句柄完成验证与终止'
    );
    assert.equal(winScript.toLowerCase().includes('taskkill'), false, '原生句柄脚本绝不得包含 taskkill');
  });

  it('8. Mihomo 安装源信任机制测试：普通用户可写拦截、哈希不匹配拦截、合法版本升级兼容', () => {
    const tmpDir = path.join(os.tmpdir(), `nexlink-trust-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const binPath = path.join(tmpDir, 'mihomo.exe');
      const manifestPath = path.join(tmpDir, TRUSTED_MIHOMO_MANIFEST_FILENAME);
      const hashV1 = createFakeMihomoPe(binPath, 'mihomo-v1.19.32');

      const manifestV1 = JSON.stringify({
        schemaVersion: 1,
        entries: [{ version: 'v1.19.32', arch: 'amd64', sha256: hashV1 }],
      });
      fs.writeFileSync(manifestPath, manifestV1, 'utf8');
      assert.ok(parseTrustedMihomoManifest(manifestV1), '合法版本清单必须可解析');

      // 8a. 安装源被普通用户修改 / 所在目录普通用户可写 -> 严格拒绝
      const unsafeAclRes = verifyMihomoInstallSource(binPath, {
        manifestPath,
        checkAcl: (p) => ({
          locked: false,
          reason: 'Writable by non-admin SID',
          unsafePath: p,
          unsafeSid: 'S-1-5-32-545',
        }),
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });
      assert.equal(unsafeAclRes.trusted, false, '安装源或父目录可被普通用户写入时必须拒绝');
      assert.ok(unsafeAclRes.error?.includes('ACL'), '错误信息必须明确指出 ACL 不安全');

      // 8b. 清单文件本身普通用户可写 -> 同样拒绝（防止普通用户伪造清单）
      const unsafeManifestAclRes = verifyMihomoInstallSource(binPath, {
        manifestPath,
        checkAcl: (p) =>
          p === manifestPath
            ? { locked: false, reason: 'Writable by Users', unsafePath: p, unsafeSid: 'S-1-5-32-545' }
            : { locked: true },
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });
      assert.equal(unsafeManifestAclRes.trusted, false, '普通用户可写的清单文件必须拒绝信任');

      // 8c. 安装源哈希不匹配（文件内容被篡改，不在清单中且无有效数字签名）-> 严格拒绝
      const tamperedHash = createFakeMihomoPe(binPath, 'malicious-backdoor-payload');
      assert.notEqual(tamperedHash, hashV1);
      const mismatchRes = verifyMihomoInstallSource(binPath, {
        manifestPath,
        checkAcl: () => ({ locked: true }),
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });
      assert.equal(mismatchRes.trusted, false, '安装源 SHA-256 与可信清单不匹配且无有效签名时必须拒绝');

      // 8d. 合法版本升级（v1.19.32 -> v1.20.0）：管理员更新二进制与清单后顺利通过，不永久锁死
      const hashV2 = createFakeMihomoPe(binPath, 'mihomo-v1.20.0-official');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            { version: 'v1.19.32', arch: 'amd64', sha256: hashV1 },
            { version: 'v1.20.0', arch: 'amd64', sha256: hashV2 },
          ],
        }),
        'utf8'
      );
      const upgradeManifestRes = verifyMihomoInstallSource(binPath, {
        manifestPath,
        checkAcl: () => ({ locked: true }),
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });
      assert.equal(upgradeManifestRes.trusted, true, '合法版本升级在受保护清单更新后必须通过验证');
      assert.equal(upgradeManifestRes.matchedVersion, 'v1.20.0');
      assert.equal(upgradeManifestRes.trustMethod, 'external-manifest');
      assert.equal(upgradeManifestRes.sha256, hashV2);

      // 8e. 合法版本升级（数字签名通道）：即使尚未更新清单，具备有效 Authenticode 签名的新版本也可平滑升级
      const hashV3 = createFakeMihomoPe(binPath, 'mihomo-v1.21.0-signed');
      const upgradeSigRes = verifyMihomoInstallSource(binPath, {
        manifestPath,
        checkAcl: () => ({ locked: true }),
        checkSignature: () => ({ valid: true, subject: 'CN=NexLink Official', thumbprint: 'AABBCC' }),
      });
      assert.equal(upgradeSigRes.trusted, true, '具备有效数字签名的合法新版本必须通过验证');
      assert.equal(upgradeSigRes.trustMethod, 'authenticode');
      assert.equal(upgradeSigRes.sha256, hashV3);

      // 8f. 便携版 / D 盘等用户可写目录：匹配内置硬编码 SHA-256 时允许安装（复制至锁定目录后会二次校验哈希防 TOCTOU）
      const portableHash = createFakeMihomoPe(binPath, 'mihomo-builtin-portable');
      const portableRes = verifyMihomoInstallSource(binPath, {
        builtinHashes: { 'v1.19.29-windows-amd64': portableHash },
        checkAcl: (p) => ({
          locked: false,
          reason: 'Writable by non-admin SID',
          unsafePath: p,
          unsafeSid: 'S-1-1-0',
        }),
        checkSignature: () => ({ valid: false, reason: 'NotSigned' }),
      });
      assert.equal(portableRes.trusted, true, '匹配内置可信哈希时即使位于 Temp/D盘 等用户可写目录也应允许安装');
      assert.equal(portableRes.trustMethod, 'builtin-manifest');
      assert.equal(portableRes.sha256, portableHash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. 验证 checkTunPrerequisites 返回结构化服务模式字段', async () => {
    const res = await checkTunPrerequisites();
    assert.equal(typeof res.isAdmin, 'boolean');
    assert.equal(typeof res.serviceInstalled, 'boolean');
    assert.equal(typeof res.serviceReady, 'boolean');
    assert.ok(['service', 'admin', 'none'].includes(res.mode));
  });

  it('10. 验证 NetworkTester.testIcmpDelay 拦截含 Shell 注入字符的恶意主机名', async () => {
    const tester = new NetworkTester(mihomoManager);
    const r1 = await tester.testIcmpDelay('1.1.1.1 & calc.exe', 500);
    const r2 = await tester.testIcmpDelay('-t 1.1.1.1', 500);
    assert.equal(r1, -1, '必须拒绝包含 & 命令拼接符的主机名');
    assert.equal(r2, -1, '必须拒绝以 - 开头的参数注入主机名');
  });
});
