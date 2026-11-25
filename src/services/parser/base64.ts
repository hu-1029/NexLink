/**
 * 安全 Base64 编码与解码工具库
 * 支持 URL-Safe Base64、补齐缺失的等号、UTF-8 多字节字符与 Base64 订阅特征自动嗅探
 */

/**
 * 判断字符串是否大概率为 Base64 编码的订阅内容
 */
export function isLikelyBase64(str: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length < 16) return false;

  // 如果已经包含明确的协议头或换行 YAML/JSON 特征，则不是纯 Base64 blob
  if (
    trimmed.startsWith('vmess://') ||
    trimmed.startsWith('vless://') ||
    trimmed.startsWith('ss://') ||
    trimmed.startsWith('trojan://') ||
    trimmed.startsWith('hysteria2://') ||
    trimmed.startsWith('hy2://') ||
    trimmed.startsWith('tuic://') ||
    trimmed.startsWith('proxies:') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('---')
  ) {
    return false;
  }

  // 移除非 Base64 字符（空格、换行）
  const cleanStr = trimmed.replace(/\s+/g, '');
  // Base64 字符集合正则（包含 URL-safe 的 - 和 _，标准填充最多 2 个 '='）
  const base64Regex = /^[A-Za-z0-9+/_-]+={0,2}$/;
  if (!base64Regex.test(cleanStr) || cleanStr.length % 4 === 1) {
    return false;
  }

  // 尝试试探性解码，必须包含明确协议/配置特征
  try {
    const decoded = safeBase64Decode(cleanStr);
    return (
      decoded.includes('://') ||
      decoded.includes('proxies:') ||
      decoded.includes('Proxy:') ||
      decoded.includes('"outbounds"')
    );
  } catch {
    return false;
  }
}

/**
 * 安全解码 Base64 字符串（兼容标准 Base64 与 URL-safe Base64，自动补足 '='，正确处理 UTF-8）
 */
export function safeBase64Decode(str: string): string {
  let clean = str.trim().replace(/\s+/g, '');

  // 转换 URL-Safe 字符: '-' -> '+', '_' -> '/'
  clean = clean.replace(/-/g, '+').replace(/_/g, '/');

  // 补齐末尾缺失的 '='
  const padLen = (4 - (clean.length % 4)) % 4;
  clean += '='.repeat(padLen);

  // 在 Node.js / Electron 环境下优先使用 Buffer 解码 UTF-8
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(clean, 'base64').toString('utf-8');
  }

  // 在纯浏览器环境下的 UTF-8 解码回退
  const binaryString = atob(clean);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes);
}

/**
 * 安全编码字符串为 Base64
 */
export function safeBase64Encode(str: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
