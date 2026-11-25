/**
 * NexLink 本地持久化存储管理器 (Atomic File-Based JSON Store)
 * 保证订阅列表、节点库、核心运行设置和选中状态在软件重启后 100% 完整保留与恢复
 */

import fs from 'fs';
import path from 'path';
import type { AppSettings, ProfileItem, ProxyNode } from '../../shared/types';

export interface AppPersistedState {
  activeNodeId?: string;
  selectedNodeName?: string;
  activeSubscriptionId?: string;
  selectedGroupId?: string;
}

export interface AppPersistedData {
  settings: AppSettings;
  subscriptions: ProfileItem[];
  nodes: ProxyNode[];
  state: AppPersistedState;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  systemProxy: false,
  tunMode: false,
  tunStack: 'mixed',
  autoLaunch: false,
  silentStart: false,
  autoUpdate: true,
  autoCheckUpdate: true,
  lastCheckUpdateAt: 0,
  mixedPort: 7890,
  apiPort: 9097,
  allowLan: false,
  logLevel: 'info',
  logLevelMigrated: false,
  mode: 'rule',
  dns: {
    nameservers: ['223.5.5.5', '119.29.29.29', 'https://dns.alidns.com/dns-query'],
    fallbacks: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
    enhancedMode: 'fake-ip',
  },
  customRules: [],
};

export class StorageManager {
  private baseDir: string = '';
  private memoryCache: AppPersistedData = {
    settings: { ...DEFAULT_SETTINGS },
    subscriptions: [],
    nodes: [],
    state: {},
  };

  constructor(storageDir?: string) {
    if (storageDir) {
      this.initialize(storageDir);
    }
  }

  public initialize(storageDir: string): void {
    this.baseDir = storageDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.loadAll();
  }

  private getFilePath(filename: string): string {
    return path.join(this.baseDir, filename);
  }

