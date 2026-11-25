/**
 * 订阅全生命周期调度与聚合管理器 (Subscription LifeCycle & Aggregation Manager)
 * 职责：单源/批量更新、定时自动拉取、多源聚合去重、节点归属维护与当前选中节点失效安全兜底
 */

import fs from 'fs';
import path from 'path';
import type { ProfileItem, ProxyNode } from '../../shared/types';
import { deduplicateNodes } from '../../services/node/dedup';
import { StorageManager, storageManager } from '../storage/store';
import { fetchSubscription } from './fetcher';
import { MihomoProcessManager, mihomoManager } from '../core/mihomo-process';

export class SubscriptionManager {
  private timer: NodeJS.Timeout | null = null;
  private isCheckingScheduled = false;
  private inFlightUpdates = new Map<string, Promise<{ success: boolean; error?: string }>>();
  private syncInFlightPromise: Promise<ProxyNode[]> | null = null;
  private syncPendingRerun = false;
  private onDataChangedCallback?: () => void;
  private storage: StorageManager;
  private mihomo: MihomoProcessManager;

  constructor(
    storage: StorageManager = storageManager,
    mihomo: MihomoProcessManager = mihomoManager
  ) {
    this.storage = storage;
    this.mihomo = mihomo;
  }

  public setOnDataChanged(callback: () => void) {
    this.onDataChangedCallback = callback;
  }

