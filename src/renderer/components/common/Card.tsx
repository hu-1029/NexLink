import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
  glow?: boolean;
  title?: string;
}

/**
 * 现代圆角微阴影磁贴卡片 (Clash Verge Rev 经典设计语言)
 * 大圆角 (20px)、纯白底色、呼吸感内衬、鼠标悬停边框流光发光动效
 */
export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  onClick,
  hoverable = false,
  glow = true,
  title,
}) => {
  return (
    <div
      onClick={onClick}
      title={title}
      className={`rounded-[22px] bg-white dark:bg-[#181c26] shadow-[0_2px_16px_rgba(0,0,0,0.025)] transition-all duration-250 select-none ${
        glow ? 'glow-card' : 'border border-slate-900/[0.04] dark:border-white/[0.06]'
      } ${
        hoverable ? 'cursor-pointer hover:-translate-y-0.5' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};
