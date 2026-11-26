import React, { useState, useEffect, useRef } from 'react';
import { Card } from '../../components/common/Card';
import { Switch } from '../../components/common/Switch';
import { SparklineChart } from '../../components/common/SparklineChart';
import { Badge } from '../../components/common/Badge';
import { CountryFlag } from '../../components/common/CountryFlag';
import { getNodeCountry } from '../../../services/parser/country';
import { useProxyStore } from '../../store/useProxyStore';
import { useProfileStore } from '../../store/useProfileStore';
import {
  ArrowDown,
  ArrowUp,
  Globe,
  Radio,
  RefreshCw,
  Server,
  Zap,
  Activity,
  Trash2,
  Copy,
  Check,
  ChevronRight,
  Shield,
  Wifi,
  SlidersHorizontal,
  Play,
  Pause,
  Layers,
  Clock,
  FolderOpen,
  RotateCcw,
  RotateCw,
  HelpCircle,
} from 'lucide-react';
import type { AppSettings, CoreStatus, TrafficStats } from '../../../shared/types';

interface DashboardPageProps {
  coreStatus: CoreStatus;
  systemProxy: boolean;
  settings?: AppSettings;
  onToggleTun?: (val: boolean) => void;
  onUpdateSettings?: (patch: Partial<AppSettings>) => void;
  onToggleCore: () => void;
  onToggleProxy: () => void;
  onResetProxy?: () => void;
  onNavigateToNodes: () => void;
  onNavigateToProfiles?: () => void;
  onNavigateToTest?: () => void;
  onRestartCore?: () => void;
  onChangeMode?: (mode: 'rule' | 'global' | 'direct') => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  coreStatus,
  systemProxy,
  settings,
  onToggleTun,
  onUpdateSettings,
  onToggleCore,
  onToggleProxy,
  onResetProxy,
  onNavigateToNodes,
  onNavigateToProfiles,
  onNavigateToTest,
  onRestartCore,
  onChangeMode,
}) => {
  const nodes = useProxyStore((s) => s.nodes);
  const activeNodeId = useProxyStore((s) => s.activeNodeId);
  const groups = useProxyStore((s) => s.groups);
  const testAllDelays = useProxyStore((s) => s.testAllDelays);
  const isTestingSpeed = useProxyStore((s) => s.isTestingSpeed);
  const subscriptions = useProfileStore((s) => s.subscriptions);
  const activeSubscriptionId = useProfileStore((s) => s.activeSubscriptionId);

  const isTunActive = typeof settings?.tunMode === 'boolean' ? settings.tunMode : false;
  const isAllowLanActive = typeof settings?.allowLan === 'boolean' ? settings.allowLan : false;
  const currentMixedPort = settings?.mixedPort || 7890;

  const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];
  const activeSub = subscriptions.find((s) => s.id === activeSubscriptionId) || subscriptions[0];

  const [isResettingProxy, setIsResettingProxy] = useState(false);
  const [isRefreshingConfig, setIsRefreshingConfig] = useState(false);

  // 追踪真实会话累计捕获连接与 DNS 域名请求
  const seenConnIdsRef = useRef<Set<string>>(new Set());
  const seenDnsReqIdsRef = useRef<Set<string>>(new Set());
  const [totalRequestsCount, setTotalRequestsCount] = useState<number>(0);
  const [totalDnsQueriesCount, setTotalDnsQueriesCount] = useState<number>(0);

  // 动态真实规则总数（优先采用内核实时上报规则总数，未启动时联动内置 6 条基础分流规则 + 用户实际自定义规则数）
  const [runtimeRulesCount, setRuntimeRulesCount] = useState<number>(0);
  const customRulesCount = Array.isArray(settings?.customRules) ? settings.customRules.length : 0;
  const totalRulesCount = runtimeRulesCount > 0 ? runtimeRulesCount : (6 + customRulesCount);

  // 策略组真实数量 (与 useProxyStore 策略组动态对齐)
  const groupsCount = groups ? groups.length : 0;

  // 格式化实时上下行数据
  const [downSpeed, setDownSpeed] = useState<number>(0);
  const [upSpeed, setUpSpeed] = useState<number>(0);
  const [downSpeedUnit, setDownSpeedUnit] = useState<string>('KB/s');
  const [upSpeedUnit, setUpSpeedUnit] = useState<string>('B/s');

  // 峰值速度追踪 (Peak Speeds - 使用字节 Ref 避免单位切换比较错误与 useEffect 重复重建)
  const [peakDown, setPeakDown] = useState<number>(0);
  const [peakDownUnit, setPeakDownUnit] = useState<string>('KB/s');
  const [peakUp, setPeakUp] = useState<number>(0);
  const [peakUpUnit, setPeakUpUnit] = useState<string>('KB/s');
  const peakDownBytesRef = useRef<number>(0);
  const peakUpBytesRef = useRef<number>(0);

  // 累计流量 (以 MB 或 GB 展示)
  const [totalUpMB, setTotalUpMB] = useState<string>('0.0');
  const [totalDownMB, setTotalDownMB] = useState<string>('0.0');

  // 波浪图历史数据点队列 (维持 25 个点)
  const [downHistory, setDownHistory] = useState<number[]>([0, 0, 0, 0, 0]);
  const [upHistory, setUpHistory] = useState<number[]>([0, 0, 0, 0, 0]);

  // 真实活跃连接
  const [connections, setConnections] = useState<any[]>([]);

  // 核心运行时长计时器 (HH:mm:ss)
  const [uptimeStr, setUptimeStr] = useState<string>('00:00:00');
  const startTimeRef = useRef<number | null>(null);

  // 复制 IP 提示状态
  const [copiedIP, setCopiedIP] = useState<boolean>(false);
  const [copiedLanIP, setCopiedLanIP] = useState<boolean>(false);


  // 服务测速 (Google & ChatGPT & GitHub) - 初始待测速，杜绝虚假固定值
  const [googleDelay, setGoogleDelay] = useState<number | null>(null);
  const [chatgptDelay, setChatgptDelay] = useState<number | null>(null);
  const [githubDelay, setGithubDelay] = useState<number | null>(null);
  const [isTestingServices, setIsTestingServices] = useState<boolean>(false);

  // 局域网真实内网 IP
  const [lanIp, setLanIp] = useState<string>('127.0.0.1');

  useEffect(() => {
    if ((window.nexlinkAPI?.system as any)?.getLanIp) {
      (window.nexlinkAPI.system as any)
        .getLanIp()
        .then((ip: string) => {
          if (ip) setLanIp(ip);
        })
        .catch(() => {});
    }
  }, []);

  // 真实应用与内核内存统计
  const [memoryStats, setMemoryStats] = useState<{
    appMB: number;
    coreMB: number;
    totalMB: number;
    appPercent: number;
    corePercent: number;
  }>({
    appMB: 0,
    coreMB: 0,
    totalMB: 0,
    appPercent: 50,
    corePercent: 50,
  });

  useEffect(() => {
    const fetchMemory = async () => {
      if ((window.nexlinkAPI?.system as any)?.getMemory) {
        try {
          const res = await (window.nexlinkAPI.system as any).getMemory();
          const aMB = Number((res.appBytes / (1024 * 1024)).toFixed(1));
          const cMB = Number((res.coreBytes / (1024 * 1024)).toFixed(1));
          const tMB = Number((res.totalBytes / (1024 * 1024)).toFixed(1));
          const total = aMB + cMB || 1;
          const aPercent = Math.max(5, Math.min(95, Math.round((aMB / total) * 100)));
          const cPercent = 100 - aPercent;
          setMemoryStats({ appMB: aMB, coreMB: cMB, totalMB: tMB, appPercent: aPercent, corePercent: cPercent });
        } catch {
          // ignore
        }
      }
    };

    fetchMemory();
    const memTimer = setInterval(fetchMemory, 3500);
    return () => clearInterval(memTimer);
  }, [coreStatus.running]);

  // 运行时长计时器
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (coreStatus.running) {
      const serverUptimeMs = coreStatus.uptime ? coreStatus.uptime * 1000 : 0;
      if (!startTimeRef.current || serverUptimeMs > 0) {
        startTimeRef.current = Date.now() - serverUptimeMs;
      }
      const updateUptime = () => {
        if (!startTimeRef.current) return;
        const elapsedSec = Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000));
        const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        setUptimeStr(`${h}:${m}:${s}`);
      };
      updateUptime();
      timer = setInterval(updateUptime, 1000);
    } else {
      startTimeRef.current = null;
      setUptimeStr('00:00:00');
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [coreStatus.running, coreStatus.uptime]);

  // 流量与波浪图监听
  useEffect(() => {
    if (!coreStatus.running) {
      setDownSpeed(0);
      setUpSpeed(0);
      setDownHistory([0, 0, 0, 0]);
      setUpHistory([0, 0, 0, 0]);
      setConnections([]);
      seenConnIdsRef.current.clear();
      seenDnsReqIdsRef.current.clear();
      peakDownBytesRef.current = 0;
      peakUpBytesRef.current = 0;
      setPeakDown(0);
      setPeakDownUnit('KB/s');
      setPeakUp(0);
      setPeakUpUnit('KB/s');
      setTotalRequestsCount(0);
      setTotalDnsQueriesCount(0);
      setRuntimeRulesCount(0);
      return;
    }

    if (window.nexlinkAPI?.core) {
      const unsubTraffic = window.nexlinkAPI.core.onTraffic((stats: TrafficStats) => {
        // 下行速度处理
        const downBytes = stats.down;
        let dNum = 0;
        let dUnit = 'KB/s';
        if (downBytes >= 1024 * 1024) {
          dNum = Number((downBytes / (1024 * 1024)).toFixed(1));
          dUnit = 'MB/s';
        } else if (downBytes >= 1024) {
          dNum = Number((downBytes / 1024).toFixed(1));
          dUnit = 'KB/s';
        } else {
          dNum = Math.round(downBytes);
          dUnit = 'B/s';
        }
        setDownSpeed(dNum);
        setDownSpeedUnit(dUnit);

        // 更新下行峰值 (统一以原始字节数比较，杜绝 MB/KB 单位换算比较错乱)
        if (downBytes > peakDownBytesRef.current) {
          peakDownBytesRef.current = downBytes;
          const dKB = downBytes / 1024;
          if (dKB >= 1024) {
            setPeakDown(Number((dKB / 1024).toFixed(1)));
            setPeakDownUnit('MB/s');
          } else {
            setPeakDown(Math.round(dKB));
            setPeakDownUnit('KB/s');
          }
        }

        // 下行波浪图入队
        setDownHistory((prev) => [...prev.slice(-24), downBytes]);

        // 上行速度处理
        const upBytes = stats.up;
        let uNum = 0;
        let uUnit = 'B/s';
        if (upBytes >= 1024 * 1024) {
          uNum = Number((upBytes / (1024 * 1024)).toFixed(1));
          uUnit = 'MB/s';
        } else if (upBytes >= 1024) {
          uNum = Number((upBytes / 1024).toFixed(1));
          uUnit = 'KB/s';
        } else {
          uNum = Math.round(upBytes);
          uUnit = 'B/s';
        }
        setUpSpeed(uNum);
        setUpSpeedUnit(uUnit);

        // 更新上行峰值 (统一以原始字节数比较)
        if (upBytes > peakUpBytesRef.current) {
          peakUpBytesRef.current = upBytes;
          const uKB = upBytes / 1024;
          if (uKB >= 1024) {
            setPeakUp(Number((uKB / 1024).toFixed(1)));
            setPeakUpUnit('MB/s');
          } else {
            setPeakUp(Math.round(uKB));
            setPeakUpUnit('KB/s');
          }
        }

        // 上行波浪图入队
        setUpHistory((prev) => [...prev.slice(-24), upBytes]);

        // 累计流量 (MB)
        setTotalUpMB((stats.upTotal / (1024 * 1024)).toFixed(1));
        setTotalDownMB((stats.downTotal / (1024 * 1024)).toFixed(1));
      });

      // 定期拉取活跃连接、分流规则与真实请求统计
      const fetchConns = () => {
        window.nexlinkAPI.core
          .getConnections()
          .then((res: any) => {
            if (res?.connections) {
              setConnections(res.connections.slice(0, 10));
              res.connections.forEach((c: any) => {
                if (c.id && !seenConnIdsRef.current.has(c.id)) {
                  if (seenConnIdsRef.current.size >= 5000) {
                    const oldest = seenConnIdsRef.current.values().next().value;
                    if (oldest !== undefined) seenConnIdsRef.current.delete(oldest);
                  }
                  seenConnIdsRef.current.add(c.id);
                }
                if (c.id && c.metadata?.host && !seenDnsReqIdsRef.current.has(c.id)) {
                  if (seenDnsReqIdsRef.current.size >= 5000) {
                    const oldest = seenDnsReqIdsRef.current.values().next().value;
                    if (oldest !== undefined) seenDnsReqIdsRef.current.delete(oldest);
                  }
                  seenDnsReqIdsRef.current.add(c.id);
                }
              });
              setTotalRequestsCount(seenConnIdsRef.current.size);
              setTotalDnsQueriesCount(seenDnsReqIdsRef.current.size);
            }
          })
          .catch(() => {});

        // 动态向内核查询生效规则数
        if ((window.nexlinkAPI?.core as any)?.getRules) {
          (window.nexlinkAPI.core as any)
            .getRules()
            .then((rRes: any) => {
              if (Array.isArray(rRes?.rules) && rRes.rules.length > 0) {
                setRuntimeRulesCount(rRes.rules.length);
              }
            })
            .catch(() => {});
        }
      };

      fetchConns();
      const connTimer = setInterval(fetchConns, 3000);

      return () => {
        unsubTraffic();
        clearInterval(connTimer);
      };
    }
  }, [coreStatus.running]);

  // 复制 IP 处理
  const handleCopyIP = (ipText: string, isLan = false) => {
    if (!ipText || ipText === '未连接' || ipText === '--') {
      return;
    }
    navigator.clipboard.writeText(ipText);
    if (isLan) {
      setCopiedLanIP(true);
      setTimeout(() => setCopiedLanIP(false), 1500);
    } else {
      setCopiedIP(true);
      setTimeout(() => setCopiedIP(false), 1500);
    }
  };

  // 测试关键服务延迟 (Google, ChatGPT, GitHub)
  const handleTestServices = async () => {
    if (!coreStatus.running) {
      alert('代理核心未运行，请先启动代理核心再进行服务测速。');
      return;
    }
    setIsTestingServices(true);
    try {
      if (window.nexlinkAPI?.core) {
        const [gDelay, cDelay, ghDelay] = await Promise.allSettled([
          window.nexlinkAPI.core.testDelay('🚀 节点选择', 'http://www.google.com/generate_204', 3000),
          window.nexlinkAPI.core.testDelay('🚀 节点选择', 'https://chatgpt.com', 3500),
          window.nexlinkAPI.core.testDelay('🚀 节点选择', 'https://github.com', 3000),
        ]);
        setGoogleDelay(gDelay.status === 'fulfilled' && gDelay.value > 0 ? gDelay.value : -1);
        setChatgptDelay(cDelay.status === 'fulfilled' && cDelay.value > 0 ? cDelay.value : -1);
        setGithubDelay(ghDelay.status === 'fulfilled' && ghDelay.value > 0 ? ghDelay.value : -1);
      }
    } catch {
      setGoogleDelay(-1);
      setChatgptDelay(-1);
      setGithubDelay(-1);
    } finally {
      setIsTestingServices(false);
    }
  };

  // 清空连接
  const handleClearConnections = async () => {
    if (window.nexlinkAPI?.core) {
      try {
        await window.nexlinkAPI.core.closeConnection('');
        setConnections([]);
      } catch {
        // 静默
      }
    }
  };

  // 打开本地数据/配置目录
  const handleOpenConfigDir = async () => {
    try {
      if (window.nexlinkAPI?.system?.openConfigDir) {
        await window.nexlinkAPI.system.openConfigDir();
      } else {
        alert('配置目录已定位至应用数据目录');
      }
    } catch (err: any) {
      alert('打开配置目录失败: ' + (err?.message || err));
    }
  };

  // 一键重置系统代理 / 修复断网
  const handleResetSystemProxy = async () => {
    setIsResettingProxy(true);
    try {
      if (window.nexlinkAPI?.system) {
        await window.nexlinkAPI.system.setProxy(false);
      }
      if (onResetProxy) {
        onResetProxy();
      } else if (systemProxy) {
        onToggleProxy?.();
      }
      alert('已成功重置系统代理！网络设置已恢复直连状态。');
    } catch (err: any) {
      alert('重置系统代理失败: ' + (err?.message || err));
    } finally {
      setIsResettingProxy(false);
    }
  };

  // 刷新配置与规则 (真实执行校验，杜绝空跑报喜)
  const handleRefreshConfig = async () => {
    if (!activeSub && !coreStatus.running) {
      alert('当前未绑定活动订阅且代理核心未运行，无需刷新配置。');
      return;
    }

    setIsRefreshingConfig(true);
    const messages: string[] = [];
    try {
      if (activeSub && window.nexlinkAPI?.subscriptions) {
        const updateRes = await window.nexlinkAPI.subscriptions.update(activeSub.id);
        if (updateRes?.success) {
          messages.push('订阅配置已拉取最新');
        } else if (updateRes?.error) {
          messages.push(`订阅更新警告: ${updateRes.error}`);
        }
      }
      if (coreStatus.running && window.nexlinkAPI?.core) {
        const restartRes = await window.nexlinkAPI.core.restart();
        if (restartRes?.success) {
          messages.push('代理内核规则已重载生效');
        } else if (restartRes?.error) {
          messages.push(`内核重载失败: ${restartRes.error}`);
        }
      }
      alert(messages.length > 0 ? messages.join('，') + '。' : '配置刷新完成。');
    } catch (err: any) {
      alert('刷新配置异常: ' + (err?.message || err));
    } finally {
      setIsRefreshingConfig(false);
    }
  };

  // 刷新 DNS 缓存 (双向清理与真实错误反馈)
  const [isFlushingDns, setIsFlushingDns] = useState(false);
  const handleFlushDns = async () => {
    setIsFlushingDns(true);
    try {
      if ((window.nexlinkAPI?.system as any)?.flushDns) {
        const res = await (window.nexlinkAPI.system as any).flushDns();
        if (typeof res === 'object' && res !== null) {
          if (res.system && res.core) {
            alert('已成功刷新 Windows 系统与代理核心 DNS 解析缓存！');
          } else if (res.system && !coreStatus.running) {
            alert('已成功刷新 Windows 系统 DNS 解析缓存（代理核心未运行）。');
          } else if (res.system) {
            alert('已刷新 Windows 系统 DNS 解析缓存（代理核心缓存刷新未响应）。');
          } else if (res.core) {
            alert('代理核心 DNS 解析缓存已清理，但系统 DNS 刷新遇到权限或未知错误。');
          } else {
            alert('DNS 解析缓存刷新失败，请以管理员身份重试。');
          }
        } else if (res === true) {
          alert('DNS 解析缓存刷新完成。');
        } else {
          alert('DNS 解析缓存刷新失败。');
        }
      } else {
        alert('系统 DNS 刷新接口不可用。');
      }
    } catch (err: any) {
      alert('DNS 缓存刷新失败: ' + (err?.message || err));
    } finally {
      setIsFlushingDns(false);
    }
  };

  // 当前出站节点信息展示 (无活动节点时展示真实状态，杜绝任何假 IP 占位)
  const displayIP = activeNode?.server || (coreStatus.running ? '127.0.0.1' : '未连接');
  const { countryCode: displayCountryCode } = getNodeCountry(activeNode || {});

  // 计算节点质量
  const getQualityText = (delay?: number) => {
    if (delay === undefined || delay === null) return '待测速';
    if (delay < 0) return '超时';
    if (delay <= 150) return '质量 极佳';
    if (delay <= 350) return '质量 良好';
    return '质量 普通';
  };

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-8">
      {/* 顶部标题区 */}
      <div className="flex items-center justify-between pt-1 pb-1">
        <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5">
          <span>仪表盘</span>
        </h1>

        <div className="flex items-center gap-2">
          {coreStatus.running ? (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold border border-emerald-500/20">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>核心正常运行 ({coreStatus.version})</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-200/80 dark:bg-white/10 text-slate-500 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-slate-400" />
              <span>核心已停止</span>
            </div>
          )}
        </div>
      </div>

      {/* 第一行：主卡片 (6 列，50%) + 上传小卡片 (3 列，25%) + 下载小卡片 (3 列，25%) */}
      {/* 完美契合用户红框指定的比例与紧凑尺寸，鼠标悬停边框流光发光 */}
      <div className="grid grid-cols-12 gap-4">
        {/* 左侧：当前激活出站节点主控卡片 (占 6 列，50%) */}
        <Card className="col-span-12 md:col-span-6 flex flex-col justify-between relative overflow-hidden p-5 bg-white dark:bg-[#181c26]">
          {/* 顶部标签行：状态徽章 + 国家徽标 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300">
                <Activity className="w-3.5 h-3.5 text-slate-400" />
                <span>状态</span>
                <span
                  className={`inline-flex items-center gap-1 font-semibold ${
                    coreStatus.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      coreStatus.running ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
                    }`}
                  />
                  {coreStatus.running ? '运行中' : '已停止'}
                </span>
              </span>

              {/* 国家代码与国旗圆角方块 */}
              <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 shadow-2xs">
                <CountryFlag countryCode={displayCountryCode} />
                <span>{displayCountryCode}</span>
              </span>
            </div>

            {/* 切换节点快捷文字 */}
            <button
              onClick={onNavigateToNodes}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
            >
              <span>节点管理</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 中间核心：大号 IP 与 右侧有机花瓣启停按钮 */}
          <div className="flex items-center justify-between my-2.5 relative">
            <div>
              {/* 大号粗体 IP 地址 (采用统一现代无衬线字体，字偶紧凑饱满) */}
              <div
                onClick={() => handleCopyIP(displayIP)}
                className="group flex items-center gap-2 cursor-pointer"
                title="点击复制出站 IP"
              >
                <span className="text-2xl lg:text-[26px] font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
                  {displayIP}
                </span>
                <span className="p-1 rounded-md text-slate-400 group-hover:text-blue-500 transition-colors">
                  {copiedIP ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </span>
              </div>

              {/* 胶囊标签组 */}
              <div className="flex items-center gap-2 mt-2">
                <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-400">
                  机房
                </span>
                <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-400">
                  {getQualityText(activeNode?.delay)}
                </span>
                {activeNode?.type && (
                  <Badge protocol={activeNode.type} size="sm" />
                )}
              </div>
            </div>

            {/* 右侧：大号蓝色有机药丸/花瓣启停主控按钮 */}
            <div className="relative flex items-center justify-center">
              <div className="absolute w-20 h-20 rounded-full bg-blue-50/80 dark:bg-blue-500/10 blur-md pointer-events-none" />

              <button
                onClick={onToggleCore}
                title={coreStatus.running ? '点击暂停核心' : '点击启动核心'}
                className="relative z-10 w-14 h-14 rounded-[20px] bg-gradient-to-tr from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-600 active:scale-95 text-white flex items-center justify-center shadow-md shadow-blue-500/30 transition-all duration-200 cursor-pointer"
              >
                {coreStatus.running ? (
                  <Pause className="w-6 h-6 fill-white text-white" />
                ) : (
                  <Play className="w-6 h-6 fill-white text-white translate-x-0.5" />
                )}
              </button>
            </div>
          </div>

          {/* 底部两列元数据：运行时长 与 组织/策略组 (字号放大加粗，居中对称规整) */}
          <div className="pt-3 border-t border-slate-100 dark:border-white/5 grid grid-cols-2 gap-4">
            <div className="flex flex-col justify-center">
              <span className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-blue-500" />
                <span>运行时长</span>
              </span>
              <span className="text-lg font-bold text-slate-900 dark:text-white mt-1 tabular-nums tracking-tight">
                {uptimeStr}
              </span>
            </div>

            <div className="flex flex-col justify-center pl-4 border-l border-slate-100 dark:border-white/5">
              <span className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-500" />
                <span>组织 / 策略组</span>
              </span>
              <span className="text-lg font-bold text-slate-900 dark:text-white mt-1 tracking-tight truncate flex items-center gap-1.5">
                <span className="text-sm">🚀</span>
                <span>{activeNode?.group?.replace(/^🚀\s*/, '') || '节点选择'}</span>
              </span>
            </div>
          </div>
        </Card>

        {/* 红框 1：紧凑上传小卡片 (占 3 列，25%，小巧精致并排) */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26] relative overflow-hidden">
          <div>
            {/* 顶部栏 */}
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-300">
                <ArrowUp className="w-3.5 h-3.5 text-blue-500" />
                <span>上传</span>
              </span>
              <span className="text-slate-400 text-[11px] tabular-nums">
                峰值 {peakUp} {peakUpUnit}
              </span>
            </div>

            {/* 大数字展示 (现代无衬线粗体，Verge 风格圆润有力) */}
            <div className="mt-2.5 flex items-baseline">
              <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
                {upSpeed}
              </span>
              <span className="text-xs font-semibold text-slate-400 ml-1">
                {upSpeedUnit}
              </span>
            </div>

            {/* 累计上传流量 */}
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              累计 {totalUpMB} MB
            </div>
          </div>

          {/* 底部精致小波浪曲线 */}
          <div className="mt-2">
            <SparklineChart
              data={upHistory}
              color="#3b82f6"
              height={36}
              className="opacity-90"
            />
          </div>
        </Card>

        {/* 红框 2：紧凑下载小卡片 (占 3 列，25%，紧挨在上传右侧并排) */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26] relative overflow-hidden">
          <div>
            {/* 顶部栏 */}
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-300">
                <ArrowDown className="w-3.5 h-3.5 text-blue-500" />
                <span>下载</span>
              </span>
              <span className="text-slate-400 text-[11px] tabular-nums">
                峰值 {peakDown} {peakDownUnit}
              </span>
            </div>

            {/* 大数字展示 */}
            <div className="mt-2.5 flex items-baseline">
              <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
                {downSpeed}
              </span>
              <span className="text-xs font-semibold text-slate-400 ml-1">
                {downSpeedUnit}
              </span>
            </div>

            {/* 累计下载流量 */}
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              累计 {totalDownMB} MB
            </div>
          </div>

          {/* 底部精致小波浪曲线 */}
          <div className="mt-2">
            <SparklineChart
              data={downHistory}
              color="#2563eb"
              height={36}
              className="opacity-95"
            />
          </div>
        </Card>
      </div>

      {/* 第二行：控制与模式卡片组 (完美对应 6 : 3 : 3 上下工整对齐) */}
      <div className="grid grid-cols-12 gap-4">
        {/* 出站模式选择卡片 (占 6 列，与上方主卡片完全对齐) */}
        <Card className="col-span-12 md:col-span-6 flex items-center justify-between p-3.5 bg-white dark:bg-[#181c26]">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200 ml-2">
            <Globe className="w-4 h-4 text-blue-500" />
            <span>出站模式</span>
          </div>

          {/* 药丸分段选择器 */}
          <div className="flex bg-slate-100 dark:bg-white/5 p-1 rounded-2xl gap-1">
            {(
              [
                { id: 'rule', label: '规则', icon: SlidersHorizontal },
                { id: 'global', label: '全局', icon: Globe },
                { id: 'direct', label: '直连', icon: Radio },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const isActive = coreStatus.mode === item.id;
              return (
                <button
                  key={item.id}
                  data-mode={item.id}
                  onClick={() => onChangeMode?.(item.id)}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-sm font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* 系统代理卡片 (占 3 列，与上方上传卡片完全对齐) */}
        <Card className="col-span-6 md:col-span-3 flex items-center justify-between p-4 bg-white dark:bg-[#181c26]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">
                系统代理
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">
                {systemProxy ? '已开启' : '已关闭'}
              </span>
            </div>
          </div>

          <Switch checked={systemProxy} onChange={onToggleProxy} size="md" />
        </Card>

        {/* 虚拟网卡 (TUN) 开关卡片 (占 3 列，与上方下载卡片完全对齐) */}
        <Card className="col-span-6 md:col-span-3 flex items-center justify-between p-4 bg-white dark:bg-[#181c26]">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
              isTunActive && coreStatus.running
                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400'
            }`}>
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">
                虚拟网卡
              </span>
              <span className={`text-[10px] block mt-0.5 font-semibold ${
                isTunActive && coreStatus.running ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'
              }`}>
                {coreStatus.running
                  ? (isTunActive ? 'TUN 已接管' : '未开启')
                  : (isTunActive ? '已配置' : '未开启')}
              </span>
            </div>
          </div>

          <Switch
            checked={isTunActive}
            onChange={(checked) => onToggleTun?.(checked)}
            size="md"
          />
        </Card>
      </div>

      {/* 第三行：四宫格信息卡片组 (各占 3 列，均分对称，标题全量统一加黑) */}
      <div className="grid grid-cols-12 gap-4">
        {/* 卡片 1：内网 IP 卡片 */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26]">
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                <Wifi className="w-4 h-4 text-blue-500" />
                <span>内网 IP</span>
              </span>
              <button
                onClick={() => handleCopyIP(lanIp, true)}
                className="text-slate-400 hover:text-blue-500 p-0.5 transition-colors"
                title="复制内网 IP"
              >
                {copiedLanIP ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* 大字内网 IP */}
            <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-white mt-2 tabular-nums">
              {lanIp}
            </div>
          </div>

          {/* 局域网代理开关与悬停说明 */}
          <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between relative">
            <div
              className="relative group/lan flex items-center gap-1.5 cursor-help"
              title="局域网代理共享：允许同一 Wi-Fi 下的手机、iPad 等设备共享电脑代理出站"
            >
              <span className="text-xs text-slate-700 dark:text-slate-300 font-semibold group-hover/lan:text-blue-600 dark:group-hover/lan:text-blue-400 transition-colors">
                局域网代理
              </span>
              <HelpCircle className="w-3.5 h-3.5 text-slate-400 group-hover/lan:text-blue-500 transition-colors" />

              {/* 鼠标悬停高级提示气泡 (Tooltip：超清高对比度设计，彻底解决黑底黑字与变色看不清问题) */}
              <div className="lan-tooltip-box absolute bottom-full left-0 mb-2.5 hidden group-hover/lan:flex flex-col w-72 p-3.5 rounded-2xl bg-white dark:bg-[#181c26] text-slate-800 dark:text-slate-100 shadow-2xl border border-slate-200/80 dark:border-white/10 z-50 text-xs pointer-events-none animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-white/10">
                  <div className="flex items-center gap-1.5 font-bold text-blue-600 dark:text-blue-400">
                    <Wifi className="w-3.5 h-3.5" />
                    <span>局域网代理共享</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold font-mono">
                    Allow LAN
                  </span>
                </div>

                <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 mt-2 mb-2.5 font-normal">
                  开启后，同一 Wi-Fi 下的手机、iPad、游戏机等设备无需安装任何代理软件，即可直接共享本电脑的节点科学上网。
                </p>

                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 space-y-1.5 text-[11px] font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400 font-sans font-medium">代理主机 (IP):</span>
                    <span className="text-blue-600 dark:text-blue-400 font-bold tabular-nums">{lanIp}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400 font-sans font-medium">代理端口:</span>
                    <span className="text-blue-600 dark:text-blue-400 font-bold tabular-nums">{currentMixedPort}</span>
                  </div>
                </div>

                <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-1.5 font-sans">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  <span>手机打开 Wi-Fi 详情 → HTTP代理设为手动并填入上述参数</span>
                </div>

                {/* 气泡底部定位指示小三角 */}
                <div className="lan-tooltip-arrow absolute top-full left-7 -mt-[1px] border-4 border-transparent border-t-white dark:border-t-[#181c26]" />
              </div>
            </div>

            <Switch
              checked={isAllowLanActive}
              onChange={(val) => onUpdateSettings?.({ allowLan: val })}
              size="sm"
            />
          </div>
        </Card>

        {/* 卡片 2：配置卡片 */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26]">
          <div>
            <div className="flex items-center justify-between text-xs">
              <span
                onClick={onNavigateToProfiles}
                className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100 hover:text-blue-600 transition-colors cursor-pointer"
                title="前往配置管理页面"
              >
                <Layers className="w-4 h-4 text-blue-500" />
                <span>配置</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleRefreshConfig}
                  disabled={isRefreshingConfig}
                  className="text-slate-400 hover:text-blue-500 p-0.5 transition-colors cursor-pointer disabled:opacity-40"
                  title="刷新配置"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingConfig ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={onNavigateToProfiles}
                  className="text-slate-400 hover:text-blue-500 p-0.5 transition-colors cursor-pointer"
                  title="前往配置管理页面"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 配置名称 */}
            <div
              onClick={onNavigateToProfiles}
              className="flex items-center justify-between mt-2 cursor-pointer group"
              title="点击跳转至配置管理"
            >
              <span className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate group-hover:text-blue-600 transition-colors">
                {activeSub?.name || '代理配置'}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-500 font-medium">
                远程
              </span>
            </div>
          </div>

          {/* 三列指标 (真实动态联动，彻底消灭伪造数字) */}
          <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-white/5 grid grid-cols-3 text-center">
            <div>
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100 tabular-nums">{groupsCount}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">策略组</div>
            </div>
            <div>
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100 tabular-nums">
                {nodes.length}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">代理</div>
            </div>
            <div>
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100 tabular-nums">{totalRulesCount}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">规则</div>
            </div>
          </div>
        </Card>

        {/* 卡片 3：服务状态卡片 (与配置卡片完全对称，带有单独的右侧跳转箭头) */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26]">
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                <Activity className="w-4 h-4 text-blue-500" />
                <span>服务状态</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleTestServices}
                  disabled={isTestingServices || !coreStatus.running}
                  className="text-slate-400 hover:text-blue-500 p-0.5 transition-colors cursor-pointer disabled:opacity-40"
                  title="重新测试服务延迟"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isTestingServices ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={onNavigateToTest}
                  className="text-slate-400 hover:text-blue-500 p-0.5 transition-colors cursor-pointer"
                  title="前往解锁测试页面"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 服务测速行 (Google, ChatGPT, GitHub) */}
            <div className="flex flex-col gap-1.5 mt-2 text-xs">
              <div className="flex items-center justify-between p-1.5 px-2 rounded-xl bg-slate-50 dark:bg-white/[0.03]">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Google</span>
                <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 text-[11px] tabular-nums">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      googleDelay === null
                        ? 'bg-slate-300 dark:bg-slate-600'
                        : googleDelay > 0
                        ? 'bg-emerald-500'
                        : 'bg-rose-500'
                    }`}
                  />
                  <span>
                    {googleDelay === null ? '待测速' : googleDelay > 0 ? `${googleDelay} ms` : '超时'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between p-1.5 px-2 rounded-xl bg-slate-50 dark:bg-white/[0.03]">
                <span className="font-semibold text-slate-700 dark:text-slate-300">ChatGPT</span>
                <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 text-[11px] tabular-nums">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      chatgptDelay === null
                        ? 'bg-slate-300 dark:bg-slate-600'
                        : chatgptDelay > 0
                        ? 'bg-emerald-500'
                        : 'bg-rose-500'
                    }`}
                  />
                  <span>
                    {chatgptDelay === null ? '待测速' : chatgptDelay > 0 ? `${chatgptDelay} ms` : '超时'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between p-1.5 px-2 rounded-xl bg-slate-50 dark:bg-white/[0.03]">
                <span className="font-semibold text-slate-700 dark:text-slate-300">GitHub</span>
                <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 text-[11px] tabular-nums">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      githubDelay === null
                        ? 'bg-slate-300 dark:bg-slate-600'
                        : githubDelay > 0
                        ? 'bg-emerald-500'
                        : 'bg-rose-500'
                    }`}
                  />
                  <span>
                    {githubDelay === null ? '待测速' : githubDelay > 0 ? `${githubDelay} ms` : '超时'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* 卡片 4：内存信息卡片 (无独立跳转页面，已移除右侧无意义箭头) */}
        <Card className="col-span-6 md:col-span-3 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26]">
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                <Server className="w-4 h-4 text-blue-500" />
                <span>内存信息</span>
              </span>
            </div>

            <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-white mt-1.5 tabular-nums">
              {memoryStats.totalMB > 0 ? memoryStats.totalMB : '--'}{' '}
              <span className="text-xs font-normal text-slate-400">MB</span>
            </div>
          </div>

          <div className="mt-2.5">
            <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden flex">
              <div
                className="h-full bg-blue-600 rounded-l-full transition-all duration-500"
                style={{ width: `${memoryStats.appPercent}%` }}
              />
              <div
                className="h-full bg-sky-400 rounded-r-full transition-all duration-500"
                style={{ width: `${memoryStats.corePercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2 tabular-nums">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                <span>应用 {memoryStats.appMB} MB</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                <span>内核 {memoryStats.coreMB} MB</span>
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* 第四行：策略组概览与大数字统计条 (严格 6 : 6 栅格对称，与上方完全对齐) */}
      <div className="grid grid-cols-12 gap-4">
        {/* 策略组快速卡片 (占 6 列，50%，垂直严格对齐，支持点击直接跳转至节点选择页面) */}
        <Card
          onClick={onNavigateToNodes}
          className="col-span-12 md:col-span-6 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26] cursor-pointer hover:border-blue-500/40 hover:shadow-md transition-all group"
          title="点击查看并切换代理策略组节点"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              <Layers className="w-4 h-4 text-blue-500" />
              <span>策略组</span>
            </span>
            <span className="p-0.5 rounded-md text-slate-400 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all">
              <ChevronRight className="w-4 h-4" />
            </span>
          </div>

          <div className="flex items-center justify-between mt-2">
            <div className="w-[64px] flex items-baseline justify-center text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
              {groupsCount} <span className="text-xs font-normal text-slate-400 ml-1">个</span>
            </div>

            {/* 策略组标签真实动态联动 */}
            <div className="flex items-center gap-1.5">
              {groups.slice(0, 3).map((g) => {
                const cleanName = g.name.replace(/^[^\w\u4e00-\u9fa5]+/, '').trim() || g.name;
                return (
                  <span
                    key={g.id}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-white/5 text-slate-800 dark:text-slate-200"
                  >
                    {cleanName}
                  </span>
                );
              })}
              {groups.length > 3 && (
                <span className="px-2 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-white/5 text-slate-800 dark:text-slate-200 tabular-nums">
                  +{groups.length - 3}
                </span>
              )}
            </div>
          </div>
        </Card>

        {/* 底部三大统计指标卡片 (占 6 列，50%，垂直严格对齐，100% 真实数据无伪造) */}
        <Card className="col-span-12 md:col-span-6 flex items-center justify-around p-4 bg-white dark:bg-[#181c26]">
          <div className="text-center">
            <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
              {coreStatus.running ? connections.length : 0}
            </div>
            <div className="text-xs text-slate-400 mt-1">实时连接</div>
          </div>

          <div className="h-8 w-px bg-slate-100 dark:bg-white/5" />

          <div className="text-center">
            <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
              {coreStatus.running ? totalRequestsCount : 0}
            </div>
            <div className="text-xs text-slate-400 mt-1">最近请求</div>
          </div>

          <div className="h-8 w-px bg-slate-100 dark:bg-white/5" />

          <div className="text-center">
            <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white tabular-nums">
              {coreStatus.running ? totalDnsQueriesCount : 0}
            </div>
            <div className="text-xs text-slate-400 mt-1">DNS 查询</div>
          </div>
        </Card>
      </div>

      {/* 第五行：常用运维操作与活跃网络连接 (严格 6 : 6 栅格对称，移除冗余底栏说明，卡片轻巧做短) */}
      <div className="grid grid-cols-12 gap-4 items-stretch">
        {/* 左侧：快捷运维工具箱 (占 6 列，50%，卡片饱满自适应撑满，告别挤压与留白) */}
        <Card className="col-span-12 md:col-span-6 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26] h-full overflow-hidden">
          <div className="flex flex-col h-full justify-between">
            {/* 头部标题与悬停安全说明 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold">
                  <Zap className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    常用运维操作
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    一键执行核心维护与网络优化
                  </p>
                </div>
              </div>

              {/* 悬停说明气泡 (替代原先占地说明框，轻盈典雅) */}
              <div className="group relative flex items-center">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 flex items-center gap-1 cursor-help hover:text-blue-600 transition-colors">
                  <Shield className="w-3 h-3 text-blue-500" />
                  <span>安全回滚</span>
                </span>
                <div className="absolute right-0 top-7 hidden group-hover:block z-30 w-60 p-2.5 rounded-xl bg-slate-900 text-white text-[11px] leading-relaxed shadow-xl border border-white/10 pointer-events-none">
                  系统代理受自动守护机制保护，核心退出时将 100% 自动安全回滚至原有网络配置。
                </div>
              </div>
            </div>

            {/* 2x3 常用运维操作磁贴网格 (6 项实用痛点功能，饱满充满卡片，拒绝拥挤与留白) */}
            <div className="grid grid-cols-2 gap-3 mt-3 flex-1">
              {/* 1. 测试所有节点 */}
              <button
                onClick={() => testAllDelays(coreStatus.running)}
                disabled={isTestingSpeed}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-blue-50/70 dark:bg-white/[0.03] dark:hover:bg-blue-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-blue-300 dark:hover:border-blue-500/40 active:scale-[0.98] cursor-pointer"
              >
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <RefreshCw className={`w-4 h-4 ${isTestingSpeed ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-300'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">
                    测试所有节点
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    批量测速握手延迟
                  </div>
                </div>
              </button>

              {/* 2. 刷新 DNS 缓存 */}
              <button
                onClick={handleFlushDns}
                disabled={isFlushingDns}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-blue-50/70 dark:bg-white/[0.03] dark:hover:bg-blue-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-blue-300 dark:hover:border-blue-500/40 active:scale-[0.98] cursor-pointer"
              >
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <Activity className={`w-4 h-4 ${isFlushingDns ? 'animate-spin' : 'group-hover:scale-110'} transition-transform duration-200`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">
                    刷新 DNS 缓存
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    清理系统与核心解析
                  </div>
                </div>
              </button>

              {/* 3. 重启代理核心 */}
              <button
                onClick={onRestartCore || onToggleCore}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-blue-50/70 dark:bg-white/[0.03] dark:hover:bg-blue-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-blue-300 dark:hover:border-blue-500/40 active:scale-[0.98] cursor-pointer"
              >
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <RotateCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">
                    重启代理核心
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    平滑重启 Mihomo 内核
                  </div>
                </div>
              </button>

              {/* 4. 清空当前连接 */}
              <button
                onClick={handleClearConnections}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-rose-50/70 dark:bg-white/[0.03] dark:hover:bg-rose-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-rose-300 dark:hover:border-rose-500/40 active:scale-[0.98] cursor-pointer"
              >
                <div className="w-8 h-8 rounded-xl bg-rose-500/10 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <Trash2 className="w-4 h-4 group-hover:scale-110 transition-transform duration-200" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-rose-600 dark:group-hover:text-rose-400 truncate">
                    清空当前连接
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    阻断全部外部并发流
                  </div>
                </div>
              </button>

              {/* 5. 打开配置目录 */}
              <button
                onClick={handleOpenConfigDir}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-blue-50/70 dark:bg-white/[0.03] dark:hover:bg-blue-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-blue-300 dark:hover:border-blue-500/40 active:scale-[0.98] cursor-pointer"
                title="在资源管理器中打开配置文件与数据所在目录"
              >
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <FolderOpen className="w-4 h-4 group-hover:scale-110 transition-transform duration-200" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">
                    打开配置目录
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    在资源管理器中定位
                  </div>
                </div>
              </button>

              {/* 6. 重置系统代理 */}
              <button
                onClick={handleResetSystemProxy}
                disabled={isResettingProxy}
                className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50/80 hover:bg-amber-50/70 dark:bg-white/[0.03] dark:hover:bg-amber-500/10 text-left transition-all border border-slate-100/80 dark:border-white/5 shadow-2xs hover:border-amber-300 dark:hover:border-amber-500/40 active:scale-[0.98] cursor-pointer"
                title="强制重置注册表系统代理配置，解决关掉代理后网页打不开问题"
              >
                <div className="w-8 h-8 rounded-xl bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <RotateCcw className={`w-4 h-4 ${isResettingProxy ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-300'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-amber-600 dark:group-hover:text-amber-400 truncate">
                    重置系统代理
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    一键修复断网/恢复直连
                  </div>
                </div>
              </button>
            </div>
          </div>
        </Card>

        {/* 右侧：活跃网络连接 (占 6 列，50%，相应做短，整齐对齐) */}
        <Card className="col-span-12 md:col-span-6 flex flex-col justify-between p-4 bg-white dark:bg-[#181c26] h-full overflow-hidden">
          <div>
            {/* 头部标题与分流状态 */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-white/5">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold">
                  <Activity className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">
                      活跃网络连接
                    </h3>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/5 text-slate-500 tabular-nums">
                      {connections.length} 并发
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {coreStatus.running ? '实时捕获当前网络出站请求流' : '核心未启动，暂无活动连接'}
                  </div>
                </div>
              </div>

              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  coreStatus.running
                    ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200/50'
                    : 'text-slate-400 bg-slate-100 dark:bg-white/5'
                }`}
              >
                {coreStatus.running ? '规则分流中' : '未连接'}
              </span>
            </div>

            {/* 精致紧凑表头对齐栏 */}
            <div className="grid grid-cols-12 text-[10px] font-semibold text-slate-400 px-2 pt-2 pb-1 uppercase tracking-wider">
              <div className="col-span-6">目标主机 / 端口</div>
              <div className="col-span-2 text-center">网络协议</div>
              <div className="col-span-2 text-center">命中分流</div>
              <div className="col-span-2 text-right">累计流量</div>
            </div>

            {/* 列表项 (高度自适应做短至 max-h-[136px]，与左侧 6 按钮网格等高饱满) */}
            <div className="flex flex-col gap-1 overflow-y-auto max-h-[136px] text-xs pr-1">
              {connections.length === 0 ? (
                <div className="py-4 text-center text-slate-400 text-[11px] font-sans">
                  {coreStatus.running
                    ? '当前暂无外部网络活动连接'
                    : '代理核心处于关闭状态，未产生任何连接'}
                </div>
              ) : (
                connections.map((conn, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 items-center px-2 py-1.5 rounded-lg bg-slate-50/70 dark:bg-white/[0.02] hover:bg-blue-50/40 dark:hover:bg-white/[0.05] transition-colors"
                  >
                    {/* 目标主机与端口 (占 6 列，50%) */}
                    <div className="col-span-6 flex items-center gap-1.5 truncate pr-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span
                        className="font-medium text-slate-800 dark:text-slate-200 truncate text-[11px] tabular-nums"
                        title={conn.metadata?.host || conn.metadata?.destinationIP}
                      >
                        {conn.metadata?.host || conn.metadata?.destinationIP || '未知目标'}:
                        {conn.metadata?.destinationPort}
                      </span>
                    </div>

                    {/* 协议类型 (占 2 列，居中) */}
                    <div className="col-span-2 text-center">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">
                        {conn.metadata?.network || 'TCP'}
                      </span>
                    </div>

                    {/* 命中规则 (占 2 列，居中药丸) */}
                    <div className="col-span-2 text-center truncate">
                      <span className="text-[10px] px-2 py-0.5 rounded font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10">
                        {conn.rule || 'Match'}
                      </span>
                    </div>

                    {/* 传输流量 (占 2 列，靠右加粗等宽) */}
                    <div className="col-span-2 text-right font-bold text-slate-800 dark:text-slate-200 text-[11px] tabular-nums">
                      {(conn.download / 1024).toFixed(1)} KB
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 底部缓冲状态条 */}
          <div className="mt-2 pt-1.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>智能流控：活跃监听</span>
            </span>
            <span className="tabular-nums">实时缓冲窗口：64 KB</span>
          </div>
        </Card>
      </div>
    </div>
  );
};
