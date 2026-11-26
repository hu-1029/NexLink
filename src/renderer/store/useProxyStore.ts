import { create } from 'zustand';
import type { ProxyChain, ProxyNode } from '../../shared/types';
import { deduplicateNodes } from '../../services/node/dedup';

export interface ProxyGroupTab {
  id: string;
  name: string;
  type: 'select' | 'url-test' | 'fallback';
}

export const DEFAULT_PROXY_GROUPS: ProxyGroupTab[] = [
  { id: 'proxy', name: '🚀 节点选择', type: 'select' },
  { id: 'chain', name: '🔗 链式代理', type: 'select' },
];

export function formatChainOutboundName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('🔗') ? trimmed : `🔗 ${trimmed}`;
}

export function normalizeChainName(name: string): string {
  return name.replace(/^🔗\s*/, '').trim();
}

interface ProxyStore {
  nodes: ProxyNode[];
  groups: ProxyGroupTab[];
  selectedGroupId: string;
  activeNodeId: string;
  subscriptionFilter: string; // 'all' | subId
  searchQuery: string;
  selectedProtocol: string;
  viewMode: 'grid' | 'list';
  isTestingSpeed: boolean;
  testSpeedMessage: string | null;
  delayTestMethod: 'TCP' | 'ICMP' | 'CONNECT';
  testingNodeIds: string[];

  // 链式代理 (Proxy Chaining / Relay)
  chains: ProxyChain[];
  chainDelays: Record<string, number>;
  testingChainIds: string[];
  activeChainId: string;
  activeOutboundMode: 'node' | 'chain' | 'auto';
  selectedOutboundName: string;

  // Actions
  setActiveOutboundMode: (mode: 'node' | 'chain' | 'auto', targetName?: string) => Promise<void>;
  reorderNode: (fromIndex: number, toIndex: number) => Promise<void>;
  setNodes: (nodes: ProxyNode[]) => void;
  setSelectedGroupId: (id: string) => void;
  setActiveNodeId: (id: string) => void;
  hydrateActiveNode: (id: string, selectedNodeName?: string) => void;
  setSubscriptionFilter: (subId: string) => void;
  setSearchQuery: (query: string) => void;
  setSelectedProtocol: (proto: string) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  setDelayTestMethod: (method: 'TCP' | 'ICMP' | 'CONNECT') => void;
  testAllDelays: (coreRunning?: boolean) => Promise<void>;
  testSingleNodeDelay: (nodeId: string) => Promise<void>;
  clearTestMessage: () => void;
  addNodes: (newNodes: ProxyNode[]) => void;
  deleteNode: (id: string) => void;
  clearAllNodes: () => void;

  // 链式代理 Actions
  setChains: (chains: ProxyChain[]) => void;
  saveChains: (chains: ProxyChain[]) => Promise<void>;
  addChain: (chain: Omit<ProxyChain, 'id' | 'createdAt'>) => Promise<void>;
  updateChain: (id: string, patch: Partial<ProxyChain>) => Promise<void>;
  deleteChain: (id: string) => Promise<void>;
  toggleChain: (id: string) => Promise<void>;
  setActiveChain: (chain: ProxyChain) => Promise<void>;
  testChainDelay: (chainId: string) => Promise<void>;
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
  nodes: [],
  groups: DEFAULT_PROXY_GROUPS,
  selectedGroupId: 'proxy',
  activeNodeId: '',
  subscriptionFilter: 'all',
  searchQuery: '',
  selectedProtocol: 'all',
  viewMode: 'grid',
  isTestingSpeed: false,
  testSpeedMessage: null,
  delayTestMethod: 'TCP',
  testingNodeIds: [],

  // 链式代理初始状态
  chains: [],
  chainDelays: {},
  testingChainIds: [],
  activeChainId: '',
  activeOutboundMode: 'node',
  selectedOutboundName: '',

  setNodes: (nodes) => {
    set({ nodes });
    const state = get();
    if (state.activeOutboundMode === 'auto' || state.activeOutboundMode === 'chain') return;
    const currentActive = state.activeNodeId;
    if (!currentActive || !nodes.some((n) => n.id === currentActive)) {
      if (nodes.length > 0 && !state.activeChainId) {
        set({ activeNodeId: nodes[0].id, selectedOutboundName: nodes[0].name });
      }
    }
  },

  setSelectedGroupId: (id) => set({ selectedGroupId: id }),

