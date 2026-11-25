import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws: http: https:;";

/**
 * 仅在开发模式 (vite dev) 放宽 CSP 以支持 HMR 及热更新调试；生产构建保持严格
 */
export function devCspPlugin(): Plugin {
  return {
    name: 'dev-csp-relax',
    apply: 'serve',
    transformIndexHtml(html: string) {
      return html.replace(
        /http-equiv="Content-Security-Policy"\s+content="[^"]*"/,
        `http-equiv="Content-Security-Policy" content="${DEV_CSP}"`
      );
    },
  };
}

const sharedAlias = {
  '@': path.resolve(__dirname, 'src/renderer'),
  '@services': path.resolve(__dirname, 'src/services'),
  '@main': path.resolve(__dirname, 'src/main'),
  '@shared': path.resolve(__dirname, 'src/shared'),
};

export default defineConfig({
  base: './',
  plugins: [
    devCspPlugin(),
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          resolve: { alias: sharedAlias },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      preload: {
        input: 'src/preload/index.ts',
        vite: {
          resolve: { alias: sharedAlias },
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs',
              },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: sharedAlias,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
  },
});
