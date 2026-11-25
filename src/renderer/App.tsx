import React, { useState, useEffect } from 'react';
import { Titlebar } from './layouts/Titlebar';
import { Sidebar, type NavTab } from './layouts/Sidebar';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { SubscriptionsPage } from './pages/subscriptions/SubscriptionsPage';
import { NodesPage } from './pages/nodes/NodesPage';
import { ProfilesPage } from './pages/profiles/ProfilesPage';
import { TestPage } from './pages/test/TestPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { LogsPage } from './pages/logs/LogsPage';
import { useProxyStore } from './store/useProxyStore';
import { useProfileStore } from './store/useProfileStore';
import { Modal } from './components/common/Modal';
import { Button } from './components/common/Button';
import { ArrowUpCircle, CheckCircle2, Shield, RefreshCw, AlertCircle } from 'lucide-react';
import type { UpdateDownloadProgress } from '../shared/types';
import type { AppInfo, AppSettings, CoreStatus, ThemeMode } from '../shared/types';
import { applyThemeColors } from './utils/themeManager';

export const App: React.FC = () => {
  const VALID_TABS: NavTab[] = ['dashboard', 'subscriptions', 'nodes', 'profiles', 'test', 'logs', 'settings'];
  const rawTab = new URLSearchParams(window.location.search).get('tab') as NavTab | null;
  const initialTab: NavTab = rawTab && VALID_TABS.includes(rawTab) ? rawTab : 'dashboard';
  const [currentTab, setCurrentTab] = useState<NavTab>(initialTab);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [coreStatus, setCoreStatus] = useState<CoreStatus>({
    running: false,
    version: 'Mihomo Meta v1.19.32',
    mixedPort: 7890,
    apiPort: 9097,
    uptime: 0,
    mode: 'rule',
  });
  const [systemProxy, setSystemProxy] = useState<boolean>(false);
  const [settings, setSettings] = useState<AppSettings>({
    theme: 'dark',
    systemProxy: false,
    logLevel: 'warning',
    mixedPort: 7890,
    apiPort: 9097,
    tunMode: false,
    tunStack: 'mixed',
    allowLan: false,
    autoLaunch: false,
    silentStart: false,
  });

  const [isCoreBusy, setIsCoreBusy] = useState<boolean>(false);
  const [downloadedUpdate, setDownloadedUpdate] = useState<UpdateDownloadProgress | null>(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
  const [isTunServiceModalOpen, setIsTunServiceModalOpen] = useState(false);
  const [isInstallingTunService, setIsInstallingTunService] = useState(false);
  const [tunServiceModalError, setTunServiceModalError] = useState<string | null>(null);

  const { nodes, activeNodeId, setNodes, setChains } = useProxyStore();
  const { subscriptions, setSubscriptions, setActiveSubscription } = useProfileStore();

  // 初始化从 Electron 主进程获取系统与核心状态，加载持久化数据
  useEffect(() => {
    if (window.nexlinkAPI) {
      window.nexlinkAPI.getAppInfo().then(setAppInfo).catch(console.error);
      window.nexlinkAPI.core.getStatus().then(setCoreStatus).catch(console.error);

      // 加载本地持久化数据 (订阅、节点、设置、状态)
      window.nexlinkAPI.storage
        .loadAll()
        .then((persisted) => {
          if (persisted.subscriptions && persisted.subscriptions.length > 0) {
            setSubscriptions(persisted.subscriptions);
          }
          if (persisted.nodes && persisted.nodes.length > 0) {
            setNodes(persisted.nodes);
          }
          if (persisted.settings) {
            setSettings((prev) => ({ ...prev, ...persisted.settings }));
            if (Array.isArray(persisted.settings.proxyChains)) {
              setChains(persisted.settings.proxyChains);
            }
          }
          if (persisted.state?.activeNodeId || persisted.state?.selectedNodeName) {
            useProxyStore
              .getState()
              .hydrateActiveNode(persisted.state.activeNodeId || '', persisted.state.selectedNodeName);
          }
          if (persisted.state?.activeSubscriptionId) {
            setActiveSubscription(persisted.state.activeSubscriptionId);
          }
          if (persisted.settings) {
            if (persisted.settings.theme) {
              setTheme(persisted.settings.theme);
              applyTheme(persisted.settings.theme);
            }
            if (persisted.settings.customBg && persisted.settings.customFg) {
              applyThemeColors(persisted.settings.customBg, persisted.settings.customFg);
            }
            if (typeof persisted.settings.systemProxy === 'boolean') {
              setSystemProxy(persisted.settings.systemProxy);
            }
            if (persisted.settings.mode) {
              setCoreStatus((prev) => ({ ...prev, mode: persisted.settings.mode! }));
            }
          }
        })
        .catch(console.error);

      // 监听主进程后台调度、托盘操作与数据同步事件
      const unsubSync = window.nexlinkAPI.storage.onSync((data) => {
        setSubscriptions(data.subscriptions);
        setNodes(data.nodes);
        if (data.state?.activeNodeId || data.state?.selectedNodeName) {
          useProxyStore.getState().hydrateActiveNode(data.state.activeNodeId || '', data.state.selectedNodeName);
        }
        if (data.settings) {
          setSettings((prev) => ({ ...prev, ...data.settings }));
          if (typeof data.settings.systemProxy === 'boolean') {
            setSystemProxy(data.settings.systemProxy);
          }
          if (data.settings.mode) {
            setCoreStatus((prev) => ({ ...prev, mode: data.settings.mode! }));
          }
        }
      });

      const unsubStatus = window.nexlinkAPI.core.onStatus((status) => {
        setCoreStatus(status);
      });

      // 启动自适应重查，确保冷启动阶段核心拉起后界面即时从未启动秒变为运行中
      const checkTimers = [800, 1800, 3000].map((delay) =>
        setTimeout(() => {
          window.nexlinkAPI?.core.getStatus().then(setCoreStatus).catch(() => {});
        }, delay)
      );

      const unsubUpdate = window.nexlinkAPI?.updater?.onUpdateStatus?.((status) => {
        if (status.status === 'downloaded') {
          console.log('[App] 自动下载更新完毕，弹出安装确认弹窗:', status);
          setDownloadedUpdate(status);
          setIsUpdateModalOpen(true);
        }
      });

      return () => {
        unsubStatus?.();
        unsubSync?.();
        checkTimers.forEach(clearTimeout);
        unsubUpdate?.();
      };
    }
  }, [setNodes, setSubscriptions, setActiveSubscription, setChains]);

  // 全局快捷键监听：按下 Ctrl+V 时若不在订阅页，自动切换至订阅管理中心
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (currentTab !== 'subscriptions') {
          // 如果当前不是输入框在打字，则自动跳转至订阅管理中心
          const activeTag = document.activeElement?.tagName.toLowerCase();
          if (activeTag !== 'input' && activeTag !== 'textarea') {
            setCurrentTab('subscriptions');
          }
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [currentTab]);

  const applyTheme = (mode: ThemeMode) => {
    let isDark = false;
    if (mode === 'system') {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      isDark = mode === 'dark';
    }
    document.documentElement.classList.toggle('dark', isDark);
  };

  const handleSetTheme = (newTheme: ThemeMode) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    setSettings((prev) => ({ ...prev, theme: newTheme }));
    window.nexlinkAPI?.system.updateSettings({ theme: newTheme }).catch(console.error);
  };

  const handleToggleTheme = () => {
    const nextTheme: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    handleSetTheme(nextTheme);
  };

  // 监听系统深色/浅色动态变更 (当处于跟随系统模式时即时响应)
  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e: MediaQueryListEvent) => {
        document.documentElement.classList.toggle('dark', e.matches);
      };
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [theme]);

  const handleToggleTun = async (val: boolean) => {
    if (!window.nexlinkAPI?.system) {
      setSettings((prev) => ({ ...prev, tunMode: val }));
      return;
    }

    if (!val) {
      setSettings((prev) => ({ ...prev, tunMode: false }));
      try {
        const updated = await window.nexlinkAPI.system.updateSettings({ tunMode: false });
        if (updated) setSettings((prev) => ({ ...prev, ...updated }));
      } catch (err: any) {
        console.error('关闭 TUN 模式失败:', err);
      }
      return;
    }

    try {
      const check = await window.nexlinkAPI.system.checkAdmin();
      if (!check.canEnableTun) {
        // 对标 Clash Verge Rev：未安装服务模式时弹出一次性安装服务引导，免除后续管理员重启
        setTunServiceModalError(null);
        setIsTunServiceModalOpen(true);
        return;
      }

      // 确保 wintun.dll 驱动已下载就绪
      if (window.nexlinkAPI.system.downloadWintun) {
        const drv = await window.nexlinkAPI.system.downloadWintun();
        if (!drv.ok) {
          alert(`虚拟网卡驱动 (wintun.dll) 自动下载失败：${drv.error || '请检查网络连接或开启系统代理后重试'}`);
          return;
        }
      }

      setSettings((prev) => ({ ...prev, tunMode: true }));
      const updated = await window.nexlinkAPI.system.updateSettings({ tunMode: true });
      if (updated) setSettings((prev) => ({ ...prev, ...updated }));
    } catch (err: any) {
      console.error('开启 TUN 模式失败:', err);
      alert(`开启 TUN 模式失败: ${err?.message || err}`);
    }
  };

  const handleInstallTunServiceAndEnable = async () => {
    if (!window.nexlinkAPI?.system?.installTunService) return;
    setIsInstallingTunService(true);
    setTunServiceModalError(null);
    try {
      const installRes = await window.nexlinkAPI.system.installTunService();
      if (!installRes.success) {
        setTunServiceModalError(installRes.error || '虚拟网卡服务安装失败');
        return;
      }

      if (window.nexlinkAPI.system.downloadWintun) {
        const drv = await window.nexlinkAPI.system.downloadWintun();
        if (!drv.ok) {
          setTunServiceModalError(`服务已安装，但 wintun.dll 驱动部署失败：${drv.error || '未知错误'}`);
          return;
        }
      }

      const updated = await window.nexlinkAPI.system.updateSettings({ tunMode: true });
      if (updated) setSettings((prev) => ({ ...prev, ...updated }));
      setIsTunServiceModalOpen(false);
    } catch (err: any) {
      setTunServiceModalError(err?.message || '安装虚拟网卡服务异常');
    } finally {
      setIsInstallingTunService(false);
    }
  };

  const handleUpdateSettings = async (patch: Partial<AppSettings>) => {
    const snapshot = settings;
    setSettings((prev) => ({ ...prev, ...patch }));
    if (typeof patch.systemProxy === 'boolean') {
      setSystemProxy(patch.systemProxy);
    }
    if (window.nexlinkAPI?.system) {
      try {
        const updated = await window.nexlinkAPI.system.updateSettings(patch);
        if (updated) {
          setSettings((prev) => ({ ...prev, ...updated }));
          if (typeof updated.systemProxy === 'boolean') setSystemProxy(updated.systemProxy);
        }
      } catch (err: any) {
        console.error('即时保存设置失败:', err);
        setSettings(snapshot);
        setSystemProxy(Boolean(snapshot.systemProxy));
        alert(err?.message || '保存设置或热重载失败，已自动回滚原配置');
      }
    }
  };

  const handleToggleSystemProxy = async () => {
    const prev = systemProxy;
    const next = !prev;
    setSystemProxy(next);
    setSettings((s) => ({ ...s, systemProxy: next }));
    if (window.nexlinkAPI?.system) {
      try {
        const ok = await window.nexlinkAPI.system.setProxy(next);
        if (ok === false) {
          setSystemProxy(prev);
          setSettings((s) => ({ ...s, systemProxy: prev }));
          if (next) alert('代理核心未运行，无法开启系统代理，请先启动核心。');
        }
      } catch (err: any) {
        setSystemProxy(prev);
        setSettings((s) => ({ ...s, systemProxy: prev }));
        console.error('切换系统代理失败:', err);
      }
    }
  };

  const handleResetSystemProxy = async () => {
    setSystemProxy(false);
    setSettings((s) => ({ ...s, systemProxy: false }));
  };

  const resolveSelectedOutboundName = (): string | undefined => {
    const store = useProxyStore.getState();
    if (store.activeOutboundMode === 'auto') return '⚡ 自动选择';
    if (store.activeOutboundMode === 'chain' && store.selectedOutboundName) return store.selectedOutboundName;
    const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];
    return activeNode?.name;
  };

  const handleToggleCore = async () => {
    if (isCoreBusy) return;
    if (!window.nexlinkAPI?.core) {
      setCoreStatus((prev) => ({ ...prev, running: !prev.running }));
      return;
    }
    setIsCoreBusy(true);
    try {
      if (coreStatus.running) {
        await window.nexlinkAPI.core.stop();
        setCoreStatus((prev) => ({ ...prev, running: false, tunActive: false }));
      } else {
        const res = await window.nexlinkAPI.core.start({
          nodes,
          selectedNodeName: resolveSelectedOutboundName(),
        });
        if (!res.success) {
          alert(res.error || '核心启动失败');
        } else {
          const status = await window.nexlinkAPI.core.getStatus();
          setCoreStatus(status);
        }
      }
    } catch (err: any) {
      alert(err?.message || '核心操作异常');
    } finally {
      setIsCoreBusy(false);
    }
  };

  const handleRestartCore = async () => {
    if (isCoreBusy || !window.nexlinkAPI?.core) return;
    setIsCoreBusy(true);
    try {
      const res = await window.nexlinkAPI.core.restart({
        nodes,
        selectedNodeName: resolveSelectedOutboundName(),
      });
      if (!res.success) {
        alert(res.error || '核心重启失败');
      } else {
        const status = await window.nexlinkAPI.core.getStatus();
        setCoreStatus(status);
      }
    } catch (err: any) {
      alert(err?.message || '核心重启异常');
    } finally {
      setIsCoreBusy(false);
    }
  };

  const handleSetMode = async (mode: 'rule' | 'global' | 'direct') => {
    setCoreStatus((prev) => ({ ...prev, mode }));
    if (window.nexlinkAPI?.core) {
      await window.nexlinkAPI.core.setMode(mode);
    }
  };

  return (
    <div
      className={`w-screen h-screen flex flex-col ${
        theme === 'dark' ? 'dark bg-[#0e1117] text-slate-100' : 'bg-[#f2f4f8] text-slate-800'
      }`}
    >
      {/* 现代 Windows 无边框原生标题栏 */}
      <Titlebar
        theme={theme}
        onToggleTheme={handleToggleTheme}
        coreRunning={coreStatus.running}
        systemProxy={systemProxy}
      />

      {/* 主体工作区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧侧边导航栏 */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          nodeCount={nodes.length}
          subCount={subscriptions.length}
          coreRunning={coreStatus.running}
        />

        {/* 右侧主视窗内容区 */}
        <main className="flex-1 h-[calc(100vh-2.5rem)] overflow-y-auto p-6">
          {currentTab === 'dashboard' && (
            <DashboardPage
              coreStatus={coreStatus}
              systemProxy={systemProxy}
              settings={settings}
              onToggleTun={handleToggleTun}
              onUpdateSettings={handleUpdateSettings}
              onToggleCore={handleToggleCore}
              onToggleProxy={handleToggleSystemProxy}
              onResetProxy={handleResetSystemProxy}
              onNavigateToNodes={() => setCurrentTab('nodes')}
              onNavigateToProfiles={() => setCurrentTab('profiles')}
              onNavigateToTest={() => setCurrentTab('test')}
              onRestartCore={handleRestartCore}
              onChangeMode={handleSetMode}
            />
          )}

          {((currentTab as any) === 'subscriptions' || (currentTab as any) === 'import') && (
            <SubscriptionsPage />
          )}

          {currentTab === 'nodes' && <NodesPage />}

          {currentTab === 'profiles' && <ProfilesPage />}

          {currentTab === 'test' && <TestPage />}

          {currentTab === 'logs' && <LogsPage />}

          {currentTab === 'settings' && (
            <SettingsPage
              theme={theme}
              onToggleTheme={handleToggleTheme}
              onSelectTheme={handleSetTheme}
              systemProxy={systemProxy}
              onToggleProxy={handleToggleSystemProxy}
              coreRunning={coreStatus.running}
              onToggleCore={handleToggleCore}
              onRestartCore={handleRestartCore}
              settings={settings}
              appVersion={appInfo?.version}
              coreVersion={coreStatus.version}
              onToggleTun={handleToggleTun}
              onUpdateSettings={handleUpdateSettings}
            />
          )}
        </main>

        {/* 自动更新就绪全局弹窗 (后台静默下载完成后弹出询问用户是否立即安装) */}
        <Modal
          isOpen={isUpdateModalOpen}
          onClose={() => setIsUpdateModalOpen(false)}
          title="NexLink 自动更新就绪"
          maxWidth="md"
          footer={
            <div className="flex items-center justify-between w-full">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsUpdateModalOpen(false)}
                className="text-xs"
              >
                稍后安装
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  const res = await window.nexlinkAPI?.updater?.installUpdate();
                  if (res && !res.success) {
                    alert(res.error || '启动更新安装程序失败');
                  }
                }}
                className="text-xs px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                立即安装并重启
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <ArrowUpCircle className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                  新版本 v{downloadedUpdate?.updateInfo?.latestVersion || '最新版'} 已自动下载就绪
                </h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  NexLink 已在后台自动下载好最新安装包，是否立即退出应用并启动更新安装？
                </p>
              </div>
            </div>

            {downloadedUpdate?.updateInfo?.releaseNotes && (
              <div className="p-3 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-xs text-slate-600 dark:text-slate-300 max-h-36 overflow-y-auto leading-relaxed whitespace-pre-wrap font-sans">
                <span className="font-bold text-slate-700 dark:text-slate-200 block mb-1">本次更新特性：</span>
                {downloadedUpdate.updateInfo.releaseNotes}
              </div>
            )}
          </div>
        </Modal>

        {/* 首次启用 TUN 虚拟网卡服务一键配置引导弹窗 */}
        <Modal
          isOpen={isTunServiceModalOpen}
          onClose={() => {
            if (!isInstallingTunService) setIsTunServiceModalOpen(false);
          }}
          title="启用虚拟网卡 (TUN) 模式"
          maxWidth="md"
          footer={
            <div className="flex items-center justify-between w-full gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={isInstallingTunService}
                onClick={async () => {
                  setIsTunServiceModalOpen(false);
                  await window.nexlinkAPI?.system?.restartAsAdmin?.();
                }}
                className="text-xs"
              >
                临时以管理员重启
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isInstallingTunService}
                  onClick={() => setIsTunServiceModalOpen(false)}
                  className="text-xs"
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isInstallingTunService}
                  onClick={handleInstallTunServiceAndEnable}
                  className="text-xs px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold flex items-center gap-1.5"
                >
                  {isInstallingTunService ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Shield className="w-3.5 h-3.5" />
                  )}
                  {isInstallingTunService ? '正在配置服务...' : '一键开启虚拟网卡'}
                </Button>
              </div>
            </div>
          }
        >
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5" />
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <h4 className="text-sm font-bold text-slate-900 dark:text-white mb-1">
                  安装虚拟网卡服务
                </h4>
                <p>
                  首次启用虚拟网卡需要安装后台服务组件。配置完成后即可直接接管系统网络流量，日常开关 TUN 无需管理员权限。
                </p>
              </div>
            </div>

            {tunServiceModalError && (
              <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{tunServiceModalError}</span>
              </div>
            )}
          </div>
        </Modal>
      </div>
    </div>
  );
};

export default App;
