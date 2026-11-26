/**
 * NexLink IPC 通信事件与通道常量定义
 */

export const IPC_CHANNELS = {
  // 窗口操作
  WINDOW_MINIMIZE: 'nexlink:window:minimize',
  WINDOW_MAXIMIZE: 'nexlink:window:maximize',
  WINDOW_CLOSE: 'nexlink:window:close',
  WINDOW_IS_MAXIMIZED: 'nexlink:window:is-maximized',

  // 应用基础信息
  APP_GET_INFO: 'nexlink:app:get-info',
  APP_OPEN_DIR: 'nexlink:app:open-dir',

  // 核心控制
  CORE_GET_STATUS: 'nexlink:core:get-status',
  CORE_START: 'nexlink:core:start',
  CORE_STOP: 'nexlink:core:stop',
  CORE_RESTART: 'nexlink:core:restart',
  CORE_SET_MODE: 'nexlink:core:set-mode',
  CORE_GET_CONFIG: 'nexlink:core:get-config',
  CORE_GET_VERSION: 'nexlink:core:get-version',
  CORE_GET_STATE: 'nexlink:core:get-state',
  CORE_UPDATE: 'nexlink:core:update',
  CORE_ROLLBACK: 'nexlink:core:rollback',
  CORE_UPDATE_GEO: 'nexlink:core:update-geo',
  CORE_UPDATE_PROGRESS: 'nexlink:core:update-progress',

  // 节点与代理组 API 交互
  CORE_GET_PROXIES: 'nexlink:core:get-proxies',
  CORE_SELECT_NODE: 'nexlink:core:select-node',
  CORE_TEST_DELAY: 'nexlink:core:test-delay',
  CORE_TEST_NODE_DELAY: 'nexlink:core:test-node-delay',
  CORE_GET_CONNECTIONS: 'nexlink:core:get-connections',
  CORE_CLOSE_CONNECTION: 'nexlink:core:close-connection',
  CORE_GET_RULES: 'nexlink:core:get-rules',

  // 核心日志与调试
  CORE_GET_LOGS: 'nexlink:core:get-logs',
  CORE_CLEAR_LOGS: 'nexlink:core:clear-logs',

  // 订阅管理联动
  SUB_UPDATE: 'nexlink:sub:update',
  SUB_UPDATE_ALL: 'nexlink:sub:update-all',
  SUB_ADD: 'nexlink:sub:add',
  SUB_DELETE: 'nexlink:sub:delete',
  SUB_TOGGLE: 'nexlink:sub:toggle',

  // 持久化数据通信
  DATA_LOAD_ALL: 'nexlink:data:load-all',
  DATA_SAVE_NODES: 'nexlink:data:save-nodes',
  DATA_SAVE_STATE: 'nexlink:data:save-state',
  DATA_SYNC: 'nexlink:data:sync',

  // 流量与状态推送 (Main -> Renderer)
  CORE_TRAFFIC_DATA: 'nexlink:core:traffic-data',
  CORE_LOG_DATA: 'nexlink:core:log-data',

  // 系统网络设置与权限
  SYS_GET_PROXY: 'nexlink:sys:get-proxy',
  SYS_SET_PROXY: 'nexlink:sys:set-proxy',
  SYS_GET_SETTINGS: 'nexlink:sys:get-settings',
  SYS_UPDATE_SETTINGS: 'nexlink:sys:update-settings',
  SYS_CHECK_ADMIN: 'nexlink:sys:check-admin',
  SYS_RESTART_AS_ADMIN: 'nexlink:sys:restart-as-admin',
  SYS_TUN_SERVICE_STATUS: 'nexlink:sys:tun-service-status',
  SYS_TUN_SERVICE_INSTALL: 'nexlink:sys:tun-service-install',
  SYS_TUN_SERVICE_UNINSTALL: 'nexlink:sys:tun-service-uninstall',
  SYS_WINTUN_STATUS: 'nexlink:sys:wintun-status',
  SYS_WINTUN_DOWNLOAD: 'nexlink:sys:wintun-download',
  SYS_FLUSH_DNS: 'nexlink:sys:flush-dns',
  SYS_GET_LAN_IP: 'nexlink:sys:get-lan-ip',
  SYS_GET_MEMORY: 'nexlink:sys:get-memory',

  // Windows UWP 回环豁免
  SYS_GET_UWP_APPS: 'nexlink:sys:get-uwp-apps',
  SYS_SAVE_UWP_APPS: 'nexlink:sys:save-uwp-apps',
  SYS_EXEMPT_ALL_UWP: 'nexlink:sys:exempt-all-uwp',
  SYS_CLEAR_ALL_UWP: 'nexlink:sys:clear-all-uwp',

  // 软件更新管理 (Check & Auto Update)
  APP_CHECK_UPDATE: 'nexlink:app:check-update',
  APP_DOWNLOAD_UPDATE: 'nexlink:app:download-update',
  APP_INSTALL_UPDATE: 'nexlink:app:install-update',
  APP_CANCEL_UPDATE: 'nexlink:app:cancel-update',
  APP_OPEN_URL: 'nexlink:app:open-url',
  APP_UPDATE_STATUS: 'nexlink:app:update-status',
} as const;

export type IpcChannelKey = keyof typeof IPC_CHANNELS;
