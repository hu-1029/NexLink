import React, { useState, useEffect, useRef } from 'react';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import { Switch } from '../../components/common/Switch';
import {
  Check,
  Copy,
  FileCode,
  Layers,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AppSettings } from '../../../shared/types';
import { parseRuleFileContent } from '@services/parser/rule-parser';
import { useProxyStore } from '../../store/useProxyStore';

const BASE_RULES = [
  { rule: 'GEOIP,private,DIRECT,no-resolve', desc: '局域网与本地专用网段直连，不进行远程解析', target: 'DIRECT' },
  { rule: 'GEOSITE,category-ads-all,REJECT', desc: '广告与已知恶意追踪域名拦截', target: 'REJECT' },
  { rule: 'GEOSITE,cn,DIRECT', desc: '中国大陆主流域名与加速服务直连', target: 'DIRECT' },
  { rule: 'GEOIP,CN,DIRECT', desc: '中国大陆 IP 归属地直连', target: 'DIRECT' },
  { rule: 'MATCH,🚀 节点选择', desc: '出站兜底默认规则：走当前选中的出站代理节点', target: 'PROXY' },
];

export const ProfilesPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'rules' | 'dns' | 'yaml'>('rules');
  const chains = useProxyStore((s) => s.chains);

  // 分流规则状态
  const [customRules, setCustomRules] = useState<string[]>([
    'DOMAIN-SUFFIX,google.com,🚀 节点选择',
    'DOMAIN-SUFFIX,github.com,🚀 节点选择',
  ]);
  const [newRuleType, setNewRuleType] = useState<string>('DOMAIN-SUFFIX');
  const [newRuleValue, setNewRuleValue] = useState<string>('');
  const [newRuleTarget, setNewRuleTarget] = useState<string>('🚀 节点选择');

  // DNS 状态
  const [dnsEnable, setDnsEnable] = useState<boolean>(true);
  const [enhancedMode, setEnhancedMode] = useState<'fake-ip' | 'redir-host'>('fake-ip');
  const [nameservers, setNameservers] = useState<string[]>([
    'https://doh.pub/dns-query',
    '223.5.5.5',
    '119.29.29.29',
  ]);
  const [fallbacks, setFallbacks] = useState<string[]>([
    'https://1.1.1.1/dns-query',
    'https://dns.google/dns-query',
  ]);
  const [newNsInput, setNewNsInput] = useState('');
  const [newFbInput, setNewFbInput] = useState('');

  // 运行时 YAML 预览
  const [runtimeYaml, setRuntimeYaml] = useState<string>('');
  const [loadingYaml, setLoadingYaml] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 初始化加载真实设置
  useEffect(() => {
    if (window.nexlinkAPI?.system) {
      window.nexlinkAPI.system
        .getSettings()
        .then((settings: AppSettings) => {
          if (Array.isArray(settings.customRules)) {
            setCustomRules(settings.customRules);
          }
          if (settings.dns) {
            setDnsEnable(Boolean(settings.dns.enable));
            if (settings.dns.enhancedMode) setEnhancedMode(settings.dns.enhancedMode);
            if (Array.isArray(settings.dns.nameservers)) setNameservers(settings.dns.nameservers);
            if (Array.isArray(settings.dns.fallbacks)) setFallbacks(settings.dns.fallbacks);
          }
        })
        .catch(console.error);
    }
  }, []);

  const fetchRuntimeYaml = async () => {
    setLoadingYaml(true);
    try {
      if (window.nexlinkAPI?.core) {
        const yaml = await window.nexlinkAPI.core.getRuntimeConfig();
        setRuntimeYaml(yaml);
      }
    } catch (err: any) {
      setRuntimeYaml(`# 获取运行时配置失败: ${err.message}`);
    } finally {
      setLoadingYaml(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'yaml') {
      fetchRuntimeYaml();
    }
  }, [activeTab]);

  // 自动保存规则并即时热应用生效
  const autoApplyRules = async (rulesToApply: string[], notice?: string) => {
    setIsSaving(true);
    try {
      if (window.nexlinkAPI?.system) {
        await window.nexlinkAPI.system.updateSettings({
          customRules: rulesToApply,
          dns: {
            enable: dnsEnable,
            enhancedMode,
            nameservers,
            fallbacks,
          },
        });

        // 主进程 SYS_UPDATE_SETTINGS 已自动执行热重载，无需再次强制 restart 断连
        let isRunning = false;
        try {
          const status = await window.nexlinkAPI.core.getStatus();
          isRunning = status.running;
        } catch {
          isRunning = false;
        }
        setSaveSuccessNotice(
          isRunning
            ? notice || '分流规则已即时更新并平滑热重载生效！'
            : notice || '分流规则已保存，将在核心启动时生效！'
        );

        if (activeTab === 'yaml') {
          fetchRuntimeYaml();
        }
      }
    } catch (err: any) {
      alert(`保存规则失败: ${err.message}`);
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveSuccessNotice(null), 3500);
    }
  };

  // 添加规则（即时持久化并生效）
  const handleAddCustomRule = async () => {
    const val = newRuleValue.trim();
    if (!val) {
      alert('请输入规则目标内容（如域名、IP段或关键词）');
      return;
    }
    const ruleStr = `${newRuleType},${val},${newRuleTarget}`;
    if (customRules.includes(ruleStr)) {
      alert('该规则已存在！');
      return;
    }
    const updated = [...customRules, ruleStr];
    setCustomRules(updated);
    setNewRuleValue('');
    await autoApplyRules(updated, `新增规则「${val}」已即时生效！`);
  };

  // 删除单条规则（即时生效）
  const handleDeleteCustomRule = async (index: number) => {
    const updated = customRules.filter((_, i) => i !== index);
    setCustomRules(updated);
    await autoApplyRules(updated, '所选规则已删除并即时生效！');
  };

  // 清空全部自定义规则（即时生效）
  const handleClearAllCustomRules = async () => {
    if (customRules.length === 0) return;
    if (confirm('确定要清空全部自定义分流规则吗？')) {
      setCustomRules([]);
      await autoApplyRules([], '自定义规则已清空并即时生效！');
    }
  };

  // 一键导入规则文件 (.yaml, .yml, .conf, .txt, .list) 并即时生效
  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseRuleFileContent(text);
      if (parsed.length === 0) {
        alert('未能从文件中识别出有效的分流规则内容，请确认文件格式 (.yaml, .yml, .conf, .txt, .list)');
        return;
      }

      // 合并现有规则与导入规则（自动去重）
      const merged = Array.from(new Set([...customRules, ...parsed]));
      const addedCount = merged.length - customRules.length;

      setCustomRules(merged);
      await autoApplyRules(
        merged,
        `成功从「${file.name}」导入 ${parsed.length} 条规则（新增 ${addedCount} 条，已自动去重），已即时生效！`
      );
    } catch (err: any) {
      alert(`导入规则失败: ${err.message}`);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 自动同步 DNS 变更
  const applyDnsChange = async (newDnsConfig: {
    enable: boolean;
    enhancedMode: 'fake-ip' | 'redir-host';
    nameservers: string[];
    fallbacks: string[];
  }) => {
    try {
      if (window.nexlinkAPI?.system) {
        await window.nexlinkAPI.system.updateSettings({
          dns: newDnsConfig,
        });
        if (activeTab === 'yaml') {
          fetchRuntimeYaml();
        }
      }
    } catch (err: any) {
      console.error('更新 DNS 失败:', err);
    }
  };

  const handleToggleDns = (val: boolean) => {
    setDnsEnable(val);
    applyDnsChange({ enable: val, enhancedMode, nameservers, fallbacks });
  };

  const handleChangeEnhancedMode = (mode: 'fake-ip' | 'redir-host') => {
    setEnhancedMode(mode);
    applyDnsChange({ enable: dnsEnable, enhancedMode: mode, nameservers, fallbacks });
  };

  const handleAddNameserver = () => {
    const val = newNsInput.trim();
    if (!val) return;
    if (!nameservers.includes(val)) {
      const updated = [...nameservers, val];
      setNameservers(updated);
      setNewNsInput('');
      applyDnsChange({ enable: dnsEnable, enhancedMode, nameservers: updated, fallbacks });
    }
  };

  const handleDeleteNameserver = (idx: number) => {
    const updated = nameservers.filter((_, i) => i !== idx);
    setNameservers(updated);
    applyDnsChange({ enable: dnsEnable, enhancedMode, nameservers: updated, fallbacks });
  };

  const handleAddFallback = () => {
    const val = newFbInput.trim();
    if (!val) return;
    if (!fallbacks.includes(val)) {
      const updated = [...fallbacks, val];
      setFallbacks(updated);
      setNewFbInput('');
      applyDnsChange({ enable: dnsEnable, enhancedMode, nameservers, fallbacks: updated });
    }
  };

  const handleDeleteFallback = (idx: number) => {
    const updated = fallbacks.filter((_, i) => i !== idx);
    setFallbacks(updated);
    applyDnsChange({ enable: dnsEnable, enhancedMode, nameservers, fallbacks: updated });
  };

  const handleCopyYaml = () => {
    if (!runtimeYaml) return;
    navigator.clipboard.writeText(runtimeYaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 pb-8">
      {/* 顶部标题与导入规则动作 */}
      <div className="flex items-center justify-between pt-1 pb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5">
              <span>配置与分流规则</span>
            </h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono font-semibold">
              自定义规则 {customRules.length} 条
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            配置高级分流路由规则、Mihomo 内建 DNS 解析与查看运行时实时合成的完整 config.yaml
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <input
            type="file"
            ref={fileInputRef}
            accept=".yaml,.yml,.conf,.txt,.list"
            className="hidden"
            onChange={handleFileImport}
          />
          <Button
            variant="primary"
            size="md"
            loading={isSaving}
            onClick={() => fileInputRef.current?.click()}
            icon={<Upload className="w-3.5 h-3.5" />}
          >
            导入规则
          </Button>
        </div>
      </div>

      {/* 保存成功通知条 */}
      {saveSuccessNotice && (
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-500" />
            <span className="font-medium">{saveSuccessNotice}</span>
          </div>
          <button
            onClick={() => setSaveSuccessNotice(null)}
            className="text-xs font-bold text-emerald-600 hover:underline"
          >
            知道了
          </button>
        </div>
      )}

      {/* 选项卡导航 (饱满药丸分段选择) */}
      <div className="flex items-center gap-2 pb-1">
        {[
          { id: 'rules', label: '分流路由规则', icon: Layers },
          { id: 'dns', label: 'DNS 解析器配置', icon: Network },
          { id: 'yaml', label: '运行时 YAML 预览', icon: FileCode },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-2 rounded-2xl text-xs font-bold transition-all ${
                isActive
                  ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25'
                  : 'bg-white dark:bg-[#181c26] text-slate-600 dark:text-slate-400 border border-slate-900/[0.04] dark:border-white/5 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: 分流路由规则 */}
      {activeTab === 'rules' && (
        <div className="flex flex-col gap-4">
          {/* 自定义规则添加面板 (纯白大圆角卡片) */}
          <Card className="flex flex-col gap-4 p-5 bg-white dark:bg-[#181c26]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                <Plus className="w-4 h-4 text-blue-500" />
                <span>新增自定义分流规则 (优先级高于预设基础规则)</span>
              </span>
              <span className="text-xs text-slate-400">
                支持域名后缀、精准域名、IP段、地理分类匹配
              </span>
            </div>

            <div className="grid grid-cols-12 gap-3.5 text-xs">
              <div className="col-span-12 md:col-span-3">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1.5">
                  规则匹配类型
                </label>
                <select
                  value={newRuleType}
                  onChange={(e) => setNewRuleType(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 font-mono"
                >
                  <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀匹配)</option>
                  <option value="DOMAIN">DOMAIN (精准全域名匹配)</option>
                  <option value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键词)</option>
                  <option value="IP-CIDR">IP-CIDR (IP 网段匹配)</option>
                  <option value="GEOIP">GEOIP (地理 IP 库)</option>
                  <option value="GEOSITE">GEOSITE (域名集合分类)</option>
                </select>
              </div>

              <div className="col-span-12 md:col-span-5">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1.5">
                  匹配值 (域名/CIDR/关键词)
                </label>
                <input
                  type="text"
                  placeholder="例如: google.com 或 10.0.0.0/8"
                  value={newRuleValue}
                  onChange={(e) => setNewRuleValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCustomRule();
                    }
                  }}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 font-mono select-text cursor-text relative z-10"
                />
              </div>

              <div className="col-span-12 md:col-span-2">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1.5">
                  出站目标策略
                </label>
                <select
                  value={newRuleTarget}
                  onChange={(e) => setNewRuleTarget(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 font-mono"
                >
                  <option value="🚀 节点选择">🚀 节点选择 (Proxy)</option>
                  <option value="DIRECT">DIRECT (直连)</option>
                  <option value="REJECT">REJECT (拦截)</option>
                  {chains.length > 0 && <option value="🔗 链式代理">🔗 链式代理 (汇总组)</option>}
                  {chains
                    .filter((c) => c.enabled !== false)
                    .map((c) => {
                      const chainName = c.name.startsWith('🔗') ? c.name : `🔗 ${c.name}`;
                      return (
                        <option key={c.id} value={chainName}>
                          {chainName}
                        </option>
                      );
                    })}
                </select>
              </div>

              <div className="col-span-12 md:col-span-2 flex items-end">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleAddCustomRule}
                  icon={<Plus className="w-3.5 h-3.5" />}
                  className="w-full justify-center"
                >
                  添加规则
                </Button>
              </div>
            </div>
          </Card>

          {/* 用户已配置的自定义规则列表 (条带式规则磁贴) */}
          <Card className="flex flex-col gap-3.5 p-5 bg-white dark:bg-[#181c26]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                <span>用户自定义规则清单</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 font-mono font-semibold">
                  {customRules.length} 条
                </span>
              </span>
              {customRules.length > 0 && (
                <button
                  onClick={handleClearAllCustomRules}
                  className="text-xs text-rose-500 hover:underline flex items-center gap-1 font-medium"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 清空自定义规则
                </button>
              )}
            </div>

            {customRules.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                暂无自定义分流规则，所有流量将按照下方预设基础规则自动分流。
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {customRules.map((ruleStr, idx) => {
                  const parts = ruleStr.split(',');
                  const type = parts[0] || '';
                  const payload = parts[1] || '';
                  const target = parts[2] || '';

                  return (
                    <div
                      key={idx}
                      className="px-4 py-3 rounded-2xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/5 flex items-center justify-between font-mono text-xs hover:border-slate-200 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400 w-6 text-right font-bold">
                          #{idx + 1}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-200/80 dark:bg-white/10 text-slate-700 dark:text-slate-300">
                          {type}
                        </span>
                        <span className="font-bold text-slate-900 dark:text-slate-100 text-sm font-sans">
                          {payload}
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <span
                          className={`text-xs px-3 py-1 rounded-full font-bold border ${
                            target === 'DIRECT'
                              ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-500/15 dark:text-emerald-400'
                              : target === 'REJECT'
                              ? 'bg-rose-50 text-rose-600 border-rose-200/60 dark:bg-rose-500/15 dark:text-rose-400'
                              : 'bg-blue-50 text-blue-600 border-blue-200/60 dark:bg-blue-500/15 dark:text-blue-400'
                          }`}
                        >
                          {target}
                        </span>

                        <button
                          onClick={() => handleDeleteCustomRule(idx)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                          title="删除规则"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 预设系统基础规则 */}
          <Card className="flex flex-col gap-3.5 p-5 bg-white dark:bg-[#181c26]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>系统内置基础分流规则 (由 NexLink 核心引擎自动兜底)</span>
              </span>
              <span className="text-xs text-slate-400">只读基础策略</span>
            </div>

            <div className="flex flex-col gap-2">
              {BASE_RULES.map((b, idx) => (
                <div
                  key={idx}
                  className="px-4 py-2.5 rounded-2xl bg-slate-50/50 dark:bg-white/[0.01] border border-slate-100 dark:border-white/5 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                      {b.rule}
                    </span>
                    <span className="text-xs text-slate-400 font-sans">{b.desc}</span>
                  </div>

                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-bold border ${
                      b.target === 'DIRECT'
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60'
                        : b.target === 'REJECT'
                        ? 'bg-rose-50 text-rose-600 border-rose-200/60'
                        : 'bg-blue-50 text-blue-600 border-blue-200/60'
                    }`}
                  >
                    {b.target}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* TAB 2: DNS 解析器配置 */}
      {activeTab === 'dns' && (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-4 p-5 bg-white dark:bg-[#181c26]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5">
              <div>
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                  Mihomo 内建 DNS 核心引擎
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  接管本地 DNS 解析，有效防止运营商劫持与 DNS 泄露
                </p>
              </div>
              <Switch checked={dnsEnable} onChange={handleToggleDns} size="md" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-2">
                  Fake-IP 模式 (增强模式)
                </span>
                <div className="flex gap-2">
                  {(['fake-ip', 'redir-host'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => handleChangeEnhancedMode(mode)}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                        enhancedMode === mode
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-white dark:bg-white/10 text-slate-600'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block mb-2">
                  主要上游 DNS 服务器 (Nameservers)
                </span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="例如: 223.5.5.5 或 doh 链接"
                    value={newNsInput}
                    onChange={(e) => setNewNsInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddNameserver();
                      }
                    }}
                    className="flex-1 px-3 py-1.5 rounded-xl bg-white dark:bg-black/20 border border-slate-200/60 text-xs font-mono select-text cursor-text relative z-10"
                  />
                  <Button variant="primary" size="sm" onClick={handleAddNameserver}>
                    添加
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {nameservers.map((ns, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-black/20 text-xs font-mono font-semibold text-slate-700 dark:text-slate-300 border border-slate-200/60"
                    >
                      <span>{ns}</span>
                      <button
                        onClick={() => handleDeleteNameserver(idx)}
                        className="text-slate-400 hover:text-rose-500"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>

                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block mt-4 mb-2">
                  后备保底 DNS (Fallbacks)
                </span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="例如: https://1.1.1.1/dns-query"
                    value={newFbInput}
                    onChange={(e) => setNewFbInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddFallback();
                      }
                    }}
                    className="flex-1 px-3 py-1.5 rounded-xl bg-white dark:bg-black/20 border border-slate-200/60 text-xs font-mono select-text cursor-text relative z-10"
                  />
                  <Button variant="secondary" size="sm" onClick={handleAddFallback}>
                    添加
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {fallbacks.map((fb, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-black/20 text-xs font-mono font-semibold text-slate-700 dark:text-slate-300 border border-slate-200/60"
                    >
                      <span>{fb}</span>
                      <button
                        onClick={() => handleDeleteFallback(idx)}
                        className="text-slate-400 hover:text-rose-500"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* TAB 3: 运行时 YAML 预览 */}
      {activeTab === 'yaml' && (
        <Card className="flex flex-col gap-3 p-5 bg-white dark:bg-[#181c26]">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5">
            <div>
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
                运行时 config.yaml 实时预览
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                底层 Mihomo 进程实际加载的完整生成配置文件
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchRuntimeYaml}
                loading={loadingYaml}
                icon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                刷新预览
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleCopyYaml}
                icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              >
                {copied ? '已复制' : '复制全文'}
              </Button>
            </div>
          </div>

          <pre className="text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto p-4 rounded-2xl bg-slate-50 dark:bg-black/30 border border-slate-100 dark:border-white/5 max-h-[500px] leading-relaxed">
            {runtimeYaml || '# 正在生成并读取运行时配置...'}
          </pre>
        </Card>
      )}
    </div>
  );
};
