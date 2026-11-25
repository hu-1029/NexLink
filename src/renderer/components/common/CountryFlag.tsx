import React from 'react';
import * as Flags from 'country-flag-icons/react/3x2';
import { Globe } from 'lucide-react';

interface CountryFlagProps {
  countryCode?: string;
  className?: string;
  title?: string;
}

export const CountryFlag: React.FC<CountryFlagProps> = ({
  countryCode,
  className = 'w-4 h-[11px] block object-cover',
  title,
}) => {
  const code = (countryCode || '').trim().toUpperCase();

  // 别名修正 (例如 UK -> GB)
  const normalizedCode = code === 'UK' ? 'GB' : code;

  // 检查是否为有效且受支持的二位国家代码
  const FlagComponent = (Flags as Record<string, React.ComponentType<{ className?: string; title?: string }>>)[
    normalizedCode
  ];

  if (FlagComponent) {
    return (
      <span
        className="inline-flex items-center justify-center shrink-0 overflow-hidden rounded-[2px] border border-black/10 dark:border-white/15 shadow-[0_0_1px_rgba(0,0,0,0.25)]"
        title={title || code}
      >
        <FlagComponent className={className} />
      </span>
    );
  }

  // 兜底：未匹配到国家或 GLOBAL/AUTO 时展示全球/地球图标
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 text-slate-400 dark:text-slate-500"
      title={title || code || 'GLOBAL'}
    >
      <Globe className="w-3.5 h-3.5" />
    </span>
  );
};
