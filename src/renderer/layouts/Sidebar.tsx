import React from 'react';
import {
  Activity,
  Layers,
  Server,
  FileCode,
  Settings,
  HelpCircle,
  Lock,
  ScrollText,
} from 'lucide-react';

export type NavTab = 'dashboard' | 'subscriptions' | 'nodes' | 'profiles' | 'test' | 'logs' | 'settings';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  nodeCount?: number;
  subCount?: number;
  coreRunning?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  nodeCount = 0,
  subCount = 0,
  coreRunning = false,
}) => {
  const navItems = [
    {
      id: 'dashboard' as NavTab,
      label: '仪表盘',
      icon: Activity,
    },
    {
      id: 'subscriptions' as NavTab,
      label: '订阅管理',
      icon: Layers,
      badge: subCount > 0 ? String(subCount) : undefined,
    },
    {
      id: 'nodes' as NavTab,
      label: '节点列表',
      icon: Server,
      badge: nodeCount > 0 ? String(nodeCount) : undefined,
    },
    {
      id: 'profiles' as NavTab,
      label: '配置管理',
      icon: FileCode,
    },
    {
      id: 'test' as NavTab,
      label: '测试',
      icon: Lock,
    },
    {
      id: 'logs' as NavTab,
      label: '日志',
      icon: ScrollText,
    },
    {
      id: 'settings' as NavTab,
      label: '系统设置',
      icon: Settings,
    },
  ];

  // 两端对齐并保持每栏文字绝对等长 (2字字距大、4字字距小、总长度严格统一)
  const renderJustifiedLabel = (label: string) => {
    const chars = label.split('');
    return (
      <span className="inline-flex justify-between w-[4.6em] font-inherit select-none leading-none">
        {chars.map((char, index) => (
          <span key={index}>{char}</span>
        ))}
      </span>
    );
  };

  return (
    <aside className="w-[204px] min-w-[204px] h-[calc(100vh-2.5rem)] bg-white/80 dark:bg-[#13161f] border-r border-slate-900/[0.04] dark:border-white/5 flex flex-col justify-between p-3 select-none transition-all duration-200">
      {/* 顶部主导航列表 */}
      <nav className="flex flex-col gap-1.5">
        <div className="px-2 py-1.5 text-[11px] font-bold tracking-widest text-slate-400 dark:text-slate-500 uppercase text-center">
          导航菜单
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;

          return (
            <button
              key={item.id}
              data-tab={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`relative w-full flex items-center justify-center px-3 py-3 rounded-2xl text-[14.5px] transition-all duration-150 cursor-pointer ${
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/25 font-black'
                  : 'text-slate-800 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100/90 dark:hover:bg-white/[0.06] hover:translate-x-0.5 font-bold'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4.5 h-4.5 transition-transform duration-150 ${isActive ? 'text-white' : 'text-slate-700 dark:text-slate-300'}`} />
                {renderJustifiedLabel(item.label)}
              </div>

              {item.badge && (
                <span
                  className={`absolute right-2.5 px-2 py-0.5 rounded-full text-[11px] font-bold tabular-nums transition-colors ${
                    isActive
                      ? 'bg-white/20 text-white shadow-xs'
                      : 'bg-black/[0.08] dark:bg-white/10 text-inherit'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 底部系统信息与驱动提示 */}
      <div className="p-2.5 px-3 rounded-2xl bg-slate-50/90 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 flex items-center justify-between text-slate-500 transition-all">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <HelpCircle className="w-3 h-3" />
          </div>
          <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Mihomo 驱动</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${coreRunning ? 'bg-emerald-500 animate-pulse shadow-xs shadow-emerald-500/50' : 'bg-slate-400'}`} />
          <span className={`text-[10px] font-bold ${coreRunning ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
            {coreRunning ? '在线' : '离线'}
          </span>
        </div>
      </div>
    </aside>
  );
};
