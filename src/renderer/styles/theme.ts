/**
 * NexLink 统一视觉规范与协议徽章配置
 */

export const PROTOCOL_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  // VLESS
  vless: {
    bg: 'bg-blue-500/10 dark:bg-blue-500/20',
    text: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-500/25',
    label: 'VLESS',
  },
  // VMess
  vmess: {
    bg: 'bg-indigo-500/10 dark:bg-indigo-500/20',
    text: 'text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-500/25',
    label: 'VMess',
  },
  // Hysteria 2 / Hy2 / Hysteria
  hysteria2: {
    bg: 'bg-violet-500/10 dark:bg-violet-500/20',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/25',
    label: 'Hy2',
  },
  hy2: {
    bg: 'bg-violet-500/10 dark:bg-violet-500/20',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/25',
    label: 'Hy2',
  },
  hysteria: {
    bg: 'bg-violet-500/10 dark:bg-violet-500/20',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/25',
    label: 'Hysteria',
  },
  hy: {
    bg: 'bg-violet-500/10 dark:bg-violet-500/20',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/25',
    label: 'Hy2',
  },
  // TUIC / TUIC5
  tuic: {
    bg: 'bg-sky-500/10 dark:bg-sky-500/20',
    text: 'text-sky-600 dark:text-sky-400',
    border: 'border-sky-500/25',
    label: 'TUIC',
  },
  tuic5: {
    bg: 'bg-sky-500/10 dark:bg-sky-500/20',
    text: 'text-sky-600 dark:text-sky-400',
    border: 'border-sky-500/25',
    label: 'TUIC',
  },
  'tuic-v5': {
    bg: 'bg-sky-500/10 dark:bg-sky-500/20',
    text: 'text-sky-600 dark:text-sky-400',
    border: 'border-sky-500/25',
    label: 'TUIC',
  },
  // Trojan
  trojan: {
    bg: 'bg-cyan-500/10 dark:bg-cyan-500/20',
    text: 'text-cyan-700 dark:text-cyan-400',
    border: 'border-cyan-500/25',
    label: 'Trojan',
  },
  // Shadowsocks / SS
  ss: {
    bg: 'bg-amber-500/10 dark:bg-amber-500/20',
    text: 'text-amber-700 dark:text-amber-400',
    border: 'border-amber-500/25',
    label: 'SS',
  },
  shadowsocks: {
    bg: 'bg-amber-500/10 dark:bg-amber-500/20',
    text: 'text-amber-700 dark:text-amber-400',
    border: 'border-amber-500/25',
    label: 'SS',
  },
  // ShadowsocksR / SSR
  ssr: {
    bg: 'bg-orange-500/10 dark:bg-orange-500/20',
    text: 'text-orange-700 dark:text-orange-400',
    border: 'border-orange-500/25',
    label: 'SSR',
  },
  shadowsocksr: {
    bg: 'bg-orange-500/10 dark:bg-orange-500/20',
    text: 'text-orange-700 dark:text-orange-400',
    border: 'border-orange-500/25',
    label: 'SSR',
  },
  // WireGuard / WG
  wireguard: {
    bg: 'bg-teal-500/10 dark:bg-teal-500/20',
    text: 'text-teal-700 dark:text-teal-400',
    border: 'border-teal-500/25',
    label: 'WG',
  },
  wg: {
    bg: 'bg-teal-500/10 dark:bg-teal-500/20',
    text: 'text-teal-700 dark:text-teal-400',
    border: 'border-teal-500/25',
    label: 'WG',
  },
  // HTTP / HTTPS
  http: {
    bg: 'bg-slate-500/10 dark:bg-slate-400/20',
    text: 'text-slate-700 dark:text-slate-300',
    border: 'border-slate-400/25',
    label: 'HTTP',
  },
  https: {
    bg: 'bg-slate-500/10 dark:bg-slate-400/20',
    text: 'text-slate-700 dark:text-slate-300',
    border: 'border-slate-400/25',
    label: 'HTTPS',
  },
  // SOCKS5 / SOCKS
  socks5: {
    bg: 'bg-zinc-500/10 dark:bg-zinc-400/20',
    text: 'text-zinc-700 dark:text-zinc-300',
    border: 'border-zinc-400/25',
    label: 'SOCKS5',
  },
  socks: {
    bg: 'bg-zinc-500/10 dark:bg-zinc-400/20',
    text: 'text-zinc-700 dark:text-zinc-300',
    border: 'border-zinc-400/25',
    label: 'SOCKS5',
  },
  socks4: {
    bg: 'bg-zinc-500/10 dark:bg-zinc-400/20',
    text: 'text-zinc-700 dark:text-zinc-300',
    border: 'border-zinc-400/25',
    label: 'SOCKS4',
  },
  // Snell
  snell: {
    bg: 'bg-fuchsia-500/10 dark:bg-fuchsia-500/20',
    text: 'text-fuchsia-700 dark:text-fuchsia-400',
    border: 'border-fuchsia-500/25',
    label: 'Snell',
  },
  // SSH 隧道
  ssh: {
    bg: 'bg-stone-500/10 dark:bg-stone-400/20',
    text: 'text-stone-700 dark:text-stone-300',
    border: 'border-stone-400/25',
    label: 'SSH',
  },
  // NaïveProxy
  naive: {
    bg: 'bg-teal-600/10 dark:bg-teal-500/20',
    text: 'text-teal-700 dark:text-teal-400',
    border: 'border-teal-600/25',
    label: 'Naïve',
  },
  naiveproxy: {
    bg: 'bg-teal-600/10 dark:bg-teal-500/20',
    text: 'text-teal-700 dark:text-teal-400',
    border: 'border-teal-600/25',
    label: 'Naïve',
  },
  // Juicity
  juicity: {
    bg: 'bg-amber-600/10 dark:bg-amber-500/20',
    text: 'text-amber-800 dark:text-amber-300',
    border: 'border-amber-600/25',
    label: 'Juicity',
  },
  // Direct (直连)
  direct: {
    bg: 'bg-emerald-500/10 dark:bg-emerald-500/20',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500/25',
    label: 'DIRECT',
  },
  // Reject (拦截)
  reject: {
    bg: 'bg-rose-500/10 dark:bg-rose-500/20',
    text: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-500/25',
    label: 'REJECT',
  },
};

