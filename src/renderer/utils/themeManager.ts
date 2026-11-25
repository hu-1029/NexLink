/**
 * NexLink 真实全局换肤引擎
 * 动态注入全局 CSS 规则，使背景色与前景色在整个应用（包含 body, #root, main, 标题及前景色）秒级生效
 */

const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function applyThemeColors(rawBg: string, rawFg: string) {
  if (typeof document === 'undefined') return;

  const bg = SAFE_HEX_COLOR_RE.test(String(rawBg || '').trim()) ? rawBg.trim() : '#13161f';
  const fg = SAFE_HEX_COLOR_RE.test(String(rawFg || '').trim()) ? rawFg.trim() : '#e2e8f0';

  document.documentElement.style.setProperty('--custom-bg', bg);
  document.documentElement.style.setProperty('--custom-fg', fg);

  let styleTag = document.getElementById('nexlink-dynamic-theme') as HTMLStyleElement | null;
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'nexlink-dynamic-theme';
    document.head.appendChild(styleTag);
  }

  styleTag.textContent = `
    /* 1. 全局背景色覆盖：主窗口、左侧侧边导航菜单栏 aside、顶部标题栏 header 等 */
    html, body, #root, #root > div, main, aside, header {
      background-color: ${bg} !important;
    }

    /* 2. 所有卡片 (Card) 全量生效自定义背景色 (排除专用气泡提示框) */
    .glow-card,
    [class*="rounded-[22px]"]:not(.lan-tooltip-box),
    [class*="bg-white dark:bg-[#181c26]"]:not(.lan-tooltip-box),
    div[class*="bg-white"]:not(button):not(input):not(span):not(label):not([class*="rounded-full"]):not(.lan-tooltip-box) {
      background-color: ${bg} !important;
      border: 1px solid rgba(128, 128, 128, 0.18) !important;
      box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.08) !important;
    }

    /* 3. 卡片内部嵌套微容器、输入框、下拉框自适应半透明背景，彻底消除刺眼死白块 */
    [class*="bg-slate-50"]:not(.lan-tooltip-box *),
    [class*="bg-slate-100"]:not(.lan-tooltip-box *):not([class*="bg-blue"]):not([class*="from-blue"]):not(button[class*="text-white"]),
    [class*="dark:bg-white/5"],
    [class*="dark:bg-black/20"] {
      background-color: rgba(128, 128, 128, 0.08) !important;
      border-color: rgba(128, 128, 128, 0.15) !important;
    }

    /* 4. 输入框与下拉选择框背景自适应 */
    input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not(.lan-tooltip-box *),
    textarea:not(.lan-tooltip-box *),
    select:not(.lan-tooltip-box *) {
      background-color: rgba(128, 128, 128, 0.08) !important;
      border-color: rgba(128, 128, 128, 0.2) !important;
      color: ${fg} !important;
    }

    /* 5. 菜单栏和顶栏的边框自适应 */
    aside, header {
      border-color: rgba(128, 128, 128, 0.12) !important;
    }

    /* 6. 全局主前景色覆盖：各级标题、段落、正文文本、表单标签、普通文本 (排除独立 tooltip) */
    body, #root, main, aside, header,
    h1, h2, h3, h4, h5, h6,
    p:not(.lan-tooltip-box *), label:not(.lan-tooltip-box *), li,
    .text-slate-900:not(.lan-tooltip-box *), .text-slate-800:not(.lan-tooltip-box *), .text-slate-700:not(.lan-tooltip-box *), .text-slate-600:not(.lan-tooltip-box *),
    .dark .text-slate-100:not(.lan-tooltip-box *), .dark .text-slate-200:not(.lan-tooltip-box *), .dark .text-slate-300:not(.lan-tooltip-box *),
    span.font-medium:not(.lan-tooltip-box *), span.font-semibold:not(.lan-tooltip-box *), span.font-bold:not(.lan-tooltip-box *), span.font-black:not(.lan-tooltip-box *) {
      color: ${fg} !important;
    }

    /* 7. 侧边栏导航菜单项未激活文字与图标随前景色统一变色 */
    aside nav button:not([class*="from-blue"]) {
      color: ${fg} !important;
    }
    aside nav button:not([class*="from-blue"]) svg {
      color: ${fg} !important;
    }

    /* 8. 次要说明文字、小字、描述文字统一跟随前景色 (附带 72% 优雅透明度) */
    .text-slate-500:not(.lan-tooltip-box *), .text-slate-400:not(.lan-tooltip-box *),
    .dark .text-slate-400:not(.lan-tooltip-box *), .dark .text-slate-500:not(.lan-tooltip-box *),
    p.text-xs:not(.lan-tooltip-box *),
    span.text-xs:not([class*="text-blue"]):not([class*="text-emerald"]):not([class*="text-amber"]):not([class*="text-rose"]):not([class*="text-white"]):not(.lan-tooltip-box *),
    span.text-[11px]:not([class*="text-blue"]):not([class*="text-emerald"]):not([class*="text-amber"]):not([class*="text-rose"]):not([class*="text-white"]):not(.lan-tooltip-box *),
    span.text-[10px]:not([class*="text-blue"]):not([class*="text-emerald"]):not([class*="text-amber"]):not([class*="text-rose"]):not([class*="text-white"]):not(.lan-tooltip-box *) {
      color: ${fg} !important;
      opacity: 0.72 !important;
    }

    /* 9. 局域网代理悬浮窗 Tooltip 背景色与前景色 100% 全量同步全局色彩 */
    .lan-tooltip-box {
      background-color: ${bg} !important;
      color: ${fg} !important;
      border: 1px solid rgba(128, 128, 128, 0.22) !important;
      box-shadow: 0 16px 36px -4px rgba(0, 0, 0, 0.25) !important;
    }
    .lan-tooltip-arrow {
      border-top-color: ${bg} !important;
    }
    .lan-tooltip-box p,
    .lan-tooltip-box span {
      color: ${fg} !important;
    }
    .lan-tooltip-box p,
    .lan-tooltip-box .text-slate-500,
    .lan-tooltip-box .text-slate-400 {
      opacity: 0.75 !important;
    }
    .lan-tooltip-box [class*="bg-slate-50"],
    .lan-tooltip-box [class*="dark:bg-white/5"] {
      background-color: rgba(128, 128, 128, 0.08) !important;
      border-color: rgba(128, 128, 128, 0.18) !important;
    }
  `;
}

export function clearThemeColors() {
  if (typeof document === 'undefined') return;
  const styleTag = document.getElementById('nexlink-dynamic-theme');
  if (styleTag) {
    styleTag.remove();
  }
  document.documentElement.style.removeProperty('--custom-bg');
  document.documentElement.style.removeProperty('--custom-fg');
}

export function getDefaultColorsForTheme(theme: 'system' | 'dark' | 'light'): { bg: string; fg: string } {
  let isDark = false;
  if (theme === 'system') {
    isDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    isDark = theme === 'dark';
  }

  return isDark
    ? { bg: '#0E1117', fg: '#F1F5F9' }
    : { bg: '#F2F4F8', fg: '#1E293B' };
}