  /**
   * 初始化定时自动更新轮询调度 (默认每 5 分钟检查一次是否有订阅达到更新周期)
   */
  public startScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.checkScheduledUpdates().catch((err) => {
        console.warn('[SubscriptionScheduler] 定时更新检查异常:', err.message);
      });
    }, 5 * 60 * 1000);
  }

  public stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 检查并执行到期的定时订阅更新
   */
  public async checkScheduledUpdates(): Promise<void> {
    if (this.isCheckingScheduled) return;
    this.isCheckingScheduled = true;
    try {
    const subs = [...this.storage.getSubscriptions()];
    const now = Date.now();

    for (const sub of subs) {
      if (!sub.enabled || !sub.autoUpdateInterval || sub.autoUpdateInterval <= 0) {
        continue;
      }

      // 失败订阅实施退避策略：若上次拉取失败，至少间隔 30 分钟再重试，防止每 5 分钟死循环重试
      if (sub.status === 'error' && sub.lastCheckAt) {
        if (now - sub.lastCheckAt < 30 * 60 * 1000) {
          continue;
        }
      }

      // 优先采用毫秒时间戳 lastUpdateAt，若无则使用标准时间解析
      let lastTs = sub.lastUpdateAt || 0;
      if (!lastTs && sub.updatedAt && sub.updatedAt !== '从未更新') {
        const parsed = new Date(sub.updatedAt).getTime();
        if (!isNaN(parsed)) {
          lastTs = parsed;
        }
      }

      const intervalMs = sub.autoUpdateInterval * 60 * 1000;

      if (now - lastTs >= intervalMs) {
        console.log(`[SubscriptionScheduler] 订阅 "${sub.name}" 触发定时自动更新...`);
        await this.updateSubscription(sub.id);
      }
    }
    } finally {
      this.isCheckingScheduled = false;
    }
  }

  /**
   * 更新单个订阅源
   */
  public async updateSubscription(id: string): Promise<{ success: boolean; error?: string }> {
    const existingTask = this.inFlightUpdates.get(id);
    if (existingTask) return existingTask;

    const task = (async () => {
      const initialSubs = this.storage.getSubscriptions();
      const initialTarget = initialSubs.find((s) => s.id === id);
      if (!initialTarget) {
        return { success: false, error: `未找到 ID 为 ${id} 的订阅配置` };
      }

      const fetchSnapshot = { ...initialTarget };
      initialTarget.status = 'updating';
      this.storage.saveSubscriptions([...initialSubs]);
      this.onDataChangedCallback?.();

      const fetchResult = await fetchSubscription(fetchSnapshot, {
        allowedBaseDir: this.storage.getBaseDir(),
      });
      const now = Date.now();
      const dateObj = new Date(now);
      const pad = (n: number) => String(n).padStart(2, '0');
      const localTimeStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;

      // 重新读取最新订阅列表，防止异步拉取期间的新增/删除操作被旧快照覆盖 (Lost Update)
      const latestSubs = this.storage.getSubscriptions();
      const latestTarget = latestSubs.find((s) => s.id === id);
      if (!latestTarget) {
        return { success: false, error: '订阅在更新期间已被删除' };
      }
      latestTarget.lastCheckAt = now;

      if (fetchResult.success) {
        latestTarget.status = 'ok';
        latestTarget.nodeCount = fetchResult.nodes.length;
        latestTarget.lastUpdateAt = now;
        latestTarget.updatedAt = localTimeStr;
        latestTarget.errorMessage = undefined;
        latestTarget.userInfo = fetchResult.userInfo;
        latestTarget.nodes = fetchResult.nodes;

        this.storage.saveSubscriptions([...latestSubs]);
        await this.reaggregateAndSyncCore();
        this.onDataChangedCallback?.();
        return { success: true };
      } else {
        latestTarget.status = 'error';
        latestTarget.errorMessage = fetchResult.error || '拉取订阅失败';
        this.storage.saveSubscriptions([...latestSubs]);
        this.onDataChangedCallback?.();
        return { success: false, error: fetchResult.error };
      }
    })();

    this.inFlightUpdates.set(id, task);
    try {
      return await task;
    } finally {
      this.inFlightUpdates.delete(id);
    }
  }

  /**
   * 更新所有启用的订阅源
   */
  public async updateAllSubscriptions(): Promise<void> {
    const subs = [...this.storage.getSubscriptions()];
    for (const sub of subs) {
      if (sub.enabled === false) continue;
      await this.updateSubscription(sub.id);
    }
  }

  /**
   * 新增订阅并立即拉取
   */
  public async addSubscription(
    subData: Omit<ProfileItem, 'id' | 'updatedAt' | 'status' | 'nodeCount'>
  ): Promise<ProfileItem> {
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let localFilePath = subData.filePath;

    // 若为内联原始节点文本/Base64/YAML，持久化存储为本地配置文件，保证重启与刷新时一致重载
    if (subData.rawContent && !localFilePath && this.storage.getBaseDir()) {
      try {
        const profilesDir = path.join(this.storage.getBaseDir(), 'profiles');
        fs.mkdirSync(profilesDir, { recursive: true });
        localFilePath = path.join(profilesDir, `${id}.txt`);
        fs.writeFileSync(localFilePath, subData.rawContent, 'utf8');
      } catch (err: any) {
        console.warn('[SubscriptionManager] 写入本地订阅文件警告:', err.message);
      }
    }

    const newSub: ProfileItem = {
      ...subData,
      id,
      filePath: localFilePath,
      nodeCount: 0,
      updatedAt: '从未更新',
      status: 'updating',
      enabled: true,
      active: false,
    };

    const subs = this.storage.getSubscriptions();
    this.storage.saveSubscriptions([newSub, ...subs]);
    this.onDataChangedCallback?.();

    // 立即拉取真实节点
    await this.updateSubscription(id);

    const updated = this.storage.getSubscriptions().find((s) => s.id === id);
    return updated || newSub;
  }

  /**
   * 删除订阅及该订阅名下的所有节点与本地关联物理文件
   */
  public async deleteSubscription(id: string): Promise<void> {
    const subs = this.storage.getSubscriptions();
    const target = subs.find((s) => s.id === id);

    // 物理安全删除本地关联的配置文件或节点快照（严格限制仅限 NexLink 内部下载的 profiles 缓存文件，绝不触碰用户原文件）
    if (target?.filePath && fs.existsSync(target.filePath)) {
      try {
        const profilesDir = path.resolve(this.storage.getBaseDir(), 'profiles');
        const resolved = path.resolve(target.filePath);
        const rel = path.relative(profilesDir, resolved);
        const isSafeInside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (isSafeInside) {
          fs.unlinkSync(target.filePath);
          console.log(`[SubscriptionManager] 已物理清理内部订阅缓存文件: ${target.filePath}`);
        } else {
          console.log(`[SubscriptionManager] 订阅文件为用户外部自选文件，保留原文件不予删除: ${target.filePath}`);
        }
      } catch (err: any) {
        console.warn('[SubscriptionManager] 清理内部订阅缓存文件提示:', err.message);
      }
    }

    const remaining = subs.filter((s) => s.id !== id);
    this.storage.saveSubscriptions(remaining);

    await this.reaggregateAndSyncCore();
    this.onDataChangedCallback?.();
  }

  /**
   * 切换订阅启用 (聚合开关)
   */
  public async toggleSubscription(id: string): Promise<void> {
    const subs = this.storage.getSubscriptions().map((s) =>
      s.id === id ? { ...s, enabled: !s.enabled } : s
    );
    this.storage.saveSubscriptions(subs);
    await this.reaggregateAndSyncCore();
    this.onDataChangedCallback?.();
  }

  /**
   * 重新计算聚合节点池，处理去重与当前选中节点失效兜底。
   * 通过单飞锁 + 脏标记合并串行化并发刷新，确保并发调用按序收敛至最新存储态，不会后发先至写入旧配置。
   */
  public reaggregateAndSyncCore(): Promise<ProxyNode[]> {
    if (this.syncInFlightPromise) {
      this.syncPendingRerun = true;
      return this.syncInFlightPromise;
    }

    this.syncInFlightPromise = this.runReaggregateSyncLoop().finally(() => {
      this.syncInFlightPromise = null;
    });
    return this.syncInFlightPromise;
  }

  private async runReaggregateSyncLoop(): Promise<ProxyNode[]> {
    let latestNodes: ProxyNode[] = [];
    do {
      this.syncPendingRerun = false;
      latestNodes = await this.performReaggregateAndSyncOnce();
    } while (this.syncPendingRerun);
    return latestNodes;
  }

  private async performReaggregateAndSyncOnce(): Promise<ProxyNode[]> {
    const subs = this.storage.getSubscriptions();
    const enabledSubs = subs.filter((s) => s.enabled !== false);

    // 收集所有启用订阅的原始节点
    const subNodes: ProxyNode[] = [];
    for (const sub of enabledSubs) {
      if (Array.isArray(sub.nodes)) {
        subNodes.push(...sub.nodes);
      }
    }

    // 加上手动独立导入的节点 (无 subscriptionId)
    const existingNodes = this.storage.getNodes();
    const manualNodes = existingNodes.filter((n) => !n.subscriptionId);

    // 基于指纹算法进行节点去重
    const aggregated = deduplicateNodes([...subNodes, ...manualNodes]);
    this.storage.saveNodes(aggregated);

    // 检查当前选中的节点或出站模式是否依然有效
    const currentState = this.storage.getState();
    const currentSettings = this.storage.getSettings();
    const isAutoMode = currentState.selectedNodeName === '⚡ 自动选择';
    const isChainMode =
      Boolean(currentState.selectedNodeName) &&
      Array.isArray(currentSettings.proxyChains) &&
      currentSettings.proxyChains.some(
        (c) => c.enabled !== false && c.name === currentState.selectedNodeName
      );
    const existingActiveNode = aggregated.find((n) => n.id === currentState.activeNodeId);

    let nextActiveNodeId = currentState.activeNodeId;
    let nextActiveNodeName = '';

    if (isAutoMode || isChainMode) {
      // 处于自动选择或链式代理模式时，保留用户当前出站策略，不覆写回首个单节点
      nextActiveNodeName = currentState.selectedNodeName || '';
    } else if (!existingActiveNode) {
      // 容错匹配：若旧节点 ID 发生变动，优先尝试按节点名称与类型匹配同一节点
      const oldActiveNode = existingNodes.find((old) => old.id === currentState.activeNodeId);
      const matchedByName = oldActiveNode
        ? aggregated.find((n) => n.name === oldActiveNode.name && n.type === oldActiveNode.type)
        : null;

      if (matchedByName) {
        nextActiveNodeId = matchedByName.id;
        nextActiveNodeName = matchedByName.name;
        console.log(`[SubscriptionManager] 节点 ID 刷新，成功根据名称恢复选中节点: ${nextActiveNodeName}`);
        this.storage.saveState({ activeNodeId: nextActiveNodeId, selectedNodeName: nextActiveNodeName });
      } else if (aggregated.length > 0) {
        nextActiveNodeId = aggregated[0].id;
        nextActiveNodeName = aggregated[0].name;
        console.log(`[SubscriptionManager] 当前激活节点已失效，安全兜底切换至: ${nextActiveNodeName}`);
        this.storage.saveState({ activeNodeId: nextActiveNodeId, selectedNodeName: nextActiveNodeName });
      } else {
        nextActiveNodeId = '';
        nextActiveNodeName = '';
        this.storage.saveState({ activeNodeId: '', selectedNodeName: '' });
      }
    } else {
      nextActiveNodeName = existingActiveNode.name;
    }

    // 先通知渲染进程刷新订阅与节点列表，再串行等待核心平滑热重载完成，保证后发变更有序合并
    this.onDataChangedCallback?.();

    if (this.mihomo.getStatus().running) {
      console.log('[SubscriptionManager] 节点集或订阅发生变动，串行平滑热更新 Mihomo 核心出站节点池...');
      try {
        await this.mihomo.hotReloadOrRestart({
          nodes: aggregated,
          settings: this.storage.getSettings(),
          selectedNodeName: nextActiveNodeName,
        });
      } catch (err: any) {
        console.warn('[SubscriptionManager] 平滑热重载运行核心出站节点警告:', err?.message || err);
      }
    }

    return aggregated;
  }
}

export const subscriptionManager = new SubscriptionManager();
