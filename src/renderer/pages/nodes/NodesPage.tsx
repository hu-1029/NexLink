import React, { useState } from 'react';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import { Badge } from '../../components/common/Badge';
import { CountryFlag } from '../../components/common/CountryFlag';
import { Modal } from '../../components/common/Modal';
import { useProxyStore } from '../../store/useProxyStore';
import { useProfileStore } from '../../store/useProfileStore';
import { getLatencyColor } from '../../styles/theme';
import { getNodeCountry } from '../../../services/parser/country';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Edit3,
  Filter,
  Grid,
  Info,
  Layers,
  Link2,
  List,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  ArrowUpDown,
  Zap,
  X,
} from 'lucide-react';
import type { ProxyChain, ProxyNode } from '../../../shared/types';

export const NodesPage: React.FC = () => {
  const {
    nodes,
    groups,
    selectedGroupId,
    setSelectedGroupId,
    activeNodeId,
    setActiveNodeId,
    testAllDelays,
    testSingleNodeDelay,
    delayTestMethod,
    setDelayTestMethod,
    isTestingSpeed,
    testingNodeIds,
    testSpeedMessage,
    clearTestMessage,
    clearAllNodes,
    deleteNode,
    chains,
    chainDelays,
    testingChainIds,
    activeChainId,
    addChain,
    updateChain,
    deleteChain,
    toggleChain,
    setActiveChain,
    testChainDelay,
    activeOutboundMode,
    selectedOutboundName,
    setActiveOutboundMode,
  } = useProxyStore();

  const { subscriptions, activeSubscriptionId } = useProfileStore();

  const [selectedSubId, setSelectedSubId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  type SortOption = 'default' | 'delay-asc' | 'delay-desc' | 'name-asc';
  const [sortBy, setSortBy] = useState<SortOption>('default');
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [inspectNode, setInspectNode] = useState<ProxyNode | null>(null);

  // 链式代理编辑/创建弹窗状态
  const [isChainModalOpen, setIsChainModalOpen] = useState(false);
  const [editingChainId, setEditingChainId] = useState<string | null>(null);
  const [chainName, setChainName] = useState('');
  const [chainEntryId, setChainEntryId] = useState('');
  const [chainExitId, setChainExitId] = useState('');
  const [chainEnabled, setChainEnabled] = useState(true);

  // 策略卡片激活态判断
  const isAutoSelected = activeOutboundMode === 'auto' || selectedOutboundName === '⚡ 自动选择';

  // 计算当前最快节点 (URL-Test 命中候选)
  const testedNodes = nodes.filter((n) => typeof n.delay === 'number' && n.delay > 0);
  testedNodes.sort((a, b) => (a.delay || 0) - (b.delay || 0));
  const fastestNode = testedNodes[0] || nodes[0];

  const shouldShowAutoCard =
    protocolFilter === 'all' &&
    (!searchQuery ||
      '自动测速选择'.toLowerCase().includes(searchQuery.toLowerCase()) ||
      'url-test'.includes(searchQuery.toLowerCase()) ||
      'auto'.includes(searchQuery.toLowerCase()) ||
      '智能优选'.toLowerCase().includes(searchQuery.toLowerCase()));
  const [isTestingAllChains, setIsTestingAllChains] = useState(false);

  // 打开创建链式代理弹窗
  const handleOpenCreateChain = () => {
    setEditingChainId(null);
    const validNodes = nodes.filter((n) => n.server && n.port);
    const entry = validNodes[0]?.id || '';
    const exit = validNodes[1]?.id || validNodes[0]?.id || '';
    setChainEntryId(entry);
    setChainExitId(exit);

    const entryNode = nodes.find((n) => n.id === entry);
    const exitNode = nodes.find((n) => n.id === exit);
    const defaultName =
      entryNode && exitNode ? `${entryNode.name} ➔ ${exitNode.name}` : '自定义链式代理';
    setChainName(defaultName);
    setChainEnabled(true);
    setIsChainModalOpen(true);
  };

  // 打开编辑链式代理弹窗
  const handleEditChain = (chain: ProxyChain) => {
    setEditingChainId(chain.id);
    setChainName(chain.name.replace(/^🔗\s*/, ''));
    setChainEntryId(chain.nodeIds[0] || '');
    setChainExitId(chain.nodeIds[1] || '');
    setChainEnabled(chain.enabled !== false);
    setIsChainModalOpen(true);
  };

  // 保存链式代理
  const handleSaveChain = async () => {
    if (!chainEntryId || !chainExitId) {
      alert('请选择前置入口节点与落地出口节点！');
      return;
    }
    if (chainEntryId === chainExitId) {
      alert('前置跳板节点与落地出口节点不能相同，必须构成跨节点链路！');
      return;
    }
    const finalName = chainName.trim() || '未命名链式代理';

    if (editingChainId) {
      await updateChain(editingChainId, {
        name: finalName,
        nodeIds: [chainEntryId, chainExitId],
        enabled: chainEnabled,
      });
    } else {
      await addChain({
        name: finalName,
        nodeIds: [chainEntryId, chainExitId],
        enabled: chainEnabled,
      });
    }
    setIsChainModalOpen(false);
  };

  // 批量测试所有启用的链式代理
  const handleTestAllChains = async () => {
    setIsTestingAllChains(true);
    try {
      for (const chain of chains) {
        if (chain.enabled !== false) {
          await testChainDelay(chain.id);
        }
      }
    } finally {
      setIsTestingAllChains(false);
    }
  };

  // 关联已启用的订阅源
  const enabledSubIds = new Set(
    subscriptions.filter((s) => s.enabled !== false).map((s) => s.id)
  );

  // 过滤与搜索
  const filteredNodes = nodes.filter((node) => {
    // 订阅归属过滤
    if (selectedSubId !== 'all') {
      if (node.subscriptionId !== selectedSubId) return false;
    } else if (node.subscriptionId && !enabledSubIds.has(node.subscriptionId)) {
      // 订阅若被关闭，默认在聚合列表中隐藏
      return false;
    }

    const matchesSearch =
      node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.server.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.country?.toLowerCase().includes(searchQuery.toLowerCase());
    const nodeType = (node.type || '').toLowerCase();
    const filter = protocolFilter.toLowerCase();
    let matchesProtocol = filter === 'all';
    if (!matchesProtocol) {
      if (nodeType === filter) {
        matchesProtocol = true;
      } else if (filter === 'hysteria2' && (nodeType === 'hy2' || nodeType === 'hysteria' || nodeType === 'hy')) {
        matchesProtocol = true;
      } else if (filter === 'tuic' && (nodeType === 'tuic5' || nodeType === 'tuic-v5')) {
        matchesProtocol = true;
      } else if (filter === 'ss' && nodeType === 'shadowsocks') {
        matchesProtocol = true;
      } else if (filter === 'ssr' && nodeType === 'shadowsocksr') {
        matchesProtocol = true;
      } else if (filter === 'wireguard' && nodeType === 'wg') {
        matchesProtocol = true;
      } else if (filter === 'socks5' && (nodeType === 'socks' || nodeType === 'socks4')) {
        matchesProtocol = true;
      }
    }
    return matchesSearch && matchesProtocol;
  });

  // 排序节点（仅对普通节点生效，智能优选卡片始终固定置顶第1位）
  const sortedNodes = [...filteredNodes].sort((a, b) => {
    if (sortBy === 'delay-asc') {
      const aValid = typeof a.delay === 'number' && a.delay > 0;
      const bValid = typeof b.delay === 'number' && b.delay > 0;
      if (aValid && bValid) return (a.delay || 0) - (b.delay || 0);
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return 0;
    }
    if (sortBy === 'delay-desc') {
      const aValid = typeof a.delay === 'number' && a.delay > 0;
      const bValid = typeof b.delay === 'number' && b.delay > 0;
      if (aValid && bValid) return (b.delay || 0) - (a.delay || 0);
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return 0;
    }
    if (sortBy === 'name-asc') {
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    }
    return 0;
  });

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-8">
      {/* 顶部标题与测速控制 */}
      <div className="flex items-center justify-between pt-1 pb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5 whitespace-nowrap">
              <span>{selectedGroupId === 'chain' ? '链式代理配置与多跳跳板' : '节点管理与测速'}</span>
            </h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold tabular-nums whitespace-nowrap">
              {selectedGroupId === 'chain'
                ? `共 ${chains.length} 条链路 (已启用 ${chains.filter((c) => c.enabled !== false).length})`
                : `共 ${filteredNodes.length} / ${nodes.length} 个节点`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {selectedGroupId === 'chain' ? (
            <>
              {chains.length > 0 && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleTestAllChains}
                  loading={isTestingAllChains}
                  icon={
                    <RefreshCw
                      className={`w-3.5 h-3.5 shrink-0 ${isTestingAllChains ? 'animate-spin' : ''}`}
                    />
                  }
                  className="bg-white dark:bg-[#181c26] border border-slate-900/[0.08] dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 text-slate-600 dark:text-slate-300 shadow-xs rounded-2xl whitespace-nowrap shrink-0 h-10 px-4 font-semibold"
                >
                  测试全部链式延迟
                </Button>
              )}
              {chains.length > 0 && (
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleOpenCreateChain}
                  icon={<Plus className="w-3.5 h-3.5" />}
                  className="shadow-sm shadow-blue-500/20 whitespace-nowrap shrink-0 font-bold rounded-2xl h-10 px-4"
                >
                  新建链式代理
                </Button>
              )}
            </>
          ) : (
            <>
              {/* 1. 清空全部 (排版在前，高质感卡片风格，单行不折行) */}
              {nodes.length > 0 && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    if (window.confirm('确定要清空全部已导入的节点吗？')) {
                      clearAllNodes();
                    }
                  }}
                  icon={<Trash2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                  title="清空全部节点"
                  className="bg-white dark:bg-[#181c26] border border-slate-900/[0.08] dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 text-slate-600 dark:text-slate-300 shadow-xs rounded-2xl whitespace-nowrap shrink-0 h-10 px-4 font-semibold"
                >
                  清空全部
                </Button>
              )}

              {/* 2. 测试方式选择 (排版在中间，精致卡片分段控制器，与整体软件风格完全融为一体) */}
              <div className="flex items-center bg-white dark:bg-[#181c26] border border-slate-900/[0.08] dark:border-white/10 shadow-xs rounded-2xl p-1 gap-1 h-10 whitespace-nowrap shrink-0">
                {(['TCP', 'ICMP', 'CONNECT'] as const).map((method) => {
                  const isActive = delayTestMethod === method;
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setDelayTestMethod(method)}
                      className={`px-4 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-xs font-bold'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-white/5 font-semibold'
                      }`}
                      title={
                        method === 'TCP'
                          ? 'TCP 握手延迟 (直连节点端口建立三次握手，延迟低、响应快，与 Clash TCP 模式一致)'
                          : method === 'ICMP'
                          ? 'ICMP Ping (系统原生 ICMP 底层网络往返延迟)'
                          : 'CONNECT 代理全链路 (经代理隧道向外访问目标网站完整响应延迟)'
                      }
                    >
                      {method}
                    </button>
                  );
                })}
              </div>

              {/* 3. 批量测试 (排版在最后面，带圈转动动画，单行不折行) */}
              <Button
                variant="primary"
                size="md"
                onClick={() => testAllDelays()}
                loading={isTestingSpeed}
                icon={<RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isTestingSpeed ? 'animate-spin' : ''}`} />}
                className="shadow-sm shadow-blue-500/20 whitespace-nowrap shrink-0 font-bold rounded-2xl h-10 px-4"
              >
                批量测试延迟
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 测速异常提示 */}
      {testSpeedMessage && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{testSpeedMessage}</span>
          </div>
          <button
            onClick={() => clearTestMessage()}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 订阅源与策略组分段药丸栏 */}
      <div className="flex flex-col gap-2.5">
        {/* 所属订阅过滤 */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <span className="text-slate-400 text-xs font-medium flex items-center gap-1.5 shrink-0 ml-1">
            <Layers className="w-3.5 h-3.5 text-blue-500" />
            <span>所属订阅:</span>
          </span>

          <button
            onClick={() => setSelectedSubId('all')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedSubId === 'all'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white dark:bg-[#181c26] text-slate-600 dark:text-slate-400 border border-slate-900/[0.04] dark:border-white/5 hover:bg-slate-50'
            }`}
          >
            全部已启用 ({nodes.length})
          </button>

          {subscriptions.map((sub) => {
            const isSelected = selectedSubId === sub.id;
            const isEnabled = sub.enabled !== false;
            const isActive = activeSubscriptionId === sub.id;
            const subNodeCount = nodes.filter((n) => n.subscriptionId === sub.id).length;
            return (
              <button
                key={sub.id}
                onClick={() => setSelectedSubId(sub.id)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-blue-600 text-white shadow-sm'
                    : !isEnabled
                    ? 'bg-slate-100/60 dark:bg-white/[0.02] text-slate-400 opacity-60'
                    : 'bg-white dark:bg-[#181c26] text-slate-600 dark:text-slate-400 border border-slate-900/[0.04] dark:border-white/5 hover:bg-slate-50'
                }`}
              >
                {isActive && isEnabled && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                )}
                <span>{sub.name}</span>
                <span className="text-[10px] opacity-75 font-mono">
                  ({isEnabled ? subNodeCount : '已停用'})
                </span>
              </button>
            );
          })}
        </div>

        {/* 策略组切换 Tab 栏 (饱满药丸风格) */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {groups.map((group) => {
            const isActive = selectedGroupId === group.id;
            return (
              <button
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
                className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25'
                    : 'bg-white dark:bg-[#181c26] text-slate-600 dark:text-slate-400 border border-slate-900/[0.04] dark:border-white/5 hover:bg-slate-50'
                }`}
              >
                {group.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 搜索与筛选控制栏 (纯白悬浮磁贴) */}
      <div className="flex items-center justify-between gap-4 p-3 rounded-2xl bg-white dark:bg-[#181c26] border border-slate-900/[0.04] dark:border-white/5 shadow-[0_2px_14px_rgba(0,0,0,0.025)]">
        {/* 搜索输入框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5 pointer-events-none" />
          <input
            type="text"
            placeholder="搜索节点名称、地区、服务器地址..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50 dark:bg-white/5 border-none text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>

        {/* 中间排序选择器 */}
        <div className="flex items-center gap-1.5 text-xs shrink-0">
          <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs font-medium text-slate-700 dark:text-slate-300 focus:outline-none cursor-pointer"
          >
            <option value="default">默认排序</option>
            <option value="delay-asc">延迟：从低到高 (最快优先)</option>
            <option value="delay-desc">延迟：从高到低</option>
            <option value="name-asc">节点名称：A - Z</option>
          </select>
        </div>

        {/* 协议筛选与视图模式切换 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={protocolFilter}
              onChange={(e) => setProtocolFilter(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs font-medium text-slate-700 dark:text-slate-300 focus:outline-none"
            >
              <option value="all">全部协议</option>
              <option value="vless">VLESS</option>
              <option value="vmess">VMess</option>
              <option value="hysteria2">Hysteria 2 (Hy2)</option>
              <option value="tuic">TUIC (tuic5)</option>
              <option value="trojan">Trojan</option>
              <option value="ss">Shadowsocks</option>
              <option value="ssr">ShadowsocksR</option>
              <option value="wireguard">WireGuard</option>
              <option value="snell">Snell</option>
              <option value="http">HTTP / HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>

          {/* 网格/列表切换 */}
          <div className="flex items-center p-0.5 rounded-xl bg-slate-100 dark:bg-white/5">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg text-xs transition-colors ${
                viewMode === 'grid' ? 'bg-white dark:bg-white/15 text-blue-600 shadow-sm' : 'text-slate-400'
              }`}
              title="卡片网格视图"
            >
              <Grid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg text-xs transition-colors ${
                viewMode === 'list' ? 'bg-white dark:bg-white/15 text-blue-600 shadow-sm' : 'text-slate-400'
              }`}
              title="紧凑列表视图"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 视图展现 */}
      {selectedGroupId === 'chain' ? (
        /* 链式代理专用看板 */
        <div className="flex flex-col gap-4 animate-in fade-in duration-150">
          {/* 说明横幅 */}
          <div className="p-4 rounded-2xl bg-blue-50/70 dark:bg-blue-500/10 border border-blue-500/20 text-xs text-slate-700 dark:text-slate-300 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm shadow-blue-500/25">
                <Link2 className="w-4.5 h-4.5" />
              </span>
              <div className="min-w-0">
                <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs flex items-center gap-2">
                  <span>链式中继隧道 (Proxy Chaining Relay)</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 font-semibold">
                    多跳中继 · 智能串联
                  </span>
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  流量先进入「前置跳板节点」建立加密中继，再由跳板发往「落地出口节点」。前置负责快速出境并抵抗丢包，落地负责目标地区伪装与流媒体/AI 解锁。
                </p>
              </div>
            </div>

          </div>

          {chains.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center border border-dashed border-slate-300/80 dark:border-white/10 rounded-[22px] text-center bg-white/50 dark:bg-white/[0.01]">
              <div className="w-14 h-14 rounded-2xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 text-blue-500">
                <Link2 className="w-7 h-7" />
              </div>
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">
                暂未配置链式代理
              </h3>
              <p className="text-xs text-slate-400 mt-1.5 max-w-md leading-relaxed">
                点击下方按钮选择前置跳板节点（例如香港专线）与落地出口节点（例如美国原生），系统将自动生成对应的 relay 代理组并在核心内即时生效。
              </p>
              <Button
                variant="primary"
                size="md"
                onClick={handleOpenCreateChain}
                icon={<Plus className="w-3.5 h-3.5" />}
                className="mt-5 font-bold"
              >
                立即创建第一条链式代理
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {chains.map((chain) => {
                const isSelected = activeChainId === chain.id;
                const isTesting = testingChainIds.includes(chain.id);
                const chainDelayVal = chainDelays[chain.id];
                const latency = getLatencyColor(chainDelayVal);

                const entryNode = nodes.find((n) => n.id === chain.nodeIds[0]);
                const exitNode = nodes.find((n) => n.id === chain.nodeIds[1]);

                const { countryCode: entryCountry } = entryNode
                  ? getNodeCountry(entryNode)
                  : { countryCode: 'UN' };
                const { countryCode: exitCountry } = exitNode
                  ? getNodeCountry(exitNode)
                  : { countryCode: 'UN' };

                return (
                  <div
                    key={chain.id}
                    className={`p-5 rounded-[22px] transition-all duration-200 relative flex flex-col justify-between gap-4 select-none ${
                      isSelected
                        ? 'bg-blue-50/40 dark:bg-blue-500/10 border-2 border-blue-500 shadow-[0_4px_20px_rgba(37,99,235,0.14)]'
                        : 'bg-white dark:bg-[#181c26] border border-slate-900/[0.04] dark:border-white/5 shadow-[0_2px_14px_rgba(0,0,0,0.025)] hover:shadow-md'
                    }`}
                  >
                    {/* 卡片头部 */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-8 h-8 rounded-xl bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                          <Link2 className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate flex items-center gap-2">
                            <span>{chain.name}</span>
                            {chain.enabled === false && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-slate-400 font-normal">
                                已停用
                              </span>
                            )}
                          </h3>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isSelected && (
                          <span className="px-2.5 py-1 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center gap-1 shadow-xs">
                            <Check className="w-3 h-3 stroke-[3]" />
                            <span>当前出站</span>
                          </span>
                        )}
                        <button
                          onClick={() => handleEditChain(chain)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
                          title="编辑链式代理"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`确定要删除链式代理「${chain.name}」吗？`)) {
                              deleteChain(chain.id);
                            }
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                          title="删除链式代理"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* 双跳拓扑可视化 */}
                    <div className="grid grid-cols-11 items-center gap-2 p-3.5 rounded-2xl bg-slate-50/80 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 text-xs">
                      {/* 前置入口 */}
                      <div className="col-span-5 p-2.5 rounded-xl bg-white dark:bg-[#13161f] border border-slate-200/50 dark:border-white/5 flex flex-col gap-1.5 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                            第 1 跳 · 前置跳板
                          </span>
                          {entryNode && <Badge protocol={entryNode.type} />}
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <CountryFlag countryCode={entryCountry} />
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate text-[11px]">
                            {entryNode ? entryNode.name : '未知或已移除节点'}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 truncate tabular-nums font-mono">
                          {entryNode ? `${entryNode.server}:${entryNode.port}` : '---'}
                        </span>
                      </div>

                      {/* 中间跳板连接指示 */}
                      <div className="col-span-1 flex flex-col items-center justify-center text-blue-500">
                        <ArrowRight className="w-4 h-4 animate-pulse" />
                      </div>

                      {/* 落地出口 */}
                      <div className="col-span-5 p-2.5 rounded-xl bg-white dark:bg-[#13161f] border border-slate-200/50 dark:border-white/5 flex flex-col gap-1.5 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                            第 2 跳 · 落地出口
                          </span>
                          {exitNode && <Badge protocol={exitNode.type} />}
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <CountryFlag countryCode={exitCountry} />
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate text-[11px]">
                            {exitNode ? exitNode.name : '未知或已移除节点'}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 truncate tabular-nums font-mono">
                          {exitNode ? `${exitNode.server}:${exitNode.port}` : '---'}
                        </span>
                      </div>
                    </div>

                    {/* 卡片底部控制与测速 */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-white/5 text-xs">
                      {/* 链路总延迟 */}
                      {isTesting ? (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400 border border-blue-200/60 dark:border-blue-500/30">
                          <span className="flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" />
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                          </span>
                          <span className="text-[10px] ml-0.5">链路测速中...</span>
                        </span>
                      ) : (
                        <span
                          onClick={() => testChainDelay(chain.id)}
                          title="点击测试整条链式代理端到端握手延迟"
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tabular-nums border cursor-pointer hover:opacity-80 transition-opacity ${latency.bg} ${latency.text} ${latency.border}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${latency.dot}`} />
                          {chainDelayVal === undefined ? '未测速 (点击测试)' : chainDelayVal < 0 ? '握手超时' : `${chainDelayVal} ms`}
                        </span>
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleChain(chain.id)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
                            chain.enabled !== false
                              ? 'bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                              : 'bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100'
                          }`}
                        >
                          {chain.enabled !== false ? '已启用' : '点击启用'}
                        </button>

                        <Button
                          variant={isSelected ? 'secondary' : 'primary'}
                          size="sm"
                          disabled={isSelected || chain.enabled === false}
                          onClick={() => setActiveChain(chain)}
                          className="font-bold"
                        >
                          {isSelected ? '正在使用' : '设为出站'}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : filteredNodes.length === 0 ? (
        <div className="py-20 flex flex-col items-center justify-center border border-dashed border-slate-300/80 dark:border-white/10 rounded-[22px] text-center bg-white/50 dark:bg-white/[0.01]">
          <Server className="w-12 h-12 text-slate-300 mb-3" />
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">未找到有效代理节点</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-sm leading-relaxed">
            当前暂无可用节点，请在「订阅管理」中刷新订阅源，或前往「智能导入中心」一键粘贴导入节点。
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 若在主节点选择组且已配置启用的链式代理，顶部提供快捷直达切换 */}
          {selectedGroupId === 'proxy' && chains.some((c) => c.enabled !== false) && (
            <div className="p-3.5 rounded-2xl bg-gradient-to-r from-blue-50/70 to-indigo-50/50 dark:from-blue-500/10 dark:to-indigo-500/5 border border-blue-200/50 dark:border-blue-500/20 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-6 h-6 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
                  <Link2 className="w-3.5 h-3.5" />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-200 shrink-0">
                  链式跳板:
                </span>
                <div className="flex items-center gap-2 overflow-x-auto">
                  {chains
                    .filter((c) => c.enabled !== false)
                    .map((c) => {
                      const isActive = activeChainId === c.id;
                      return (
                        <button
                          key={c.id}
                          onClick={() => setActiveChain(c)}
                          className={`px-3 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                            isActive
                              ? 'bg-blue-600 text-white shadow-xs font-bold'
                              : 'bg-white dark:bg-[#181c26] text-slate-700 dark:text-slate-300 border border-slate-200/60 dark:border-white/10 hover:bg-slate-50'
                          }`}
                        >
                          {isActive && <Check className="w-3 h-3 stroke-[3]" />}
                          <span>{c.name}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
              <button
                onClick={() => setSelectedGroupId('chain')}
                className="text-blue-600 dark:text-blue-400 font-bold hover:underline shrink-0 text-xs flex items-center gap-1"
              >
                <span>管理链路</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {viewMode === 'grid' ? (
        /* 网格卡片模式 (高质感磁贴) */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 策略卡片：⚡ 自动测速选择 (URL-Test 智能优选 - 深灰配色且固定在第1张卡片) */}
          {shouldShowAutoCard && (
            <div
              onClick={() => setActiveOutboundMode('auto')}
              className={`p-4 rounded-[20px] transition-all duration-200 cursor-pointer relative group flex flex-col justify-between select-none ${
                isAutoSelected
                  ? 'bg-blue-50/30 dark:bg-blue-500/10 border-2 border-blue-500 shadow-[0_4px_20px_rgba(37,99,235,0.12)]'
                  : 'bg-white dark:bg-[#181c26] border border-slate-900/[0.04] dark:border-white/5 shadow-[0_2px_14px_rgba(0,0,0,0.025)] hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)] hover:-translate-y-0.5'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 rounded-full bg-slate-600 dark:bg-slate-400 shadow-xs shrink-0 ml-0.5" title="智能优选" />
                    <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200/60 dark:border-slate-700 flex items-center gap-1 shadow-2xs">
                      <Zap className="w-3.5 h-3.5 text-slate-700 dark:text-slate-300 fill-slate-700 dark:fill-slate-300" />
                      <span>智能优选</span>
                    </span>
                  </div>

                  {/* 当前激活指示 */}
                  {isAutoSelected && (
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
                      <Check className="w-3 h-3 stroke-[3]" />
                    </span>
                  )}
                </div>

                {/* 标题 */}
                <h3
                  className={`text-sm font-bold mt-2.5 line-clamp-1 transition-colors ${
                    isAutoSelected ? 'text-blue-600 dark:text-blue-400 font-extrabold' : 'text-slate-900 dark:text-slate-100'
                  }`}
                >
                  ⚡ 自动测速选择
                </h3>

                <div className="text-xs text-slate-400 truncate mt-1 tabular-nums">
                  {fastestNode ? `当前优选: ${fastestNode.name}` : '自动测速并无缝分流至最低延迟节点'}
                </div>
              </div>

              <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between text-xs">
                {(() => {
                  const hasFastestDelay = fastestNode && typeof fastestNode.delay === 'number' && fastestNode.delay > 0;
                  const latency = hasFastestDelay ? getLatencyColor(fastestNode.delay) : null;
                  return (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        testAllDelays();
                      }}
                      title="点击并发触发全节点测速并刷新最优出站"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold tabular-nums border cursor-pointer hover:opacity-80 transition-opacity ${
                        latency
                          ? `${latency.bg} ${latency.text} ${latency.border}`
                          : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/10 dark:text-slate-300 dark:border-white/10'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${latency ? latency.dot : 'bg-slate-400'}`} />
                      {hasFastestDelay ? `${fastestNode.delay} ms` : '并发优选测速'}
                    </span>
                  );
                })()}

                {/* 右下角彻底删除多余文案，保持干净 */}
                <span />
              </div>
            </div>
          )}

          {sortedNodes.map((node) => {
            const isSelected = !isAutoSelected && !activeChainId && activeNodeId === node.id;
            const latency = getLatencyColor(node.delay);
            const { countryCode: displayCountry } = getNodeCountry(node);
            const isNodeTesting = testingNodeIds.includes(node.id);

            return (
              <div
                key={node.id}
                onClick={() => setActiveNodeId(node.id)}
                onDoubleClick={() => setInspectNode(node)}
                className={`p-4 rounded-[20px] transition-all duration-200 cursor-pointer relative group flex flex-col justify-between select-none ${
                  isSelected
                    ? 'bg-blue-50/30 dark:bg-blue-500/10 border-2 border-blue-500 shadow-[0_4px_20px_rgba(37,99,235,0.12)]'
                    : 'bg-white dark:bg-[#181c26] border border-slate-900/[0.04] dark:border-white/5 shadow-[0_2px_14px_rgba(0,0,0,0.025)] hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)] hover:-translate-y-0.5'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge protocol={node.type} />
                      <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 shadow-2xs">
                        <CountryFlag countryCode={displayCountry} />
                        <span>{displayCountry}</span>
                      </span>
                    </div>

                    {/* 当前激活指示 */}
                    {isSelected && (
                      <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
                        <Check className="w-3 h-3 stroke-[3]" />
                      </span>
                    )}
                  </div>

                  {/* 节点名称 (突出加粗大字) */}
                  <h3
                    className={`text-sm font-bold mt-2.5 line-clamp-1 transition-colors ${
                      isSelected ? 'text-blue-600 dark:text-blue-400 font-extrabold' : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {node.name}
                  </h3>

                  <div className="text-xs text-slate-400 truncate mt-1 tabular-nums">
                    {node.server}:{node.port}
                  </div>
                </div>

                <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between text-xs">
                  {/* 延迟胶囊: 测速中展示3个动态跳跃小点动画，测速完展示真实延迟 */}
                  {isNodeTesting ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400 border border-blue-200/60 dark:border-blue-500/30 shadow-2xs select-none">
                      <span className="flex items-center gap-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                      <span className="text-[10px] tracking-tight ml-0.5">测速中...</span>
                    </span>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        testSingleNodeDelay(node.id);
                      }}
                      title={`点击单独测试此节点 (${delayTestMethod})`}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold tabular-nums border cursor-pointer hover:opacity-80 transition-opacity ${latency.bg} ${latency.text} ${latency.border}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${latency.dot}`} />
                      {node.delay === undefined ? '未测速' : node.delay < 0 ? '超时 / 离线' : `${node.delay} ms`}
                    </span>
                  )}

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        testSingleNodeDelay(node.id);
                      }}
                      disabled={isNodeTesting}
                      className="p-1 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-40"
                      title={`使用 [${delayTestMethod}] 测试此节点`}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isNodeTesting ? 'animate-spin text-blue-500' : ''}`} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setInspectNode(node);
                      }}
                      className="p-1 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-white/10"
                      title="查看参数"
                    >
                      <Info className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`确定要移除节点 "${node.name}" 吗？`)) {
                          deleteNode(node.id);
                        }
                      }}
                      className="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                      title="删除节点"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}


        </div>
      ) : (
        /* 紧凑列表模式 */
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-white/5 text-slate-400 text-xs bg-slate-50/50 dark:bg-black/20">
                <th className="py-3 px-4 w-12">状态</th>
                <th className="py-3 px-4">节点名称</th>
                <th className="py-3 px-4">协议</th>
                <th className="py-3 px-4">服务器地址与端口</th>
                <th className="py-3 px-4">延迟</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5 font-mono">
              {/* 列表模式：智能优选置顶第1行 */}
              {shouldShowAutoCard && (
                <tr
                  onClick={() => setActiveOutboundMode('auto')}
                  className={`cursor-pointer transition-colors ${
                    isAutoSelected
                      ? 'bg-blue-50/40 dark:bg-blue-500/10'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                  }`}
                >
                  <td className="py-3 px-4">
                    {isAutoSelected ? (
                      <span className="w-4 h-4 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                      </span>
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-slate-400 inline-block ml-1" />
                    )}
                  </td>
                  <td className="py-3 px-4 font-sans font-bold text-slate-800 dark:text-slate-200">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-slate-700 dark:text-slate-300 fill-slate-700 dark:fill-slate-300" />
                      <span>⚡ 自动测速选择</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="w-3 h-3 rounded-full bg-slate-600 dark:bg-slate-400 shadow-xs inline-block ml-1" title="智能优选" />
                  </td>
                  <td className="py-3 px-4 text-slate-500 text-xs font-mono">
                    {fastestNode ? `当前优选: ${fastestNode.name}` : '自动分流至最低延迟节点'}
                  </td>
                  <td className="py-3 px-4">
                    {(() => {
                      const hasFastestDelay = fastestNode && typeof fastestNode.delay === 'number' && fastestNode.delay > 0;
                      const latency = hasFastestDelay ? getLatencyColor(fastestNode.delay) : null;
                      return (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            testAllDelays();
                          }}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold tabular-nums border cursor-pointer hover:opacity-80 transition-opacity ${
                            latency
                              ? `${latency.bg} ${latency.text} ${latency.border}`
                              : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/10 dark:text-slate-300 dark:border-white/10'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${latency ? latency.dot : 'bg-slate-400'}`} />
                          {hasFastestDelay ? `${fastestNode.delay} ms` : '并发优选'}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-[11px] text-blue-600 font-bold">
                      {isAutoSelected ? '已生效' : ''}
                    </span>
                  </td>
                </tr>
              )}

              {sortedNodes.map((node) => {
                const isSelected = !isAutoSelected && !activeChainId && activeNodeId === node.id;
                const latency = getLatencyColor(node.delay);
                const { countryCode: displayCountry } = getNodeCountry(node);
                const isNodeTesting = testingNodeIds.includes(node.id);

                return (
                  <tr
                    key={node.id}
                    onClick={() => setActiveNodeId(node.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-50/40 dark:bg-blue-500/10'
                        : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                    }`}
                  >
                    <td className="py-3 px-4">
                      {isSelected ? (
                        <span className="w-4 h-4 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </span>
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-slate-300 inline-block ml-1" />
                      )}
                    </td>
                    <td className="py-3 px-4 font-sans font-bold text-slate-800 dark:text-slate-200">
                      <div className="flex items-center gap-2">
                        <CountryFlag countryCode={displayCountry} />
                        <span>{node.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <Badge protocol={node.type} />
                        <span className="text-[11px] font-bold text-slate-400 font-mono">{displayCountry}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      {node.server}:{node.port}
                    </td>
                    <td className="py-3 px-4">
                      {isNodeTesting ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400 border border-blue-200/60 dark:border-blue-500/30">
                          <span className="flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                          </span>
                          <span className="text-[10px] ml-0.5">测速中...</span>
                        </span>
                      ) : (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            testSingleNodeDelay(node.id);
                          }}
                          title={`点击单独测试此节点 (${delayTestMethod})`}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono border cursor-pointer hover:opacity-80 transition-opacity ${latency.bg} ${latency.text} ${latency.border}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${latency.dot}`} />
                          {node.delay === undefined ? '未测速' : node.delay < 0 ? '超时' : `${node.delay} ms`}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInspectNode(node);
                        }}
                      >
                        详情
                      </Button>
                    </td>
                  </tr>
                );
              })}


            </tbody>
          </table>
        </Card>
      )}
    </div>
  )}

      {/* 链式代理新建 / 编辑模态弹窗 */}
      {isChainModalOpen && (
        <Modal
          isOpen={true}
          onClose={() => setIsChainModalOpen(false)}
          title={editingChainId ? '编辑链式代理' : '新建链式代理 (多跳中继跳板)'}
          maxWidth="lg"
          footer={
            <div className="flex items-center justify-end gap-2.5">
              <Button
                variant="secondary"
                size="md"
                onClick={() => setIsChainModalOpen(false)}
              >
                取消
              </Button>
              <Button variant="primary" size="md" onClick={handleSaveChain}>
                保存并即时生效
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4 text-xs">
            {/* 提示说明 */}
            <div className="p-3.5 rounded-xl bg-blue-50/60 dark:bg-blue-500/10 border border-blue-500/20 text-slate-600 dark:text-slate-300 leading-relaxed">
              链式代理将客户端流量依次转发至前置节点与落地节点。推荐将「香港/台湾/日本等低延迟 IPLC/专线节点」选为前置跳板，将「美国/欧洲/新加坡等解锁节点」选为落地出口。
            </div>

            {/* 链路自定义名称 */}
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-1.5">
                链式代理自定义名称
              </label>
              <input
                type="text"
                placeholder="例如: 🇭🇰 香港专线 ➔ 🇺🇸 美国原生"
                value={chainName}
                onChange={(e) => setChainName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/10 text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 select-text cursor-text"
              />
            </div>

            {/* 前置入口跳板节点选择 */}
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center justify-between mb-1.5">
                <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                  <span>第 1 跳 · 前置入口节点 (国内直连跳板)</span>
                </span>
                <span className="text-[11px] text-slate-400 font-normal">建议选择延迟最低的专线节点</span>
              </label>
              <select
                value={chainEntryId}
                onChange={(e) => {
                  const newEntry = e.target.value;
                  setChainEntryId(newEntry);
                  const entryN = nodes.find((n) => n.id === newEntry);
                  const exitN = nodes.find((n) => n.id === chainExitId);
                  if (entryN && exitN) {
                    setChainName(`${entryN.name} ➔ ${exitN.name}`);
                  }
                }}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="" disabled>
                  请选择前置入口节点...
                </option>
                {nodes
                  .filter((n) => n.server && n.port)
                  .map((n) => {
                    const { countryCode } = getNodeCountry(n);
                    return (
                      <option key={n.id} value={n.id}>
                        [{countryCode}] {n.name} ({n.type.toUpperCase()} ·{' '}
                        {n.delay && n.delay > 0 ? `${n.delay}ms` : '未测速'})
                      </option>
                    );
                  })}
              </select>
            </div>

            {/* 落地出口节点选择 */}
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center justify-between mb-1.5">
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <span>第 2 跳 · 落地出口节点 (目标地区解锁)</span>
                </span>
                <span className="text-[11px] text-slate-400 font-normal">
                  负责对外伪装与流媒体/ChatGPT 解锁
                </span>
              </label>
              <select
                value={chainExitId}
                onChange={(e) => {
                  const newExit = e.target.value;
                  setChainExitId(newExit);
                  const entryN = nodes.find((n) => n.id === chainEntryId);
                  const exitN = nodes.find((n) => n.id === newExit);
                  if (entryN && exitN) {
                    setChainName(`${entryN.name} ➔ ${exitN.name}`);
                  }
                }}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="" disabled>
                  请选择落地出口节点...
                </option>
                {nodes
                  .filter((n) => n.server && n.port)
                  .map((n) => {
                    const { countryCode } = getNodeCountry(n);
                    return (
                      <option key={n.id} value={n.id}>
                        [{countryCode}] {n.name} ({n.type.toUpperCase()} ·{' '}
                        {n.delay && n.delay > 0 ? `${n.delay}ms` : '未测速'})
                      </option>
                    );
                  })}
              </select>
            </div>

            {/* 启用开关 */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10">
              <div>
                <span className="font-bold text-slate-800 dark:text-slate-200 block text-xs">
                  立即启用该链式代理
                </span>
                <span className="text-[11px] text-slate-400 mt-0.5 block">
                  启用后将自动写入 Mihomo 核心并加入策略组出站选择池
                </span>
              </div>
              <input
                type="checkbox"
                checked={chainEnabled}
                onChange={(e) => setChainEnabled(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 节点详情参数模态窗 */}
      {inspectNode && (
        <Modal
          isOpen={true}
          onClose={() => setInspectNode(null)}
          title={`节点详情: ${inspectNode.name}`}
          maxWidth="lg"
          footer={
            <Button variant="primary" size="md" onClick={() => setInspectNode(null)}>
              关闭
            </Button>
          }
        >
          <div className="flex flex-col gap-3 text-xs font-mono">
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 grid grid-cols-2 gap-3.5">
              <div>
                <span className="text-slate-400 block text-xs">协议类型</span>
                <span className="font-bold text-slate-800 dark:text-slate-200 uppercase mt-0.5 block">{inspectNode.type}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-xs">当前延迟</span>
                <span
                  className={`font-bold mt-0.5 block ${
                    inspectNode.delay && inspectNode.delay > 0 ? 'text-emerald-500' : 'text-rose-500'
                  }`}
                >
                  {inspectNode.delay === undefined
                    ? '未测速'
                    : inspectNode.delay < 0
                    ? '握手超时 / 节点离线'
                    : `${inspectNode.delay} ms`}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-xs">服务器地址</span>
                <span className="text-slate-800 dark:text-slate-200 mt-0.5 block">{inspectNode.server}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-xs">目标端口</span>
                <span className="text-slate-800 dark:text-slate-200 mt-0.5 block">{inspectNode.port}</span>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10">
              <span className="text-slate-400 block text-xs mb-2">Mihomo 节点配置参数</span>
              <pre className="text-xs text-slate-700 dark:text-slate-300 overflow-x-auto p-3 bg-black/5 dark:bg-black/30 rounded-xl leading-relaxed">
{JSON.stringify(
  {
    name: inspectNode.name,
    type: inspectNode.type,
    server: inspectNode.server,
    port: inspectNode.port,
    ...(inspectNode.protocolConfig || {}),
  },
  null,
  2
)}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
