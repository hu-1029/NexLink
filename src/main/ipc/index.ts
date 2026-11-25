import * as Electron from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-events';
import type {
  AppInfo,
  AppSettings,
  CoreStatus,
  ProxyNode,
  SystemProxyConfig,
} from '../../shared/types';
import { mihomoManager } from '../core/mihomo-process';
import { systemProxyManager } from '../network/system-proxy';
import { checkTunPrerequisites, isCurrentProcessAdmin, restartAsAdmin } from '../network/tun-checker';
import { tunServiceManager } from '../network/service-manager';
import { storageManager, type AppPersistedState } from '../storage/store';
import { subscriptionManager } from '../subscription/manager';
import { resolveSafeLocalProfilePath } from '../subscription/fetcher';
import { buildMihomoConfig } from '../core/config-builder';
import { isValidPort } from '../../services/node/node-utils';
import { NetworkTester } from '../services/network-tester';
import { uwpToolService } from '../services/uwp-tool';
import { updateService } from '../services/updater';
import { coreUpdaterService } from '../services/core-updater';

const app = Electron.app;
const defaultIpcMain = Electron.ipcMain;
const networkTester = new NetworkTester(mihomoManager);

export interface IpcHandlerOptions {
  onSettingsUpdated?: (settings: Partial<AppSettings>) => void;
  ipcMainInstance?: Pick<Electron.IpcMain, 'handle' | 'removeHandler'>;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验并标准化 CORE_START / CORE_RESTART 传入载荷，拦截非法结构与越界端口
 */
export function resolveCoreLifecyclePayload(
  payload: unknown,
  persistedSettings: AppSettings,
  persistedNodes: ProxyNode[],
  state: AppPersistedState
): { nodes: ProxyNode[]; settings: AppSettings; selectedNodeName?: string } {
  if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
    throw new Error('无效的核心启动参数载荷: 必须为对象');
  }

  const raw = isPlainObject(payload) ? payload : {};

  if (raw.selectedNodeName !== undefined && typeof raw.selectedNodeName !== 'string') {
    throw new Error('无效的核心启动参数: selectedNodeName 必须为字符串');
  }

  let nodes = persistedNodes;
  if (raw.nodes !== undefined) {
    if (!Array.isArray(raw.nodes)) {
      throw new Error('无效的核心启动参数: nodes 必须为数组');
    }
    for (const node of raw.nodes) {
      if (!isPlainObject(node)) {
        throw new Error('无效的核心启动参数: nodes 包含非法的节点对象');
      }
      if (node.port !== undefined && !isValidPort(node.port)) {
        throw new Error(`无效的核心启动参数: 节点端口非法 (${String(node.port)})`);
      }
    }
    nodes = raw.nodes as ProxyNode[];
  }

