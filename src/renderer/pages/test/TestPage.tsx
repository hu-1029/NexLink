import React, { useState } from 'react';
import { Button } from '../../components/common/Button';
import { CountryFlag } from '../../components/common/CountryFlag';
import { useProxyStore } from '../../store/useProxyStore';
import { getNodeCountry } from '../../../services/parser/country';
import {
  RotateCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';

interface ServiceItem {
  id: string;
  name: string;
  url: string;
  category: 'ai' | 'media' | 'social' | 'regional' | 'mainland';
  status: 'idle' | 'testing' | 'unlocked' | 'custom_only' | 'failed';
  statusText?: string;
  delay?: number;
  detail?: string;
}

// 补齐至 15 个核心主流服务，3 列 × 5 排完美对称，无任何落单空缺
const DEFAULT_SERVICES: ServiceItem[] = [
  // --- 排列 1：全球顶级 AI 生产力大模型 ---
  {
    id: 'chatgpt',
    name: 'ChatGPT Web',
    url: 'https://chatgpt.com',
    category: 'ai',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    category: 'ai',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    category: 'ai',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },

  // --- 排列 2：全球三大顶级影视流媒体 ---
  {
    id: 'youtube',
    name: 'YouTube Premium',
    url: 'https://www.youtube.com/premium',
    category: 'media',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'netflix',
    name: 'Netflix',
    url: 'https://www.netflix.com',
    category: 'media',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'disney',
    name: 'Disney+',
    url: 'https://www.disneyplus.com',
    category: 'media',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },

  // --- 排列 3：全球主流社交与开发者平台 (新增补齐) ---
  {
    id: 'twitter',
    name: 'Twitter / X',
    url: 'https://x.com',
    category: 'social',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://github.com',
    category: 'social',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    url: 'https://www.tiktok.com',
    category: 'social',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },

  // --- 排列 4：数字生活与音乐影音 ---
  {
    id: 'spotify',
    name: 'Spotify',
    url: 'https://www.spotify.com',
    category: 'media',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'prime',
    name: 'Prime Video',
    url: 'https://www.amazon.com/gp/video',
    category: 'media',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'muse',
    name: 'Muse AI (Copilot)',
    url: 'https://copilot.microsoft.com',
    category: 'ai',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },

  // --- 排列 5：大中华区特区流媒体与直连番剧 ---
  {
    id: 'bahamut',
    name: 'Bahamut Anime (动画疯)',
    url: 'https://ani.gamer.com.tw',
    category: 'regional',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'bilibili_hmt',
    name: '哔哩哔哩港澳台',
    url: 'https://api.bilibili.com/pgc/player/web/v2/playurl',
    category: 'regional',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
  {
    id: 'bilibili_cn',
    name: '哔哩哔哩大陆',
    url: 'https://www.bilibili.com',
    category: 'mainland',
    status: 'idle',
    statusText: '待检测',
    detail: '-- --',
  },
];

function getDisplayNodeName(nodeName: string): string {
  if (!nodeName) return '默认代理链路';
  // 如果包含 # 备注，取 # 后的内容
  if (nodeName.includes('#')) {
    const afterHash = nodeName.split('#').pop()?.trim();
    if (afterHash) return afterHash;
  }
  // 如果包含协议头，如 tuic:// 或 vless://
  if (nodeName.includes('://')) {
    const parts = nodeName.split('://');
    const prefix = parts[0];
    const rest = parts[1];
    const match = prefix.match(/^(.+?)(tuic|vless|vmess|hysteria2|hy2|trojan|ss|ssr)$/i);
    if (match && match[1]) {
      return match[1];
    }
    const atMatch = rest.match(/@([^:?]+):(\d+)/);
    if (atMatch) {
      return `${atMatch[1]}:${atMatch[2]}`;
    }
  }
  if (nodeName.length > 36) {
    return nodeName.slice(0, 32) + '...';
  }
  return nodeName;
}

export const TestPage: React.FC = () => {
  const { nodes, activeNodeId } = useProxyStore();
  const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];
  const { countryCode: activeCountry } = getNodeCountry(activeNode || {});
  const activeNodeName = activeNode?.name || '默认代理链路';
  const displayNodeName = getDisplayNodeName(activeNodeName);

  const [services, setServices] = useState<ServiceItem[]>(DEFAULT_SERVICES);
  const [isTestingAll, setIsTestingAll] = useState<boolean>(false);

  const unlockedCount = services.filter((s) => s.status === 'unlocked').length;

  const resetAll = () => {
    setServices(DEFAULT_SERVICES.map((s) => ({ ...s, status: 'idle', statusText: '待检测', detail: '-- --' })));
  };

  // 单个服务检测逻辑
  const testSingle = async (serviceId: string) => {
    const target = services.find((s) => s.id === serviceId);
    if (!target) return;

    setServices((prev) =>
      prev.map((s) =>
        s.id === serviceId
          ? { ...s, status: 'testing', statusText: '检测中...', detail: '正在握手通信...' }
          : s
      )
    );

    try {
      let delay = -1;
      if (window.nexlinkAPI?.core) {
        // 通过当前节点或代理组发起真实握手测速
        delay = await window.nexlinkAPI.core.testDelay('🚀 节点选择', target.url, 4000);
      } else {
        // 无核心接口直接返回超时，绝不伪造虚假测试延迟
        delay = -1;
      }

      setServices((prev) =>
        prev.map((s) => {
          if (s.id !== serviceId) return s;

          if (delay > 0 && delay < 4000) {
            // 特殊规则判断 (如特定地区流媒体)
            if (s.id === 'bilibili_hmt') {
              const isHmt = ['HK', 'MO', 'TW'].includes(activeCountry) || /港|澳|台/.test(activeNodeName);
              if (isHmt) {
                return {
                  ...s,
                  status: 'unlocked',
                  statusText: '可连通',
                  delay,
                  detail: `${delay} ms (${activeCountry})`,
                };
              }
              return {
                ...s,
                status: 'failed',
                statusText: '地区限制',
                delay,
                detail: `需港澳台节点 (${activeCountry})`,
              };
            }

            if (s.id === 'bahamut') {
              const isTw = activeCountry === 'TW' || /台|tw/i.test(activeNodeName);
              if (isTw) {
                return {
                  ...s,
                  status: 'unlocked',
                  statusText: '可连通',
                  delay,
                  detail: `${delay} ms (TW)`,
                };
              }
              return {
                ...s,
                status: 'failed',
                statusText: '地区限制',
                delay,
                detail: `需台湾节点 (${activeCountry})`,
              };
            }

            if (s.id === 'bilibili_cn') {
              return {
                ...s,
                status: 'unlocked',
                statusText: '国内直连',
                delay,
                detail: `${delay} ms (CN)`,
              };
            }

            // AI 服务地区限制判定
            if (s.id === 'chatgpt' || s.id === 'claude') {
              if (['CN', 'HK', 'RU'].includes(activeCountry)) {
                return {
                  ...s,
                  status: 'failed',
                  statusText: '地区不支持',
                  delay,
                  detail: `该地区限制 (${activeCountry})`,
                };
              }
            }

            return {
              ...s,
              status: 'unlocked',
              statusText: '可连通',
              delay,
              detail: `${delay} ms (${activeCountry})`,
            };
          } else {
            return {
              ...s,
              status: 'failed',
              statusText: '未解锁',
              detail: '连接超时 / 阻断',
            };
          }
        })
      );
    } catch {
      setServices((prev) =>
        prev.map((s) =>
          s.id === serviceId
            ? { ...s, status: 'failed', statusText: '检测失败', detail: '核心未就绪' }
            : s
        )
      );
    }
  };

  // 全部批量检测
  const testAll = async () => {
    if (isTestingAll) return;
    setIsTestingAll(true);

    const promises = services.map((s) => testSingle(s.id));
    await Promise.allSettled(promises);
    setIsTestingAll(false);
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-12">
      {/* 顶部标题与操作栏 (严格防止超长节点名挤压，保证横向大气不折行) */}
      <div className="flex items-center justify-between gap-4 pt-1 pb-1">
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <h1 className="text-2xl lg:text-3xl font-black tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
            解锁测试
          </h1>

          {/* 可连通统计计数 */}
          <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold tabular-nums whitespace-nowrap shrink-0">
            可连通 {unlockedCount} / {services.length}
          </span>

          {/* 当前测试出站节点徽章 (白底卡片质感，严格截断防撑爆) */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white dark:bg-[#181c26] border border-slate-900/[0.08] dark:border-white/10 shadow-xs text-xs font-bold text-slate-700 dark:text-slate-300 min-w-0 max-w-md shrink overflow-hidden">
            <span className="text-slate-400 font-medium whitespace-nowrap shrink-0">当前出站:</span>
            <CountryFlag countryCode={activeCountry} />
            <span className="font-mono whitespace-nowrap shrink-0">{activeCountry}</span>
            <span className="text-slate-600 dark:text-slate-300 font-bold truncate" title={activeNodeName}>
              {displayNodeName}
            </span>
          </div>
        </div>

        {/* 顶部右侧操作按钮区 (严格单行不压缩不折行) */}
        <div className="flex items-center gap-2.5 shrink-0 whitespace-nowrap">
          <Button
            variant="secondary"
            size="md"
            onClick={resetAll}
            disabled={isTestingAll}
            className="bg-white dark:bg-[#181c26] border border-slate-900/[0.08] dark:border-white/10 hover:bg-slate-50 text-slate-600 dark:text-slate-300 shadow-xs rounded-2xl whitespace-nowrap shrink-0 h-10 px-4 font-semibold"
          >
            重置
          </Button>

          <Button
            variant="primary"
            size="md"
            onClick={testAll}
            loading={isTestingAll}
            icon={<RotateCw className={`w-3.5 h-3.5 shrink-0 ${isTestingAll ? 'animate-spin' : ''}`} />}
            className="shadow-sm shadow-blue-500/20 whitespace-nowrap shrink-0 font-bold rounded-2xl h-10 px-5 text-xs"
          >
            {isTestingAll ? '正在测试...' : '测试全部'}
          </Button>
        </div>
      </div>

      {/* 3 列 × 5 排 卡片网格布局 (大字体、加黑、大气通透、不局促) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
        {services.map((item) => {
          const isTesting = item.status === 'testing';

          return (
            <div
              key={item.id}
              className="glow-card p-5 lg:p-6 rounded-2xl bg-white dark:bg-[#181c26] shadow-[0_2px_16px_rgba(0,0,0,0.03)] flex flex-col justify-between"
            >
              <div>
                {/* 顶部服务标题 (加粗放大) 与单项刷新按钮 */}
                <div className="flex items-center justify-between">
                  <span className="font-black text-slate-900 dark:text-white text-base lg:text-[17px] tracking-tight">
                    {item.name}
                  </span>
                  <button
                    onClick={() => testSingle(item.id)}
                    disabled={isTesting || isTestingAll}
                    title="单独测试此项"
                    className="w-8 h-8 rounded-full border border-blue-400/35 hover:border-blue-500 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/15 flex items-center justify-center transition-all cursor-pointer disabled:opacity-40"
                  >
                    <RotateCw className={`w-4 h-4 ${isTesting ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {/* 状态徽章胶囊 (更大、更黑、视觉醒目) */}
                <div className="mt-4">
                  {item.status === 'idle' && (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-slate-400" />
                      <span>待检测</span>
                    </span>
                  )}

                  {item.status === 'testing' && (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                      <span>检测中...</span>
                    </span>
                  )}

                  {item.status === 'unlocked' && (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-600 border border-emerald-200/70 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/20">
                      <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
                      <span>{item.statusText || '可连通'}</span>
                    </span>
                  )}

                  {item.status === 'custom_only' && (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-50 text-amber-600 border border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20">
                      <AlertTriangle className="w-4 h-4 stroke-[2.5]" />
                      <span>{item.statusText || '仅自制剧'}</span>
                    </span>
                  )}

                  {item.status === 'failed' && (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-50 text-rose-600 border border-rose-200/70 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/20">
                      <XCircle className="w-4 h-4 stroke-[2.5]" />
                      <span>{item.statusText || '未解锁'}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* 虚线分割与底部延迟数值与评级 (字体加大加黑) */}
              <div className="mt-5 pt-3.5 border-t border-dashed border-slate-200 dark:border-white/10 flex items-center justify-between text-xs">
                <span className="font-mono text-sm font-bold text-slate-700 dark:text-slate-300 tabular-nums tracking-wide">
                  {item.detail || '-- --'}
                </span>
                {item.delay !== undefined && item.delay > 0 && (
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-md font-bold tracking-wide ${
                      item.delay < 350
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                        : item.delay < 800
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'
                    }`}
                  >
                    {item.delay < 350 ? '极佳' : item.delay < 800 ? '普通' : '较慢'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
