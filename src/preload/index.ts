import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-events';
import type {
  AppInfo,
  AppSettings,
  CoreStatus,
  LogItem,
  ProfileItem,
  ProxyNode,
  SystemProxyConfig,
  TrafficStats,
  TunCheckStatus,
  TunServiceStatus,
  UwpAppItem,
  UpdateInfo,
  UpdateDownloadProgress,
  WintunDriverStatus,
} from '../shared/types';
import type { AppPersistedData } from '../main/storage/store';

export const nexlinkAPI = {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  },

  // 应用信息
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO),

  // 核心管理
  core: {
    getStatus: (): Promise<CoreStatus> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_STATUS),
    start: (payload?: {
      nodes?: ProxyNode[];
      settings?: AppSettings;
      selectedNodeName?: string;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_START, payload),
    stop: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.CORE_STOP),
    restart: (payload?: {
      nodes?: ProxyNode[];
      settings?: AppSettings;
      selectedNodeName?: string;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_RESTART, payload),
    setMode: (mode: 'rule' | 'global' | 'direct'): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_SET_MODE, mode),
    getRuntimeConfig: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_CONFIG),
    getCoreVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_VERSION),
    getCoreState: (): Promise<{
      currentVersion: string;
      isUsingCustomCore: boolean;
      hasBackup: boolean;
      backupVersion?: string;
      bundledVersion: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_STATE),
    updateCore: (options?: { force?: boolean }): Promise<{
      success: boolean;
      updated: boolean;
      currentVersion: string;
      latestVersion?: string;
      sha256?: string;
      serviceSynced?: boolean;
      syncError?: string;
      message: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.CORE_UPDATE, options),
    rollbackCore: (): Promise<{
      success: boolean;
      updated: boolean;
      currentVersion: string;
      message: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.CORE_ROLLBACK),
    updateGeoDatabases: (): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_UPDATE_GEO),
    onUpdateProgress: (callback: (msg: string) => void) => {
      const listener = (_: any, msg: string) => callback(msg);
      ipcRenderer.on(IPC_CHANNELS.CORE_UPDATE_PROGRESS, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CORE_UPDATE_PROGRESS, listener);
      };
    },
    getProxies: (): Promise<any> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_PROXIES),
    selectNode: (groupName: string, nodeName: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_SELECT_NODE, groupName, nodeName),
    testDelay: (nodeName: string, url?: string, timeout?: number): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_TEST_DELAY, nodeName, url, timeout),
    testNodeDelay: (
      node: { name: string; server: string; port: number; type?: string },
      method?: 'TCP' | 'ICMP' | 'CONNECT',
      timeout?: number
    ): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_TEST_NODE_DELAY, node, method, timeout),
    getConnections: (): Promise<any> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_CONNECTIONS),
    getRules: (): Promise<{ rules: any[] }> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_RULES),
    closeConnection: (id?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CORE_CLOSE_CONNECTION, id),
    getLogs: (): Promise<LogItem[]> => ipcRenderer.invoke(IPC_CHANNELS.CORE_GET_LOGS),
    clearLogs: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.CORE_CLEAR_LOGS),
    onTraffic: (callback: (data: TrafficStats) => void) => {
      const listener = (_: any, data: TrafficStats) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CORE_TRAFFIC_DATA, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CORE_TRAFFIC_DATA, listener);
      };
    },
    onStatus: (callback: (data: CoreStatus) => void) => {
      const listener = (_: any, data: CoreStatus) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CORE_GET_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CORE_GET_STATUS, listener);
      };
    },
    onLog: (callback: (data: LogItem) => void) => {
      const listener = (_: any, data: LogItem) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CORE_LOG_DATA, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CORE_LOG_DATA, listener);
      };
    },
  },

  // 订阅管理接口
  subscriptions: {
    update: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SUB_UPDATE, id),
    updateAll: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SUB_UPDATE_ALL),
    add: (sub: any): Promise<ProfileItem> => ipcRenderer.invoke(IPC_CHANNELS.SUB_ADD, sub),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SUB_DELETE, id),
    toggle: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SUB_TOGGLE, id),
  },

  // 持久化存储接口
  storage: {
    loadAll: (): Promise<AppPersistedData> => ipcRenderer.invoke(IPC_CHANNELS.DATA_LOAD_ALL),
    saveNodes: (nodes: ProxyNode[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.DATA_SAVE_NODES, nodes),
    saveState: (state: any): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.DATA_SAVE_STATE, state),
    onSync: (callback: (data: AppPersistedData) => void) => {
      const listener = (_: any, data: AppPersistedData) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.DATA_SYNC, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.DATA_SYNC, listener);
      };
    },
  },

  // 系统与设置
  system: {
    getProxy: (): Promise<SystemProxyConfig> => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_PROXY),
    setProxy: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_PROXY, enabled),
    getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_SETTINGS),
    updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_UPDATE_SETTINGS, settings),
    checkAdmin: (): Promise<TunCheckStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_CHECK_ADMIN),
    restartAsAdmin: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_RESTART_AS_ADMIN),
    getTunServiceStatus: (): Promise<TunServiceStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_TUN_SERVICE_STATUS),
    installTunService: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_TUN_SERVICE_INSTALL),
    uninstallTunService: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_TUN_SERVICE_UNINSTALL),
    getWintunStatus: (): Promise<WintunDriverStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_WINTUN_STATUS),
    downloadWintun: (): Promise<{ ok: boolean; dllPath: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_WINTUN_DOWNLOAD),
    openConfigDir: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_DIR),
    flushDns: (): Promise<{ system: boolean; core: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_FLUSH_DNS),
    getLanIp: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_LAN_IP),
    getMemory: (): Promise<{ appBytes: number; coreBytes: number; totalBytes: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_MEMORY),
    getUwpApps: (): Promise<UwpAppItem[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_UWP_APPS),
    saveUwpApps: (sids: string[]): Promise<{ success: boolean; count: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_SAVE_UWP_APPS, sids),
    exemptAllUwp: (): Promise<{ success: boolean; count: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_EXEMPT_ALL_UWP),
    clearAllUwp: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYS_CLEAR_ALL_UWP),
  },

  // 软件更新管理
  updater: {
    checkUpdate: (options?: {
      repo?: string;
      mockUpdate?: boolean;
      mockVersion?: string;
    }): Promise<UpdateInfo> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATE, options),
    downloadUpdate: (downloadUrl?: string): Promise<{ success: boolean; filePath?: string; actualSha256?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, downloadUrl),
    cancelDownload: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CANCEL_UPDATE),
    installUpdate: (_filePath?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),
    openUrl: (url: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_URL, url),
    onUpdateStatus: (callback: (status: UpdateDownloadProgress) => void) => {
      const listener = (_: any, data: UpdateDownloadProgress) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_STATUS, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('nexlinkAPI', nexlinkAPI);

export type NexlinkAPI = typeof nexlinkAPI;