  let settings = persistedSettings;
  if (raw.settings !== undefined) {
    if (!isPlainObject(raw.settings)) {
      throw new Error('无效的核心启动参数: settings 必须为对象');
    }
    const inputSettings = raw.settings;
    if (inputSettings.mixedPort !== undefined && !isValidPort(inputSettings.mixedPort)) {
      throw new Error(`系统混合代理端口非法 (必须为 1-65535 整数): ${inputSettings.mixedPort}`);
    }
    if (inputSettings.apiPort !== undefined && !isValidPort(inputSettings.apiPort)) {
      throw new Error(`控制端口非法 (必须为 1-65535 整数): ${inputSettings.apiPort}`);
    }
    if (
      inputSettings.mode !== undefined &&
      !['rule', 'global', 'direct'].includes(inputSettings.mode)
    ) {
      throw new Error(`非法的代理运行模式: ${String(inputSettings.mode)}`);
    }
    if (inputSettings.tunMode !== undefined && typeof inputSettings.tunMode !== 'boolean') {
      throw new Error('无效的核心启动参数: tunMode 必须为布尔值');
    }
    if (inputSettings.allowLan !== undefined && typeof inputSettings.allowLan !== 'boolean') {
      throw new Error('无效的核心启动参数: allowLan 必须为布尔值');
    }
    if (inputSettings.systemProxy !== undefined && typeof inputSettings.systemProxy !== 'boolean') {
      throw new Error('无效的核心启动参数: systemProxy 必须为布尔值');
    }
    if (inputSettings.dns !== undefined && !isPlainObject(inputSettings.dns)) {
      throw new Error('无效的核心启动参数: dns 必须为对象');
    }

    const targetMixedPort = Number(inputSettings.mixedPort ?? persistedSettings.mixedPort ?? 7890);
    const targetApiPort = Number(inputSettings.apiPort ?? persistedSettings.apiPort ?? 9097);
    if (targetMixedPort === targetApiPort) {
      throw new Error(`端口冲突: 混合代理端口与控制端口不能相同 (${targetMixedPort})`);
    }

    settings = {
      ...persistedSettings,
      ...inputSettings,
      ...(inputSettings.dns
        ? { dns: { ...(persistedSettings.dns || {}), ...inputSettings.dns } }
        : {}),
    } as AppSettings;
  }

  const selectedNodeName =
    raw.selectedNodeName ||
    state.selectedNodeName ||
    (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);

  return { nodes, settings, selectedNodeName };
}

/**
 * 校验并清洗 SUB_ADD 入参：严禁本地订阅经 url 读取文件，并强制通过 realpathSync 锁定在 profiles/ 目录内
 */
export function sanitizeAndValidateSubAddPayload(subData: unknown, baseDir: string): any {
  if (!isPlainObject(subData)) {
    throw new Error('无效的订阅参数');
  }

  const safeSubData: Record<string, any> = { ...subData };
  const subType =
    safeSubData.type === 'local' ? 'local' : safeSubData.type === 'remote' ? 'remote' : null;
  if (!subType) {
    throw new Error(`无效的订阅类型: ${String(safeSubData.type)}`);
  }

  if (subType === 'local') {
    if (
      safeSubData.url !== undefined &&
      safeSubData.url !== null &&
      String(safeSubData.url).trim() !== ''
    ) {
      throw new Error('安全拦截: 本地订阅不允许传入 url 参数');
    }
    delete safeSubData.url;

    if (safeSubData.filePath !== undefined && safeSubData.filePath !== null) {
      if (typeof safeSubData.filePath !== 'string') {
        throw new Error('无效的本地订阅 filePath 参数');
      }
      if (safeSubData.filePath.trim() !== '') {
        const pathCheck = resolveSafeLocalProfilePath(safeSubData.filePath, baseDir);
        if (!pathCheck.ok) {
          throw new Error(pathCheck.error);
        }
        safeSubData.filePath = pathCheck.realPath;
      } else {
        delete safeSubData.filePath;
      }
    }

    if (safeSubData.rawContent !== undefined && typeof safeSubData.rawContent !== 'string') {
      throw new Error('无效的本地订阅 rawContent 参数');
    }
  } else {
    if (
      safeSubData.filePath !== undefined &&
      safeSubData.filePath !== null &&
      String(safeSubData.filePath).trim() !== ''
    ) {
      throw new Error('安全拦截: 远程订阅不允许传入本地 filePath 参数');
    }
    delete safeSubData.filePath;

    const urlStr = typeof safeSubData.url === 'string' ? safeSubData.url.trim() : '';
    if (!/^https?:\/\//i.test(urlStr)) {
      throw new Error('远程订阅必须提供有效的 http:// 或 https:// 地址');
    }
    safeSubData.url = urlStr;
  }

  return safeSubData;
}

