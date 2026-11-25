/**
 * 全格式智能导入中心主调度引擎
 * 自动嗅探格式、分发解析、递归解码 Base64 订阅、捕获行级异常与去重聚合
 */

import type { ParseError, ParseResult, ProxyNode } from '../../shared/types';
import { isLikelyBase64, safeBase64Decode } from '../parser/base64';
import { parseSingleUri } from '../parser/protocol-uri';
import { parseClashYaml } from '../converter/clash-parser';
import { parseJsonConfig } from '../converter/json-parser';
import { deduplicateNodes } from '../node/dedup';

/**
 * 智能导入主入口
 * @param content 用户粘贴的文本或文件内容
 * @param options 配置参数（如关联的订阅 ID，已有节点用于去重）
 */
export function smartParse(
  content: string,
  options: {
    subscriptionId?: string;
    existingNodes?: ProxyNode[];
  } = {}
): ParseResult {
  const trimmed = content.trim();

  if (!trimmed) {
    return {
      success: false,
      format: 'unknown',
      nodes: [],
      errors: [{ raw: '', error: '导入内容为空' }],
      totalParsed: 0,
    };
  }

  // 1. 递归检测并解码 Base64 订阅包（限制递归深度防栈溢出）
  const depth = (options as any)._depth || 0;
  if (depth < 3 && isLikelyBase64(trimmed)) {
    try {
      const decoded = safeBase64Decode(trimmed);
      if (decoded && decoded.trim() !== trimmed) {
        const innerResult = smartParse(decoded, { ...options, _depth: depth + 1 } as any);
        if (innerResult.nodes.length > 0 || innerResult.format !== 'unknown') {
          return {
            ...innerResult,
            format: 'base64-blob',
          };
        }
      }
    } catch {
      // 若解码异常则继续向下尝试其他格式
    }
  }

  // 2. 检测 Clash / Mihomo YAML 格式（仅匹配行首键名，避免误拦截含 Proxy: 备注的 URI 列表）
  if (
    /^(?:proxies|Proxy|port|mixed-port|mode)\s*:/m.test(trimmed)
  ) {
    try {
      const rawNodes = parseClashYaml(trimmed, options.subscriptionId);
      const taggedNodes = rawNodes.map((n) => ({
        ...n,
        subscriptionId: options.subscriptionId,
      }));
      const nodes = deduplicateNodes(taggedNodes, options.existingNodes);
      return {
        success: nodes.length > 0,
        format: 'clash-yaml',
        nodes,
        errors: [],
        totalParsed: nodes.length,
      };
    } catch (err: any) {
      return {
        success: false,
        format: 'clash-yaml',
        nodes: [],
        errors: [{ raw: trimmed.slice(0, 80), error: err.message || 'Clash YAML 解析失败' }],
        totalParsed: 0,
      };
    }
  }

  // 3. 检测 Sing-box / V2Ray JSON 格式
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const rawNodes = parseJsonConfig(trimmed, options.subscriptionId);
      const taggedNodes = rawNodes.map((n) => ({
        ...n,
        subscriptionId: options.subscriptionId,
      }));
      const nodes = deduplicateNodes(taggedNodes, options.existingNodes);
      return {
        success: nodes.length > 0,
        format: 'sing-box-json',
        nodes,
        errors: [],
        totalParsed: nodes.length,
      };
    } catch (err: any) {
      return {
        success: false,
        format: 'sing-box-json',
        nodes: [],
        errors: [{ raw: trimmed.slice(0, 80), error: err.message || 'JSON 配置解析失败' }],
        totalParsed: 0,
      };
    }
  }

  // 4. 解析多行 URI 混合列表 (vmess, vless, ss, trojan, hysteria2, tuic, wireguard)
  const lines = trimmed.split(/[\r\n]+/);
  const parsedNodes: ProxyNode[] = [];
  const errors: ParseError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    try {
      const node = parseSingleUri(line, options.subscriptionId);
      node.subscriptionId = options.subscriptionId;
      parsedNodes.push(node);
    } catch (err: any) {
      errors.push({
        line: i + 1,
        raw: line.length > 100 ? `${line.substring(0, 100)}...` : line,
        error: err.message || '未知解析异常',
      });
    }
  }

  const nodes = deduplicateNodes(parsedNodes, options.existingNodes);

  return {
    success: nodes.length > 0,
    format: 'uri-list',
    nodes,
    errors,
    totalParsed: nodes.length,
  };
}
