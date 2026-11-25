import YAML from 'yaml';

/**
 * 支持的分流规则匹配类型集合
 */
export const SUPPORTED_RULE_TYPES = new Set([
  'DOMAIN-SUFFIX',
  'DOMAIN',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'GEOSITE',
  'SRC-IP-CIDR',
  'DST-PORT',
  'SRC-PORT',
  'PROCESS-NAME',
]);

/**
 * 格式化单行规则字符串
 */
export function normalizeRuleLine(
  rawLine: string,
  defaultTarget: string = '🚀 节点选择'
): string | null {
  let line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
    return null;
  }

  // 去除 YAML 列表前缀 "- "
  if (line.startsWith('- ')) {
    line = line.substring(2).trim();
  }

  // 去除包裹的引号
  if (
    (line.startsWith("'") && line.endsWith("'")) ||
    (line.startsWith('"') && line.endsWith('"'))
  ) {
    line = line.substring(1, line.length - 1).trim();
  }

  if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
    return null;
  }

  // 1. 通配符域名规则，如 +.google.com
  if (line.startsWith('+.')) {
    return `DOMAIN-SUFFIX,${line.substring(2).trim()},${defaultTarget}`;
  }

  // 2. 点前缀域名规则，如 .google.com
  if (line.startsWith('.') && line.length > 1 && !line.includes(',')) {
    return `DOMAIN-SUFFIX,${line.substring(1).trim()},${defaultTarget}`;
  }

  // 3. 通用逗号分隔规则 (DOMAIN-SUFFIX,google.com,PROXY,no-resolve)
  const noInlineComment = line.replace(/\s+#.*$/, '').trim();
  const parts = noInlineComment.split(',').map((p) => p.trim()).filter(Boolean);
  const ruleType = parts[0]?.toUpperCase();

  if (SUPPORTED_RULE_TYPES.has(ruleType)) {
    const value = parts[1];
    if (!value) return null;

    const modifiers: string[] = [];
    let rawTarget: string | undefined = parts[2];
    if (rawTarget && ['no-resolve', 'src'].includes(rawTarget.toLowerCase())) {
      modifiers.push(rawTarget.toLowerCase());
      rawTarget = undefined;
    }
    for (let i = 3; i < parts.length; i++) {
      const m = parts[i].toLowerCase();
      if (m === 'no-resolve' || m === 'src') {
        modifiers.push(m);
      }
    }

    let target = rawTarget || defaultTarget;
    const upperTarget = target.toUpperCase();
    if (upperTarget === 'DIRECT' || upperTarget === 'REJECT' || upperTarget === 'REJECT-DROP' || upperTarget === 'PASS') {
      target = upperTarget;
    } else {
      target = defaultTarget;
    }

    return modifiers.length > 0
      ? `${ruleType},${value},${target},${modifiers.join(',')}`
      : `${ruleType},${value},${target}`;
  }

  // 4. 纯域名格式检测 (如 google.com / sub.domain.org / *.domain.com)
  const cleanedDomain = line.startsWith('*.') ? line.substring(2) : line;
  if (/^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+$/.test(cleanedDomain)) {
    return `DOMAIN-SUFFIX,${cleanedDomain},${defaultTarget}`;
  }

  // 5. 纯 IPv4 / CIDR 格式检测 (如 1.2.3.4 或 10.0.0.0/8)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(line)) {
    const val = line.includes('/') ? line : `${line}/32`;
    return `IP-CIDR,${val},${defaultTarget}`;
  }

  return null;
}

/**
 * 解析各种规则文件内容 (.yaml, .yml, .conf, .txt, .list)
 */
export function parseRuleFileContent(
  content: string,
  defaultTarget: string = '🚀 节点选择'
): string[] {
  const result: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return result;

  // 1. 优先尝试作为 YAML 结构化解析 (Clash rules 列表或 rule-provider payload 格式)
  try {
    const parsedYaml = YAML.parse(trimmed);
    if (parsedYaml && typeof parsedYaml === 'object') {
      // 1.1 解析 rules: 列表
      if (Array.isArray(parsedYaml.rules)) {
        for (const item of parsedYaml.rules) {
          if (typeof item === 'string') {
            const norm = normalizeRuleLine(item, defaultTarget);
            if (norm) result.push(norm);
          }
        }
        if (result.length > 0) {
          return Array.from(new Set(result));
        }
      }

      // 1.2 解析 payload: 列表
      if (Array.isArray(parsedYaml.payload)) {
        for (const item of parsedYaml.payload) {
          if (typeof item === 'string') {
            const norm = normalizeRuleLine(item, defaultTarget);
            if (norm) result.push(norm);
          }
        }
        if (result.length > 0) {
          return Array.from(new Set(result));
        }
      }
    }
  } catch {
    // 非合法完整 YAML，平滑降级为按行逐行扫描
  }

  // 2. 按行扫描 (.conf, .txt, .list, 或普通文本)
  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // 忽略节头声明，如 [Rule], [Rules]
    if (line.startsWith('[') && line.endsWith(']')) {
      continue;
    }
    const norm = normalizeRuleLine(line, defaultTarget);
    if (norm) {
      result.push(norm);
    }
  }

  return Array.from(new Set(result));
}
