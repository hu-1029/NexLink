import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  durationMs?: number;
}

type ToastListener = (item: ToastItem) => void;
const listeners = new Set<ToastListener>();

/**
 * 全局触发轻量级悬浮 Toast 提示（可在任意组件或回调中调用）
 */
export function showToast(input: Omit<ToastItem, 'id'>): void {
  const item: ToastItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    durationMs: 4500,
    ...input,
  };
  listeners.forEach((fn) => {
    try {
      fn(item);
    } catch {
      // ignore
    }
  });
}

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onToast: ToastListener = (item) => {
      setToasts((prev) => [...prev.slice(-2), item]);
      const ms = item.durationMs ?? 4500;
      if (ms > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== item.id));
        }, ms);
      }
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  if (toasts.length === 0) return null;

  const iconMap: Record<ToastType, React.ReactNode> = {
    success: <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />,
    error: <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />,
    info: <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />,
  };

  const borderMap: Record<ToastType, string> = {
    success: 'border-emerald-500/30',
    error: 'border-rose-500/35',
    warning: 'border-amber-500/35',
    info: 'border-blue-500/30',
  };

  return (
    <div className="fixed top-12 right-4 z-[9999] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 p-3.5 rounded-2xl bg-white/95 dark:bg-[#1a1f2c]/95 backdrop-blur-md shadow-lg border ${borderMap[t.type]} animate-in fade-in slide-in-from-top-2 duration-200`}
        >
          {iconMap[t.type]}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-slate-900 dark:text-slate-100 leading-snug">
              {t.title}
            </div>
            {t.message && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 break-words leading-relaxed">
                {t.message}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5 rounded-lg cursor-pointer shrink-0"
            aria-label="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
