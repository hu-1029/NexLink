import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import { Badge } from '../../components/common/Badge';
import { Modal } from '../../components/common/Modal';
import { useProxyStore } from '../../store/useProxyStore';
import { useProfileStore } from '../../store/useProfileStore';
import { smartParse } from '../../../services/importer/smart-importer';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ClipboardPaste,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ParseError, ProxyNode } from '../../../shared/types';
import {
  SAMPLE_BASE64_SUBSCRIPTION,
  SAMPLE_CLASH_YAML,
  SAMPLE_RAW_MULTILINE,
  SAMPLE_SINGBOX_JSON,
  SAMPLE_VLESS_REALITY,
  SAMPLE_USER_VLESS_REALITY_BASE64,
  SAMPLE_CF_WORKER_VLESS_WS_TLS,
  SAMPLE_CF_CLEAN_IP_VLESS_REALITY,
} from '../../../../tests/samples/samples';

interface DetectedNodeItem {
  id: string;
  node: ProxyNode;
  name: string;
  protocol: string;
  server: string;
  port: number;
  features: string;
  status: 'valid' | 'warning' | 'error';
  selected: boolean;
  rawString: string;
}

function getFeatures(node: ProxyNode): string {
  const cfg = (node.protocolConfig || {}) as any;
  if (node.type === 'vless') {
    if (cfg.security === 'reality') return 'Reality + Vision';
    if (cfg.network === 'grpc') return 'gRPC + TLS';
    if (cfg.network === 'ws') return `WebSocket (${cfg.ws?.path || '/'})`;
    return 'VLESS TCP';
  }
  if (node.type === 'vmess') {
    if (cfg.network === 'ws') return 'WebSocket + TLS';
    if (cfg.network === 'grpc') return 'gRPC';
    return 'VMess TCP';
  }
  if (node.type === 'ss') return `SS (${cfg.cipher || 'AEAD'})`;
  if (node.type === 'trojan') return `Trojan (${cfg.network || 'tcp'})`;
  if (node.type === 'hysteria2') return `Hy2 (${cfg.obfs ? 'Obfs' : 'UDP'})`;
  if (node.type === 'tuic') return `TUIC (${cfg.congestionController || 'bbr'})`;
  if (node.type === 'wireguard') return 'WireGuard';
  return node.type.toUpperCase();
}

