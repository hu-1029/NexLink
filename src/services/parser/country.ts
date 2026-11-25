/**
 * 节点名称与服务器地址地区检测工具
 * 优先匹配国旗 emoji、中文地名，对双字母缩写使用单词边界精准匹配，防止 "node" 误伤 "de"
 */

interface CountryInfo {
  country: string;
  countryCode: string;
}

const REGION_RULES: Array<{
  exactKeywords: string[]; // 中文、完整地名或 Emoji（直接 includes 匹配）
  codeKeywords: string[];  // 2~3 字母代码（需单词边界匹配，如 \bde\b）
  country: string;
  countryCode: string;
}> = [
  {
    exactKeywords: ['香港', 'hongkong', 'hong kong', '🇭🇰'],
    codeKeywords: ['hk'],
    country: 'Hong Kong',
    countryCode: 'HK',
  },
  {
    exactKeywords: ['台湾', '台北', '台中', 'taiwan', '🇹🇼'],
    codeKeywords: ['tw'],
    country: 'Taiwan',
    countryCode: 'TW',
  },
  {
    exactKeywords: ['日本', '东京', '大阪', 'japan', 'tokyo', 'osaka', '🇯🇵'],
    codeKeywords: ['jp'],
    country: 'Japan',
    countryCode: 'JP',
  },
  {
    exactKeywords: ['新加坡', '狮城', 'singapore', '🇸🇬'],
    codeKeywords: ['sg'],
    country: 'Singapore',
    countryCode: 'SG',
  },
  {
    exactKeywords: ['美国', '洛杉矶', '圣何塞', '西雅图', '硅谷', '纽约', '芝加哥', 'usa', 'united states', '🇺🇸'],
    codeKeywords: ['us'],
    country: 'United States',
    countryCode: 'US',
  },
  {
    exactKeywords: ['韩国', '首尔', 'korea', 'seoul', '🇰🇷'],
    codeKeywords: ['kr'],
    country: 'South Korea',
    countryCode: 'KR',
  },
  {
    exactKeywords: ['德国', '法兰克福', 'germany', 'frankfurt', '🇩🇪'],
    codeKeywords: ['de'],
    country: 'Germany',
    countryCode: 'DE',
  },
  {
    exactKeywords: ['英国', '伦敦', 'london', 'united kingdom', '🇬🇧'],
    codeKeywords: ['uk', 'gb'],
    country: 'United Kingdom',
    countryCode: 'GB',
  },
  {
    exactKeywords: ['法国', '巴黎', 'france', 'paris', '🇫🇷'],
    codeKeywords: ['fr'],
    country: 'France',
    countryCode: 'FR',
  },
  {
    exactKeywords: ['加拿大', '多伦多', '温哥华', 'canada', 'toronto', '🇨🇦'],
    codeKeywords: ['ca'],
    country: 'Canada',
    countryCode: 'CA',
  },
  {
    exactKeywords: ['澳大利亚', '悉尼', '墨尔本', 'australia', 'sydney', '🇦🇺'],
    codeKeywords: ['au'],
    country: 'Australia',
    countryCode: 'AU',
  },
  {
    exactKeywords: ['俄罗斯', '莫斯科', 'russia', 'moscow', '🇷🇺'],
    codeKeywords: ['ru'],
    country: 'Russia',
    countryCode: 'RU',
  },
];

export const COUNTRY_FLAGS: Record<string, string> = {
  US: '🇺🇸',
  HK: '🇭🇰',
  TW: '🇹🇼',
  JP: '🇯🇵',
  SG: '🇸🇬',
  KR: '🇰🇷',
  GB: '🇬🇧',
  UK: '🇬🇧',
  DE: '🇩🇪',
  FR: '🇫🇷',
  CA: '🇨🇦',
  AU: '🇦🇺',
  RU: '🇷🇺',
  NL: '🇳🇱',
  IN: '🇮🇳',
  TH: '🇹🇭',
  MY: '🇲🇾',
  PH: '🇵🇭',
  VN: '🇻🇳',
  CN: '🇨🇳',
  GLOBAL: '🌐',
  AUTO: '🌐',
};

export function getCountryFlag(countryCode?: string): string {
  if (!countryCode) return '🌐';
  const upper = countryCode.toUpperCase();
  if (COUNTRY_FLAGS[upper]) return COUNTRY_FLAGS[upper];
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
    const codePoints = [...upper].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
    return String.fromCodePoint(...codePoints);
  }
  return '🌐';
}

// 常见海外云服务器 IP 常用段检测 (如 Google Cloud US, AWS US, Cloudflare 等)
function detectByServerIP(server: string): CountryInfo | null {
  if (!server) return null;
  const clean = server.trim();
  const parts = clean.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 4 && !parts.some(isNaN)) {
    const [p0, p1] = parts;
    // Google Cloud US 主力段 (34.x, 35.x)
    if (p0 === 34 || p0 === 35) {
      return { country: 'United States', countryCode: 'US' };
    }
    // 常见美区托管机房 (147.224.x.x, 104.16~31.x.x, 198.18.x.x 等)
    if (p0 === 147 && p1 === 224) {
      return { country: 'United States', countryCode: 'US' };
    }
    if (p0 === 104 && p1 >= 16 && p1 <= 31) {
      return { country: 'United States', countryCode: 'US' };
    }
    // AWS US (54.x, 52.x, 44.x, 3.x)
    if (p0 === 54 || p0 === 52 || p0 === 44 || p0 === 3) {
      return { country: 'United States', countryCode: 'US' };
    }
    // DigitalOcean / Vultr / Linode US 常见段
    if (p0 === 159 && p1 === 203) return { country: 'United States', countryCode: 'US' };
    if (p0 === 192 && p1 === 241) return { country: 'United States', countryCode: 'US' };
    if (p0 === 165 && p1 === 227) return { country: 'United States', countryCode: 'US' };
  }
  return null;
}

export function detectCountry(name: string, server: string = ''): CountryInfo {
  const target = `${name} ${server}`.toLowerCase();

  // 1. 优先通过明确中文地名、别名或 Emoji 匹配
  for (const rule of REGION_RULES) {
    for (const kw of rule.exactKeywords) {
      if (target.includes(kw.toLowerCase())) {
        return {
          country: rule.country,
          countryCode: rule.countryCode,
        };
      }
    }
  }

  // 2. 匹配两字母/三字母国际缩写（使用边界正则，如 \bhk\b, \bus\b）
  for (const rule of REGION_RULES) {
    for (const kw of rule.codeKeywords) {
      const regex = new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i');
      if (regex.test(target)) {
        return {
          country: rule.country,
          countryCode: rule.countryCode,
        };
      }
    }
  }

  // 3. 尝试通过已知常用服务器 IP 段进行匹配
  const ipMatch = detectByServerIP(server);
  if (ipMatch) {
    return ipMatch;
  }

  return {
    country: 'Other',
    countryCode: 'GLOBAL',
  };
}

export function getNodeCountry(node: { countryCode?: string; name?: string; server?: string }): { countryCode: string; flag: string } {
  let code = (node.countryCode || '').toUpperCase();
  if (!code || code === 'GLOBAL' || code === 'AUTO') {
    const detected = detectCountry(node.name || '', node.server || '');
    if (detected.countryCode && detected.countryCode !== 'GLOBAL') {
      code = detected.countryCode;
    } else {
      code = code || 'GLOBAL';
    }
  }
  return {
    countryCode: code,
    flag: getCountryFlag(code),
  };
}