export function registerIpcHandlers(
  mainWindow: Electron.BrowserWindow,
  options?: IpcHandlerOptions
): void {
  const ipcMain = options?.ipcMainInstance || defaultIpcMain;
  // 防止窗口重建时重复注册 ipcMain.handle 抛出致命异常
  for (const ch of Object.values(IPC_CHANNELS)) {
    ipcMain.removeHandler(ch);
  }
  // 绑定 Mihomo 进程管理器的事件推送给前端渲染进程
  mihomoManager.setCallbacks(
    (trafficData) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.CORE_TRAFFIC_DATA, trafficData);
      }
    },
    (status) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.CORE_GET_STATUS, status);
      }
    },
    (logItem) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.CORE_LOG_DATA, logItem);
      }
    }
  );

  // 绑定订阅与存储数据变更同步推送
  subscriptionManager.setOnDataChanged(() => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
    }
  });

  // 窗口管理
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return mainWindow.isMaximized();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
    mainWindow.close();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
    return mainWindow.isMaximized();
  });

  // 应用信息与目录
  ipcMain.handle(IPC_CHANNELS.APP_GET_INFO, (): AppInfo => {
    return {
      name: 'NexLink',
      version: app.getVersion() || '0.1.0',
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
    };
  });

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_DIR, async (): Promise<string> => {
    const dir = app.getPath('userData');
    await Electron.shell.openPath(dir);
    return dir;
  });

  // 核心管理
  ipcMain.handle(IPC_CHANNELS.CORE_GET_STATUS, (): CoreStatus => {
    return mihomoManager.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_START,
    async (
      _,
      payload: { nodes?: ProxyNode[]; settings?: AppSettings; selectedNodeName?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const startOptions = resolveCoreLifecyclePayload(
        payload,
        storageManager.getSettings(),
        storageManager.getNodes(),
        storageManager.getState()
      );
      return await mihomoManager.start(startOptions);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CORE_STOP, async (): Promise<boolean> => {
    return await mihomoManager.stop();
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_RESTART,
    async (
      _,
      payload: { nodes?: ProxyNode[]; settings?: AppSettings; selectedNodeName?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const restartOptions = resolveCoreLifecyclePayload(
        payload,
        storageManager.getSettings(),
        storageManager.getNodes(),
        storageManager.getState()
      );
      return await mihomoManager.restart(restartOptions);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_SET_MODE,
    async (_, mode: 'rule' | 'global' | 'direct'): Promise<boolean> => {
      storageManager.saveSettings({ mode });
      options?.onSettingsUpdated?.({ mode });
      return await mihomoManager.setMode(mode);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CORE_GET_CONFIG, (): string => {
    let content = mihomoManager.getRuntimeConfig();
    if (!content) {
      const state = storageManager.getState();
      const nodes = storageManager.getNodes();
      const selectedNodeName =
        state.selectedNodeName ||
        (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);

      content = buildMihomoConfig({
        nodes,
        settings: storageManager.getSettings(),
        apiSecret: 'nexlink-runtime-secret',
        selectedNodeName,
      });
    }
    return content.replace(/^(\s*secret:\s*).*$/gm, "$1'********'");
  });

  ipcMain.handle(IPC_CHANNELS.CORE_GET_VERSION, (): string => {
    return mihomoManager.getInstalledCoreVersion();
  });

  ipcMain.handle(IPC_CHANNELS.CORE_GET_STATE, () => {
    return coreUpdaterService.getCoreState();
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_UPDATE,
    async (event, options?: { force?: boolean }) => {
      return await coreUpdaterService.checkAndUpdateCore({
        ...options,
        onProgress: (msg: string) => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.CORE_UPDATE_PROGRESS, msg);
            }
          } catch {
            // ignore
          }
        },
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.CORE_ROLLBACK, async () => {
    return await coreUpdaterService.rollbackCore();
  });

  ipcMain.handle(IPC_CHANNELS.CORE_UPDATE_GEO, async () => {
    return await coreUpdaterService.updateGeoDatabases();
  });

  // 节点与代理组 API 交互
  ipcMain.handle(IPC_CHANNELS.CORE_GET_PROXIES, async () => {
    if (!mihomoManager.getStatus().running) {
      return { proxies: {} };
    }
    try {
      return await mihomoManager.getApiClient().getProxies();
    } catch (err: any) {
      console.warn('[IPC] 获取核心节点列表失败:', err.message);
      return { proxies: {} };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_SELECT_NODE,
    async (_, groupName: string, nodeName: string): Promise<boolean> => {
      if (!mihomoManager.getStatus().running) {
        return false;
      }
      try {
        const res = await mihomoManager.getApiClient().selectProxy(groupName, nodeName);
        // 若在全局模式或存在 GLOBAL 组，同步切换 GLOBAL 出站指向
        try {
          await mihomoManager.getApiClient().selectProxy('GLOBAL', nodeName);
        } catch (_e) {
          void _e;
        }
        return res;
      } catch (err: any) {
        console.error(`[IPC] 切换节点至 ${nodeName} 失败:`, err.message);
        throw err;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_TEST_DELAY,
    async (
      _,
      nodeName: string,
      url: string = 'http://www.gstatic.com/generate_204',
      timeout: number = 3000
    ): Promise<number> => {
      if (!mihomoManager.getStatus().running) {
        throw new Error('代理核心尚未启动，无法进行真实握手测速');
      }
      return await mihomoManager.getApiClient().getProxyDelay(nodeName, url, timeout);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_TEST_NODE_DELAY,
    async (
      _,
      node: { name: string; server: string; port: number; type?: string },
      method: 'TCP' | 'ICMP' | 'CONNECT' = 'TCP',
      timeout: number = 2500
    ): Promise<number> => {
      return await networkTester.testDelay(node, method, timeout);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CORE_GET_CONNECTIONS, async () => {
    if (!mihomoManager.getStatus().running) {
      return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
    }
    try {
      return await mihomoManager.getApiClient().getConnections();
    } catch (err: any) {
      console.warn('[IPC] 获取连接列表失败:', err.message);
      return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CORE_CLOSE_CONNECTION, async (_, id: string): Promise<boolean> => {
    if (!mihomoManager.getStatus().running) return false;
    if (!id) {
      return await mihomoManager.getApiClient().closeAllConnections();
    }
    return await mihomoManager.getApiClient().closeConnection(id);
  });

  ipcMain.handle(IPC_CHANNELS.CORE_GET_RULES, async () => {
    if (!mihomoManager.getStatus().running) {
      return { rules: [] };
    }
    try {
      return await mihomoManager.getApiClient().getRules();
    } catch {
      return { rules: [] };
    }
  });

  // 订阅管理联动
  ipcMain.handle(IPC_CHANNELS.SUB_UPDATE, async (_, id: string) => {
    return await subscriptionManager.updateSubscription(id);
  });

  ipcMain.handle(IPC_CHANNELS.SUB_UPDATE_ALL, async () => {
    await subscriptionManager.updateAllSubscriptions();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.SUB_ADD, async (_, subData: any) => {
    const safeSubData = sanitizeAndValidateSubAddPayload(subData, storageManager.getBaseDir());
    return await subscriptionManager.addSubscription(safeSubData);
  });

  ipcMain.handle(IPC_CHANNELS.SUB_DELETE, async (_, id: string) => {
    await subscriptionManager.deleteSubscription(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.SUB_TOGGLE, async (_, id: string) => {
    await subscriptionManager.toggleSubscription(id);
    return true;
  });

  // 持久化数据接口
  ipcMain.handle(IPC_CHANNELS.DATA_LOAD_ALL, () => {
    return storageManager.getData();
  });

  ipcMain.handle(IPC_CHANNELS.DATA_SAVE_NODES, (_, nodes: ProxyNode[]) => {
    storageManager.saveNodes(nodes);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.DATA_SAVE_STATE, (_, state: any) => {
    storageManager.saveState(state);
    return true;
  });

  // 系统代理与设置
  ipcMain.handle(IPC_CHANNELS.SYS_GET_PROXY, async (): Promise<SystemProxyConfig> => {
    return await systemProxyManager.getCurrentProxy();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_SET_PROXY, async (_, enabled: boolean): Promise<boolean> => {
    const currentSettings = storageManager.getSettings();
    const activePort = mihomoManager.getStatus().mixedPort || currentSettings.mixedPort || 7890;
    storageManager.saveSettings({ systemProxy: enabled });
    options?.onSettingsUpdated?.({ systemProxy: enabled });
    if (enabled) {
      if (!mihomoManager.getStatus().running) {
        console.log('[IPC] 核心未运行，已保存系统代理设置但暂不调用 enableProxy');
        return false;
      }
      return await systemProxyManager.enableProxy(activePort, currentSettings.bypassList, mihomoManager.getPid());
    } else {
      return await systemProxyManager.restoreProxy(activePort);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYS_GET_SETTINGS, (): AppSettings => {
    return storageManager.getSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.SYS_UPDATE_SETTINGS,
    async (_, newSettings: Partial<AppSettings>): Promise<AppSettings> => {
      const prevSettings = storageManager.getSettings();
      const targetMixedPort = newSettings.mixedPort ?? prevSettings.mixedPort ?? 7890;
      const targetApiPort = newSettings.apiPort ?? prevSettings.apiPort ?? 9097;

      if (newSettings.mixedPort !== undefined && !isValidPort(newSettings.mixedPort)) {
        throw new Error(`系统混合代理端口非法 (必须为 1-65535 整数): ${newSettings.mixedPort}`);
      }
      if (newSettings.apiPort !== undefined && !isValidPort(newSettings.apiPort)) {
        throw new Error(`控制端口非法 (必须为 1-65535 整数): ${newSettings.apiPort}`);
      }
      if (targetMixedPort === targetApiPort) {
        throw new Error(`端口冲突: 混合代理端口与控制端口不能相同 (${targetMixedPort})`);
      }

      // 安全守卫（对标 Clash Verge 服务模式）：服务模式就绪或管理员身份均可直接开启 TUN，否则安全拦截
      if (newSettings.tunMode === true) {
        const prereq = await checkTunPrerequisites();
        if (!prereq.canEnableTun) {
          console.warn('[IPC] 虚拟网卡服务未就绪且非管理员权限，已拦截 TUN 激活指令，等待用户安装服务');
          newSettings.tunMode = false;
        } else {
          const driverRes = await mihomoManager.ensureWintunReady();
          if (!driverRes.ok) {
            console.warn('[IPC] wintun.dll 驱动未就绪，已拦截 TUN 激活:', driverRes.error);
            newSettings.tunMode = false;
          }
        }
      }

      if (app.isPackaged && 'githubRepo' in newSettings) {
        delete (newSettings as any).githubRepo;
      }
      const updated = storageManager.saveSettings(newSettings);
      options?.onSettingsUpdated?.(newSettings);

      // 开机自启动与静默启动系统级联动生效
      if (
        typeof newSettings.autoLaunch === 'boolean' ||
        typeof newSettings.silentStart === 'boolean'
      ) {
        try {
          app.setLoginItemSettings({
            openAtLogin: Boolean(updated.autoLaunch),
            openAsHidden: Boolean(updated.silentStart),
            path: process.execPath,
            args: updated.silentStart ? ['--hidden'] : [],
          });
          console.log(
            `[IPC] 开机自启配置已生效: openAtLogin=${updated.autoLaunch}, openAsHidden=${updated.silentStart}`
          );
        } catch (err: any) {
          console.warn('[IPC] 设置开机自启警告:', err.message);
        }
      }

      // 系统代理联动（完整携带 bypassList 与真实端口，修复自定义端口无法关闭代理和白名单不生效问题）
      const activePort = mihomoManager.getStatus().mixedPort || prevSettings.mixedPort || 7890;
      if (typeof newSettings.systemProxy === 'boolean') {
        if (newSettings.systemProxy) {
          if (mihomoManager.getStatus().running) {
            await systemProxyManager.enableProxy(
              mihomoManager.getStatus().mixedPort || updated.mixedPort || 7890,
              updated.bypassList,
              mihomoManager.getPid()
            );
          } else {
            console.log('[IPC] 核心未运行，系统代理设置已保存但暂不调用 enableProxy');
          }
        } else {
          await systemProxyManager.restoreProxy(activePort);
        }
      } else if (
        newSettings.bypassList !== undefined &&
        !newSettings.mixedPort &&
        updated.systemProxy
      ) {
        if (mihomoManager.getStatus().running) {
          await systemProxyManager.enableProxy(
            mihomoManager.getStatus().mixedPort || updated.mixedPort || 7890,
            updated.bypassList,
            mihomoManager.getPid()
          );
        }
      }

      // 代理模式切换
      if (newSettings.mode && newSettings.mode !== prevSettings.mode) {
        await mihomoManager.setMode(newSettings.mode);
      }

      // TUN 模式变更、TUN 协议栈变更、网络端口、控制端口、DNS、日志级别、分流规则、允许局域网或链式代理变更时，若核心正在运行，平滑重载/重启核心以应用配置
      const tunChanged =
        typeof newSettings.tunMode === 'boolean' && newSettings.tunMode !== prevSettings.tunMode;
      const tunStackChanged =
        Boolean(newSettings.tunStack) && newSettings.tunStack !== prevSettings.tunStack;
      const portChanged =
        Boolean(newSettings.mixedPort) && newSettings.mixedPort !== prevSettings.mixedPort;
      const apiPortChanged =
        Boolean(newSettings.apiPort) && newSettings.apiPort !== prevSettings.apiPort;
      const dnsChanged =
        newSettings.dns !== undefined && JSON.stringify(newSettings.dns) !== JSON.stringify(prevSettings.dns);
      const logLevelChanged =
        Boolean(newSettings.logLevel) && newSettings.logLevel !== prevSettings.logLevel;
      const customRulesChanged =
        Array.isArray(newSettings.customRules) &&
        JSON.stringify(newSettings.customRules) !== JSON.stringify(prevSettings.customRules);
      const lanChanged =
        typeof newSettings.allowLan === 'boolean' && newSettings.allowLan !== prevSettings.allowLan;
      const chainsChanged =
        Array.isArray(newSettings.proxyChains) &&
        JSON.stringify(newSettings.proxyChains) !== JSON.stringify(prevSettings.proxyChains);

      const needHardRestart = portChanged || apiPortChanged;
      const shouldUpdateCore =
        tunChanged ||
        tunStackChanged ||
        portChanged ||
        apiPortChanged ||
        dnsChanged ||
        logLevelChanged ||
        customRulesChanged ||
        lanChanged ||
        chainsChanged;

      if (shouldUpdateCore && mihomoManager.getStatus().running) {
        const nodes = storageManager.getNodes();
        const state = storageManager.getState();
        const selectedNodeName =
          state.selectedNodeName ||
          (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);

        if (needHardRestart) {
          console.log('[IPC] 检测到核心监听端口变更，执行安全重启核心...');
          const restartRes = await mihomoManager.restart({
            nodes,
            settings: updated,
            selectedNodeName,
          });
          if (!restartRes.success) {
            storageManager.saveSettings(prevSettings);
            throw new Error(restartRes.error || '核心重启应用新配置失败，已回滚设置');
          }
        } else {
          // 核心与 TUN 彻底解耦：开/关 TUN、DNS 或规则变更，使用平滑热重载，严禁杀死核心
          console.log('[IPC] 检测到 TUN/DNS/规则配置变更，正在平滑热重载核心配置 (核心持续运行，系统代理无缝保持)...');
          const reloadRes = await mihomoManager.hotReloadOrRestart({
            nodes,
            settings: updated,
            selectedNodeName,
          });
          if (!reloadRes.success) {
            storageManager.saveSettings(prevSettings);
            throw new Error(reloadRes.error || '配置热重载校验失败，已回滚设置');
          }
        }
      }

      return updated;
    }
  );

  ipcMain.handle(IPC_CHANNELS.SYS_CHECK_ADMIN, async () => {
    return await checkTunPrerequisites();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_RESTART_AS_ADMIN, async () => {
    return await restartAsAdmin();
  });

  // 虚拟网卡特权服务模式 (Service Mode) 与 Wintun 驱动管理
  ipcMain.handle(IPC_CHANNELS.SYS_TUN_SERVICE_STATUS, async () => {
    return await tunServiceManager.getServiceStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_TUN_SERVICE_INSTALL, async () => {
    const res = await tunServiceManager.installService(isCurrentProcessAdmin(), mihomoManager.getMihomoExePath());
    if (res.success && mihomoManager.getStatus().running) {
      // 服务安装完成后若核心正在运行，平滑迁移到服务模式，使后续开关 TUN 零重启秒开
      const nodes = storageManager.getNodes();
      const state = storageManager.getState();
      const selectedNodeName =
        state.selectedNodeName ||
        (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);
      await mihomoManager.restart({
        nodes,
        settings: storageManager.getSettings(),
        selectedNodeName,
      });
    }
    return res;
  });

  ipcMain.handle(IPC_CHANNELS.SYS_TUN_SERVICE_UNINSTALL, async () => {
    const settings = storageManager.getSettings();
    if (settings.tunMode && !isCurrentProcessAdmin()) {
      storageManager.saveSettings({ tunMode: false });
      options?.onSettingsUpdated?.({ tunMode: false });
    }
    const wasRunning = mihomoManager.getStatus().running;
    if (wasRunning) {
      await mihomoManager.stop();
    }
    const res = await tunServiceManager.uninstallService(isCurrentProcessAdmin());
    if (wasRunning) {
      const nodes = storageManager.getNodes();
      const state = storageManager.getState();
      const selectedNodeName =
        state.selectedNodeName ||
        (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);
      await mihomoManager.start({
        nodes,
        settings: storageManager.getSettings(),
        selectedNodeName,
      });
    }
    return res;
  });

  ipcMain.handle(IPC_CHANNELS.SYS_WINTUN_STATUS, () => {
    return mihomoManager.getWintunStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_WINTUN_DOWNLOAD, async () => {
    return await mihomoManager.ensureWintunReady();
  });

  ipcMain.handle(
    IPC_CHANNELS.SYS_FLUSH_DNS,
    async (): Promise<{ system: boolean; core: boolean }> => {
      let systemOk = false;
      let coreOk = false;

      // 1. 清理 Windows 系统 DNS 缓存，严格校验错误码
      try {
        if (process.platform === 'win32') {
          const { execFile } = await import('child_process');
          systemOk = await new Promise<boolean>((resolve) => {
            execFile('ipconfig.exe', ['/flushdns'], { windowsHide: true, timeout: 3000 }, (error) => {
              if (error) {
                console.error('[DNS Flush] ipconfig /flushdns 执行失败:', error);
                resolve(false);
              } else {
                resolve(true);
              }
            });
          });
        }
      } catch (err: any) {
        console.error('[DNS Flush] 系统缓存清理异常:', err);
        systemOk = false;
      }

      // 2. 清理代理内核（Mihomo）内部 FakeIP / DNS 解析缓存
      if (mihomoManager.getStatus().running) {
        try {
          const apiClient = mihomoManager.getApiClient();
          coreOk = await apiClient.flushDns();
        } catch (err: any) {
          console.error('[DNS Flush] 代理核心缓存清理异常:', err);
          coreOk = false;
        }
      }

      return { system: systemOk, core: coreOk };
    }
  );

  ipcMain.handle(IPC_CHANNELS.SYS_GET_LAN_IP, async (): Promise<string> => {
    try {
      const os = await import('os');
      const interfaces = os.networkInterfaces();
      const candidates: string[] = [];

      for (const name of Object.keys(interfaces)) {
        const netList = interfaces[name];
        if (!netList) continue;
        for (const net of netList) {
          if (net.family === 'IPv4' && !net.internal) {
            if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) {
              return net.address;
            }
            if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) {
              return net.address;
            }
            candidates.push(net.address);
          }
        }
      }
      return candidates[0] || '127.0.0.1';
    } catch {
      return '127.0.0.1';
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SYS_GET_MEMORY,
    async (): Promise<{ appBytes: number; coreBytes: number; totalBytes: number }> => {
      let appBytes = 0;
      try {
        const metrics = app.getAppMetrics();
        for (const m of metrics) {
          appBytes += (m.memory?.workingSetSize || 0) * 1024;
        }
      } catch {
        appBytes = process.memoryUsage().rss;
      }

      if (appBytes <= 0) {
        appBytes = process.memoryUsage().rss;
      }

      let coreBytes = 0;
      if (mihomoManager.getStatus().running) {
        try {
          coreBytes = await mihomoManager.getApiClient().getMemory();
        } catch {
          coreBytes = 0;
        }
      }

      return {
        appBytes,
        coreBytes,
        totalBytes: appBytes + coreBytes,
      };
    }
  );
  // 日志管理
  ipcMain.handle(IPC_CHANNELS.CORE_GET_LOGS, () => {
    return mihomoManager.getLogs();
  });

  ipcMain.handle(IPC_CHANNELS.CORE_CLEAR_LOGS, () => {
    mihomoManager.clearLogs();
    return true;
  });

  // Windows UWP 回环豁免
  ipcMain.handle(IPC_CHANNELS.SYS_GET_UWP_APPS, async () => {
    return await uwpToolService.getUwpApps();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_SAVE_UWP_APPS, async (_, sids: string[]) => {
    return await uwpToolService.saveExemptions(sids);
  });

  ipcMain.handle(IPC_CHANNELS.SYS_EXEMPT_ALL_UWP, async () => {
    return await uwpToolService.exemptAll();
  });

  ipcMain.handle(IPC_CHANNELS.SYS_CLEAR_ALL_UWP, async () => {
    return await uwpToolService.clearAll();
  });

  // 软件更新管理 (收拢权限至主进程，强校验域名白名单与完整性，杜绝任意执行漏洞)
  ipcMain.handle(
    IPC_CHANNELS.APP_CHECK_UPDATE,
    async (_, options?: { repo?: string; mockUpdate?: boolean; mockVersion?: string }) => {
      const currentSettings = storageManager.getSettings();
      // 生产环境安全兜底，始终以本地配置或默认官方仓库为准
      const safeRepo = options?.mockUpdate ? options.repo : currentSettings.githubRepo || 'hu-1029/NexLink';
      return await updateService.checkUpdate({
        ...options,
        repo: safeRepo,
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.APP_DOWNLOAD_UPDATE,
    async () => {
      return await updateService.downloadUpdate(undefined, (progress) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_STATUS, progress);
        }
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.APP_CANCEL_UPDATE, () => {
    return updateService.cancelDownload();
  });

  ipcMain.handle(IPC_CHANNELS.APP_INSTALL_UPDATE, async () => {
    // 强制只安装主进程自身通过完整性校验的文件，忽略外界传入的任意路径
    return await updateService.installUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_URL, async (_, url: string) => {
    return await updateService.openUrl(url);
  });
}
