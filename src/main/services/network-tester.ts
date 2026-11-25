import net from 'net';
import os from 'os';
import { execFile } from 'child_process';
import type { MihomoProcessManager } from '../core/mihomo-process';

const SAFE_HOST_REGEX = /^[a-zA-Z0-9._:-]+$/;

export class NetworkTester {
  private mihomoManager: MihomoProcessManager;

  constructor(mihomoManager: MihomoProcessManager) {
    this.mihomoManager = mihomoManager;
  }

  /**
   * 自动发现宿主机真实物理网卡 IPv4 地址 (绕过 TUN / Fake-IP 虚拟网卡劫持)
   */
  private getPhysicalLocalAddress(): string | undefined {
    try {
      const ifaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        const lower = name.toLowerCase();
        if (
          lower.includes('meta') ||
          lower.includes('wintun') ||
          lower.includes('tun') ||
          lower.includes('tap') ||
          lower.includes('docker') ||
          lower.includes('vmware') ||
          lower.includes('tailscale') ||
          lower.includes('wireguard') ||
          lower.includes('wsl') ||
          lower.includes('vethernet') ||
          lower.includes('loopback')
        ) {
          continue;
        }
        for (const a of addrs || []) {
          if (
            a.family === 'IPv4' &&
            !a.internal &&
            !a.address.startsWith('198.18.') &&
            !a.address.startsWith('169.254.')
          ) {
            return a.address;
          }
        }
      }
    } catch {
      // 容错兜底
    }
    return undefined;
  }

  /**
   * 1. TCP 握手测速 (TCP Ping)
   * 测量与节点 server:port 建立三次握手的单次 RTT 时间
   */
  public async testTcpDelay(server: string, port: number, timeoutMs: number = 2500): Promise<number> {
    return new Promise((resolve) => {
      if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return resolve(-1);

      const localAddress = this.getPhysicalLocalAddress();
      const start = performance.now();
      const socket = new net.Socket();
      let settled = false;

      const cleanup = () => {
        if (!settled) {
          settled = true;
          socket.destroy();
        }
      };

      socket.setTimeout(timeoutMs);

      const options: net.SocketConnectOpts = {
        host: server.trim(),
        port: port,
      };
      if (localAddress && !net.isIPv6(server.trim())) {
        options.localAddress = localAddress;
      }

      socket.connect(options, () => {
        const delay = Math.round(performance.now() - start);
        cleanup();
        resolve(delay > 0 ? delay : 1);
      });

      socket.on('error', () => {
        if (settled) return;
        cleanup();
        if (options.localAddress) {
          const fallbackSocket = new net.Socket();
          fallbackSocket.setTimeout(timeoutMs);
          const fbStart = performance.now();
          fallbackSocket.connect(port, server.trim(), () => {
            const delay = Math.round(performance.now() - fbStart);
            fallbackSocket.destroy();
            resolve(delay > 0 ? delay : 1);
          });
          fallbackSocket.on('error', () => {
            fallbackSocket.destroy();
            resolve(-1);
          });
          fallbackSocket.on('timeout', () => {
            fallbackSocket.destroy();
            resolve(-1);
          });
        } else {
          resolve(-1);
        }
      });

      socket.on('timeout', () => {
        cleanup();
        resolve(-1);
      });
    });
  }

  /**
   * 2. ICMP Ping 测速
   * 使用原生 execFile 替代 shell 拼接，彻底杜绝恶意订阅域名导致的命令注入风险
   */
  public async testIcmpDelay(server: string, timeoutMs: number = 2000): Promise<number> {
    return new Promise((resolve) => {
      if (!server) return resolve(-1);

      const cleanHost = server.trim();
      if (!cleanHost || cleanHost.length > 253 || !SAFE_HOST_REGEX.test(cleanHost) || cleanHost.startsWith('-')) {
        return resolve(-1);
      }

      const safeTimeout = Math.max(200, Math.min(10000, Math.floor(timeoutMs)));
      const bin = process.platform === 'win32' ? 'ping.exe' : 'ping';
      const args =
        process.platform === 'win32'
          ? ['-n', '1', '-w', String(safeTimeout), cleanHost]
          : ['-c', '1', '-W', String(Math.max(1, Math.ceil(safeTimeout / 1000))), cleanHost];

      execFile(bin, args, { timeout: safeTimeout + 1000, windowsHide: true, encoding: 'buffer' }, (error, stdoutBuf) => {
        if (error || !stdoutBuf) return resolve(-1);
        const stdout = stdoutBuf.toString('latin1');

        const match = stdout.match(/[<=](\d+(?:\.\d+)?)\s*ms/i);
        if (match && match[1]) {
          return resolve(Math.max(1, Math.round(parseFloat(match[1]))));
        }
        if (stdout.includes('<1ms') || stdout.includes('< 1ms')) {
          return resolve(1);
        }
        resolve(-1);
      });
    });
  }

  /**
   * 3. CONNECT 代理全链路握手测速 (HTTP URL-Test)
   */
  public async testConnectDelay(
    nodeName: string,
    url: string = 'http://cp.cloudflare.com/generate_204',
    timeoutMs: number = 3000
  ): Promise<number> {
    if (!this.mihomoManager.getStatus().running) {
      throw new Error('代理核心尚未启动，无法进行 CONNECT 代理隧道测速');
    }
    return await this.mihomoManager.getApiClient().getProxyDelay(nodeName, url, timeoutMs);
  }

  /**
   * 统一调度测速
   */
  public async testDelay(
    node: { name: string; server: string; port: number; type?: string },
    method: 'TCP' | 'ICMP' | 'CONNECT' = 'TCP',
    timeoutMs: number = 2500
  ): Promise<number> {
    if (method === 'ICMP') {
      const res = await this.testIcmpDelay(node.server, timeoutMs);
      if (res > 0) return res;
      return await this.testTcpDelay(node.server, node.port, timeoutMs);
    }

    if (method === 'CONNECT') {
      try {
        if (this.mihomoManager.getStatus().running) {
          const res = await this.testConnectDelay(node.name, 'http://cp.cloudflare.com/generate_204', timeoutMs);
          if (res > 0) return res;
        }
      } catch {
        // 核心测速失败时，回退至 TCP 握手测速保障界面有真实数据
      }
      return await this.testTcpDelay(node.server, node.port, timeoutMs);
    }

    const isUdpOnly = ['tuic', 'hysteria', 'hysteria2', 'wireguard'].includes((node.type || '').toLowerCase());
    if (isUdpOnly) {
      const icmpRes = await this.testIcmpDelay(node.server, timeoutMs);
      if (icmpRes > 0) return icmpRes;
      if (this.mihomoManager.getStatus().running) {
        try {
          return await this.testConnectDelay(node.name, 'http://cp.cloudflare.com/generate_204', timeoutMs);
        } catch {
          return -1;
        }
      }
      return -1;
    }

    const tcpRes = await this.testTcpDelay(node.server, node.port, timeoutMs);
    if (tcpRes > 0) return tcpRes;
    const icmpFallback = await this.testIcmpDelay(node.server, 1500);
    return icmpFallback > 0 ? icmpFallback : -1;
  }
}
