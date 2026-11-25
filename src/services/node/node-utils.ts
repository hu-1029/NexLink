/**
确定性稳定节点 ID 生成与严格节点参数校验
彻底解决：
1. 每次更新订阅节点 ID 随机变动导致选中节点被切回第一个的问题
2. 非法畸形端口 (如 99999999) 导致内核启动失败的问题
*/

/**
 * 严格校验端口号合法性 (1 - 65535 纯正整数，彻底拒绝 '7890abc' 等畸形输入)
 */
export function isValidPort(port: any): boolean {
  if (typeof port !== 'number' && typeof port !== 'string') return false;
  const str = String(port).trim();
  if (!/^\d+$/.test(str)) return false;
  const num = Number(str);
  return Number.isInteger(num) && num >= 1 && num <= 65535;
}

/**
 * 严格校验服务器地址合法性
 */
export function isValidServer(server: any): boolean {
  if (typeof server !== 'string') return false;
  const trimmed = server.trim();
  if (!trimmed || trimmed.length > 255) return false;
  // 不能包含换行符、空格、制表符或未转义的控制字符
  if (/[\s\r\n\t]/.test(trimmed)) return false;
  return true;
}

/**
 * 基于节点核心参数计算稳定的确定性哈希 ID
 * 同一个订阅中的同一个节点即使重复解析多次，生成的 ID 始终保持绝对一致；
 * 跨订阅时注入 subscriptionId 作用域，彻底杜绝不同订阅间节点 ID 重复碰撞
 */
export function generateDeterministicNodeId(
  type: string,
  server: string,
  port: number,
  authOrUuid: string = '',
  name: string = '',
  subscriptionId: string = ''
): string {
  const seed = `${(subscriptionId || '').trim()}#${type.toLowerCase()}://${server.trim().toLowerCase()}:${port}#${authOrUuid.trim()}#${name.trim()}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashVal = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `node-${type.toLowerCase()}-${hashVal.toString(36)}`;
}