export function getLatencyColor(delay?: number): { text: string; bg: string; border: string; dot: string } {
  if (delay === undefined) {
    return {
      text: 'text-slate-400 dark:text-slate-500',
      bg: 'bg-slate-100 dark:bg-slate-800/60',
      border: 'border-slate-300 dark:border-white/5',
      dot: 'bg-slate-400',
    };
  }
  if (delay < 0) {
    // 明确标记超时或无法连通节点，以红色醒目展现
    return {
      text: 'text-rose-600 dark:text-rose-400',
      bg: 'bg-rose-50 dark:bg-rose-500/15',
      border: 'border-rose-200 dark:border-rose-500/30',
      dot: 'bg-rose-500',
    };
  }
  if (delay <= 150) {
    return {
      text: 'text-emerald-700 dark:text-emerald-400',
      bg: 'bg-emerald-50 dark:bg-emerald-500/15',
      border: 'border-emerald-200 dark:border-emerald-500/30',
      dot: 'bg-emerald-500',
    };
  }
  if (delay <= 350) {
    return {
      text: 'text-amber-700 dark:text-amber-400',
      bg: 'bg-amber-50 dark:bg-amber-500/15',
      border: 'border-amber-200 dark:border-amber-500/30',
      dot: 'bg-amber-500',
    };
  }
  return {
    text: 'text-rose-700 dark:text-rose-400',
    bg: 'bg-rose-50 dark:bg-rose-500/15',
    border: 'border-rose-200 dark:border-rose-500/30',
    dot: 'bg-rose-500',
  };
}
