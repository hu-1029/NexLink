/**
 * 多协议与订阅格式真实测试样本库
 * 覆盖：VMess、VLESS (Reality/Vision/gRPC)、Shadowsocks (SIP002/2022/Plugins)、Trojan、Hysteria2、TUIC、WireGuard、Base64 订阅包、Clash YAML、Sing-box JSON
 */

import { safeBase64Encode } from '../../src/services/parser/base64';

// 1. VMess: v2rayN 标准 JSON Base64 格式 (带 WS + TLS)
const vmessObj = {
  v: '2',
  ps: '🇭🇰 香港 01 | 专线 [VMess-WS]',
  add: 'hk.example.com',
  port: '443',
  id: 'a0b1c2d3-e4f5-6789-0123-456789abcdef',
  aid: '0',
  scy: 'auto',
  net: 'ws',
  type: 'none',
  host: 'hk.example.com',
  path: '/vmess-ws',
  tls: 'tls',
  sni: 'hk.example.com',
  alpn: 'h2,http/1.1',
  fp: 'chrome',
};
export const SAMPLE_VMESS_WS = `vmess://${safeBase64Encode(JSON.stringify(vmessObj))}`;

// 2. VLESS: Reality + Vision (当前最主流协议配置)
export const SAMPLE_VLESS_REALITY =
  'vless://550e8400-e29b-41d4-a716-446655440000@us.reality.net:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=O2xZgL7b3K5q-X12vN3Y8u9I_P0kL4mJ7nH6gF5dE4s&sid=6ba7b810&spx=%2F#%F0%9F%87%BA%F0%9F%87%B8%20%E7%BE%8E%E5%9B%BD%2001%20%7C%20Reality%20%E6%9E%81%E9%80%9F';

// 2.1 Base64 复合 Authority (none:uuid@host:port) + 别名参数 (remarks/peer/xtls=2/pbk/sid/fingerprint) 模拟测试样本
export const SAMPLE_USER_VLESS_REALITY_BASE64 =
  'vless://bm9uZToxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTVAMTk4LjUxLjEwMC4xMDoxNzYyNg?remarks=vless%2Breality-%E5%9C%A3%E4%BD%95%E5%A1%9E&tls=1&peer=www.sony.com&udp=1&xtls=2&pbk=FakeRealityPublicKeyExample0000000000000001&sid=19d4&fingerprint=chrome';

// 2.2 Cloudflare Workers 节点样本：优选 IP + WebSocket + TLS
export const SAMPLE_CF_WORKER_VLESS_WS_TLS =
  'vless://d342d11e-d424-4583-b36e-524ab1f0afa4@104.16.1.1:443?encryption=none&security=tls&sni=my-sub.workers.dev&type=ws&host=my-sub.workers.dev&path=%2F%3Fed%3D2048#%E2%9A%A1%20Cloudflare%20Worker%20%E4%BC%98%E9%80%89IP%20%5BWS%2BTLS%5D';

// 2.3 Cloudflare 优选 IP 节点模拟测试样本：Reality + Vision 极速专线
export const SAMPLE_CF_CLEAN_IP_VLESS_REALITY =
  'vless://22222222-3333-4444-5555-666666666666@203.0.113.20:443?flow=xtls-rprx-vision&fp=chrome&pbk=FakeRealityPublicKeyExample0000000000000002&security=reality&sid=a1b2c3d4e5f60708&sni=gateway.icloud.com&spx=%2FHesarWeb&type=tcp#Cloudflare%20Reality%20%E6%9E%81%E9%80%9F';

// 3. VLESS: gRPC + TLS
export const SAMPLE_VLESS_GRPC =
  'vless://550e8400-e29b-41d4-a716-446655440001@jp.grpc.net:443?encryption=none&security=tls&sni=jp.grpc.net&type=grpc&serviceName=vless-grpc#%F0%9F%87%AF%F0%9F%87%B5%20%E6%97%A5%E6%9C%AC%2002%20%7C%20gRPC%20%E4%B8%93%E7%BA%BF';

// 4. Shadowsocks: SIP002 标准形式
export const SAMPLE_SS_SIP002 =
  `ss://${safeBase64Encode('aes-256-gcm:mySecretPassword123')}@sg.ss-node.org:8388#${encodeURIComponent('🇸🇬 新加坡 01 | SS-GCM')}`;

// 5. Shadowsocks: 2022 现代加密套件
export const SAMPLE_SS_2022 =
  `ss://${safeBase64Encode('2022-blake3-aes-128-gcm:v8k6d3G8QZ1yK2b7L5n9X3j1')}@tw.ss2022.net:8389#%F0%9F%87%B9%F0%9F%87%BC%20%E5%8F%B0%E6%B9%BE%2001%20%7C%20SS-2022`;

// 6. Shadowsocks: 带 v2ray-plugin 插件
export const SAMPLE_SS_PLUGIN =
  `ss://${safeBase64Encode('chacha20-ietf-poly1305:pass1234')}@de.ss-plugin.com:443/?plugin=v2ray-plugin%3Btls%3Bhost%3Dde.ss-plugin.com#%F0%9F%87%A9%F0%9F%87%AA%20%E5%BE%B7%E5%9B%BD%20%7C%20SS-Plugin`;

