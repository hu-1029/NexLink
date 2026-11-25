import React from 'react';
import { PROTOCOL_COLORS } from '../../styles/theme';

interface BadgeProps {
  children?: React.ReactNode;
  variant?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  protocol?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  protocol,
  size = 'sm',
  className = '',
}) => {
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs';

  if (protocol) {
    const protoKey = protocol.toLowerCase();
    const style = PROTOCOL_COLORS[protoKey] || {
      bg: 'bg-slate-100 dark:bg-white/10',
      text: 'text-slate-700 dark:text-slate-300',
      border: 'border-slate-200/60 dark:border-white/10',
      label: protocol.toUpperCase(),
    };
    return (
      <span
        className={`inline-flex items-center font-bold tracking-wide rounded-lg border ${sizeClasses} ${style.bg} ${style.text} ${style.border} ${className}`}
      >
        {style.label || children}
      </span>
    );
  }

  const variantClasses = {
    brand: 'bg-blue-50 text-blue-600 border-blue-200/60 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/20',
    success: 'bg-emerald-50 text-emerald-600 border-emerald-200/60 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/20',
    warning: 'bg-amber-50 text-amber-600 border-amber-200/60 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/20',
    danger: 'bg-rose-50 text-rose-600 border-rose-200/60 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/20',
    neutral: 'bg-slate-100 text-slate-700 border-slate-200/60 dark:bg-white/5 dark:text-slate-300 dark:border-white/10',
  };

  return (
    <span
      className={`inline-flex items-center font-semibold rounded-lg border ${sizeClasses} ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
};
