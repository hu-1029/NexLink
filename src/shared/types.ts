/**
 * NexLink 全局共享核心数据类型定义 (Unified Proxy & Subscription Schema)
 */

export type ThemeMode = 'system' | 'dark' | 'light';

export type ProtocolType =
  | 'vless'
  | 'vmess'
  | 'ss'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'http'
  | 'socks5';

export interface VlessConfig {
  uuid: string;
  flow?: string;
  encryption?: string;
  network?: 'tcp' | 'ws' | 'grpc' | 'h2' | 'xhttp' | 'splithttp';
  security?: 'none' | 'tls' | 'reality';
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  skipCertVerify?: boolean;
  reality?: {
    publicKey: string;
    shortId?: string;
    spiderX?: string;
  };
  ws?: {
    path?: string;
    headers?: Record<string, string>;
  };
  grpc?: {
    serviceName?: string;
  };
}

export interface VmessConfig {
  uuid: string;
  alterId?: number;
  cipher?: string;
  network?: 'tcp' | 'ws' | 'grpc' | 'h2' | 'xhttp' | 'splithttp';
  security?: 'none' | 'tls';
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  ws?: {
    path?: string;
    headers?: Record<string, string>;
  };
  grpc?: {
    serviceName?: string;
  };
}

export interface ShadowsocksConfig {
  cipher: string;
  password: string;
  plugin?: string;
  pluginOpts?: string;
}

export interface TrojanConfig {
  password: string;
  sni?: string;
  alpn?: string[];
  network?: 'tcp' | 'ws' | 'grpc';
  skipCertVerify?: boolean;
  fingerprint?: string;
  ws?: {
    path?: string;
    headers?: Record<string, string>;
  };
  grpc?: {
    serviceName?: string;
  };
}

export interface Hysteria2Config {
  auth: string;
  sni?: string;
  skipCertVerify?: boolean;
  obfs?: string;
  obfsPassword?: string;
  up?: number;
  down?: number;
  ports?: string;
}

export interface TuicConfig {
  uuid: string;
  password?: string;
  congestionController?: string;
  udpRelayMode?: string;
  sni?: string;
  alpn?: string[];
  skipCertVerify?: boolean;
}

export interface WireGuardConfig {
  privateKey: string;
  publicKey?: string;
  ip: string;
  ipv6?: string;
  presharedKey?: string;
  reserved?: number[];
  mtu?: number;
  peers?: Array<{
    publicKey: string;
    endpoint: string;
    allowedIps?: string[];
  }>;
}

export type ProtocolConfig =
  | { type: 'vless'; config: VlessConfig }
  | { type: 'vmess'; config: VmessConfig }
  | { type: 'ss'; config: ShadowsocksConfig }
  | { type: 'trojan'; config: TrojanConfig }
  | { type: 'hysteria2'; config: Hysteria2Config }
  | { type: 'tuic'; config: TuicConfig }
  | { type: 'wireguard'; config: WireGuardConfig }
  | { type: 'http' | 'socks5'; config: Record<string, any> };

export interface ProxyNode {
  id: string;
  name: string;
  type: ProtocolType;
  server: string;
  port: number;
  delay?: number; // 未测速时必须为 undefined
  isAlive?: boolean;
  country?: string;
  countryCode?: string;
  group?: string;
  subscriptionId?: string; // 归属订阅 ID
  protocolConfig?: ProtocolConfig['config'];
  rawUri?: string;
  rawConfig?: Record<string, any>;
}

export interface SubscriptionUserInfo {
  upload?: number; // 字节
  download?: number; // 字节
  total?: number; // 字节
  expire?: number; // 时间戳 (秒)
  expireDate?: string; // 格式化到期日期 (如 2026-12-31)
}

