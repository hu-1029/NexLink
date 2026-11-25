import React, { useState } from 'react';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import { Switch } from '../../components/common/Switch';
import { Modal } from '../../components/common/Modal';
import { useProfileStore } from '../../store/useProfileStore';
import { smartParse } from '../../../services/importer/smart-importer';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Clipboard,
  Copy,
  ExternalLink,
  Layers,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';

export const SubscriptionsPage: React.FC = () => {
  const {
    subscriptions,
    activeSubscriptionId,
    setActiveSubscription,
    toggleSubscriptionEnabled,
    updateSubscription,
    updateAllSubscriptions,
    addSubscription,
    deleteSubscription,
    isUpdatingAll,
  } = useProfileStore();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newSubName, setNewSubName] = useState('');
  const [newSubUrl, setNewSubUrl] = useState('');
  const [detectedSummary, setDetectedSummary] = useState<{
    type: 'remote' | 'nodes' | 'file' | 'unknown';
    count: number;
    protocolText?: string;
    suggestion?: string;
  } | null>(null);

  const handleUrlChange = (val: string) => {
    setNewSubUrl(val);
    const trimmed = val.trim();
    if (!trimmed) {
      setDetectedSummary(null);
      return;
    }

    // 1. 远程 HTTP/HTTPS 订阅
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      let domain = '远程订阅';
      try {
        const u = new URL(trimmed);
        domain = u.hostname;
      } catch (_e) {
        void _e;
      }
      const suggestion = `专线订阅 (${domain})`;
      setDetectedSummary({
        type: 'remote',
        count: 0,
        suggestion,
      });
      if (!newSubName.trim()) {
        setNewSubName(suggestion);
      }
      return;
    }

    // 2. 单节点或多协议节点链接 / Base64 订阅包 / Clash YAML / Sing-box JSON 智能识别
    try {
      const res = smartParse(trimmed);
      if (res.nodes.length > 0) {
        const protocols = Array.from(new Set(res.nodes.map((n: any) => n.type.toUpperCase()))).join('/');
        const autoName =
          res.nodes.length === 1
            ? res.nodes[0].name || `${protocols} 节点`
            : `自定义节点集 (${res.nodes.length}个节点)`;
        setDetectedSummary({
          type: 'nodes',
          count: res.nodes.length,
          protocolText: protocols,
          suggestion: autoName,
        });
        if (!newSubName.trim()) {
          setNewSubName(autoName);
        }
        return;
      }
    } catch (_err) {
      void _err;
    }

    // 3. 本地文件绝对路径
    if (/^[a-zA-Z]:\\|^\\\\|\.ya?ml$|\.json$/i.test(trimmed)) {
      const fileName = trimmed.split(/[\\/]/).pop() || '本地配置';
      setDetectedSummary({
        type: 'file',
        count: 0,
        suggestion: fileName,
      });
      if (!newSubName.trim()) {
        setNewSubName(fileName);
      }
      return;
    }

    setDetectedSummary({
      type: 'unknown',
      count: 0,
    });
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        handleUrlChange(text);
      }
    } catch {
      alert('无法直接读取系统剪贴板，请在输入框内使用 Ctrl+V 手动粘贴。');
    }
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = newSubUrl.trim();
    if (!trimmedUrl) return;

    const isHttp = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://');
    const isPath = /^[a-zA-Z]:\\|^\\\\/.test(trimmedUrl);
    const finalName = newSubName.trim() || detectedSummary?.suggestion || '自定义订阅源';

    // 立即关闭弹窗并清空表单，避免阻塞等待远程订阅下载与核心热重载导致界面卡顿
    setNewSubName('');
    setNewSubUrl('');
    setDetectedSummary(null);
    setIsAddModalOpen(false);

    // 后台异步入库并拉取节点（主进程会立刻推送“更新中”状态并在拉取完成后自动刷新列表）
    addSubscription({
      name: finalName,
      type: isHttp ? 'remote' : 'local',
      url: isHttp ? trimmedUrl : undefined,
      filePath: isPath ? trimmedUrl : undefined,
      rawContent: !isHttp && !isPath ? trimmedUrl : undefined,
    }).catch((err: any) => {
      console.error('添加订阅失败:', err);
      alert(`添加订阅失败: ${err?.message || '请检查链接或网络连接'}`);
    });
  };

  const handleCopyUrl = (url?: string) => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    alert('订阅链接已复制到剪贴板！');
  };

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-8">
      {/* 头部标题与操作 */}
      <div className="flex items-center justify-between pt-1 pb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5">
              <span>订阅管理</span>
            </h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold tabular-nums">
              共 {subscriptions.length} 个配置源
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            管理远程 HTTP 订阅与本地配置文件，支持多源增量去重与定时自动拉取更新
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="md"
            onClick={() => updateAllSubscriptions()}
            loading={isUpdatingAll}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            更新所有订阅
          </Button>

          <Button
            variant="primary"
            size="md"
            onClick={() => setIsAddModalOpen(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            添加订阅源
          </Button>
        </div>
      </div>

      {/* 订阅卡片网格列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {subscriptions.length === 0 ? (
          <div className="col-span-1 md:col-span-2 py-20 flex flex-col items-center justify-center border border-dashed border-slate-300/80 dark:border-white/10 rounded-[22px] text-center bg-white/50 dark:bg-white/[0.01]">
            <Layers className="w-12 h-12 text-slate-300 mb-3" />
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">暂无任何订阅源</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-sm leading-relaxed">
              点击下方按钮输入服务商订阅 URL，或直接在此处一键粘贴节点链接与订阅密文。
            </p>
            <Button
              variant="primary"
              size="md"
              className="mt-4"
              onClick={() => setIsAddModalOpen(true)}
              icon={<Plus className="w-4 h-4" />}
            >
              添加第一个订阅源
            </Button>
          </div>
        ) : (
          subscriptions.map((sub) => {
            const isError = sub.status === 'error';
            const isUpdating = sub.status === 'updating';
            const isActive = sub.id === activeSubscriptionId || sub.active;
            const isEnabled = sub.enabled !== false;

            return (
              <Card
                key={sub.id}
                className={`flex flex-col justify-between p-4 transition-all duration-200 bg-white dark:bg-[#181c26] overflow-hidden ${
                  !isEnabled
                    ? 'opacity-60 grayscale-[35%]'
                    : isError
                    ? 'border-rose-300 dark:border-rose-500/30'
                    : isActive
                    ? 'border-2 border-blue-500 shadow-[0_4px_20px_rgba(37,99,235,0.12)]'
                    : 'hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)]'
                }`}
              >
                {/* 卡片头部 */}
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className={`w-11 h-11 shrink-0 rounded-2xl flex items-center justify-center font-bold text-xs ${
                          !isEnabled
                            ? 'bg-slate-100 text-slate-400'
                            : isError
                            ? 'bg-rose-50 text-rose-500'
                            : isActive
                            ? 'bg-blue-600 text-white shadow-md shadow-blue-500/25'
                            : 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
                        }`}
                      >
                        {sub.type === 'remote' ? (
                          <ExternalLink className="w-5 h-5" />
                        ) : (
                          <Layers className="w-5 h-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 min-w-0">
                          <span className="truncate" title={sub.name}>
                            {sub.name}
                          </span>
                          <span className="shrink-0 whitespace-nowrap text-[11px] px-2 py-0.5 rounded-md font-semibold bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300">
                            {sub.type === 'remote' ? '远程订阅' : '本地文件'}
                          </span>
                        </h3>
                        <div
                          className="text-xs text-slate-400 font-mono mt-0.5 truncate max-w-full"
                          title={sub.url || sub.filePath}
                        >
                          {sub.url || sub.filePath}
                        </div>
                      </div>
                    </div>

                    {/* 状态与活动徽章 */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isActive && isEnabled && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-blue-600 px-2.5 py-0.5 rounded-full shadow-sm shrink-0 whitespace-nowrap">
                          <Check className="w-3 h-3 stroke-[3]" />
                          活动中
                        </span>
                      )}

                      {!isEnabled ? (
                        <span className="inline-flex items-center text-[11px] font-medium text-slate-400 bg-slate-100 dark:bg-white/5 px-2.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
                          已停用
                        </span>
                      ) : isError ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 bg-rose-50 dark:bg-rose-500/10 px-2.5 py-0.5 rounded-full border border-rose-200/60 shrink-0 whitespace-nowrap">
                          <AlertTriangle className="w-3 h-3" />
                          更新失败
                        </span>
                      ) : isUpdating ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 bg-blue-50 dark:bg-blue-500/10 px-2.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          拉取中...
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 rounded-full border border-emerald-200/60 shrink-0 whitespace-nowrap">
                          <CheckCircle2 className="w-3 h-3" />
                          正常
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 错误详情展示 */}
                  {isError && sub.errorMessage && (
                    <div className="mt-3 p-3 rounded-2xl bg-rose-50 text-xs text-rose-600 font-mono">
                      失败原因: {sub.errorMessage}
                    </div>
                  )}

                  {/* 订阅综合指标与套餐信息 (纵向紧凑列表) */}
                  <div className="mt-4 p-3.5 rounded-2xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/5 text-xs flex flex-col divide-y divide-slate-200/50 dark:divide-white/5">
                    {/* 有效节点数 */}
                    <div className="flex items-center justify-between pb-2">
                      <span className="text-slate-400 font-sans flex items-center gap-1.5">
                        <Server className="w-3.5 h-3.5 text-blue-500" />
                        有效节点数
                      </span>
                      <span className="font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                        {sub.nodeCount} 个
                      </span>
                    </div>

                    {/* 服务商订阅流量 */}
                    <div className="py-2 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 font-sans">服务商订阅流量</span>
                        <span className="font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                          {sub.userInfo &&
                          (sub.userInfo.total || sub.userInfo.download || sub.userInfo.upload) ? (
                            `${(
                              ((sub.userInfo.upload || 0) + (sub.userInfo.download || 0)) /
                              1073741824
                            ).toFixed(1)} GB / ${((sub.userInfo.total || 0) / 1073741824).toFixed(1)} GB`
                          ) : (
                            <span className="text-slate-400 font-normal">未知 (服务商未提供)</span>
                          )}
                        </span>
                      </div>

                      {sub.userInfo && sub.userInfo.total ? (
                        <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
                          <div
                            className="h-full bg-blue-600 rounded-full transition-all"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (((sub.userInfo.upload || 0) + (sub.userInfo.download || 0)) /
                                    sub.userInfo.total) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>

                    {/* 套餐到期时间 */}
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-400 font-sans">套餐到期时间</span>
                      <span className="font-mono text-slate-700 dark:text-slate-300 font-medium">
                        {sub.userInfo?.expireDate ? (
                          sub.userInfo.expireDate
                        ) : (
                          <span className="text-slate-400">未知</span>
                        )}
                      </span>
                    </div>

                    {/* 最后更新时间 */}
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-400 font-sans flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        最后更新时间
                      </span>
                      <span className="text-slate-700 dark:text-slate-300 tabular-nums font-mono">
                        {sub.updatedAt}
                      </span>
                    </div>

                    {/* 自动更新策略 */}
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-slate-400 font-sans flex items-center gap-1.5">
                        <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                        自动更新策略
                      </span>
                      <span className="text-slate-700 dark:text-slate-300">
                        {sub.autoUpdateInterval ? `每 ${sub.autoUpdateInterval / 60} 小时` : '手动刷新'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 卡片底部操作按钮 */}
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-white/5 flex items-center justify-between gap-1 flex-nowrap">
                  <div className="flex items-center gap-1.5 shrink-0">
                    {(!isActive || !isEnabled) && !isError && (
                      <Button
                        variant={isEnabled ? 'primary' : 'outline'}
                        size="sm"
                        onClick={() => {
                          if (!isEnabled) {
                            toggleSubscriptionEnabled(sub.id);
                          }
                          setActiveSubscription(sub.id);
                        }}
                        className="h-[30px] px-2.5 text-xs rounded-xl"
                      >
                        {isEnabled ? '设为当前' : '启用并切换'}
                      </Button>
                    )}
                    {isActive && isEnabled && (
                      <span className="h-[30px] px-2.5 text-xs font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-500/30 dark:border-emerald-500/40 shrink-0 whitespace-nowrap shadow-sm select-none">
                        正在使用
                      </span>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCopyUrl(sub.url || sub.filePath)}
                      icon={<Copy className="w-3.5 h-3.5" />}
                      title="复制订阅 URL"
                      className="h-[30px] px-2.5 text-xs rounded-xl"
                    >
                      复制
                    </Button>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <div
                      className="flex items-center gap-1 mr-0.5 select-none shrink-0"
                      title={isEnabled ? '点击停用此订阅源 (从出站节点池移除)' : '点击启用此订阅源'}
                    >
                      <span className="text-xs text-slate-500 font-medium shrink-0 whitespace-nowrap">
                        {isEnabled ? '已启用' : '已停用'}
                      </span>
                      <Switch
                        checked={isEnabled}
                        onChange={() => toggleSubscriptionEnabled(sub.id)}
                        size="sm"
                      />
                    </div>

                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => updateSubscription(sub.id)}
                      loading={isUpdating}
                      icon={<RefreshCw className="w-3.5 h-3.5" />}
                      className="h-[30px] px-2.5 text-xs rounded-xl"
                    >
                      刷新
                    </Button>

                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        if (confirm(`确定要移除订阅 "${sub.name}" 吗？`)) {
                          deleteSubscription(sub.id);
                        }
                      }}
                      icon={<Trash2 className="w-3.5 h-3.5" />}
                      className="h-[30px] px-2.5 text-xs rounded-xl"
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>

      {/* 添加新订阅 / 万能节点导入模态弹窗 */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setDetectedSummary(null);
        }}
        title="添加订阅源或直接导入节点"
        footer={
          <>
            <Button
              variant="outline"
              size="md"
              onClick={() => {
                setIsAddModalOpen(false);
                setDetectedSummary(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleAddSubmit}
              disabled={!newSubUrl.trim()}
            >
              确认添加与导入
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddSubmit} className="flex flex-col gap-4 text-xs">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-slate-700 dark:text-slate-300 font-bold text-xs">
                订阅链接 / 节点分享链接 / Base64 / 配置文件
              </label>
              <button
                type="button"
                onClick={handlePasteFromClipboard}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-semibold"
              >
                <Clipboard className="w-3.5 h-3.5" />
                读取剪贴板
              </button>
            </div>
            <textarea
              rows={4}
              placeholder="直接粘贴任意内容：远程订阅 URL (http/https)、单个或多行节点链接 (vless://、vmess://、ss://、trojan://、hy2:// 等)、Base64 订阅密文、Clash YAML 或本地文件路径..."
              value={newSubUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 font-mono text-xs leading-relaxed resize-none"
              required
            />

            {/* 实时智能识别状态指示 */}
            {detectedSummary && (
              <div className="mt-2.5 flex items-center gap-2 animate-in fade-in duration-150">
                {detectedSummary.type === 'nodes' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 text-xs font-semibold">
                    <Sparkles className="w-4 h-4 text-emerald-500" />
                    <span>
                      已智能识别出 <strong>{detectedSummary.count}</strong> 个有效代理节点 (协议: {detectedSummary.protocolText})
                    </span>
                  </div>
                )}
                {detectedSummary.type === 'remote' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 text-xs font-semibold">
                    <ExternalLink className="w-4 h-4 text-blue-500" />
                    <span>已智能识别为远程 HTTP/HTTPS 订阅链接</span>
                  </div>
                )}
                {detectedSummary.type === 'file' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 text-xs font-semibold">
                    <Server className="w-4 h-4 text-blue-500" />
                    <span>已智能识别为本地配置文件路径</span>
                  </div>
                )}
                {detectedSummary.type === 'unknown' && newSubUrl.trim() && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-amber-600 text-xs font-semibold">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>万能解析引擎待命：输入即可自动解包识别</span>
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-slate-400 mt-2">
              万能输入栏：无论任何链接格式直接输入，系统均能全自动识别、去重并同步入库。
            </p>
          </div>

          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-bold text-xs mb-1.5">
              订阅显示名称 (可选，留空将自动智能命名)
            </label>
            <input
              type="text"
              placeholder={detectedSummary?.suggestion || '例如：专线 VIP 订阅'}
              value={newSubName}
              onChange={(e) => setNewSubName(e.target.value)}
              className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
        </form>
      </Modal>
    </div>
  );
};
