/**
 * Mihomo 本地 RESTful API 客户端
 * 严格监听 127.0.0.1 本地回环地址，带独立动态 API Secret 鉴权与超时防护
 */

export interface MihomoVersionInfo {
  version: string;
}

export interface MihomoProxyItem {
  name: string;
  type: string;
  udp?: boolean;
  now?: string; // 代理组当前选中出站
  all?: string[]; // 代理组包含的节点列表
  history?: Array<{ time: string; delay: number }>;
}

export interface MihomoProxiesResponse {
  proxies: Record<string, MihomoProxyItem>;
}

export interface MihomoTrafficData {
  up: number;
  down: number;
}

export interface MihomoConnectionItem {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: string;
    destinationPort: string;
    host: string;
    dnsMode: string;
    processPath?: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface MihomoConnectionsResponse {
  downloadTotal: number;
  uploadTotal: number;
  memory: number;
  connections: MihomoConnectionItem[];
}

export class MihomoApiClient {
  private baseUrl: string;
  private secret: string;

  constructor(port: number = 9097, secret: string = '') {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.secret = secret;
  }

  public updateEndpoint(port: number, secret: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.secret = secret;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.secret) {
      headers.Authorization = `Bearer ${this.secret}`;
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs: number = 4000
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...(options.headers as Record<string, string>),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
      }
      throw err;
    }
  }

  /**
   * 1. 获取核心版本
   */
  async getVersion(): Promise<MihomoVersionInfo> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/version`);
    if (!res.ok) {
      throw new Error(`获取版本失败: HTTP ${res.status}`);
    }
    return (await res.json()) as MihomoVersionInfo;
  }

  /**
   * 2. 获取所有代理节点与策略组
   */
  async getProxies(): Promise<MihomoProxiesResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/proxies`);
    if (!res.ok) {
      throw new Error(`获取节点失败: HTTP ${res.status}`);
    }
    return (await res.json()) as MihomoProxiesResponse;
  }

  /**
   * 3. 获取特定策略组信息
   */
  async getProxyGroup(groupName: string): Promise<MihomoProxyItem> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/proxies/${encodeURIComponent(groupName)}`
    );
    if (!res.ok) {
      throw new Error(`获取策略组 ${groupName} 失败: HTTP ${res.status}`);
    }
    return (await res.json()) as MihomoProxyItem;
  }

  /**
   * 4. 切换策略组的目标出站节点
   */
  async selectProxy(groupName: string, proxyName: string): Promise<boolean> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/proxies/${encodeURIComponent(groupName)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ name: proxyName }),
      }
    );
    if (!res.ok && res.status !== 204) {
      throw new Error(`切换节点至 ${proxyName} 失败: HTTP ${res.status}`);
    }
    return true;
  }

  /**
   * 5. 节点单项或并发延迟测试
   */
  async getProxyDelay(
    proxyName: string,
    testUrl: string = 'http://www.gstatic.com/generate_204',
    timeoutMs: number = 3000
  ): Promise<number> {
    const url = `${this.baseUrl}/proxies/${encodeURIComponent(
      proxyName
    )}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeoutMs}`;
    const res = await this.fetchWithTimeout(url, {}, timeoutMs + 1000);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `测速失败: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { delay: number };
    return data.delay;
  }

  /**
   * 6. 获取活跃连接与实时统计
   */
  async getConnections(): Promise<MihomoConnectionsResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/connections`);
    if (!res.ok) {
      throw new Error(`获取连接失败: HTTP ${res.status}`);
    }
    const data = (await res.json()) as any;
    return {
      downloadTotal: data.downloadTotal || 0,
      uploadTotal: data.uploadTotal || 0,
      memory: data.memory || 0,
      connections: Array.isArray(data.connections) ? data.connections : [],
    };
  }

  /**
   * 7. 关闭指定连接
   */
  async closeConnection(id: string): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.ok || res.status === 204;
  }

  /**
   * 8. 关闭所有活动连接
   */
  /**
   * 8.1 获取当前生效规则
   */
  async getRules(): Promise<{ rules: any[] }> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/rules`);
    if (!res.ok) {
      throw new Error(`获取规则失败: HTTP ${res.status}`);
    }
    return (await res.json()) as { rules: any[] };
  }

  async closeAllConnections(): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/connections`, {
      method: 'DELETE',
    });
    return res.ok || res.status === 204;
  }

  /**
   * 9. 切换分流模式 (rule / global / direct)
   */
  async changeMode(mode: 'rule' | 'global' | 'direct'): Promise<boolean> {
    const capitalized = mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase();
    const tryModes = [capitalized, mode.toLowerCase()];
    let lastStatus = 0;
    let lastBody = '';

    for (const m of tryModes) {
      try {
        const res = await this.fetchWithTimeout(`${this.baseUrl}/configs`, {
          method: 'PATCH',
          body: JSON.stringify({ mode: m }),
        });
        if (res.ok || res.status === 204) {
          return true;
        }
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
      } catch (err: any) {
        lastBody = err?.message || String(err);
      }
    }

    console.warn(`[APIClient] changeMode(${mode}) failed across variants: status=${lastStatus}, body=${lastBody}`);
    return false;
  }

  /**
   * 重新加载运行时配置文件 (平滑热更新，零断网、不重置现有连接)
   */
  async reloadConfigs(configPath: string, force: boolean = true): Promise<boolean> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/configs?force=${force}`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: configPath }),
      },
      8000
    );
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `热重载配置失败: HTTP ${res.status}`);
    }
    return true;
  }

  /**
   * 触发 Mihomo 热更新 GeoIP / GeoSite / ASN 数据库 (无需重启核心)
   */
  async updateGeoDatabases(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/configs/geo`,
        { method: 'POST', body: JSON.stringify({}) },
        45000
      );
      if (res.ok || res.status === 204) {
        return { ok: true };
      }
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || '更新 Geo 数据库超时或失败' };
    }
  }

  /**
   * 清理代理核心 DNS 解析缓存 (FakeIP 及原生 DNS 缓存)
   */
  async flushDns(): Promise<boolean> {
    let success = false;
    try {
      const res1 = await this.fetchWithTimeout(`${this.baseUrl}/cache/fakeip/flush`, { method: 'POST' }, 2000).catch(() => null);
      if (res1?.ok || res1?.status === 204) success = true;

      const res2 = await this.fetchWithTimeout(`${this.baseUrl}/dns/flush`, { method: 'POST' }, 2000).catch(() => null);
      if (res2?.ok || res2?.status === 204) success = true;
    } catch {
      // ignore
    }
    return success;
  }

  /**
   * 获取内核物理内存占用 (bytes)
   */
  async getMemory(): Promise<number> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/connections`, {}, 2000);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (typeof data.memory === 'number') {
          return data.memory;
        }
      }
    } catch {
      // fallback
    }
    return 0;
  }

  /**
   * 启动带初始连接握手超时保护的 NDJSON/SSE 流读取器
   */
  private startJsonLineStream<T>(
    endpointPath: string,
    errorLabel: string,
    onData: (data: T) => void,
    onError?: (err: Error) => void,
    connectTimeoutMs: number = 5000
  ): () => void {
    const controller = new AbortController();
    let isAborted = false;
    let timedOut = false;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const connectStream = async () => {
      let handshakeTimer: NodeJS.Timeout | null = null;
      try {
        if (connectTimeoutMs > 0) {
          handshakeTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, connectTimeoutMs);
        }

        const response = await fetch(`${this.baseUrl}${endpointPath}`, {
          headers: this.getHeaders(),
          signal: controller.signal,
        });

        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }

        if (!response.ok || !response.body) {
          throw new Error(`无法连接${errorLabel}: HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder();
        let buffer = '';

        while (!isAborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed) as T;
              onData(data);
            } catch {
              // 忽略解析错误行
            }
          }
        }
      } catch (err: any) {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (!isAborted) {
          if (timedOut) {
            onError?.(new Error(`${errorLabel}连接超时 (${connectTimeoutMs}ms)`));
          } else {
            onError?.(err instanceof Error ? err : new Error(String(err?.message || err)));
          }
        }
      } finally {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        const readerToCancel = activeReader;
        activeReader = null;
        if (readerToCancel) {
          try {
            await readerToCancel.cancel();
          } catch {
            // ignore cancel error
          }
          try {
            readerToCancel.releaseLock();
          } catch {
            // ignore releaseLock error
          }
        }
      }
    };

    void connectStream();

    return () => {
      isAborted = true;
      const readerToCancel = activeReader;
      activeReader = null;
      if (readerToCancel) {
        void readerToCancel.cancel().catch(() => {});
      }
      controller.abort();
    };
  }

  /**
   * 10. 启动流式实时流量监控（SSE 流或轮询降级）
   */
  startTrafficStream(
    onData: (data: MihomoTrafficData) => void,
    onError?: (err: Error) => void,
    connectTimeoutMs: number = 5000
  ): () => void {
    return this.startJsonLineStream<MihomoTrafficData>(
      '/traffic',
      '流量流',
      onData,
      onError,
      connectTimeoutMs
    );
  }

  /**
   * 11. 启动流式实时日志监控 (SSE /logs)
   */
  startLogStream(
    level: string = 'info',
    onData: (data: { type: string; payload: string }) => void,
    onError?: (err: Error) => void,
    connectTimeoutMs: number = 5000
  ): () => void {
    return this.startJsonLineStream<{ type: string; payload: string }>(
      `/logs?level=${encodeURIComponent(level)}`,
      '日志流',
      onData,
      onError,
      connectTimeoutMs
    );
  }
}
