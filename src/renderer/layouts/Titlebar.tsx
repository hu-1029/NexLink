import React, { useState, useEffect } from 'react';
import { Minus, Square, Copy, X, Sun, Moon, ShieldCheck } from 'lucide-react';
import type { ThemeMode } from '../../shared/types';
import appIcon from '@/assets/icon.png';

interface TitlebarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  coreRunning: boolean;
  systemProxy: boolean;
  appVersion?: string;
}

export const Titlebar: React.FC<TitlebarProps> = ({
  theme,
  onToggleTheme,
  coreRunning,
  systemProxy,
  appVersion,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (window.nexlinkAPI?.window) {
      window.nexlinkAPI.window.isMaximized().then(setIsMaximized).catch(() => {});
    }
  }, []);

  const handleMinimize = () => {
    window.nexlinkAPI?.window?.minimize();
  };

  const handleMaximize = async () => {
    if (window.nexlinkAPI?.window) {
      const state = await window.nexlinkAPI.window.maximize();
      setIsMaximized(state);
    }
  };

  const handleClose = () => {
    window.nexlinkAPI?.window?.close();
  };

  return (
    <header className="h-10 w-full bg-white/80 dark:bg-[#13161f] border-b border-slate-900/[0.04] dark:border-white/5 flex items-center justify-between px-3.5 select-none titlebar-drag-region z-50 transition-colors">
      {/* 左侧应用标识与核心状态胶囊 */}
      <div className="flex items-center gap-3 titlebar-no-drag">
        <div className="flex items-center gap-2">
          <img src={appIcon} alt="NexLink" className="w-5 h-5 rounded object-contain select-none pointer-events-none" />
          <span className="text-xs font-bold tracking-wide text-slate-800 dark:text-slate-200">
            NexLink
            <span className="text-[10px] text-slate-400 font-medium tabular-nums ml-1.5">
              v{appVersion || '0.1.0'}
            </span>
          </span>
        </div>

        {/* 状态徽章 */}
        <div className="flex items-center gap-2 ml-1">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium transition-all ${
              coreRunning
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-slate-100 text-slate-500 dark:bg-white/5'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                coreRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
              }`}
            />
            {coreRunning ? '核心运行中' : '未连接'}
          </span>

          {systemProxy && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <ShieldCheck className="w-3 h-3" />
              系统代理开启
            </span>
          )}
        </div>
      </div>

      {/* 右侧窗口控制按钮区 */}
      <div className="flex items-center gap-1 titlebar-no-drag">
        {/* 主题切换 */}
        <button
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors mr-1"
        >
          {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        </button>

        {/* 最小化 */}
        <button
          onClick={handleMinimize}
          className="w-8 h-7 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/10 rounded-lg transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        {/* 最大化 / 还原 */}
        <button
          onClick={handleMaximize}
          className="w-8 h-7 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/10 rounded-lg transition-colors"
        >
          {isMaximized ? <Copy className="w-3.5 h-3.5 rotate-180" /> : <Square className="w-3 h-3" />}
        </button>

        {/* 关闭 */}
        <button
          onClick={handleClose}
          className="w-8 h-7 flex items-center justify-center text-slate-500 hover:text-white hover:bg-rose-500 rounded-lg transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
