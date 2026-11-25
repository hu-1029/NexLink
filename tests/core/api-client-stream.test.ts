import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { MihomoApiClient } from '../../src/main/core/api-client';

describe('MihomoApiClient SSE 流握手超时保护单元测试', () => {
  it('1. startTrafficStream 与 startLogStream 在初始握手挂死时应触发 AbortController 超时并回调 onError', async () => {
    const openSockets = new Set<any>();
    const server = http.createServer((_req, _res) => {
      // 故意不返回响应头，模拟 SSE 握手阶段永久挂起
    });
    server.on('connection', (sock) => {
      openSockets.add(sock);
      sock.on('close', () => openSockets.delete(sock));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const client = new MihomoApiClient(port);

    try {
      const trafficErr = await new Promise<Error>((resolve, reject) => {
        const stop = client.startTrafficStream(
          () => reject(new Error('挂死流不应产出数据')),
          (err) => {
            stop();
            resolve(err);
          },
          120
        );
      });
      assert.match(trafficErr.message, /流量流连接超时/);

      const logErr = await new Promise<Error>((resolve, reject) => {
        const stop = client.startLogStream(
          'info',
          () => reject(new Error('挂死日志流不应产出数据')),
          (err) => {
            stop();
            resolve(err);
          },
          120
        );
      });
      assert.match(logErr.message, /日志流连接超时/);
    } finally {
      for (const sock of openSockets) sock.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('2. 正常建立 HTTP 200 SSE 连接并收到数据后可稳定解析，主动 stop() 不误报 onError', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/traffic') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(`${JSON.stringify({ up: 128, down: 256 })}\n`);
        // 建立连接后保持长连接静默一段时间，验证不会在握手超时后被误杀
        setTimeout(() => {
          if (!res.destroyed) {
            res.write(`${JSON.stringify({ up: 512, down: 1024 })}\n`);
          }
        }, 140);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const client = new MihomoApiClient(port);

    try {
      const received: Array<{ up: number; down: number }> = [];
      let unexpectedErr: Error | null = null;

      await new Promise<void>((resolve, reject) => {
        const guardTimer = setTimeout(() => reject(new Error('测试 2 超时未收到足够数据')), 2000);
        const stop = client.startTrafficStream(
          (data) => {
            received.push(data);
            if (received.length >= 2) {
              clearTimeout(guardTimer);
              stop();
              resolve();
            }
          },
          (err) => {
            clearTimeout(guardTimer);
            unexpectedErr = err;
            reject(err);
          },
          80
        );
      });

      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(unexpectedErr, null, '正常长连接与主动关闭不应触发 onError');
      assert.deepStrictEqual(received, [
        { up: 128, down: 256 },
        { up: 512, down: 1024 },
      ]);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