export const ImportCenterPage: React.FC<{ onNavigateToNodes: () => void }> = ({ onNavigateToNodes }) => {
  const { nodes, addNodes } = useProxyStore();
  const { addSubscription } = useProfileStore();

  const [inputText, setInputText] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [detectedFormat, setDetectedFormat] = useState<string>('uri-list');
  const [detectedNodes, setDetectedNodes] = useState<DetectedNodeItem[]>([]);
  const [invalidLines, setInvalidLines] = useState<{ line: string; reason: string }[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [targetGroup, setTargetGroup] = useState<'current' | 'new'>('current');
  const [newGroupName, setNewGroupName] = useState('📥 智能导入分组');
  const [importSuccessModal, setImportSuccessModal] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  // 调用真实全格式解析引擎
  const runRealSniffer = useCallback(
    (text: string) => {
      if (!text.trim()) {
        setDetectedNodes([]);
        setInvalidLines([]);
        setDetectedFormat('unknown');
        return;
      }

      const result = smartParse(text, { existingNodes: nodes });
      setDetectedFormat(result.format);

      const items: DetectedNodeItem[] = result.nodes.map((n: ProxyNode, idx: number) => ({
        id: n.id || `node-${idx}`,
        node: n,
        name: n.name,
        protocol: n.type,
        server: n.server,
        port: n.port,
        features: getFeatures(n),
        status: 'valid',
        selected: true,
        rawString: n.rawUri || '',
      }));

      setDetectedNodes(items);
      setInvalidLines(
        result.errors.map((e: ParseError) => ({
          line: e.raw,
          reason: e.line ? `第 ${e.line} 行: ${e.error}` : e.error,
        }))
      );
    },
    [nodes]
  );

  // 监听全局 Ctrl + V 粘贴
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      const text = e.clipboardData?.getData('text');
      if (text) {
        setInputText(text);
        runRealSniffer(text);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [runRealSniffer]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    runRealSniffer(val);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        if (content) {
          setInputText(content);
          runRealSniffer(content);
        }
      };
      reader.readAsText(file);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const clipText = await navigator.clipboard.readText();
      if (!clipText.trim()) {
        alert('剪贴板中暂无文本内容！');
        return;
      }
      setInputText(clipText);
      runRealSniffer(clipText);
    } catch {
      alert('请允许剪贴板访问权限以快捷导入');
    }
  };

  const handleSampleClick = (sampleType: 'vless' | 'cf' | 'hybrid' | 'base64' | 'clash' | 'singbox') => {
    let sample = '';
    if (sampleType === 'vless') {
      sample = SAMPLE_VLESS_REALITY;
    } else if (sampleType === 'cf') {
      sample = [
        SAMPLE_USER_VLESS_REALITY_BASE64,
        SAMPLE_CF_WORKER_VLESS_WS_TLS,
        SAMPLE_CF_CLEAN_IP_VLESS_REALITY,
      ].join('\n');
    } else if (sampleType === 'hybrid') {
      sample = SAMPLE_RAW_MULTILINE;
    } else if (sampleType === 'base64') {
      sample = SAMPLE_BASE64_SUBSCRIPTION;
    } else if (sampleType === 'clash') {
      sample = SAMPLE_CLASH_YAML;
    } else {
      sample = SAMPLE_SINGBOX_JSON;
    }
    setInputText(sample);
    runRealSniffer(sample);
  };

  const handleToggleSelectAll = (checked: boolean) => {
    setDetectedNodes((prev) => prev.map((n) => ({ ...n, selected: checked })));
  };

  const handleToggleSelect = (id: string) => {
    setDetectedNodes((prev) => prev.map((n) => (n.id === id ? { ...n, selected: !n.selected } : n)));
  };

  const handleConfirmImport = async () => {
    const selected = detectedNodes.filter((n) => n.selected);
    if (selected.length === 0) {
      alert('请至少勾选一个有效节点进行导入！');
      return;
    }

    let subId: string | undefined = undefined;
    if (targetGroup === 'new') {
      subId = await addSubscription({
        name: newGroupName,
        type: 'local',
      });
    }

    const nodesToAdd: ProxyNode[] = selected.map((item) => ({
      ...item.node,
      subscriptionId: subId || item.node.subscriptionId,
      group: targetGroup === 'current' ? '🚀 节点选择' : newGroupName,
      delay: undefined, // 未测速绝不伪造
      isAlive: false,
    }));

    addNodes(nodesToAdd);
    setImportedCount(nodesToAdd.length);
    setImportSuccessModal(true);
  };

  const filteredNodes =
    selectedFilter === 'all'
      ? detectedNodes
      : detectedNodes.filter((n) => n.protocol === selectedFilter);

  const selectedCount = detectedNodes.filter((n) => n.selected).length;

  const formatLabels: Record<string, string> = {
    'uri-list': '多协议 URI 列表',
    'base64-blob': 'Base64 订阅包 (已自动解密)',
    'clash-yaml': 'Clash / Mihomo YAML 配置',
    'sing-box-json': 'Sing-box / V2Ray JSON 配置',
    unknown: '未识别格式',
  };

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-200">
      {/* 顶部标题与优势说明 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-cyan-400" />
              全格式智能导入中心 (Smart Import Hub)
            </h2>
            <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-500 border border-cyan-500/30 font-semibold flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              自由粘贴 · 全协议支持
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            直接粘贴任何节点的分享链接、Base64 订阅密文、Clash YAML 或 Sing-box JSON，自动识别并提取有效节点
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            onClick={handlePasteFromClipboard}
            icon={<ClipboardPaste className="w-3.5 h-3.5" />}
          >
            读取剪贴板
          </Button>
          {inputText && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setInputText('');
                setDetectedNodes([]);
                setInvalidLines([]);
              }}
              icon={<RotateCcw className="w-3.5 h-3.5" />}
            >
              清空重置
            </Button>
          )}
        </div>
      </div>

      {/* 大面积智能粘贴与拖拽导入区域 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`relative rounded-2xl border-2 border-dashed transition-all p-4 ${
          isDragOver
            ? 'border-brand-500 bg-brand-500/10 shadow-lg shadow-brand-500/20'
            : 'border-slate-300 dark:border-white/10 bg-white/60 dark:bg-dark-card/60 hover:border-brand-500/40'
        }`}
      >
        <textarea
          rows={5}
          value={inputText}
          onChange={handleTextChange}
          placeholder="在此直接粘贴（Ctrl+V）任意内容：
• 单个或批量链接：vmess://, vless://, ss://, trojan://, hysteria2://, tuic://, wireguard://
• Base64 编码的订阅包（系统将自动识别并解密提取）
• Clash / Mihomo YAML 完整配置文件 或 Sing-box JSON
• 或直接将 .yaml, .txt 配置文件拖放至此处..."
          className="w-full bg-transparent resize-y text-xs font-mono text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none leading-relaxed"
        />

        {/* 底部快捷测试样本选择 */}
        <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-white/5 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">真实测试样本库:</span>
            <button
              onClick={() => handleSampleClick('vless')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors font-mono"
            >
              VLESS Reality
            </button>
            <button
              onClick={() => handleSampleClick('cf')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 border border-orange-500/20 transition-colors font-mono"
            >
              Cloudflare 专线样本
            </button>
            <button
              onClick={() => handleSampleClick('hybrid')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20 border border-indigo-500/20 transition-colors font-mono"
            >
              10协议混合列表
            </button>
            <button
              onClick={() => handleSampleClick('base64')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border border-amber-500/20 transition-colors font-mono"
            >
              Base64 订阅包
            </button>
            <button
              onClick={() => handleSampleClick('clash')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-purple-500/10 text-purple-500 hover:bg-purple-500/20 border border-purple-500/20 transition-colors font-mono"
            >
              Clash YAML
            </button>
            <button
              onClick={() => handleSampleClick('singbox')}
              className="text-[11px] px-2 py-0.5 rounded-lg bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500/20 border border-cyan-500/20 transition-colors font-mono"
            >
              Sing-box JSON
            </button>
          </div>

          <div className="flex items-center gap-2 text-slate-400 text-[11px]">
            <span>按 Ctrl+V 随时粘贴</span>
            <span className="font-mono">|</span>
            <span>字符数: {inputText.length}</span>
          </div>
        </div>
      </div>

      {/* 识别状态总览与导入配置面板 */}
      {inputText && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-white/70 dark:bg-dark-card/90 border border-slate-200/80 dark:border-white/5">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  识别格式:
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-brand-500/15 text-brand-500 border border-brand-500/30">
                  {formatLabels[detectedFormat] || detectedFormat}
                </span>
              </div>

              <span className="text-slate-300 dark:text-white/10 font-mono">|</span>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">成功提取:</span>
                <span className="font-bold font-mono text-emerald-500">
                  {detectedNodes.length} 个节点
                </span>
                {invalidLines.length > 0 && (
                  <span className="font-bold font-mono text-rose-500 ml-2">
                    ({invalidLines.length} 行异常)
                  </span>
                )}
              </div>
            </div>

            {/* 导入目标位置选择 */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">导入至:</span>
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300">
                  <input
                    type="radio"
                    name="targetGroup"
                    checked={targetGroup === 'current'}
                    onChange={() => setTargetGroup('current')}
                    className="text-brand-500 focus:ring-brand-500"
                  />
                  <span>默认节点池 (🚀 节点选择)</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300 ml-2">
                  <input
                    type="radio"
                    name="targetGroup"
                    checked={targetGroup === 'new'}
                    onChange={() => setTargetGroup('new')}
                    className="text-brand-500 focus:ring-brand-500"
                  />
                  <span>新建独立本地订阅</span>
                </label>
              </div>

              {targetGroup === 'new' && (
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="输入分组名称"
                  className="px-2.5 py-1 text-xs rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-300 dark:border-white/10 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500 w-36"
                />
              )}

              <Button
                variant="primary"
                size="md"
                onClick={handleConfirmImport}
                disabled={selectedCount === 0}
                icon={<Check className="w-3.5 h-3.5" />}
              >
                确认导入 ({selectedCount} 个节点)
              </Button>
            </div>
          </div>

          {/* 异常错误行提示抽屉 */}
          {invalidLines.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-600 dark:text-rose-400 flex flex-col gap-1.5 font-mono">
              <div className="flex items-center gap-2 font-bold">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>以下 {invalidLines.length} 条内容未能识别为有效代理节点：</span>
              </div>
              <div className="max-h-24 overflow-y-auto space-y-1 pl-6 text-[11px]">
                {invalidLines.map((inv, i) => (
                  <div key={i} className="truncate">
                    • <span className="opacity-80">{inv.line}</span> — <span className="text-rose-400">{inv.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 提取结果预览表格 */}
          {detectedNodes.length > 0 && (
            <Card className="p-0 overflow-hidden border">
              {/* 表格操作控制条 */}
              <div className="p-3 bg-slate-50/70 dark:bg-white/[0.02] border-b border-slate-200/80 dark:border-white/5 flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none text-slate-700 dark:text-slate-300 font-semibold">
                    <input
                      type="checkbox"
                      checked={
                        detectedNodes.length > 0 &&
                        detectedNodes.every((n) => n.selected)
                      }
                      onChange={(e) => handleToggleSelectAll(e.target.checked)}
                      className="rounded text-brand-500 focus:ring-brand-500"
                    />
                    <span>全选 ({detectedNodes.length})</span>
                  </label>

                  <span className="text-slate-300 dark:text-white/10 font-mono">|</span>

                  {/* 协议筛选 Chips */}
                  <div className="flex items-center gap-1.5">
                    {['all', 'vless', 'vmess', 'hysteria2', 'ss', 'trojan', 'tuic', 'wireguard'].map(
                      (proto) => {
                        const count =
                          proto === 'all'
                            ? detectedNodes.length
                            : detectedNodes.filter((n) => n.protocol === proto).length;
                        if (proto !== 'all' && count === 0) return null;
                        const isSelected = selectedFilter === proto;
                        return (
                          <button
                            key={proto}
                            onClick={() => setSelectedFilter(proto)}
                            className={`px-2.5 py-0.5 rounded-lg text-[11px] font-medium transition-all ${
                              isSelected
                                ? 'bg-brand-500 text-white shadow-sm'
                                : 'bg-slate-200/60 dark:bg-white/5 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-white/10'
                            }`}
                          >
                            {proto === 'all' ? '全部' : proto.toUpperCase()} ({count})
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 font-mono">
                  已选择: {selectedCount} / {detectedNodes.length}
                </div>
              </div>

              {/* 节点列表 Table */}
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100/50 dark:bg-white/[0.01] text-slate-400 font-mono text-[10px] sticky top-0 z-10">
                    <tr>
                      <th className="py-2 px-3 w-8 text-center">选择</th>
                      <th className="py-2 px-3">协议</th>
                      <th className="py-2 px-3">节点备注名称</th>
                      <th className="py-2 px-3">服务器主机 : 端口</th>
                      <th className="py-2 px-3">核心特征</th>
                      <th className="py-2 px-3 text-right">解析状态</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/60 dark:divide-white/5 font-mono">
                    {filteredNodes.map((item) => (
                      <tr
                        key={item.id}
                        onClick={() => handleToggleSelect(item.id)}
                        className={`hover:bg-brand-500/[0.03] cursor-pointer transition-colors ${
                          item.selected ? 'bg-brand-500/[0.02]' : 'opacity-60'
                        }`}
                      >
                        <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={() => handleToggleSelect(item.id)}
                            className="rounded text-brand-500 focus:ring-brand-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <Badge protocol={item.protocol as any} />
                        </td>
                        <td className="py-2.5 px-3 font-sans font-bold text-slate-900 dark:text-slate-100 truncate max-w-[220px]">
                          {item.name}
                        </td>
                        <td className="py-2.5 px-3 text-slate-500 truncate max-w-[180px]">
                          {item.server}:{item.port}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 truncate max-w-[200px] text-[11px]">
                          {item.features}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500 font-sans">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            有效
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* 导入成功弹窗 */}
      <Modal
        isOpen={importSuccessModal}
        onClose={() => setImportSuccessModal(false)}
        title="导入完成"
      >
        <div className="flex flex-col items-center justify-center py-4 text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h4 className="text-base font-bold text-slate-900 dark:text-slate-100">
            成功导入 {importedCount} 个有效代理节点！
          </h4>
          <p className="text-xs text-slate-400 mt-1 max-w-sm">
            已成功解析并保存至出站节点池。您可以在节点管理页面查看、双击查看底层协议配置。
          </p>

          <div className="flex items-center gap-3 mt-6">
            <Button
              variant="outline"
              size="md"
              onClick={() => {
                setImportSuccessModal(false);
                setInputText('');
                setDetectedNodes([]);
              }}
            >
              继续导入
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setImportSuccessModal(false);
                onNavigateToNodes();
              }}
            >
              前往节点列表查看
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
