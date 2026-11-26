import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { useProxyStore, formatChainOutboundName, normalizeChainName } from '../../src/renderer/store/useProxyStore';
import { resolveIsDark } from '../../src/renderer/utils/themeManager';
import { ErrorBoundary } from '../../src/renderer/components/common/ErrorBoundary';
import { parseUwpAppsJsonOutput } from '../../src/main/services/uwp-tool';
import { buildRestartAsAdminPsScript } from '../../src/main/network/tun-checker';
import { IPC_CHANNELS } from '../../src/shared/ipc-events';

function assertPowerShellAstValid(script: string) {
  if (process.platform !== 'win32') return;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const check = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  $msgs = ($errors | ForEach-Object { $_.Message }) -join '; '
  Write-Error "AST errors: $msgs"
  exit 1
}
Write-Output 'AST_OK'
`;
  const encoded = Buffer.from(check, 'utf16le').toString('base64');
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }
  );
  assert.strictEqual(out.trim(), 'AST_OK');
}

describe('Batch 8 UI 容错、代理链水合、系统工具编码/路径转义与契约清理测试', () => {
  it('1. useProxyStore 代理链重启水合：保存带 🔗 前缀的 selectedNodeName 后重启可精确匹配并恢复激活状态', async () => {
    const chain = {
      id: 'chain-jp-01',
      name: '日本BGP中转链路',
      nodeIds: ['node-1', 'node-2'],
      enabled: true,
      createdAt: 1795600000000,
    };
    const node1 = {
      id: 'node-1',
      name: '节点一',
      type: 'vless' as const,
      server: '1.1.1.1',
      port: 443,
    };

    assert.strictEqual(formatChainOutboundName('日本BGP中转链路'), '🔗 日本BGP中转链路');
    assert.strictEqual(formatChainOutboundName('🔗 日本BGP中转链路'), '🔗 日本BGP中转链路');
    assert.strictEqual(normalizeChainName('🔗 日本BGP中转链路'), '日本BGP中转链路');

    const prevWindow = (globalThis as any).window;
    let persistedSelectedName = '';
    let selectedCoreNode = '';
    (globalThis as any).window = {
      nexlinkAPI: {
        storage: {
          saveState: async (state: { selectedNodeName?: string }) => {
            persistedSelectedName = state.selectedNodeName || '';
          },
        },
        core: {
          selectNode: async (_group: string, name: string) => {
            selectedCoreNode = name;
          },
        },
      },
    };

    try {
      // 设置链路并激活
      useProxyStore.setState({ nodes: [node1], chains: [chain], activeChainId: '', activeNodeId: 'node-1', activeOutboundMode: 'node', selectedOutboundName: '节点一' });
      await useProxyStore.getState().setActiveChain(chain);
      assert.strictEqual(useProxyStore.getState().activeChainId, 'chain-jp-01');
      assert.strictEqual(useProxyStore.getState().activeOutboundMode, 'chain');
      assert.strictEqual(useProxyStore.getState().selectedOutboundName, '🔗 日本BGP中转链路');
      assert.strictEqual(persistedSelectedName, '🔗 日本BGP中转链路');
      assert.strictEqual(selectedCoreNode, '🔗 日本BGP中转链路');

      // 模拟重启清空活跃状态后通过 persisted.state.selectedNodeName='🔗 日本BGP中转链路' 水合恢复
      useProxyStore.setState({ activeChainId: '', activeNodeId: '', activeOutboundMode: 'node', selectedOutboundName: '' });
      useProxyStore.getState().hydrateActiveNode('', persistedSelectedName);
      assert.strictEqual(useProxyStore.getState().activeChainId, 'chain-jp-01');
      assert.strictEqual(useProxyStore.getState().activeOutboundMode, 'chain');
      assert.strictEqual(useProxyStore.getState().selectedOutboundName, '🔗 日本BGP中转链路');

      // 兼容无前缀历史值
      useProxyStore.setState({ activeChainId: '', activeOutboundMode: 'node', selectedOutboundName: '' });
      useProxyStore.getState().hydrateActiveNode('', '日本BGP中转链路');
      assert.strictEqual(useProxyStore.getState().activeChainId, 'chain-jp-01');
      assert.strictEqual(useProxyStore.getState().activeOutboundMode, 'chain');
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = prevWindow;
      }
    }
  });

  it('2. resolveIsDark 在 dark/light/system 模式下正确跟随系统深色状态且 ErrorBoundary 正确捕获渲染异常', () => {
    assert.strictEqual(resolveIsDark('dark', false), true);
    assert.strictEqual(resolveIsDark('light', true), false);
    assert.strictEqual(resolveIsDark('system', true), true);
    assert.strictEqual(resolveIsDark('system', false), false);

    const errState = ErrorBoundary.getDerivedStateFromError(new Error('模拟页面崩溃'));
    assert.strictEqual(errState.hasError, true);
    assert.strictEqual(errState.errorMessage, '模拟页面崩溃');
  });

  it('3. uwp-tool parseUwpAppsJsonOutput 正确无乱码解析中文 DisplayName 与单条/数组 JSON 输出', () => {
    const exempt = new Set(['S-1-15-2-222222222-1-2-3-4-5-6']);
    const sampleJson = JSON.stringify([
      {
        sid: 'S-1-15-2-111111111-1-2-3-4-5-6',
        displayName: '腾讯QQ音乐 UWP 中文版',
        moniker: 'Tencent.QQMusic',
      },
      {
        sid: 'S-1-15-2-222222222-1-2-3-4-5-6',
        displayName: '微软应用商店定制版',
        moniker: 'Custom.StoreCN',
      },
    ]);

    const items = parseUwpAppsJsonOutput(sampleJson, exempt);
    assert.strictEqual(items.length, 2);
    // 已豁免应用应优先排序
    assert.strictEqual(items[0].isExempt, true);
    assert.strictEqual(items[0].displayName, '微软应用商店定制版');
    assert.strictEqual(items[1].displayName, '腾讯QQ音乐 UWP 中文版');

    // 单对象输出兼容（PowerShell 单条对象未包数组时的容错）
    const single = parseUwpAppsJsonOutput(
      JSON.stringify({ sid: 'S-1-15-2-333333333-1-2-3-4-5-6', displayName: '哔哩哔哩桌面客户端', moniker: 'Bili.UWP' }),
      new Set()
    );
    assert.strictEqual(single.length, 1);
    assert.strictEqual(single[0].displayName, '哔哩哔哩桌面客户端');
  });

  it('4. tun-checker buildRestartAsAdminPsScript 在含空格与单引号的开发路径下 0 AST 语法错误', () => {
    const devScript = buildRestartAsAdminPsScript({
      isPackaged: false,
      execPath: 'C:\\Program Files\\Electron\\electron.exe',
      cwd: "D:\\My Projects\\O'Brien's Workspace\\NexLink App",
    });
    assert.ok(devScript.includes('-EncodedCommand'), 'dev 模式必须使用 -EncodedCommand 包装避免嵌套单引号');
    assertPowerShellAstValid(devScript);

    // 验证内层 Base64 解码后的命令本身也是合法 PowerShell AST
    const b64Match = devScript.match(/'-EncodedCommand','([^']+)'/);
    assert.ok(b64Match && b64Match[1]);
    const decodedInner = Buffer.from(b64Match![1], 'base64').toString('utf16le');
    assert.ok(decodedInner.includes("O''Brien''s Workspace"));
    assertPowerShellAstValid(decodedInner);

    const prodScript = buildRestartAsAdminPsScript({
      isPackaged: true,
      execPath: 'C:\\Program Files\\NexLink\\NexLink.exe',
      cwd: 'C:\\Program Files\\NexLink',
    });
    assertPowerShellAstValid(prodScript);
  });

  it('5. 契约漂移与死代码/本机调试路径清理检查', () => {
    assert.strictEqual(fs.existsSync(path.resolve('src/renderer/pages/import/ImportCenterPage.tsx')), false);
    assert.strictEqual('CORE_VALIDATE_CONFIG' in IPC_CHANNELS, false);

    const cfgBuilder = fs.readFileSync(path.resolve('src/main/core/config-builder.ts'), 'utf8');
    assert.strictEqual(cfgBuilder.includes('activeProfileContent'), false);

    const mockData = fs.readFileSync(path.resolve('src/renderer/mock/mockData.ts'), 'utf8');
    assert.strictEqual(mockData.includes('20122'), false);

    const appTsx = fs.readFileSync(path.resolve('src/renderer/App.tsx'), 'utf8');
    assert.ok(appTsx.includes('ErrorBoundary'));
    assert.ok(appTsx.includes('resolveIsDark(theme, systemDark)'));
  });
});