// 7. Trojan: 标准 TLS + WebSocket
export const SAMPLE_TROJAN_WS =
  'trojan://myTrojanPassword@kr.trojan.net:443?security=tls&sni=kr.trojan.net&type=ws&path=%2Ftrojan-ws&host=kr.trojan.net#%F0%9F%87%B0%F0%9F%87%B7%20%E9%9F%A9%E5%9B%BD%E9%A6%96%E5%B0%94%20%7C%20Trojan-WS';

// 8. Hysteria 2: 带 Salamander 混淆与端口跳跃
export const SAMPLE_HYSTERIA2_OBFS =
  'hysteria2://ultraAuthKey@uk.hy2-node.com:443?insecure=0&sni=uk.hy2-node.com&obfs=salamander&obfs-password=hy2ObfsPass123&mport=20000-40000#%F0%9F%87%AC%F0%9F%87%A7%20%E8%8B%B1%E5%9B%BD%E4%BC%A6%E6%95%A6%20%7C%20Hy2-Obfs';

// 9. TUIC: v5 标准 BBR 协议
export const SAMPLE_TUIC_V5 =
  'tuic://99999999-8888-7777-6666-555555555555:tuicPassword@fr.tuic.net:8443?congestion_control=bbr&alpn=h3&sni=fr.tuic.net&udp_relay_mode=native#%F0%9F%87%AB%F0%9F%87%B7%20%E6%B3%95%E5%9B%BD%E5%B7%B4%E9%BB%8E%20%7C%20TUIC-v5';

// 10. WireGuard: 标准参数
export const SAMPLE_WIREGUARD =
  'wireguard://aGVsbG93b3JsZHByaXZhdGVrZXkxMjM0NTY3ODkwMTI=@ca.wireguard.org:51820?publickey=cHVibGlja2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=&ip=10.0.0.2&presharedkey=cHJlc2hhcmVka2V5MTIzNDU2Nzg5MDEyMzQ1Ng==#%F0%9F%87%A8%F0%9F%87%A6%20%E5%8A%A0%E6%8B%BF%E5%A4%A7%20%7C%20WireGuard';

// 11. 混合多协议订阅包 (Base64 编码前)
export const SAMPLE_RAW_MULTILINE = [
  SAMPLE_VMESS_WS,
  SAMPLE_VLESS_REALITY,
  SAMPLE_VLESS_GRPC,
  SAMPLE_SS_SIP002,
  SAMPLE_SS_2022,
  SAMPLE_SS_PLUGIN,
  SAMPLE_TROJAN_WS,
  SAMPLE_HYSTERIA2_OBFS,
  SAMPLE_TUIC_V5,
  SAMPLE_WIREGUARD,
].join('\n');

// 12. 真实 Base64 订阅 Blob
export const SAMPLE_BASE64_SUBSCRIPTION = safeBase64Encode(SAMPLE_RAW_MULTILINE);

// 13. Clash / Mihomo 标准 YAML 配置文件样本
export const SAMPLE_CLASH_YAML = `
port: 7890
socks-port: 7891
mode: rule
log-level: info

proxies:
  - name: "🇭🇰 香港 01 [Clash-Reality]"
    type: vless
    server: hk.clash.net
    port: 443
    uuid: 550e8400-e29b-41d4-a716-446655440000
    network: tcp
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: www.apple.com
    reality-opts:
      public-key: O2xZgL7b3K5q-X12vN3Y8u9I_P0kL4mJ7nH6gF5dE4s
      short-id: 6ba7b810
    client-fingerprint: chrome

  - name: "🇯🇵 日本 02 [Clash-VMess]"
    type: vmess
    server: jp.clash.net
    port: 443
    uuid: a0b1c2d3-e4f5-6789-0123-456789abcdef
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts:
      path: /vmess-ws
      headers:
        Host: jp.clash.net

  - name: "🇺🇸 美国 03 [Clash-SS-2022]"
    type: ss
    server: us.clash.net
    port: 8388
    cipher: 2022-blake3-aes-128-gcm
    password: v8k6d3G8QZ1yK2b7L5n9X3j1
    udp: true

  - name: "🇸🇬 新加坡 04 [Clash-Hy2]"
    type: hysteria2
    server: sg.clash.net
    port: 443
    password: authSecretPassword
    sni: sg.clash.net
    obfs: salamander
    obfs-password: obfsPassword123
`;

// 14. Sing-box 标准 JSON 配置样本
export const SAMPLE_SINGBOX_JSON = JSON.stringify({
  outbounds: [
    {
      type: 'vless',
      tag: '🇭🇰 香港 01 [SingBox-Reality]',
      server: 'hk.singbox.net',
      server_port: 443,
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      flow: 'xtls-rprx-vision',
      network: 'tcp',
      tls: {
        enabled: true,
        server_name: 'www.microsoft.com',
        reality: {
          enabled: true,
          public_key: 'O2xZgL7b3K5q-X12vN3Y8u9I_P0kL4mJ7nH6gF5dE4s',
          short_id: '6ba7b810',
        },
      },
    },
    {
      type: 'shadowsocks',
      tag: '🇯🇵 日本 02 [SingBox-SS]',
      server: 'jp.singbox.net',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'password123',
    },
    {
      type: 'direct',
      tag: 'direct',
    },
  ],
});