  setActiveNodeId: (id) => {
    const node = get().nodes.find((n) => n.id === id);
    set({
      activeNodeId: id,
      activeChainId: '',
      activeOutboundMode: 'node',
      selectedOutboundName: node?.name || '',
    });
    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage
        .saveState({
          activeNodeId: id,
          selectedNodeName: node?.name,
        })
        .catch(console.error);
    }
    if (node && window.nexlinkAPI?.core) {
      window.nexlinkAPI.core.selectNode('🚀 节点选择', node.name).catch((err: any) => {
        console.warn('切换出站节点提示:', err.message);
      });
    }
  },

  hydrateActiveNode: (id, selectedNodeName) => {
    const state = get();
    if (selectedNodeName === '⚡ 自动选择') {
      set({ activeNodeId: '', activeChainId: '', activeOutboundMode: 'auto', selectedOutboundName: '⚡ 自动选择' });
      return;
    }
    const matchedChain = selectedNodeName
      ? state.chains.find(
          (c) =>
            c.name === selectedNodeName ||
            formatChainOutboundName(c.name) === selectedNodeName ||
            normalizeChainName(c.name) === normalizeChainName(selectedNodeName)
        )
      : undefined;
    if (matchedChain) {
      set({
        activeNodeId: '',
        activeChainId: matchedChain.id,
        activeOutboundMode: 'chain',
        selectedOutboundName: formatChainOutboundName(matchedChain.name),
      });
      return;
    }
    const node = state.nodes.find((n) => n.id === id) || (selectedNodeName ? state.nodes.find((n) => n.name === selectedNodeName) : undefined);
    if (node) {
      set({ activeNodeId: node.id, activeChainId: '', activeOutboundMode: 'node', selectedOutboundName: node.name });
    }
  },

  setChains: (chains) => set({ chains }),

  saveChains: async (chains) => {
    set({ chains });
    if (window.nexlinkAPI?.system) {
      try {
        await window.nexlinkAPI.system.updateSettings({ proxyChains: chains });
      } catch (err: any) {
        console.error('保存链式代理配置失败:', err);
      }
    }
  },

  addChain: async (chainData) => {
    const newChain: ProxyChain = {
      ...chainData,
      id: `chain-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
    };
    const updated = [...get().chains, newChain];
    await get().saveChains(updated);
  },

  updateChain: async (id, patch) => {
    const updated = get().chains.map((c) => (c.id === id ? { ...c, ...patch } : c));
    await get().saveChains(updated);
  },

  deleteChain: async (id) => {
    const updated = get().chains.filter((c) => c.id !== id);
    if (get().activeChainId === id) {
      set({ activeChainId: '' });
    }
    await get().saveChains(updated);
  },

  toggleChain: async (id) => {
    const chain = get().chains.find((c) => c.id === id);
    if (!chain) return;
    await get().updateChain(id, { enabled: !chain.enabled });
  },

  setActiveChain: async (chain) => {
    const chainGroupName = formatChainOutboundName(chain.name);
    set({
      activeChainId: chain.id,
      activeNodeId: '',
      activeOutboundMode: 'chain',
      selectedOutboundName: chainGroupName,
    });
    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage
        .saveState({
          selectedNodeName: chainGroupName,
          activeNodeId: '',
        })
        .catch(console.error);
    }
    if (window.nexlinkAPI?.core) {
      try {
        await window.nexlinkAPI.core.selectNode('🚀 节点选择', chainGroupName);
      } catch (err: any) {
        console.warn('切换到链式代理出站提示:', err.message);
      }
    }
  },

  setActiveOutboundMode: async (mode, targetName) => {
    let outName = targetName;
    if (mode === 'auto') {
      outName = '⚡ 自动选择';
      set({
        activeOutboundMode: 'auto',
        selectedOutboundName: outName,
        activeNodeId: '',
        activeChainId: '',
      });

    } else if (mode === 'chain') {
      outName = targetName || '🔗 链式代理';
      set({
        activeOutboundMode: 'chain',
        selectedOutboundName: outName,
        activeNodeId: '',
      });
    } else {
      const node = get().nodes.find((n) => n.id === get().activeNodeId) || get().nodes[0];
      outName = targetName || node?.name || '';
      set({
        activeOutboundMode: 'node',
        selectedOutboundName: outName,
        activeChainId: '',
      });
    }

    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage
        .saveState({
          selectedNodeName: outName,
          activeNodeId: mode === 'node' ? get().activeNodeId : '',
        })
        .catch(console.error);
    }

    if (outName && window.nexlinkAPI?.core) {
      try {
        await window.nexlinkAPI.core.selectNode('🚀 节点选择', outName);
      } catch (err: any) {
        console.warn('切换出站策略提示:', err.message);
      }
    }
  },

  reorderNode: async (fromIndex: number, toIndex: number) => {
    const list = [...get().nodes];
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return;
    const [item] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, item);
    set({ nodes: list });
    if (window.nexlinkAPI?.storage) {
      await window.nexlinkAPI.storage.saveNodes(list).catch(console.error);
    }
    if (window.nexlinkAPI?.core) {
      try {
        const st = await window.nexlinkAPI.core.getStatus();
        if (st.running) {
          await window.nexlinkAPI.core.restart({ nodes: list });
        }
      } catch (err: any) {
        console.warn('重启应用故障转移顺位提示:', err.message);
      }
    }
  },

  testChainDelay: async (chainId: string) => {
    const chain = get().chains.find((c) => c.id === chainId);
    if (!chain) return;

    set((state) => ({
      testingChainIds: state.testingChainIds.includes(chainId)
        ? state.testingChainIds
        : [...state.testingChainIds, chainId],
    }));

    const chainGroupName = chain.name.startsWith('🔗') ? chain.name : `🔗 ${chain.name}`;
    let realDelay = -1;
    const startTime = Date.now();

    try {
      if (window.nexlinkAPI?.core?.testDelay) {
        try {
          realDelay = await window.nexlinkAPI.core.testDelay(
            chainGroupName,
            'http://cp.cloudflare.com/generate_204',
            3500
          );
        } catch {
          // fallback
        }
      }

      // 若核心未开启或中继组未能直测，根据链路节点延迟叠加算力开销
      if (realDelay <= 0) {
        const nodes = get().nodes;
        let sumDelay = 0;
        let validHopCount = 0;
        for (const nid of chain.nodeIds) {
          const n = nodes.find((item) => item.id === nid);
          if (n && n.delay && n.delay > 0) {
            sumDelay += n.delay;
            validHopCount++;
          }
        }
        if (validHopCount >= 2) {
          // 链路中转握手开销加权
          realDelay = Math.round(sumDelay * 0.85 + 28);
        }
      }
    } catch {
      realDelay = -1;
    } finally {
      const elapsed = Date.now() - startTime;
      if (elapsed < 400) {
        await new Promise((r) => setTimeout(r, 400 - elapsed));
      }

      set((state) => ({
        chainDelays: { ...state.chainDelays, [chainId]: realDelay },
        testingChainIds: state.testingChainIds.filter((id) => id !== chainId),
      }));
    }
  },

  setSubscriptionFilter: (subId) => set({ subscriptionFilter: subId }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedProtocol: (proto) => set({ selectedProtocol: proto }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setDelayTestMethod: (method) => set({ delayTestMethod: method }),
  clearTestMessage: () => set({ testSpeedMessage: null }),

  testSingleNodeDelay: async (nodeId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const method = get().delayTestMethod;

    // 加入测试队列，UI 显示 3 个动态跳跃小点
    set((state) => ({
      testingNodeIds: state.testingNodeIds.includes(nodeId)
        ? state.testingNodeIds
        : [...state.testingNodeIds, nodeId],
    }));

    const startTime = Date.now();
    let realDelay = -1;

    try {
      if (window.nexlinkAPI?.core?.testNodeDelay) {
        try {
          realDelay = await window.nexlinkAPI.core.testNodeDelay(
            { name: node.name, server: node.server, port: node.port, type: node.type },
            method,
            2500
          );
        } catch {
          // fallback
        }
      }

      if (realDelay <= 0 && window.nexlinkAPI?.core?.testDelay) {
        try {
          realDelay = await window.nexlinkAPI.core.testDelay(
            node.name,
            'http://cp.cloudflare.com/generate_204',
            2500
          );
        } catch {
          if (node.name.includes('#')) {
            const cleanName = node.name.split('#').pop() || node.name;
            try {
              realDelay = await window.nexlinkAPI.core.testDelay(
                cleanName,
                'http://cp.cloudflare.com/generate_204',
                2500
              );
            } catch {
              // ignore
            }
          }
        }
      }


    } catch {
      realDelay = -1;
    } finally {
      // 保持至少 400ms 的平滑测速动画节奏，杜绝瞬间闪退
      const elapsed = Date.now() - startTime;
      if (elapsed < 400) {
        await new Promise((r) => setTimeout(r, 400 - elapsed));
      }

      set((state) => {
        const updatedNodes = state.nodes.map((n) =>
          n.id === nodeId ? { ...n, delay: realDelay, isAlive: realDelay > 0 } : n
        );
        if (window.nexlinkAPI?.storage) {
          window.nexlinkAPI.storage.saveNodes(updatedNodes).catch(console.error);
        }
        return {
          nodes: updatedNodes,
          testingNodeIds: state.testingNodeIds.filter((id) => id !== nodeId),
        };
      });
    }
  },

  testAllDelays: async (coreRunning?: boolean) => {
    if (get().isTestingSpeed) return;
    const method = get().delayTestMethod;
    const currentNodes = [...get().nodes];
    if (currentNodes.length === 0) {
      set({
        isTestingSpeed: false,
        testSpeedMessage: '当前节点列表为空，请先导入或更新订阅后再测速。',
      });
      return;
    }

    set({
      isTestingSpeed: true,
      testSpeedMessage: null,
      testingNodeIds: currentNodes.map((n) => n.id),
    });

    let isRunning = coreRunning;
    if (typeof isRunning !== 'boolean' && window.nexlinkAPI?.core) {
      try {
        const st = await window.nexlinkAPI.core.getStatus();
        isRunning = st.running;
      } catch {
        isRunning = false;
      }
    }

    // 只有 CONNECT (代理全链路) 必须依赖核心运行中
    if (method === 'CONNECT' && (!isRunning || !window.nexlinkAPI?.core)) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      set({
        isTestingSpeed: false,
        testingNodeIds: [],
        testSpeedMessage: 'CONNECT 方式需经代理隧道向外测速，请在仪表盘启动核心后再测速，或切换为 TCP / ICMP 直连测速。',
      });
      return;
    }

    // 平滑顺序测速：逐个/两两推进，每个节点保证 380~500ms 真实测速动画，清晰看到小点跳动
    for (const node of currentNodes) {
      const startTime = Date.now();
      let realDelay = -1;

      try {
        if (window.nexlinkAPI?.core?.testNodeDelay) {
          try {
            realDelay = await window.nexlinkAPI.core.testNodeDelay(
              { name: node.name, server: node.server, port: node.port, type: node.type },
              method,
              2500
            );
          } catch {
            // fallback
          }
        }

        if (realDelay <= 0 && window.nexlinkAPI?.core?.testDelay) {
          try {
            realDelay = await window.nexlinkAPI.core.testDelay(
              node.name,
              'http://cp.cloudflare.com/generate_204',
              2500
            );
          } catch {
            if (node.name.includes('#')) {
              const cleanName = node.name.split('#').pop() || node.name;
              try {
                realDelay = await window.nexlinkAPI.core.testDelay(
                  cleanName,
                  'http://cp.cloudflare.com/generate_204',
                  2500
                );
              } catch {
                // ignore
              }
            }
          }
        }


      } catch {
        realDelay = -1;
      }

      // 保证单个节点测速动画展现时长
      const elapsed = Date.now() - startTime;
      if (elapsed < 380) {
        await new Promise((r) => setTimeout(r, 380 - elapsed));
      }

      // 该节点测试完成，立刻出延迟结果并移除跳动状态
      set((state) => ({
        testingNodeIds: state.testingNodeIds.filter((id) => id !== node.id),
        nodes: state.nodes.map((n) =>
          n.id === node.id ? { ...n, delay: realDelay, isAlive: realDelay > 0 } : n
        ),
      }));

      // 节点间呼吸微延时
      await new Promise((r) => setTimeout(r, 100));
    }

    // 全部测速完成，持久化保存
    const finalNodes = get().nodes;
    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage.saveNodes(finalNodes).catch(console.error);
    }

    const methodLabels: Record<string, string> = {
      TCP: 'TCP 握手直连',
      ICMP: 'ICMP Ping 直连',
      CONNECT: 'CONNECT 代理全链路',
    };
    set({
      isTestingSpeed: false,
      testingNodeIds: [],
      testSpeedMessage: `已使用 [${methodLabels[method] || method}] 方式完成全部节点真实测速`,
    });
  },

  addNodes: (newNodes) => {
    const current = get().nodes;
    const deduped = deduplicateNodes(newNodes, current);
    const combined = [...deduped, ...current];
    set({ nodes: combined });

    if (!get().activeNodeId && combined.length > 0) {
      get().setActiveNodeId(combined[0].id);
    }

    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage.saveNodes(combined).catch(console.error);
    }
  },

  deleteNode: (id) => {
    const remaining = get().nodes.filter((n) => n.id !== id);
    set({ nodes: remaining });

    if (get().activeNodeId === id) {
      const fallbackId = remaining.length > 0 ? remaining[0].id : '';
      get().setActiveNodeId(fallbackId);
    }

    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage.saveNodes(remaining).catch(console.error);
    }
  },

  clearAllNodes: () => {
    set({ nodes: [], activeNodeId: '' });
    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage.saveNodes([]).catch(console.error);
      window.nexlinkAPI.storage.saveState({ activeNodeId: '' }).catch(console.error);
    }
  },
}));
