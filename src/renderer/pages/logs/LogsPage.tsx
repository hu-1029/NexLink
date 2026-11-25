import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import {
  Pause,
  Play,
  ArrowDownUp,
  Trash2,
  Search,
  FileText,
} from 'lucide-react';
import type { LogItem } from '../../../shared/types';

export const LogsPage: React.FC = () => {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<string>('ALL');
  const [filterText, setFilterText] = useState<string>('');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [useRegex, setUseRegex] = useState<boolean>(false);

  // 流式滚动控制
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const isPausedRef = useRef<boolean>(false);
  const autoScrollRef = useRef<boolean>(true);

  isPausedRef.current = isPaused;
  autoScrollRef.current = autoScroll;

  // 1. 初始化拉取最近日志
  useEffect(() => {
    if (window.nexlinkAPI?.core?.getLogs) {
      window.nexlinkAPI.core
        .getLogs()
        .then((initialLogs) => {
          if (Array.isArray(initialLogs)) {
            setLogs(initialLogs);
          }
        })
        .catch(console.error);
    }
  }, []);

  // 2. 实时订阅内核日志推送
  useEffect(() => {
    if (!window.nexlinkAPI?.core?.onLog) return;

    const unsub = window.nexlinkAPI.core.onLog((item: LogItem) => {
      if (isPausedRef.current) return;

      setLogs((prev) => {
        const next = [...prev, item];
        if (next.length > 1000) {
          return next.slice(next.length - 1000);
        }
        return next;
      });
    });

    return () => {
      unsub();
    };
  }, []);

  // 3. 自动滚动到底部
  useEffect(() => {
    if (autoScroll && !isPaused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll, isPaused]);

  // 4. 清空日志
  const handleClear = async () => {
    setLogs([]);
    if (window.nexlinkAPI?.core?.clearLogs) {
      try {
        await window.nexlinkAPI.core.clearLogs();
      } catch (err) {
        console.error('清空日志异常:', err);
      }
    }
  };

  // 5. 过滤日志（预编译正则避免循环内重复创建 RegExp）
  const filteredLogs = useMemo(() => {
    const trimmedFilter = filterText.trim();
    let compiledRegex: RegExp | null = null;
    if (useRegex && trimmedFilter) {
      try {
        compiledRegex = new RegExp(trimmedFilter, caseSensitive ? '' : 'i');
      } catch {
        compiledRegex = null;
      }
    }
    const needle = caseSensitive ? filterText : filterText.toLowerCase();
    const targetLevel = selectedLevel.toLowerCase();

    return logs.filter((log) => {
      if (selectedLevel !== 'ALL' && targetLevel !== log.level.toLowerCase()) {
        return false;
      }
      if (!trimmedFilter) return true;
      if (useRegex) {
        return compiledRegex ? compiledRegex.test(log.message) || compiledRegex.test(log.level) : true;
      }
      const hay = caseSensitive
        ? `${log.message} ${log.level}`
        : `${log.message} ${log.level}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [logs, selectedLevel, filterText, caseSensitive, useRegex]);

  // 日志徽章样式映射 (严格对齐 Clash Verge Rev)
  const getLevelBadgeClass = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error':
        return 'text-rose-500 font-bold';
      case 'warn':
      case 'warning':
        return 'text-amber-500 font-bold';
      case 'debug':
        return 'text-slate-400 font-semibold';
      case 'info':
      default:
        return 'text-blue-500 dark:text-blue-400 font-bold';
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-7xl mx-auto animate-in fade-in duration-200 select-none pb-8 h-[calc(100vh-5.5rem)]">
      {/* 顶部标题与操作栏 */}
      <div className="flex items-center justify-between pt-1 pb-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-800 dark:text-slate-100 flex items-center gap-2.5">
            <span>日志</span>
          </h1>
        </div>

        {/* 右侧控制区: 暂停/播放、滚动置底、清除 */}
        <div className="flex items-center gap-2">
          {/* 暂停 / 继续按钮 */}
          <button
            type="button"
            onClick={() => setIsPaused(!isPaused)}
            className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 text-xs font-semibold ${
              isPaused
                ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-600 dark:text-amber-400'
                : 'bg-white dark:bg-[#181c26] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:text-blue-500 hover:border-blue-500/30 shadow-2xs'
            }`}
            title={isPaused ? '恢复实时流式推送' : '暂停实时流式推送'}
          >
            {isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4" />}
            <span>{isPaused ? '已暂停' : '流式推送'}</span>
          </button>

          {/* 自动滚动开关 */}
          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 text-xs font-semibold ${
              autoScroll
                ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 text-blue-600 dark:text-blue-400'
                : 'bg-white dark:bg-[#181c26] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:text-blue-500 hover:border-blue-500/30 shadow-2xs'
            }`}
            title="开启/关闭新日志自动滚动到底部"
          >
            <ArrowDownUp className="w-4 h-4" />
            <span>{autoScroll ? '自动滚动' : '固定视角'}</span>
          </button>

          {/* 清除按钮 */}
          <Button
            variant="primary"
            size="sm"
            onClick={handleClear}
            icon={<Trash2 className="w-3.5 h-3.5" />}
          >
            清除
          </Button>
        </div>
      </div>

      {/* 第二栏：过滤条件操作条 */}
      <Card className="p-3 bg-white dark:bg-[#181c26] flex items-center justify-between gap-3 shadow-sm border border-slate-200/80 dark:border-white/5">
        <div className="flex items-center gap-3 flex-1">
          {/* 日志等级下拉筛选框 */}
          <div className="relative shrink-0">
            <select
              value={selectedLevel}
              onChange={(e) => setSelectedLevel(e.target.value)}
              className="px-3.5 py-1.5 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
            >
              <option value="ALL">ALL</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>

          {/* 搜索过滤输入框 */}
          <div className="relative flex-1 flex items-center">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="过滤条件"
              className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        </div>

        {/* 区分大小写与正则开关 */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`px-2 py-1 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer border ${
              caseSensitive
                ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
            title="区分大小写 (Case Sensitive)"
          >
            Aa
          </button>

          <button
            type="button"
            onClick={() => setUseRegex(!useRegex)}
            className={`px-2 py-1 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer border ${
              useRegex
                ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
            title="正则表达式匹配 (Regex)"
          >
            .*
          </button>
        </div>
      </Card>

      {/* 主体日志视窗卡片 (严格呈现图2排版规范) */}
      <Card className="flex-1 p-0 bg-white dark:bg-[#13161f] shadow-sm border border-slate-200/80 dark:border-white/5 flex flex-col overflow-hidden">
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-[12.5px] leading-relaxed select-text"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 py-16 gap-2">
              <FileText className="w-8 h-8 opacity-40 text-slate-400" />
              <span className="text-xs">暂无符合条件的日志记录</span>
              <span className="text-[11px] text-slate-400/80">
                启动代理核心后，实时连接握手与分流日志将在此秒级展现
              </span>
            </div>
          ) : (
            filteredLogs.map((log) => (
              <div
                key={log.id}
                className="pb-2.5 border-b border-slate-100 dark:border-white/[0.04] last:border-0 hover:bg-slate-50/50 dark:hover:bg-white/[0.02] px-1.5 py-1 rounded-lg transition-colors"
              >
                {/* 顶部时间与等级 */}
                <div className="flex items-center gap-2 text-[11px] mb-1">
                  <span className="text-slate-400 tabular-nums">{log.time}</span>
                  <span className={getLevelBadgeClass(log.level)}>
                    {log.level.toUpperCase()}
                  </span>
                </div>
                {/* 日志明细内容 */}
                <div className="text-slate-800 dark:text-slate-200 break-all whitespace-pre-wrap font-sans text-xs">
                  {log.message}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部状态条 */}
        <div className="px-4 py-2 border-t border-slate-100 dark:border-white/5 bg-slate-50/80 dark:bg-[#181c26]/60 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>内存实时缓存 {logs.length} / 1000 条</span>
          </div>
          <span>显示 {filteredLogs.length} 条</span>
        </div>
      </Card>
    </div>
  );
};