  private safeReadJSON<T>(filename: string, fallback: T): T {
    const filePath = this.getFilePath(filename);
    const bakPath = `${filePath}.bak`;

    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(bakPath)) {
        try {
          const bakContent = fs.readFileSync(bakPath, 'utf8');
          if (bakContent.trim()) {
            console.log(`[Storage] 原文件 ${filename} 不存在，成功从备份恢复`);
            return JSON.parse(bakContent) as T;
          }
        } catch (_e) {
          void _e;
        }
      }
      return fallback;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.trim()) {
        throw new Error('文件内容为空（可能因断电截断为 0 字节）');
      }
      return JSON.parse(content) as T;
    } catch (err: any) {
      console.error(`[Storage CRITICAL] 文件 ${filename} 发生解析损坏! 错误:`, err.message);

      // 1. 紧急保存损坏文件副本，绝不允许悄悄覆盖导致用户资产永久灭失
      try {
        const corruptPath = `${filePath}.corrupted_${Date.now()}`;
        fs.copyFileSync(filePath, corruptPath);
        console.warn(`[Storage] 已紧急留存损坏现场至: ${corruptPath}`);
      } catch (_e) {
        void _e;
      }

      // 2. 尝试从上一版本完好的 .bak 备份中救回数据
      if (fs.existsSync(bakPath)) {
        try {
          const bakContent = fs.readFileSync(bakPath, 'utf8');
          if (bakContent.trim()) {
            const recovered = JSON.parse(bakContent) as T;
            console.log(`[Storage] 成功从 .bak 备份中救回 ${filename} 的历史有效数据！`);
            return recovered;
          }
        } catch (bakErr: any) {
          console.error(`[Storage] 读取备份文件 ${bakPath} 亦失败:`, bakErr.message);
        }
      }

      return fallback;
    }
  }

  private atomicWriteJSON(filename: string, data: any): void {
    const filePath = this.getFilePath(filename);
    const uniq = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = `${filePath}.tmp_${uniq}`;
    const bakPath = `${filePath}.bak`;
    const bakTmpPath = `${bakPath}.tmp_${uniq}`;
    try {
      const jsonStr = JSON.stringify(data, null, 2);
      const fd = fs.openSync(tempPath, 'w');
      try {
        fs.writeSync(fd, jsonStr, 0, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // 先将上一版完好主文件原子留存到 .bak
      if (fs.existsSync(filePath)) {
        try {
          const prevStat = fs.statSync(filePath);
          if (prevStat.size > 0) {
            fs.copyFileSync(filePath, bakTmpPath);
            fs.renameSync(bakTmpPath, bakPath);
          }
        } catch (_e) {
          void _e;
          try { if (fs.existsSync(bakTmpPath)) fs.unlinkSync(bakTmpPath); } catch { /* ignore */ }
        }
      }

      try {
        fs.renameSync(tempPath, filePath);
      } catch (_renameErr) {
        void _renameErr;
        fs.copyFileSync(tempPath, filePath);
        try {
          fs.unlinkSync(tempPath);
        } catch (_unlinkErr) {
          void _unlinkErr;
        }
      }
    } catch (err: any) {
      console.error(`[Storage] 原子写入 ${filename} 异常:`, err.message);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (cleanErr: any) {
        console.warn(`[Storage] 清理临时文件失败:`, cleanErr.message);
      }
    }
  }

  /**
   * 加载所有持久化配置
   */
  public loadAll(): AppPersistedData {
    const settings = this.safeReadJSON<AppSettings>('settings.json', DEFAULT_SETTINGS);
    const subscriptions = this.safeReadJSON<ProfileItem[]>('subscriptions.json', []);
    const nodes = this.safeReadJSON<ProxyNode[]>('nodes.json', []);
    const state = this.safeReadJSON<AppPersistedState>('state.json', {});

    const mergedSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      dns: {
        ...(DEFAULT_SETTINGS.dns || {}),
        ...(settings.dns || {}),
      } as any,
    };
    // 恢复正常实时连接与分流日志显示：若此前旧版本将日志级别自动迁移为 warning，执行一次性平滑恢复为 info
    // 恢复后将 logLevelMigrated 置为 false，后续若用户主动手动设为 warning 不再覆盖
    if (settings.logLevelMigrated && mergedSettings.logLevel === 'warning') {
      mergedSettings.logLevel = 'info';
      mergedSettings.logLevelMigrated = false;
      this.atomicWriteJSON('settings.json', mergedSettings);
    }

    this.memoryCache = {
      settings: mergedSettings,
      subscriptions,
      nodes,
      state,
    };

    return this.memoryCache;
  }

  public getData(): AppPersistedData {
    return this.memoryCache;
  }

  public getSettings(): AppSettings {
    return this.memoryCache.settings;
  }

  public saveSettings(newSettings: Partial<AppSettings>): AppSettings {
    this.memoryCache.settings = {
      ...this.memoryCache.settings,
      ...newSettings,
      ...(newSettings.dns
        ? { dns: { ...(this.memoryCache.settings.dns || {}), ...newSettings.dns } as any }
        : {}),
    };
    this.atomicWriteJSON('settings.json', this.memoryCache.settings);
    return this.memoryCache.settings;
  }

  public getSubscriptions(): ProfileItem[] {
    return this.memoryCache.subscriptions;
  }

  public saveSubscriptions(subs: ProfileItem[]): void {
    this.memoryCache.subscriptions = subs;
    this.atomicWriteJSON('subscriptions.json', subs);
  }

  public getNodes(): ProxyNode[] {
    return this.memoryCache.nodes;
  }

  public saveNodes(nodes: ProxyNode[]): void {
    this.memoryCache.nodes = nodes;
    this.atomicWriteJSON('nodes.json', nodes);
  }

  public getState(): AppPersistedState {
    return this.memoryCache.state;
  }

  public saveState(partialState: Partial<AppPersistedState>): void {
    this.memoryCache.state = { ...this.memoryCache.state, ...partialState };
    this.atomicWriteJSON('state.json', this.memoryCache.state);
  }

  public getBaseDir(): string {
    return this.baseDir;
  }
}

export const storageManager = new StorageManager();
