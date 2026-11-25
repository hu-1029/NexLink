import React, { useState, useEffect } from 'react';
import { Card } from '../../components/common/Card';
import { Modal } from '../../components/common/Modal';
import { Button } from '../../components/common/Button';
import { Switch } from '../../components/common/Switch';
import {
  Cpu,
  Laptop,
  Moon,
  Network,
  RefreshCw,
  Shield,
  Sun,
  Zap,
  AppWindow,
  CheckSquare,
  Square,
  Search,
  Check,
  ShieldCheck,
  ArrowUpCircle,
  Download,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type {
  AppSettings,
  ThemeMode,
  TunServiceStatus,
  UwpAppItem,
  UpdateInfo,
  UpdateDownloadProgress,
  WintunDriverStatus,
} from '../../../shared/types';
import { applyThemeColors, getDefaultColorsForTheme } from '../../utils/themeManager';

interface SettingsPageProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onSelectTheme?: (mode: ThemeMode) => void;
  systemProxy: boolean;
  onToggleProxy: () => void;
  coreRunning: boolean;
  onToggleCore: () => void;
  onRestartCore?: () => void;
  settings?: AppSettings;
  appVersion?: string;
  coreVersion?: string;
  onToggleTun?: (val: boolean) => void;
  onUpdateSettings?: (patch: Partial<AppSettings>) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  theme,
  onToggleTheme,
  onSelectTheme,
  systemProxy,
  onToggleProxy,
  coreRunning,
  onToggleCore,
  onRestartCore,
  settings,
  appVersion,
  coreVersion,
  onToggleTun,
  onUpdateSettings,
}) => {
  const [tunMode, setTunMode] = useState(settings?.tunMode || false);
  const [autoLaunch, setAutoLaunch] = useState(settings?.autoLaunch || false);
  const [silentStart, setSilentStart] = useState(settings?.silentStart || false);
  const [mixedPort, setMixedPort] = useState(settings?.mixedPort || 7890);
  const [apiPort, setApiPort] = useState(settings?.apiPort || 9097);
  const [tunStack, setTunStack] = useState<'mixed' | 'gvisor' | 'system'>(settings?.tunStack || 'mixed');
  const [tunServiceStatus, setTunServiceStatus] = useState<TunServiceStatus | null>(null);
  const [wintunStatus, setWintunStatus] = useState<WintunDriverStatus | null>(null);
  const [isServiceBusy, setIsServiceBusy] = useState(false);
  const [isWintunBusy, setIsWintunBusy] = useState(false);
  const [tunActionMsg, setTunActionMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  // Windows UWP 回环免流状态管理
  const [isUwpModalOpen, setIsUwpModalOpen] = useState(false);
  const [uwpApps, setUwpApps] = useState<UwpAppItem[]>([]);
  const [uwpLoading, setUwpLoading] = useState(false);
  const [uwpSearch, setUwpSearch] = useState('');
  const [selectedSids, setSelectedSids] = useState<Set<string>>(new Set());
  const [uwpMessage, setUwpMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [isSavingUwp, setIsSavingUwp] = useState(false);

  // 内核版本与在线更新状态
  const [installedCoreVersion, setInstalledCoreVersion] = useState<string>('');
  const [coreState, setCoreState] = useState<{
    isUsingCustomCore: boolean;
    hasBackup: boolean;
    backupVersion?: string;
    bundledVersion: string;
  }>({ isUsingCustomCore: false, hasBackup: false, bundledVersion: '' });
  const [isUpdatingCore, setIsUpdatingCore] = useState(false);
  const [isRollingBackCore, setIsRollingBackCore] = useState(false);
  const [coreUpdateMsg, setCoreUpdateMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isUpdatingGeo, setIsUpdatingGeo] = useState(false);
  const [geoUpdateMsg, setGeoUpdateMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  const refreshCoreState = () => {
    window.nexlinkAPI?.core?.getCoreState?.().then((st) => {
      if (st) {
        if (st.currentVersion) setInstalledCoreVersion(st.currentVersion);
        setCoreState({
          isUsingCustomCore: st.isUsingCustomCore,
          hasBackup: st.hasBackup,
          backupVersion: st.backupVersion,
          bundledVersion: st.bundledVersion,
        });
      }
    }).catch(() => {});
  };

  useEffect(() => {
    refreshCoreState();
  }, []);

  useEffect(() => {
    const unsub = window.nexlinkAPI?.core?.onUpdateProgress?.((msg) => {
      setCoreUpdateMsg({ text: msg, type: 'info' });
    });
    return () => {
      unsub?.();
    };
  }, []);

  const handleUpdateCore = async () => {
    if (!window.nexlinkAPI?.core?.updateCore || isUpdatingCore || isRollingBackCore) return;
    setIsUpdatingCore(true);
    setCoreUpdateMsg({ text: '正在检查并拉取最新 Mihomo 内核...', type: 'info' });
    try {
      const res = await window.nexlinkAPI.core.updateCore();
      if (res.currentVersion && res.currentVersion !== 'unknown') {
        setInstalledCoreVersion(res.currentVersion);
      }
      if (res.success) {
        setCoreUpdateMsg({
          text: res.message,
          type: res.updated ? 'success' : 'info',
        });
        refreshCoreState();
        window.nexlinkAPI?.system?.getTunServiceStatus?.().then(setTunServiceStatus).catch(() => {});
      } else {
        setCoreUpdateMsg({ text: res.message || '更新内核失败', type: 'error' });
      }
    } catch (err: any) {
      setCoreUpdateMsg({ text: err?.message || '更新内核失败', type: 'error' });
    } finally {
      setIsUpdatingCore(false);
    }
  };

  const handleRollbackCore = async () => {
    if (!window.nexlinkAPI?.core?.rollbackCore || isUpdatingCore || isRollingBackCore) return;
    setIsRollingBackCore(true);
    setCoreUpdateMsg({ text: '正在回退内核版本...', type: 'info' });
    try {
      const res = await window.nexlinkAPI.core.rollbackCore();
      if (res.currentVersion && res.currentVersion !== 'unknown') {
        setInstalledCoreVersion(res.currentVersion);
      }
      setCoreUpdateMsg({
        text: res.message,
        type: res.success ? (res.updated ? 'success' : 'info') : 'error',
      });
      refreshCoreState();
      window.nexlinkAPI?.system?.getTunServiceStatus?.().then(setTunServiceStatus).catch(() => {});
    } catch (err: any) {
      setCoreUpdateMsg({ text: err?.message || '回退内核失败', type: 'error' });
    } finally {
      setIsRollingBackCore(false);
    }
  };

  const handleUpdateGeo = async () => {
    if (!window.nexlinkAPI?.core?.updateGeoDatabases || isUpdatingGeo) return;
    setIsUpdatingGeo(true);
    setGeoUpdateMsg({ text: '正在更新 GeoIP / GeoSite 规则库...', type: 'info' });
    try {
      const res = await window.nexlinkAPI.core.updateGeoDatabases();
      setGeoUpdateMsg({
        text: res.message,
        type: res.success ? 'success' : 'error',
      });
    } catch (err: any) {
      setGeoUpdateMsg({ text: err?.message || '更新 Geo 规则库失败', type: 'error' });
    } finally {
      setIsUpdatingGeo(false);
    }
  };

  // 软件更新管理状态
  const [autoUpdate, setAutoUpdate] = useState(
    settings?.autoUpdate !== false && settings?.autoCheckUpdate !== false
  );
  const [lastCheckUpdateAt, setLastCheckUpdateAt] = useState(settings?.lastCheckUpdateAt || 0);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isDownloadPromptOpen, setIsDownloadPromptOpen] = useState(false);
  const [pendingUpdateInfo, setPendingUpdateInfo] = useState<UpdateInfo | null>(null);

  const loadUwpApps = async () => {
    if (!window.nexlinkAPI?.system?.getUwpApps) return;
    setUwpLoading(true);
    try {
      const res = await window.nexlinkAPI.system.getUwpApps();
      if (Array.isArray(res)) {
        setUwpApps(res);
        const exempts = new Set<string>();
        res.forEach((app: UwpAppItem) => {
          if (app.isExempt) exempts.add(app.sid);
        });
        setSelectedSids(exempts);
      }
    } catch (err) {
      console.error('获取 UWP 应用列表失败:', err);
    } finally {
      setUwpLoading(false);
    }
  };

  const handleOpenUwpModal = () => {
    setIsUwpModalOpen(true);
    loadUwpApps();
  };

  const toggleUwpSelect = (sid: string) => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const filteredUwpApps = uwpApps.filter((app) => {
    const q = uwpSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      app.displayName.toLowerCase().includes(q) ||
      app.packageFamilyName.toLowerCase().includes(q) ||
      app.sid.toLowerCase().includes(q)
    );
  });

  const handleSelectAllFiltered = () => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      filteredUwpApps.forEach((a) => next.add(a.sid));
      return next;
    });
  };

  const handleDeselectAllFiltered = () => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      filteredUwpApps.forEach((a) => next.delete(a.sid));
      return next;
    });
  };

  const handleInvertFiltered = () => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      filteredUwpApps.forEach((a) => {
        if (next.has(a.sid)) next.delete(a.sid);
        else next.add(a.sid);
      });
      return next;
    });
  };

  const handleExemptAll = async () => {
    if (!window.nexlinkAPI?.system?.exemptAllUwp) return;
    setIsSavingUwp(true);
    try {
      const res = await window.nexlinkAPI.system.exemptAllUwp();
      if (res.success) {
        setUwpMessage({ text: '已一键全部豁免 Windows UWP 应用回环访问', type: 'success' });
        await loadUwpApps();
      } else {
        setUwpMessage({ text: `操作失败: ${res.error || '未知错误'}`, type: 'error' });
      }
    } catch (err: any) {
      setUwpMessage({ text: `操作失败: ${err.message}`, type: 'error' });
    } finally {
      setIsSavingUwp(false);
      setTimeout(() => setUwpMessage(null), 3500);
    }
  };

  const handleClearAll = async () => {
    if (!window.nexlinkAPI?.system?.clearAllUwp) return;
    if (!window.confirm('确定要清空所有 UWP 应用的回环豁免吗？所有 UWP 沙盒应用将恢复默认网络隔离。')) return;
    setIsSavingUwp(true);
    try {
      const res = await window.nexlinkAPI.system.clearAllUwp();
      if (res.success) {
        setUwpMessage({ text: '已清空所有应用豁免', type: 'success' });
        await loadUwpApps();
      } else {
        setUwpMessage({ text: `操作失败: ${res.error || '未知错误'}`, type: 'error' });
      }
    } catch (err: any) {
      setUwpMessage({ text: `操作失败: ${err.message}`, type: 'error' });
    } finally {
      setIsSavingUwp(false);
      setTimeout(() => setUwpMessage(null), 3500);
    }
  };

  const handleSaveUwp = async () => {
    if (!window.nexlinkAPI?.system?.saveUwpApps) return;
    setIsSavingUwp(true);
    try {
      const res = await window.nexlinkAPI.system.saveUwpApps(Array.from(selectedSids));
      if (res.success) {
        setUwpMessage({ text: 'UWP 应用回环豁免设置已保存并生效！', type: 'success' });
        await loadUwpApps();
        setTimeout(() => {
          setIsUwpModalOpen(false);
          setUwpMessage(null);
        }, 900);
      } else {
        setUwpMessage({ text: `保存失败: ${res.error || '未知错误'}`, type: 'error' });
      }
    } catch (err: any) {
      setUwpMessage({ text: `保存失败: ${err.message}`, type: 'error' });
    } finally {
      setIsSavingUwp(false);
    }
  };


  const [bypassList, setBypassList] = useState(
    settings?.bypassList ||
      'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>'
  );

  const refreshTunInfraStatus = async () => {
    try {
      if (window.nexlinkAPI?.system?.getTunServiceStatus) {
        const svc = await window.nexlinkAPI.system.getTunServiceStatus();
        setTunServiceStatus(svc);
      }
      if (window.nexlinkAPI?.system?.getWintunStatus) {
        const wt = await window.nexlinkAPI.system.getWintunStatus();
        setWintunStatus(wt);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshTunInfraStatus();
  }, []);

  const handleInstallService = async () => {
    if (!window.nexlinkAPI?.system?.installTunService) return;
    setIsServiceBusy(true);
    setTunActionMsg(null);
    try {
      const res = await window.nexlinkAPI.system.installTunService();
      if (res.success) {
        setTunActionMsg({ text: '虚拟网卡服务安装成功，现在可直接免管理员开关 TUN！', type: 'success' });
      } else {
        setTunActionMsg({ text: res.error || '服务安装失败', type: 'error' });
      }
      await refreshTunInfraStatus();
    } catch (err: any) {
      setTunActionMsg({ text: err?.message || '服务安装异常', type: 'error' });
    } finally {
      setIsServiceBusy(false);
    }
  };

  const handleUninstallService = async () => {
    if (!window.nexlinkAPI?.system?.uninstallTunService) return;
    if (!window.confirm('确定卸载虚拟网卡后台服务吗？卸载后普通权限下将无法直接启用 TUN 模式。')) return;
    setIsServiceBusy(true);
    setTunActionMsg(null);
    try {
      const res = await window.nexlinkAPI.system.uninstallTunService();
      if (res.success) {
        setTunActionMsg({ text: '虚拟网卡服务已安全卸载', type: 'success' });
      } else {
        setTunActionMsg({ text: res.error || '卸载失败', type: 'error' });
      }
      await refreshTunInfraStatus();
    } catch (err: any) {
      setTunActionMsg({ text: err?.message || '卸载异常', type: 'error' });
    } finally {
      setIsServiceBusy(false);
    }
  };

  const handleDownloadWintun = async () => {
    if (!window.nexlinkAPI?.system?.downloadWintun) return;
    setIsWintunBusy(true);
    setTunActionMsg(null);
    try {
      const res = await window.nexlinkAPI.system.downloadWintun();
      if (res.ok) {
        setTunActionMsg({ text: 'wintun.dll 虚拟网卡驱动已就绪！', type: 'success' });
      } else {
        setTunActionMsg({ text: res.error || '下载 wintun.dll 失败', type: 'error' });
      }
      await refreshTunInfraStatus();
    } catch (err: any) {
      setTunActionMsg({ text: err?.message || '下载驱动异常', type: 'error' });
    } finally {
      setIsWintunBusy(false);
    }
  };

  // 动态真实换肤色彩状态 (支持即时换色并持久化)
  const defaultColors = getDefaultColorsForTheme(theme);
  const [bgColor, setBgColor] = useState(settings?.customBg || defaultColors.bg);
  const [fgColor, setFgColor] = useState(settings?.customFg || defaultColors.fg);

  useEffect(() => {
    if (settings?.customBg) setBgColor(settings.customBg);
    if (settings?.customFg) setFgColor(settings.customFg);
  }, [settings?.customBg, settings?.customFg]);

  // 外部 settings 变化时同步回显
  useEffect(() => {
    if (settings) {
      if (typeof settings.tunMode === 'boolean') setTunMode(settings.tunMode);
      if (typeof settings.autoLaunch === 'boolean') setAutoLaunch(settings.autoLaunch);
      if (typeof settings.silentStart === 'boolean') setSilentStart(settings.silentStart);
      if (settings.mixedPort) setMixedPort(settings.mixedPort);
      if (settings.apiPort) setApiPort(settings.apiPort);
      if (settings.tunStack) setTunStack(settings.tunStack);
      if (typeof settings.bypassList === 'string' && settings.bypassList.trim()) {
        setBypassList(settings.bypassList);
      }
      if (typeof settings.autoUpdate === 'boolean') {
        setAutoUpdate(settings.autoUpdate);
      } else if (typeof settings.autoCheckUpdate === 'boolean') {
        setAutoUpdate(settings.autoCheckUpdate);
      }
      if (settings.lastCheckUpdateAt) setLastCheckUpdateAt(settings.lastCheckUpdateAt);
    }
  }, [settings]);

  useEffect(() => {
    if (window.nexlinkAPI?.system && !settings) {
      window.nexlinkAPI.system
        .getSettings()
        .then((s: AppSettings) => {
          if (s.mixedPort) setMixedPort(s.mixedPort);
          if (s.apiPort) setApiPort(s.apiPort);
          if (typeof s.tunMode === 'boolean') setTunMode(s.tunMode);
          if (typeof s.autoLaunch === 'boolean') setAutoLaunch(s.autoLaunch);
          if (typeof s.silentStart === 'boolean') setSilentStart(s.silentStart);
        })
        .catch(console.error);
    }
  }, [settings]);

  // 监听后台更新事件与下载进度
  useEffect(() => {
    if (!window.nexlinkAPI?.updater?.onUpdateStatus) return;
    const unsub = window.nexlinkAPI.updater.onUpdateStatus((status) => {
      setDownloadProgress(status);
      if (status.status === 'downloading') {
        setIsDownloading(true);
      } else if (status.status === 'downloaded') {
        setIsDownloading(false);
        setIsDownloaded(true);
      } else if (status.status === 'error') {
        setIsDownloading(false);
        setUpdateError(status.error || '下载更新包失败');
      } else if (status.status === 'available' && status.updateInfo) {
        setUpdateResult(status.updateInfo);
      }
    });
    return () => unsub?.();
  }, []);

  const handleCheckUpdate = async (isManual = true) => {
    void isManual;
    if (!window.nexlinkAPI?.updater) return;
    setIsCheckingUpdate(true);
    setUpdateError(null);
    try {
      const res = await window.nexlinkAPI.updater.checkUpdate();
      setUpdateResult(res);
      const now = Date.now();
      setLastCheckUpdateAt(now);
      handleUpdate({ lastCheckUpdateAt: now });
      if (res.error) {
        setUpdateError(res.error);
      } else if (res.hasUpdate) {
        setPendingUpdateInfo(res);
        if (!autoUpdate) {
          // 未开启自动更新：弹窗提示用户发现新版本，询问是否立即下载
          setIsDownloadPromptOpen(true);
        } else if (res.downloadUrl) {
          // 已开启自动更新：自动在后台开始下载
          handleStartDownload(res.downloadUrl);
        }
      }
    } catch (err: any) {
      setUpdateError(err.message || '检查更新失败');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleStartDownload = async (customUrl?: string) => {
    const url = customUrl || pendingUpdateInfo?.downloadUrl || updateResult?.downloadUrl;
    if (!window.nexlinkAPI?.updater || !url) return;
    setIsDownloading(true);
    setIsDownloaded(false);
    setUpdateError(null);
    try {
      const res = await window.nexlinkAPI.updater.downloadUpdate(url);
      if (!res.success) {
        setUpdateError(res.error || '下载失败');
        setIsDownloading(false);
      } else if (res.filePath) {
        setIsDownloaded(true);
        setIsDownloading(false);
      }
    } catch (err: any) {
      setUpdateError(err.message || '下载更新包异常');
      setIsDownloading(false);
    }
  };

  const handleCancelDownload = async () => {
    if (!window.nexlinkAPI?.updater) return;
    await window.nexlinkAPI.updater.cancelDownload();
    setIsDownloading(false);
  };

  const handleInstallUpdate = async () => {
    if (!window.nexlinkAPI?.updater) return;
    try {
      const res = await window.nexlinkAPI.updater.installUpdate();
      if (res && !res.success) {
        setUpdateError(res.error || '启动安装程序失败');
      }
    } catch (err: any) {
      setUpdateError(err.message || '启动安装程序异常');
    }
  };

  const handleOpenUrl = (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    if (window.nexlinkAPI?.updater?.openUrl) {
      window.nexlinkAPI.updater.openUrl(url).catch(console.error);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleToggleTun = async (val: boolean) => {
    setTunMode(val);
    if (onToggleTun) {
      onToggleTun(val);
      return;
    }
    if (onUpdateSettings) {
      onUpdateSettings({ tunMode: val });
    } else if (window.nexlinkAPI?.system) {
      window.nexlinkAPI.system.updateSettings({ tunMode: val }).catch(console.error);
    }
  };

  const handleUpdate = (patch: Partial<AppSettings>) => {
    if (onUpdateSettings) {
      onUpdateSettings(patch);
    } else if (window.nexlinkAPI?.system) {
      window.nexlinkAPI.system.updateSettings(patch).catch(console.error);
    }
  };

  const handleBgChange = (newBg: string) => {
    setBgColor(newBg);
    applyThemeColors(newBg, fgColor);
    handleUpdate({ customBg: newBg });
  };

  const handleFgChange = (newFg: string) => {
    setFgColor(newFg);
    applyThemeColors(bgColor, newFg);
    handleUpdate({ customFg: newFg });
  };

  const handleSelectThemeMode = (mode: ThemeMode) => {
    const def = getDefaultColorsForTheme(mode);
    setBgColor(def.bg);
    setFgColor(def.fg);
    applyThemeColors(def.bg, def.fg);
    if (onSelectTheme) {
      onSelectTheme(mode);
      handleUpdate({ customBg: def.bg, customFg: def.fg });
    } else {
      onToggleTheme();
      handleUpdate({ theme: mode, customBg: def.bg, customFg: def.fg });
    }
  };

  const isCurrentTunActive = typeof settings?.tunMode === 'boolean' ? settings.tunMode : tunMode;

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-8">
      {/* 顶部标题栏 (去除多余即时生效文字与胶囊，保持极简大气) */}
      <div className="pt-1 pb-1">
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5">
            <span>系统设置</span>
          </h1>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold tabular-nums">
            {coreVersion || 'Mihomo Meta v1.19.32'}
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          配置 Windows 系统代理联动、TUN 虚拟网卡模式、网络监听端口与底层 Mihomo 运行参数
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 卡片 1: Windows 系统代理与自动化 (标题加大加黑，视觉饱满通透) */}
        <Card className="flex flex-col p-5 bg-white dark:bg-[#181c26] h-full justify-between">
          <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 dark:border-white/5 shrink-0">
            <Shield className="w-4.5 h-4.5 text-blue-500 shrink-0" />
            <h3 className="text-sm lg:text-[15px] font-black text-slate-900 dark:text-slate-100 tracking-normal">
              WINDOWS 系统代理与自动化
            </h3>
          </div>

          <div className="flex flex-col gap-3.5 flex-1 justify-between">
            {/* 系统代理 */}
            <div className="flex items-center justify-between py-1">
              <div>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                  设置系统代理
                </span>
                <span className="text-xs text-slate-400 block mt-0.5">
                  自动配置 Windows 注册表并支持安全原始回滚
                </span>
              </div>
              <Switch checked={systemProxy} onChange={onToggleProxy} size="md" />
            </div>

            {/* 开机自动启动 */}
            <div className="flex items-center justify-between py-1 border-t border-slate-100 dark:border-white/5 pt-3">
              <div>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                  开机自动启动
                </span>
                <span className="text-xs text-slate-400 block mt-0.5">
                  登录 Windows 系统时自动在后台启动 NexLink
                </span>
              </div>
              <Switch
                checked={autoLaunch}
                onChange={(val) => {
                  setAutoLaunch(val);
                  handleUpdate({ autoLaunch: val });
                }}
                size="md"
              />
            </div>

            {/* 静默启动到托盘 */}
            <div className="flex items-center justify-between py-1 border-t border-slate-100 dark:border-white/5 pt-3">
              <div>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                  静默启动到托盘
                </span>
                <span className="text-xs text-slate-400 block mt-0.5">
                  启动时不弹出主窗口，直接最小化到系统托盘
                </span>
              </div>
              <Switch
                checked={silentStart}
                onChange={(val) => {
                  setSilentStart(val);
                  handleUpdate({ silentStart: val });
                }}
                size="md"
              />
            </div>

            {/* UWP 应用回环免流 */}
            <div className="border-t border-slate-100 dark:border-white/5 pt-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    Windows UWP 应用回环免流
                  </span>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    解除应用商店与沙盒应用对 127.0.0.1 代理的回环访问隔离
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleOpenUwpModal}
                    className="text-xs px-3 py-1.5 flex items-center gap-1.5 font-bold cursor-pointer"
                  >
                    <AppWindow className="w-3.5 h-3.5" />
                    管理应用列表
                  </Button>
                </div>
              </div>
            </div>

            {/* Mihomo 内核更新与回退 */}
            <div className="border-t border-slate-100 dark:border-white/5 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    Mihomo 内核版本更新
                  </span>
                  <span className="text-xs font-mono text-slate-400 block mt-0.5">
                    当前版本: {installedCoreVersion || 'v1.19.29'}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {(coreState.isUsingCustomCore || coreState.hasBackup) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRollbackCore}
                      loading={isRollingBackCore}
                      disabled={isUpdatingCore}
                      className="text-xs px-2.5 py-1.5 font-bold cursor-pointer shrink-0"
                      title={
                        coreState.hasBackup
                          ? `回退到上一版备份 (${coreState.backupVersion || '上一版'})`
                          : `还原为软件内置稳定版 (${coreState.bundledVersion || 'v1.19.29'})`
                      }
                    >
                      {isRollingBackCore ? '回退中...' : '回退'}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleUpdateCore}
                    loading={isUpdatingCore}
                    disabled={isRollingBackCore}
                    className="text-xs px-3 py-1.5 flex items-center gap-1.5 font-bold cursor-pointer shrink-0"
                    icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
                  >
                    {isUpdatingCore ? '更新中...' : '更新内核'}
                  </Button>
                </div>
              </div>
              {coreUpdateMsg && (
                <div
                  className={`mt-2 px-3 py-2 rounded-xl text-xs border ${
                    coreUpdateMsg.type === 'success'
                      ? 'bg-emerald-50/80 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-500/20'
                      : coreUpdateMsg.type === 'error'
                      ? 'bg-rose-50/80 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200/60 dark:border-rose-500/20'
                      : 'bg-blue-50/80 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-500/20'
                  }`}
                >
                  {coreUpdateMsg.text}
                </div>
              )}
            </div>

            {/* GeoIP / GeoSite 规则库热更新 */}
            <div className="border-t border-slate-100 dark:border-white/5 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    GeoIP / GeoSite 规则库
                  </span>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    保持国内外分流规则数据库最新，支持运行时免重启热更新
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleUpdateGeo}
                  loading={isUpdatingGeo}
                  className="text-xs px-3 py-1.5 flex items-center gap-1.5 font-bold cursor-pointer shrink-0"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                >
                  {isUpdatingGeo ? '更新中...' : '更新规则库'}
                </Button>
              </div>
              {geoUpdateMsg && (
                <div
                  className={`mt-2 px-3 py-2 rounded-xl text-xs border ${
                    geoUpdateMsg.type === 'success'
                      ? 'bg-emerald-50/80 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-500/20'
                      : geoUpdateMsg.type === 'error'
                      ? 'bg-rose-50/80 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200/60 dark:border-rose-500/20'
                      : 'bg-blue-50/80 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-500/20'
                  }`}
                >
                  {geoUpdateMsg.text}
                </div>
              )}
            </div>

            {/* 系统代理绕过白名单 */}
            <div className="border-t border-slate-100 dark:border-white/5 pt-3">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                系统代理绕过白名单 (ProxyOverride)
              </span>
              <textarea
                value={bypassList}
                onChange={(e) => setBypassList(e.target.value)}
                onBlur={(e) => handleUpdate({ bypassList: e.target.value })}
                rows={3}
                className="w-full p-3 rounded-2xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.08] dark:border-white/10 text-xs font-mono text-inherit focus:outline-none focus:ring-2 focus:ring-blue-500/30 leading-relaxed resize-none"
              />
            </div>
          </div>
        </Card>

        {/* 右侧上半部分组合栏：上半部分 TUN 模式 + 下半部分 软件版本与自动更新 (两卡片上下齐高并与左侧底部严格对齐) */}
        <div className="flex flex-col gap-4 h-full">
          {/* 上半部分: TUN 虚拟网卡模式 */}
          <Card className="flex-1 flex flex-col p-5 bg-white dark:bg-[#181c26]">
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 dark:border-white/5 shrink-0">
              <Network className="w-4.5 h-4.5 text-blue-500 shrink-0" />
              <h3 className="text-sm lg:text-[15px] font-black text-slate-900 dark:text-slate-100 tracking-normal">
                TUN 虚拟网卡模式 (全局接管)
              </h3>
            </div>

            <div className="flex flex-col gap-3.5 flex-1 justify-center">
              {/* 启用 TUN 模式 */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    启用 TUN 模式
                  </span>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    接管系统全部网络流量
                  </span>
                </div>
                <Switch checked={isCurrentTunActive} onChange={handleToggleTun} size="md" />
              </div>

              {/* 虚拟网卡服务模式 */}
              <div className="border-t border-slate-100 dark:border-white/5 pt-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      虚拟网卡服务
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                        tunServiceStatus?.reachable
                          ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                          : tunServiceStatus?.installed
                          ? 'bg-amber-50 text-amber-600 border-amber-200/60 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
                          : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'
                      }`}
                    >
                      {tunServiceStatus?.reachable
                        ? '服务已就绪'
                        : tunServiceStatus?.installed
                        ? '已安装未就绪'
                        : '未安装'}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    一次性安装系统服务，后续开关 TUN 零弹窗无需重启
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {tunServiceStatus?.reachable ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isServiceBusy}
                      onClick={handleUninstallService}
                      className="text-xs px-2.5 py-1 text-rose-600 dark:text-rose-400"
                    >
                      {isServiceBusy ? '处理中...' : '卸载服务'}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isServiceBusy}
                      onClick={handleInstallService}
                      className="text-xs px-2.5 py-1 font-bold"
                    >
                      {isServiceBusy ? '安装中...' : '一键安装服务'}
                    </Button>
                  )}
                </div>
              </div>

              {/* Wintun 虚拟网卡驱动状态 */}
              <div className="border-t border-slate-100 dark:border-white/5 pt-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      Wintun 虚拟网卡驱动
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                        wintunStatus?.ready
                          ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                          : 'bg-amber-50 text-amber-600 border-amber-200/60 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
                      }`}
                    >
                      {wintunStatus?.ready ? `已就绪 (${wintunStatus.arch})` : '待下载'}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    支持直连与本地代理隧道自动下载部署 wintun.dll
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isWintunBusy}
                  onClick={handleDownloadWintun}
                  className="text-xs px-2.5 py-1 shrink-0"
                >
                  {isWintunBusy ? '下载中...' : wintunStatus?.ready ? '校验驱动' : '下载驱动'}
                </Button>
              </div>

              {tunActionMsg && (
                <div
                  className={`p-2 rounded-xl text-xs font-medium ${
                    tunActionMsg.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/20'
                      : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/20'
                  }`}
                >
                  {tunActionMsg.text}
                </div>
              )}

              {/* TUN 协议栈 */}
              <div className="border-t border-slate-100 dark:border-white/5 pt-3 flex items-center justify-between">
                <div className="pr-3 min-w-0">
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    TUN 协议栈 (Stack)
                  </span>
                  <span className="text-xs text-slate-400 block mt-0.5 leading-relaxed">
                    Mixed 推荐默认均衡，gVisor 用户态兼容性好，System 原生系统栈吞吐最高
                  </span>
                </div>
                <select
                  value={tunStack}
                  onChange={(e) => {
                    const val = e.target.value as any;
                    setTunStack(val);
                    handleUpdate({ tunStack: val });
                  }}
                  className="px-3.5 py-2 rounded-xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.08] dark:border-white/10 text-xs font-semibold text-inherit focus:outline-none cursor-pointer shrink-0"
                >
                  <option value="mixed">Mixed (推荐/混合均衡)</option>
                  <option value="gvisor">gVisor (用户态/高兼容)</option>
                  <option value="system">System (系统原生/高性能)</option>
                </select>
              </div>
            </div>
          </Card>
          {/* 下半部分: 软件版本与自动更新 (自动填充右侧下半空间并与左侧底部严格对齐) */}
          <Card className="flex-1 flex flex-col p-5 bg-white dark:bg-[#181c26] justify-between">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/5 shrink-0">
              <div className="flex items-center gap-2.5">
                <ArrowUpCircle className="w-4.5 h-4.5 text-blue-500 shrink-0" />
                <h3 className="text-sm lg:text-[15px] font-black text-slate-900 dark:text-slate-100 tracking-normal">
                  软件版本与自动更新
                </h3>
              </div>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold border border-blue-500/20 shrink-0">
                v{appVersion || '0.1.0'}
              </span>
            </div>

            <div className="flex flex-col gap-3.5 flex-1 justify-center">
              {/* 1. 当前版本信息与检查更新按钮 */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      NexLink 客户端
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    {lastCheckUpdateAt
                      ? `上次检查: ${new Date(lastCheckUpdateAt).toLocaleString('zh-CN', { hour12: false })}`
                      : '上次检查: 从未检查'}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleCheckUpdate()}
                  disabled={isCheckingUpdate || isDownloading}
                  className="text-xs px-3 py-1.5 flex items-center gap-1.5 font-bold cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
                  {isCheckingUpdate ? '检查中...' : '检查更新'}
                </Button>
              </div>

              {/* 2. 自动更新开关 */}
              <div className="flex items-center justify-between py-1 border-t border-slate-100 dark:border-white/5 pt-3">
                <div>
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 block">
                    自动更新
                  </span>
                  <span className="text-xs text-slate-400 block mt-0.5">
                    后台自动检测并静默下载新版，完成后弹窗提示安装
                  </span>
                </div>
                <Switch
                  checked={autoUpdate}
                  onChange={(val) => {
                    setAutoUpdate(val);
                    handleUpdate({ autoUpdate: val, autoCheckUpdate: val });
                  }}
                  size="md"
                />
              </div>

              {/* 3. 检查状态展示区 */}
              {isCheckingUpdate && (
                <div className="p-2.5 rounded-xl bg-blue-500/5 border border-blue-500/15 text-xs text-blue-700 dark:text-blue-300 flex items-center gap-2 animate-pulse">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
                  <span>正在连接 GitHub 检查最新发布版本...</span>
                </div>
              )}

              {isDownloaded && (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="font-semibold">新版本安装包已下载就绪</span>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleInstallUpdate}
                    className="text-xs px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1"
                  >
                    立即安装
                  </Button>
                </div>
              )}

              {isDownloading && downloadProgress && (
                <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-center justify-between text-xs font-bold text-blue-700 dark:text-blue-300">
                    <div className="flex items-center gap-2">
                      <span>正在后台下载更新... {downloadProgress.percent || 0}%</span>
                      <button
                        type="button"
                        onClick={handleCancelDownload}
                        className="text-[10px] text-rose-500 hover:underline cursor-pointer font-bold"
                      >
                        取消
                      </button>
                    </div>
                    <span className="font-mono text-[11px]">
                      {downloadProgress.speed
                        ? `${(downloadProgress.speed / 1024 / 1024).toFixed(1)} MB/s`
                        : ''}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-blue-200/50 dark:bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-all duration-300 rounded-full"
                      style={{ width: `${downloadProgress.percent || 0}%` }}
                    />
                  </div>
                </div>
              )}

              {!isCheckingUpdate && !isDownloading && !isDownloaded && updateResult && !updateResult.hasUpdate && !updateError && (
                <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="font-medium">当前已是最新版本 (v{updateResult.currentVersion})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenUrl(updateResult.htmlUrl || 'https://github.com/hu-1029/NexLink/releases')}
                    className="text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1 font-bold cursor-pointer"
                  >
                    <span>发布页</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              )}

              {!isCheckingUpdate && updateError && (
                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-xs text-amber-700 dark:text-amber-300 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span className="truncate">{updateError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenUrl('https://github.com/hu-1029/NexLink/releases')}
                    className="text-[11px] text-amber-600 dark:text-amber-400 hover:underline shrink-0 flex items-center gap-1 font-bold cursor-pointer"
                  >
                    <span>GitHub</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              )}

              {!isCheckingUpdate && !isDownloading && !isDownloaded && updateResult?.hasUpdate && (
                <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-blue-600 text-white font-bold">
                        发现新版
                      </span>
                      <span className="text-xs font-bold text-slate-800 dark:text-white">
                        v{updateResult.latestVersion}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleStartDownload()}
                      className="text-xs px-2.5 py-1 font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      立即下载
                    </Button>
                  </div>
                  {updateResult.releaseNotes && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-300 max-h-20 overflow-y-auto leading-relaxed whitespace-pre-wrap bg-black/[0.03] dark:bg-black/20 p-2 rounded-lg font-sans">
                      {updateResult.releaseNotes}
                    </div>
                  )}
                </div>
              )}


            </div>
          </Card>
        </div>


        {/* 卡片 3: 代理核心与监听端口配置 (标题加大加黑，失焦即时保存) */}
        <Card className="flex flex-col gap-4 p-5 bg-white dark:bg-[#181c26]">
          <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 dark:border-white/5">
            <Zap className="w-4.5 h-4.5 text-blue-500 shrink-0" />
            <h3 className="text-sm lg:text-[15px] font-black text-slate-900 dark:text-slate-100 tracking-normal">
              代理核心与监听端口配置
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <div className="p-3.5 rounded-2xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.06] dark:border-white/10">
              <span className="text-xs font-semibold text-slate-500 block mb-1">
                混合代理端口
              </span>
              <input
                type="number"
                min={1}
                max={65535}
                value={mixedPort}
                onChange={(e) => setMixedPort(Number(e.target.value))}
                onBlur={() => {
                  if (mixedPort < 1 || mixedPort > 65535) {
                    alert('端口号必须在 1 - 65535 之间');
                    return;
                  }
                  if (mixedPort === apiPort) {
                    alert(`端口冲突: 混合代理端口与控制端口不能相同 (${mixedPort})`);
                    return;
                  }
                  handleUpdate({ mixedPort });
                }}
                className="w-full bg-black/[0.03] dark:bg-black/20 px-3 py-1.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-bold tabular-nums text-inherit focus:outline-none"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.06] dark:border-white/10">
              <span className="text-xs font-semibold text-slate-500 block mb-1">
                外部控制端口
              </span>
              <input
                type="number"
                min={1}
                max={65535}
                value={apiPort}
                onChange={(e) => setApiPort(Number(e.target.value))}
                onBlur={() => {
                  if (apiPort < 1 || apiPort > 65535) {
                    alert('端口号必须在 1 - 65535 之间');
                    return;
                  }
                  if (apiPort === mixedPort) {
                    alert(`端口冲突: 控制端口与混合代理端口不能相同 (${apiPort})`);
                    return;
                  }
                  handleUpdate({ apiPort });
                }}
                className="w-full bg-black/[0.03] dark:bg-black/20 px-3 py-1.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-bold tabular-nums text-inherit focus:outline-none"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.06] dark:border-white/10">
              <span className="text-xs font-semibold text-slate-500 block mb-1">
                SOCKS5 独立端口
              </span>
              <div className="w-full bg-black/[0.03] dark:bg-black/20 px-3 py-1.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-bold tabular-nums text-inherit">
                {mixedPort + 2 <= 65535 && mixedPort + 2 !== apiPort ? mixedPort + 2 : '集成于混合端口'}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-black/[0.04] dark:bg-white/5 border border-black/[0.06] dark:border-white/10">
              <span className="text-xs font-semibold text-slate-500 block mb-1">
                HTTP 独立端口
              </span>
              <div className="w-full bg-black/[0.03] dark:bg-black/20 px-3 py-1.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-bold tabular-nums text-inherit">
                {mixedPort + 1 <= 65535 && mixedPort + 1 !== apiPort ? mixedPort + 1 : '集成于混合端口'}
              </div>
            </div>
          </div>
        </Card>

        {/* 卡片 4: 核心运行控制与外观 (舒展大气排版，前背景色竖向排布，实时全局换肤) */}
        <Card className="flex flex-col gap-3.5 p-5 bg-white dark:bg-[#181c26]">
          <div>
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 dark:border-white/5">
              <Cpu className="w-4.5 h-4.5 text-blue-500 shrink-0" />
              <h3 className="text-sm lg:text-[15px] font-black text-slate-900 dark:text-slate-100 tracking-normal">
                核心运行控制与外观
              </h3>
            </div>

            {/* 1. Mihomo 核心运行状态与重启 */}
            <div className="flex items-center justify-between py-2.5 border-b border-slate-100 dark:border-white/5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                    Mihomo Meta 核心
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-semibold font-mono border ${
                      coreRunning
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-400'
                        : 'bg-amber-50 text-amber-600 border-amber-200/60 dark:bg-amber-500/10 dark:text-amber-400'
                    }`}
                  >
                    {coreRunning ? '运行中' : '已停止'}
                  </span>
                </div>
                <span className="text-xs font-mono text-slate-400 block mt-0.5">
                  {installedCoreVersion ? `Mihomo Meta ${installedCoreVersion}` : (coreVersion || 'Mihomo Meta v1.19.29')} with_gvisor
                </span>
              </div>
              <Button
                variant="secondary"
                size="md"
                onClick={coreRunning && onRestartCore ? onRestartCore : onToggleCore}
                icon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                {coreRunning ? '重启核心' : '启动核心'}
              </Button>
            </div>

            {/* 2. 界面色彩主题切换 (删除冗余文字，左右舒展排列) */}
            <div className="flex items-center justify-between py-2.5 border-b border-slate-100 dark:border-white/5">
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                界面色彩主题
              </span>

              {/* 三段式切换控制器 */}
              <div className="inline-flex p-1 rounded-2xl bg-black/[0.05] dark:bg-white/5 border border-black/[0.08] dark:border-white/10 shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => handleSelectThemeMode('system')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs transition-all cursor-pointer ${
                    theme === 'system'
                      ? 'bg-blue-600 text-white shadow-xs font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-blue-600 font-semibold'
                  }`}
                  title="自动跟随 Windows 系统的深浅色模式"
                >
                  <Laptop className="w-3.5 h-3.5" />
                  <span>跟随系统</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSelectThemeMode('light')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs transition-all cursor-pointer ${
                    theme === 'light'
                      ? 'bg-blue-600 text-white shadow-xs font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-blue-600 font-semibold'
                  }`}
                  title="始终使用浅色明亮模式"
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>浅色</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSelectThemeMode('dark')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs transition-all cursor-pointer ${
                    theme === 'dark'
                      ? 'bg-blue-600 text-white shadow-xs font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-blue-600 font-semibold'
                  }`}
                  title="始终使用深色暗夜模式"
                >
                  <Moon className="w-3.5 h-3.5" />
                  <span>深色</span>
                </button>
              </div>
            </div>
          </div>

          {/* 3. 外观色彩 (竖向上下排布，大气舒展，拒绝拥挤) */}
          <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-black/[0.03] dark:bg-black/20 divide-y divide-black/[0.05] dark:divide-white/5 overflow-hidden">
            {/* 背景色 (第一行) */}
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                背景色
              </span>
              <label className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/[0.06] dark:bg-white/10 border border-black/10 dark:border-white/15 text-xs font-mono text-slate-700 dark:text-slate-200 cursor-pointer hover:bg-black/[0.09] transition-colors shadow-2xs">
                <span
                  className="w-4 h-4 rounded-[4px] border border-black/20 dark:border-white/20 shadow-2xs shrink-0"
                  style={{ backgroundColor: bgColor }}
                />
                <span className="font-semibold tracking-wider"># {bgColor.replace('#', '')}</span>
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => handleBgChange(e.target.value.toUpperCase())}
                  className="sr-only"
                />
              </label>
            </div>

            {/* 前景色 (第二行) */}
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                前景色
              </span>
              <label className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/[0.06] dark:bg-white/10 border border-black/10 dark:border-white/15 text-xs font-mono text-slate-700 dark:text-slate-200 cursor-pointer hover:bg-black/[0.09] transition-colors shadow-2xs">
                <span
                  className="w-4 h-4 rounded-[4px] border border-black/20 dark:border-white/20 shadow-2xs shrink-0"
                  style={{ backgroundColor: fgColor }}
                />
                <span className="font-semibold tracking-wider"># {fgColor.replace('#', '')}</span>
                <input
                  type="color"
                  value={fgColor}
                  onChange={(e) => handleFgChange(e.target.value.toUpperCase())}
                  className="sr-only"
                />
              </label>
            </div>
          </div>
        </Card>
      </div>
      {/* Windows UWP 回环免流配置弹窗 */}
      <Modal
        isOpen={isUwpModalOpen}
        onClose={() => setIsUwpModalOpen(false)}
        title="Windows UWP 沙盒应用回环免流管理"
        maxWidth="2xl"
        footer={
          <div className="flex items-center justify-between w-full">
            <Button
              variant="secondary"
              size="sm"
              onClick={loadUwpApps}
              disabled={uwpLoading || isSavingUwp}
              className="text-xs flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${uwpLoading ? 'animate-spin' : ''}`} />
              重新扫描应用
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsUwpModalOpen(false)}
                className="text-xs"
              >
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveUwp}
                disabled={isSavingUwp}
                className="text-xs flex items-center gap-1.5"
              >
                {isSavingUwp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                保存并生效
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3 select-none">
          {/* 说明卡片 */}
          <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              Windows 系统对所有 Microsoft Store 及 UWP 应用强制实施 AppContainer 沙盒隔离，默认禁止访问本地 127.0.0.1 端口。勾选需要访问代理的应用，或直接点击下方“一键全部豁免”即可解决无法联网的问题。
            </div>
          </div>

          {/* 快捷批量操作条 */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10">
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleExemptAll}
                disabled={isSavingUwp}
                className="text-xs px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
              >
                一键全部豁免 (推荐)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClearAll}
                disabled={isSavingUwp}
                className="text-xs px-2.5 py-1 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 border-rose-200 dark:border-rose-500/20"
              >
                清空豁免
              </Button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
              共 <span className="font-bold text-slate-700 dark:text-slate-200">{uwpApps.length}</span> 个应用，已生效豁免 <span className="font-bold text-emerald-600 dark:text-emerald-400">{uwpApps.filter((a) => a.isExempt).length}</span> 个 (待保存已勾选 {selectedSids.size} 个)
            </div>
          </div>

          {/* 搜索与多选控制栏 */}
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={uwpSearch}
                onChange={(e) => setUwpSearch(e.target.value)}
                placeholder="搜索应用名称或包名..."
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-inherit focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0 text-xs">
              <button
                type="button"
                onClick={handleSelectAllFiltered}
                className="px-2 py-1 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 hover:bg-slate-200/60 dark:hover:bg-white/10 font-medium transition-colors cursor-pointer"
              >
                全选
              </button>
              <button
                type="button"
                onClick={handleDeselectAllFiltered}
                className="px-2 py-1 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 hover:bg-slate-200/60 dark:hover:bg-white/10 font-medium transition-colors cursor-pointer"
              >
                全不选
              </button>
              <button
                type="button"
                onClick={handleInvertFiltered}
                className="px-2 py-1 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 hover:bg-slate-200/60 dark:hover:bg-white/10 font-medium transition-colors cursor-pointer"
              >
                反选
              </button>
            </div>
          </div>

          {/* 提示信息 */}
          {uwpMessage && (
            <div
              className={`p-2.5 rounded-xl text-xs font-semibold text-center animate-in fade-in ${
                uwpMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20'
                  : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-500/20'
              }`}
            >
              {uwpMessage.text}
            </div>
          )}

          {/* 应用列表展示区 */}
          <div className="max-h-[360px] overflow-y-auto rounded-xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/5 bg-slate-50/50 dark:bg-black/20">
            {uwpLoading ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
                <RefreshCw className="w-5 h-5 animate-spin text-blue-500" />
                <span className="text-xs">正在极速扫描已安装的 UWP 应用...</span>
              </div>
            ) : filteredUwpApps.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-400">
                {uwpSearch ? '未找到匹配的 UWP 应用' : '暂未扫描到 UWP 应用'}
              </div>
            ) : (
              filteredUwpApps.map((app) => {
                const isChecked = selectedSids.has(app.sid);
                return (
                  <div
                    key={app.sid}
                    onClick={() => toggleUwpSelect(app.sid)}
                    className={`flex items-center justify-between p-2.5 transition-colors cursor-pointer select-none hover:bg-blue-500/[0.04] ${
                      isChecked ? 'bg-blue-500/[0.06] dark:bg-blue-500/10' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 pr-3">
                      <div className="shrink-0 text-blue-600 dark:text-blue-400">
                        {isChecked ? (
                          <CheckSquare className="w-4.5 h-4.5" />
                        ) : (
                          <Square className="w-4.5 h-4.5 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                          {app.displayName}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5" title={app.packageFamilyName}>
                          {app.packageFamilyName}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      {app.isExempt ? (
                        <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-200/50 dark:border-emerald-500/20">
                          已豁免
                        </span>
                      ) : (
                        <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-400 font-medium">
                          隔离中
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Modal>

      {/* 未开启自动更新时，手动检查更新发现新版本的确认下载弹窗 */}
      <Modal
        isOpen={isDownloadPromptOpen}
        onClose={() => setIsDownloadPromptOpen(false)}
        title="发现新版本"
        maxWidth="md"
        footer={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsDownloadPromptOpen(false)}
              className="text-xs px-3 py-1.5 cursor-pointer"
            >
              稍后下载
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setIsDownloadPromptOpen(false);
                const url = pendingUpdateInfo?.downloadUrl || updateResult?.downloadUrl;
                if (url) {
                  handleStartDownload(url);
                }
              }}
              className="text-xs px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              立即下载
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 py-1">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <ArrowUpCircle className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                检测到 NexLink 新版本: v{pendingUpdateInfo?.latestVersion || updateResult?.latestVersion}
              </h4>
              <p className="text-xs text-slate-400 mt-0.5">
                当前运行版本为 v{pendingUpdateInfo?.currentVersion || updateResult?.currentVersion || '0.1.0'}。是否立即开始下载新版本安装包？
              </p>
            </div>
          </div>

          {(pendingUpdateInfo?.releaseNotes || updateResult?.releaseNotes) && (
            <div className="p-3 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-xs text-slate-600 dark:text-slate-300 max-h-36 overflow-y-auto leading-relaxed whitespace-pre-wrap font-sans">
              <span className="font-bold text-slate-700 dark:text-slate-200 block mb-1">本次更新说明：</span>
              {pendingUpdateInfo?.releaseNotes || updateResult?.releaseNotes}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
