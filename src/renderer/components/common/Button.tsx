import React from 'react';
import { twMerge } from 'tailwind-merge';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  className = '',
  disabled,
  ...props
}) => {
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs rounded-xl gap-1.5 font-medium',
    md: 'px-4 py-2 text-xs rounded-2xl gap-2 font-semibold',
    lg: 'px-5 py-2.5 text-sm rounded-2xl gap-2.5 font-bold',
  };

  const variantClasses = {
    primary:
      'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm shadow-blue-500/25 border border-blue-500/30',
    secondary:
      'bg-white dark:bg-white/10 hover:bg-slate-50 dark:hover:bg-white/15 text-slate-700 dark:text-slate-200 border border-slate-900/[0.06] dark:border-white/10 shadow-sm',
    outline:
      'bg-transparent hover:bg-slate-100/80 dark:hover:bg-white/5 text-slate-700 dark:text-slate-300 border border-slate-300/80 dark:border-white/15',
    ghost:
      'bg-transparent hover:bg-slate-100/80 dark:hover:bg-white/5 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
    danger:
      'bg-rose-50 hover:bg-rose-100/80 text-rose-600 dark:bg-rose-500/10 dark:hover:bg-rose-500/20 dark:text-rose-400 border border-rose-200 dark:border-rose-500/20',
  };

  return (
    <button
      disabled={disabled || loading}
      className={twMerge(
        'inline-flex items-center justify-center whitespace-nowrap shrink-0 transition-all duration-150 select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {loading ? (
        <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
};
