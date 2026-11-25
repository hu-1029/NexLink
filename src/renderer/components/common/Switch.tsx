import React from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

/**
 * 经典药丸状滑动开关 (Clash Verge Rev 质感)
 */
export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  className = '',
  label,
}) => {
  const sizeMap = {
    sm: { track: 'w-9 h-5', thumb: 'w-4 h-4', translate: 'translate-x-4', offset: 'left-0.5 top-0.5' },
    md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5', offset: 'left-0.5 top-0.5' },
    lg: { track: 'w-12 h-6.5', thumb: 'w-5.5 h-5.5', translate: 'translate-x-5.5', offset: 'left-0.5 top-0.5' },
  };

  const currentSize = sizeMap[size];

  return (
    <label
      role="switch"
      aria-checked={checked}
      data-checked={checked}
      className={`inline-flex items-center gap-2.5 select-none cursor-pointer transition-opacity ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'active:opacity-90'
      } ${className}`}
      onClick={(e) => {
        if (!disabled) {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <div
        className={`relative transition-colors duration-200 rounded-full ${currentSize.track} ${
          checked
            ? 'bg-blue-600 dark:bg-blue-500 shadow-inner'
            : 'bg-black/15 dark:bg-white/20 border border-black/10 dark:border-white/10 shadow-inner'
        }`}
      >
        <div
          className={`absolute ${currentSize.offset} transition-transform duration-200 rounded-full bg-white shadow-xs border border-black/10 dark:border-white/20 ${
            currentSize.thumb
          } ${checked ? currentSize.translate : 'translate-x-0'}`}
        />
      </div>
      {label && (
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
          {label}
        </span>
      )}
    </label>
  );
};