export interface ProfileItem {
  id: string;
  name: string;
  type: 'remote' | 'local';
  url?: string;
  filePath?: string;
  rawContent?: string;
  nodeCount: number;
  updatedAt: string;
  lastUpdateAt?: number; // 绝对毫秒时间戳 (Date.now())，彻底消除时区解析差导致的虚假超时
  lastCheckAt?: number;  // 最后一次拉取尝试时间戳 (含失败退避)
  status: 'ok' | 'updating' | 'error';
  errorMessage?: string;
  autoUpdateInterval?: number; // 分钟
  enabled?: boolean; // 是否启用聚合
  active?: boolean;  // 是否为当前活动订阅
  userInfo?: SubscriptionUserInfo; // 订阅流量与到期信息
  nodes?: ProxyNode[]; // 该订阅抓取到的原始节点列表
}

export interface ParseError {
  line?: number;
  raw: string;
  error: string;
}

export interface ParseResult {
  success: boolean;
  format: 'uri-list' | 'base64-blob' | 'clash-yaml' | 'mihomo-yaml' | 'v2ray-json' | 'sing-box-json' | 'unknown';
  nodes: ProxyNode[];
  errors: ParseError[];
  totalParsed: number;
}

export interface SystemProxyConfig {
  enabled: boolean;
  server: string;
  bypass: string;
}

export interface CoreStatus {
  running: boolean;
  version: string;
  mixedPort: number;
  apiPort: number;
  uptime: number;
  mode: 'rule' | 'global' | 'direct';
  coreRunMode?: 'service' | 'sidecar';
  tunActive?: boolean;
}

export interface TunServiceStatus {
  installed: boolean;
  running: boolean;
  reachable: boolean;
  version?: string;
  coreRunning?: boolean;
  corePid?: number;
  error?: string;
}

export interface WintunDriverStatus {
  ready: boolean;
  dllPath: string;
  size: number;
  arch: string;
}

export interface TunCheckStatus {
  isAdmin: boolean;
  serviceInstalled: boolean;
  serviceRunning: boolean;
  serviceReady: boolean;
  mode: 'service' | 'admin' | 'none';
  canEnableTun: boolean;
  message?: string;
}

export interface TrafficStats {
  up: number;         // 字节/秒
  down: number;       // 字节/秒
  upTotal: number;    // 累计上传字节
  downTotal: number;  // 累计下载字节
}

export interface ProxyChain {
  id: string;
  name: string;
  nodeIds: string[]; // 节点 ID 序列，顺序为：[前置入口节点, ..., 落地出口节点]
  enabled: boolean;
  createdAt?: number;
}

export interface AppSettings {
  theme: ThemeMode;
  systemProxy: boolean;
  tunMode: boolean;
  tunStack?: 'mixed' | 'gvisor' | 'system';
  autoLaunch: boolean;
  silentStart: boolean;
  autoUpdate?: boolean; // 后台自动检测并下载更新，完成后弹窗提示安装
  autoCheckUpdate?: boolean; // 兼容旧开关：启动与运行时是否自动检查更新
  lastCheckUpdateAt?: number; // 上次成功检查更新时间戳
  githubRepo?: string; // 绑定的 GitHub 仓库全称 (如 owner/repo)
  mixedPort: number;
  apiPort: number;
  allowLan: boolean;
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  logLevelMigrated?: boolean;
  mode?: 'rule' | 'global' | 'direct';
  dns?: {
    enable?: boolean;
    nameservers?: string[];
    fallbacks?: string[];
    enhancedMode?: 'fake-ip' | 'redir-host';
  };
  customRules?: string[];
  proxyChains?: ProxyChain[];
  bypassList?: string;
  customBg?: string;
  customFg?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
}


export interface LogItem {
  id: string;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface UwpAppItem {
  sid: string;
  displayName: string;
  packageFamilyName: string;
  isExempt: boolean;
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  assetName?: string;
  assetSize?: number;
  expectedSha256?: string;
  actualSha256?: string;
  htmlUrl?: string;
  isPrerelease?: boolean;
  error?: string;
}

export interface UpdateDownloadProgress {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  percent?: number;
  transferred?: number;
  total?: number;
  speed?: number; // bytes/s
  savePath?: string;
  error?: string;
  updateInfo?: UpdateInfo;
}
