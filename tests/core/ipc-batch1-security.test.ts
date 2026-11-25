import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  registerIpcHandlers,
  resolveCoreLifecyclePayload,
  sanitizeAndValidateSubAddPayload,
} from '../../src/main/ipc/index';
import { DEFAULT_SETTINGS, storageManager } from '../../src/main/storage/store';
import { IPC_CHANNELS } from '../../src/shared/ipc-events';

describe('Batch 1 IPC 边界与本地订阅沙箱安全防回归测试', () => {
  it('1. sanitizeAndValidateSubAddPayload: 拒绝 local 订阅传入 url、../ 穿越、及软链接/Junction 逃逸', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_ipc_sub_'));
    const profilesDir = path.join(baseDir, 'profiles');
    const outsideDir = path.join(baseDir, 'outside');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const validProfile = path.join(profilesDir, 'valid.txt');
    const outsideSecret = path.join(outsideDir, 'secret.yaml');
    fs.writeFileSync(validProfile, 'vless://11111111-2222-3333-4444-555555555555@1.1.1.1:443#n1', 'utf8');
    fs.writeFileSync(outsideSecret, 'secret: true', 'utf8');

    try {
      // 1) type: 'local' + url -> 必须拒绝
      assert.throws(
        () => sanitizeAndValidateSubAddPayload({ name: 'evil', type: 'local', url: outsideSecret }, baseDir),
        /本地订阅不允许传入 url/
      );

      // 2) type: 'local' + ../ 穿越 -> 必须拒绝
      assert.throws(
        () =>
          sanitizeAndValidateSubAddPayload(
            { name: 'trav', type: 'local', filePath: path.join(profilesDir, '..', 'outside', 'secret.yaml') },
            baseDir
          ),
        /安全拦截/
      );

      // 3) type: 'local' + 软链接 / Windows Junction 逃逸 -> 必须被 realpathSync 拦截
      const linkDir = path.join(profilesDir, 'link-out');
      let linkCreated = false;
      try {
        fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
        linkCreated = true;
      } catch {
        linkCreated = false;
      }
      if (linkCreated) {
        assert.throws(
          () =>
            sanitizeAndValidateSubAddPayload(
              { name: 'sym', type: 'local', filePath: path.join(linkDir, 'secret.yaml') },
              baseDir
            ),
          /安全拦截|逃逸/
        );
      }

      // 4) type: 'remote' + 非 http(s) url 或携带 filePath -> 必须拒绝
      assert.throws(
        () => sanitizeAndValidateSubAddPayload({ name: 'r1', type: 'remote', url: 'file:///C:/Windows/win.ini' }, baseDir),
        /http:\/\/ 或 https:\/\//
      );
      assert.throws(
        () =>
          sanitizeAndValidateSubAddPayload(
            { name: 'r2', type: 'remote', url: 'https://example.com/sub', filePath: validProfile },
            baseDir
          ),
        /远程订阅不允许传入本地 filePath/
      );

      // 5) 合法受控目录文件与合法内联 rawContent 正常放行并规范化为 realPath
      const safeFile = sanitizeAndValidateSubAddPayload(
        { name: 'ok-file', type: 'local', filePath: validProfile },
        baseDir
      );
      assert.strictEqual(safeFile.filePath, fs.realpathSync(validProfile));
      assert.strictEqual(safeFile.url, undefined);

      const safeInline = sanitizeAndValidateSubAddPayload(
        { name: 'ok-inline', type: 'local', rawContent: 'vless://11111111-2222-3333-4444-555555555555@1.1.1.1:443#n1' },
        baseDir
      );
      assert.strictEqual(safeInline.type, 'local');
      assert.ok(safeInline.rawContent);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('2. registerIpcHandlers: SUB_ADD、CORE_START、CORE_RESTART 实际注册的 IPC 处理器拦截非法载荷', async () => {
    const handlers = new Map<string, (event: any, ...args: any[]) => any>();
    const mockIpcMain = {
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
      handle: (channel: string, listener: (event: any, ...args: any[]) => any) => {
        handlers.set(channel, listener);
      },
    };
    const mockWindow = {
      isDestroyed: () => true,
      webContents: { send: () => {} },
    } as any;

    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_ipc_handlers_'));
    const prevBaseDir = storageManager.getBaseDir();
    storageManager.initialize(baseDir);

    try {
      registerIpcHandlers(mockWindow, { ipcMainInstance: mockIpcMain });

      const subAddHandler = handlers.get(IPC_CHANNELS.SUB_ADD);
      const coreStartHandler = handlers.get(IPC_CHANNELS.CORE_START);
      const coreRestartHandler = handlers.get(IPC_CHANNELS.CORE_RESTART);
      assert.ok(subAddHandler && coreStartHandler && coreRestartHandler);

      await assert.rejects(
        () => subAddHandler({}, { name: 'evil', type: 'local', url: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }),
        /本地订阅不允许传入 url/
      );

      await assert.rejects(
        () => coreStartHandler({}, 'not-an-object'),
        /必须为对象/
      );

      await assert.rejects(
        () => coreRestartHandler({}, { settings: { mixedPort: 7890, apiPort: 7890 } }),
        /端口冲突/
      );

      await assert.rejects(
        () => coreStartHandler({}, { settings: { mixedPort: 99999 } }),
        /端口非法/
      );
    } finally {
      if (prevBaseDir) {
        storageManager.initialize(prevBaseDir);
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('3. resolveCoreLifecyclePayload: 严格校验节点、端口、模式、布尔开关，合法参数正常合并', () => {
    assert.throws(
      () => resolveCoreLifecyclePayload(['bad'], DEFAULT_SETTINGS, [], {}),
      /必须为对象/
    );
    assert.throws(
      () => resolveCoreLifecyclePayload({ nodes: 'bad' }, DEFAULT_SETTINGS, [], {}),
      /nodes 必须为数组/
    );
    assert.throws(
      () => resolveCoreLifecyclePayload({ nodes: [{ name: 'n', port: 0 }] }, DEFAULT_SETTINGS, [], {}),
      /节点端口非法/
    );
    assert.throws(
      () => resolveCoreLifecyclePayload({ selectedNodeName: 123 }, DEFAULT_SETTINGS, [], {}),
      /selectedNodeName 必须为字符串/
    );
    assert.throws(
      () => resolveCoreLifecyclePayload({ settings: { mode: 'invalid-mode' } }, DEFAULT_SETTINGS, [], {}),
      /非法的代理运行模式/
    );
    assert.throws(
      () => resolveCoreLifecyclePayload({ settings: { tunMode: 'yes' } }, DEFAULT_SETTINGS, [], {}),
      /tunMode 必须为布尔值/
    );

    const resolved = resolveCoreLifecyclePayload(
      { settings: { mixedPort: 7891 }, selectedNodeName: 'HK-01' },
      DEFAULT_SETTINGS,
      [],
      {}
    );
    assert.strictEqual(resolved.settings.mixedPort, 7891);
    assert.strictEqual(resolved.settings.apiPort, DEFAULT_SETTINGS.apiPort);
    assert.strictEqual(resolved.selectedNodeName, 'HK-01');

    const defaulted = resolveCoreLifecyclePayload(undefined, DEFAULT_SETTINGS, [], { selectedNodeName: 'Auto' });
    assert.strictEqual(defaulted.selectedNodeName, 'Auto');
    assert.strictEqual(defaulted.settings.mixedPort, DEFAULT_SETTINGS.mixedPort);
  });
});
