import * as Electron from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../shared/ipc-events';
import { mihomoManager } from './core/mihomo-process';
import { storageManager } from './storage/store';
import { subscriptionManager } from './subscription/manager';
import { systemProxyManager } from './network/system-proxy';
import { checkTunPrerequisites, cleanupLegacyRunAsAdminRegistry, isCurrentProcessAdmin } from './network/tun-checker';
import { tunServiceManager } from './network/service-manager';
import { updateService } from './services/updater';

const app = Electron.app;
const BrowserWindow = Electron.BrowserWindow;
const shell = Electron.shell;
const Tray = Electron.Tray;
const Menu = Electron.Menu;
const nativeImage = Electron.nativeImage;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function shouldEnableRemoteDebugging(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  if (isPackaged) return false;
  return Boolean(
    env.NEXLINK_DEBUG_PORT || argv.some((a) => a.includes('remote-debugging-port'))
  );
}

export async function stopWithTimeoutAndFallback(
  stopFn: () => Promise<boolean>,
  emergencyCleanupFn: () => void,
  timeoutMs: number = 5500
): Promise<{ timedOut: boolean; stopped: boolean }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const raceRes = await Promise.race([
      stopFn().then((ok) => ({ kind: 'done' as const, ok })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (raceRes.kind === 'timeout') {
      console.warn(`[NexLink] 退出停止核心超时 (${timeoutMs}ms)，触发紧急清理兜底`);
      emergencyCleanupFn();
      return { timedOut: true, stopped: false };
    }
    return { timedOut: false, stopped: Boolean(raceRes.ok) };
  } catch (err: any) {
    console.error('[NexLink] 退出时停止 Mihomo 异常，触发紧急清理兜底:', err?.message || err);
    emergencyCleanupFn();
    return { timedOut: false, stopped: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app?.commandLine?.appendSwitch('disable-color-correct-rendering');
app?.commandLine?.appendSwitch('proxy-bypass-list', '<local>;localhost;127.0.0.1;::1');
if (app && shouldEnableRemoteDebugging(Boolean(app.isPackaged))) {
  app.commandLine?.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow: Electron.BrowserWindow | null = null;
let tray: Electron.Tray | null = null;
let trayTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

function getPreloadPath(): string {
  const cjsPath = path.join(__dirname, '../preload/index.cjs');
  const mjsPath = path.join(__dirname, '../preload/index.mjs');
  const jsPath = path.join(__dirname, '../preload/index.js');
  if (fs.existsSync(cjsPath)) return cjsPath;
  if (fs.existsSync(mjsPath)) return mjsPath;
  return jsPath;
}

export function getResourcesDir(): string {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'resources');
  }
  return path.resolve(app?.getAppPath() || process.cwd(), 'resources');
}

// 经校验的标准 16x16 PNG 托盘图标 Base64 备用（蓝色常规图标与绿色 TUN 模式图标）
const BLUE_TRAY_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACRklEQVR4nJWTzW8OURTGf+fOnXn1bbXSChGhiYg0JdGw8RGJhI2FHSv/ABYkNjb+DLGwtWJlz0IkxAINEkKlwgJ9pV+vdsbM3HuP3HlbabHgSSZzc+95Ts7znHNEVY2IhDzPj1prT4okfTQIwjoYDYCoL5xz99vt9qPIJcI5d9V7dfqPiLGR05DzPD+y+rD83def3pZuqetiMhcDvTaJXVF69+Zz5fLS16vxkWvTtHUK0NmO99fvdO2HUWH8mXD59CC2LRiFxSJw6dYCLzo1Y6MpN85ucsN9Jolc41xoRWnTU5VMW+XJtsDdQc/zxZrEgALvO47JrxWDmwyTszWvv9XRH6lCaEUTYgySgljI5qGbB84/7HL7TYERSKxg2wafQto2SM+6CLWrp5gzzWEkETqlknnh2r0unbnAoR0pIQOfCV6UFe8b2F9N2iBMvSw5uLmPdwOWj19qtqaGmw+WmNrTon/IUBoISQxe01xWIAkUmfB0smTnAkwMpywuBIYQfpRKaElTRfyryJ8JVEA2gBkQHk9XXDkywIXD/czPetSDtiBkvST8TQLR8UzQDBIjjc6LxwfYkhgefCp7ZBRNe29rK5De4ApFomhLKIzi453CmWNtzp3oZ6YOjU+FXTfkYqw1ZVQwtj3Vvbsy5ryyfzRj90hClOoDjI+kHNiaMmuUiRHLvo02tl6tMeW6Uc4rrV/PVK6ofG+UV754zp13r7qVW3a6bpSbOqqq+u9lipxGw9p1Nivr3PPot3U2vXVW74uwZp1/Arn0sq4hApKXAAAAAElFTkSuQmCC';

const GREEN_TRAY_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACXklEQVR4nKVTO2sUURT+zn3sY/IgEWJ8RDQ+ljxAQQRFWwttLCwFQ0Cw8Aco+AMk2NlZCVraWFhqJdiIGAxrEgPZZDFKNJrdTXbu7Mzch9zZ7JJACsEz3Jk7557vmzPfOYecc4yIrFLqihDiKnEqwpsFYbcxOOudhiKt9dsgCN57LLwlSfLAGKPdP5qP9ZgMrJS63DnYjsP06+Y33YibnkybbGXEWiWRXqgt6TBRaSfeY4WU8joAtxHVzIvlZ6KQWwatT2Dq1F0EkoOIoZFs4WH5EeajOZT6jmBm7LEezB3gHsu01XkAtFSvkrIr4PmP2KTXWFWzYMSzLCvNKspqDgMFiWrrCyrNRa8Paei8F8H5ICLyN9TTPBpW4enafbz59QoEguAEKRLkmMaAkBCsq68T3R1pRKYAiQE0bQ3a5vGkOoO11gbO9p1HgRsUmC+N9gXpFkd0NpKAz1s/cUleQD9bQCVZR5EP4fn3l7jYs4qhXBGSpRAw4LsKzLo78twxPtRXYJMSjsoxbMQKvTQMbTWK3KDI/LLg5PYhQFsHyQmfmmVMj9zD7UPTqMdhlnLAbAbu4QZ85xc8WHQ18Be1n4xHYNzhzugUBsVBzNbeAdwhRxY5OJ/sjtmMJHv1wNi1YLmCZdtwzmS+m8eu4daJG0jNb/RxgkMr83eSZoyx2ONL/afdmd4RNM06zvWOYzQ42f6GszjeM45SMInE/sFwfhKHixOewTGIeE8rh2mYLjbmdZSqnVb2bdxu5Vgr/SMs61iHe1r5v4eJdo8zEywbZ+al2WecvdMZF2ltu+P8F104wDzI7xMFAAAAAElFTkSuQmCC';

export function getTrayIcon(
  resourcesDir: string,
  tunMode: boolean,
  customNativeImage?: typeof Electron.nativeImage
): Electron.NativeImage | null {
  const imgApi = customNativeImage || nativeImage;
  const iconBase = tunMode ? 'tray-green' : 'tray-blue';
  const pngPath = path.join(resourcesDir, 'icons', `${iconBase}.png`);
  if (imgApi?.createFromPath && fs.existsSync(pngPath)) {
    const img = imgApi.createFromPath(pngPath);
    if (!img.isEmpty()) return img;
  }
  const icoPath = path.join(resourcesDir, 'icons', `${iconBase}.ico`);
  if (imgApi?.createFromPath && fs.existsSync(icoPath)) {
    const img = imgApi.createFromPath(icoPath);
    if (!img.isEmpty()) return img;
  }
  const fallbackPng = path.join(resourcesDir, 'icons/tray-16.png');
  if (imgApi?.createFromPath && fs.existsSync(fallbackPng)) {
    const img = imgApi.createFromPath(fallbackPng);
    if (!img.isEmpty()) return img;
  }
  const base64Str = tunMode ? GREEN_TRAY_BASE64 : BLUE_TRAY_BASE64;
  return imgApi?.createFromDataURL ? imgApi.createFromDataURL(base64Str) : null;
}

export function updateTrayContextMenu(): void {
  if (!tray) return;
  const settings = storageManager.getSettings();
  const coreStatus = mihomoManager.getStatus();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示 NexLink 主界面',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: coreStatus.running ? '代理内核：运行中' : '代理内核：未启动',
      enabled: false,
    },
    {
      label: '系统代理',
      type: 'checkbox',
      checked: Boolean(settings.systemProxy),
      click: async (item) => {
        const currentSettings = storageManager.getSettings();
        storageManager.saveSettings({ systemProxy: item.checked });
        const activePort = mihomoManager.getStatus().mixedPort || currentSettings.mixedPort || 7890;
        if (item.checked) {
          if (mihomoManager.getStatus().running) {
            await systemProxyManager.enableProxy(activePort, currentSettings.bypassList, mihomoManager.getPid());
          } else {
            console.log('[Tray] 核心未运行，已保存系统代理设置但暂不调用 enableProxy');
          }
        } else {
          await systemProxyManager.restoreProxy(activePort);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
        }
        updateTrayState();
      },
    },
    {
      label: 'TUN 虚拟网卡 (全局接管)',
      type: 'checkbox',
      checked: Boolean(settings.tunMode),
      click: async (item) => {
        if (item.checked) {
          const prereq = await checkTunPrerequisites();
          if (!prereq.canEnableTun) {
            const { dialog } = await import('electron');
            const choice = await dialog.showMessageBox({
              type: 'info',
              title: '安装虚拟网卡服务',
              message: '首次启用 TUN 模式需要安装一次后台虚拟网卡服务',
              detail: '安装后日常开关 TUN 均无需管理员权限、无需重启客户端。是否立即安装并开启 TUN？',
              buttons: ['一键安装服务并开启', '取消'],
              defaultId: 0,
              cancelId: 1,
            });
            if (choice.response !== 0) {
              updateTrayState();
              return;
            }
            const installRes = await tunServiceManager.installService(
              isCurrentProcessAdmin(),
              mihomoManager.getMihomoExePath()
            );
            if (!installRes.success) {
              dialog.showErrorBox('服务安装失败', installRes.error || '请稍后重试');
              updateTrayState();
              return;
            }
          }
          const drv = await mihomoManager.ensureWintunReady();
          if (!drv.ok) {
            const { dialog } = await import('electron');
            dialog.showErrorBox('虚拟网卡驱动准备失败', drv.error || '无法自动下载 wintun.dll');
            updateTrayState();
            return;
          }
        }
        storageManager.saveSettings({ tunMode: item.checked });
        if (mihomoManager.getStatus().running) {
          const nodes = storageManager.getNodes();
          const state = storageManager.getState();
          const selectedNodeName =
            state.selectedNodeName ||
            (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);
          await mihomoManager.hotReloadOrRestart({
            nodes,
            settings: storageManager.getSettings(),
            selectedNodeName,
          });
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
        }
        updateTrayState();
      },
    },
    {
      label: '代理模式',
      submenu: [
        {
          label: '规则分流 (Rule)',
          type: 'radio',
          checked: (settings.mode || 'rule') === 'rule',
          click: async () => {
            storageManager.saveSettings({ mode: 'rule' });
            await mihomoManager.setMode('rule');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
            }
            updateTrayState();
          },
        },
        {
          label: '全局代理 (Global)',
          type: 'radio',
          checked: settings.mode === 'global',
          click: async () => {
            storageManager.saveSettings({ mode: 'global' });
            await mihomoManager.setMode('global');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
            }
            updateTrayState();
          },
        },
        {
          label: '直接连接 (Direct)',
          type: 'radio',
          checked: settings.mode === 'direct',
          click: async () => {
            storageManager.saveSettings({ mode: 'direct' });
            await mihomoManager.setMode('direct');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.DATA_SYNC, storageManager.getData());
            }
            updateTrayState();
          },
        },
      ],
    },
    { type: 'separator' },
    {
      label: '退出 NexLink',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray?.setContextMenu(contextMenu);
}

let lastTrayFingerprint = '';
const trayIconCache = new Map<string, Electron.NativeImage>();

export function updateTrayState(resourcesDir?: string, force: boolean = false): void {
  if (!tray) return;
  const dir = resourcesDir || getResourcesDir();
  const settings = storageManager.getSettings();
  const coreStatus = mihomoManager.getStatus();
  const isTun = coreStatus.running ? Boolean(coreStatus.tunActive) : Boolean(settings.tunMode);
  const fingerprint = `${coreStatus.running}|${isTun}|${Boolean(settings.systemProxy)}|${coreStatus.mode || settings.mode || 'rule'}`;
  if (!force && fingerprint === lastTrayFingerprint) return;
  lastTrayFingerprint = fingerprint;

  // 动态切换托盘图标并缓存 NativeImage，避免每 5 秒重复读盘
  const cacheKey = `${dir}:${isTun ? 'tun' : 'normal'}`;
  let icon = trayIconCache.get(cacheKey);
  if (!icon) {
    const loaded = getTrayIcon(dir, isTun);
    if (loaded) {
      trayIconCache.set(cacheKey, loaded);
      icon = loaded;
    }
  }
  if (icon) {
    tray.setImage(icon);
  }

  // 动态更新悬浮提示文案
  if (isTun) {
    tray.setToolTip('NexLink 代理客户端 - TUN 虚拟网卡模式已启用');
  } else if (settings.systemProxy) {
    tray.setToolTip('NexLink 代理客户端 - 系统代理已开启');
  } else {
    tray.setToolTip('NexLink 代理客户端');
  }

  // 仅在状态变更时刷新托盘上下文菜单，避免展开菜单时被打断
  updateTrayContextMenu();
}

function createTray(resourcesDir?: string): void {
  if (tray) return;
  const dir = resourcesDir || getResourcesDir();
  const settings = storageManager.getSettings();
  const coreStatus = mihomoManager.getStatus();
  const isTun = coreStatus.running ? Boolean(coreStatus.tunActive) : Boolean(settings.tunMode);
  const icon = getTrayIcon(dir, isTun);
  if (!icon || !Tray) return;

  tray = new Tray(icon);
  tray.setToolTip(isTun ? 'NexLink 代理客户端 - TUN 虚拟网卡模式已启用' : 'NexLink 代理客户端');

  updateTrayContextMenu();

  // 每 5 秒自动同步托盘状态与上下文菜单
  if (trayTimer) clearInterval(trayTimer);
  trayTimer = setInterval(() => {
    updateTrayState(dir);
  }, 5000);

  const showMainWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  };

  // 鼠标左键单击托盘图标：直接唤起并聚焦主页面
  tray.on('click', showMainWindow);
  // 保持双击同样支持唤起主页面
  tray.on('double-click', showMainWindow);
}

function createWindow(resourcesDir?: string): void {
  const preloadPath = getPreloadPath();
  const settings = storageManager.getSettings();
  const startHidden = Boolean(settings.silentStart) || process.argv.includes('--hidden');
  const dir = resourcesDir || getResourcesDir();
  const appIconPath = path.join(dir, 'icons/app-icon.ico');
  const appIcon = fs.existsSync(appIconPath) ? nativeImage.createFromPath(appIconPath) : undefined;
  console.log('[NexLink] Inside createWindow. Preload:', preloadPath, { startHidden, hasIcon: Boolean(appIcon) });

  mainWindow = new BrowserWindow({
    title: 'NexLink',
    icon: appIcon,
    width: 1080,
    height: 720,
    minWidth: 960,
    minHeight: 640,
    center: true,
    frame: false,
    show: !startHidden,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!startHidden) {
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 2000);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('ready-to-show', () => {
    console.log('[NexLink] Window ready-to-show event fired!');
    if (!startHidden) {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  // 窗口最小化/恢复与托盘图标状态联动
  mainWindow.on('minimize', () => {
    updateTrayState(dir);
  });

  mainWindow.on('restore', () => {
    updateTrayState(dir);
  });

  // 窗口关闭拦截：隐藏到系统托盘，保持代理后台运行零中断
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      console.log('[NexLink] 窗口已最小化至托盘后台运行');
      updateTrayState(dir);
    }
  });

  const rawDevUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  // 规范化开发服务器地址：将 localhost 替换为 127.0.0.1 规避 Windows 下 IPv6 ::1 绑定差异
  const devServerUrl = rawDevUrl ? rawDevUrl.replace('//localhost:', '//127.0.0.1:') : undefined;

  let devLoadRetries = 0;
  const maxDevRetries = 6;
  let isLoadedSuccessfully = false;

  const loadFallbackHtml = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const distHtml = path.join(__dirname, '../../dist/index.html');
    if (fs.existsSync(distHtml)) {
      console.log('[NexLink] 加载本地构建产物 dist/index.html 兜底');
      if (!app.isPackaged && process.env.NEXLINK_INITIAL_TAB) {
        mainWindow.loadFile(distHtml, {
          query: { tab: process.env.NEXLINK_INITIAL_TAB },
        });
      } else {
        mainWindow.loadFile(distHtml);
      }
    } else {
      console.error('[NexLink] 本地构建产物 dist/index.html 亦不存在，请先执行 npm run build');
    }
  };

  const loadDevServer = () => {
    if (!mainWindow || mainWindow.isDestroyed() || isLoadedSuccessfully) return;
    if (devServerUrl && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/i.test(devServerUrl)) {
      console.log(`[NexLink] 正在加载开发服务器: ${devServerUrl} (尝试 ${devLoadRetries + 1}/${maxDevRetries})`);
      mainWindow.loadURL(devServerUrl).catch((err) => {
        console.warn(`[NexLink] mainWindow.loadURL 异常: ${err.message}`);
      });
    } else {
      loadFallbackHtml();
    }
  };

  mainWindow.webContents.on('did-finish-load', () => {
    isLoadedSuccessfully = true;
    console.log('[NexLink] webContents did-finish-load!');
    // 页面加载完成后立即主动同步一次最新的 Mihomo 核心运行状态，消除竞态与假离线
    mainWindow?.webContents.send(IPC_CHANNELS.CORE_GET_STATUS, mihomoManager.getStatus());
    if (!app.isPackaged && process.env.NEXLINK_CAPTURE_PATH) {
      setTimeout(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.NEXLINK_CAPTURE_PATH!, image.toPNG());
          console.log('[NexLink] Page captured successfully to:', process.env.NEXLINK_CAPTURE_PATH);
          if (process.env.NEXLINK_AUTO_EXIT) {
            app.quit();
          }
        } catch (err: any) {
          console.error('[NexLink] Capture error:', err.message);
        }
      }, 3000);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.log('[NexLink] webContents did-fail-load error:', errorCode, errorDescription, validatedURL);
    // 当由于 Vite dev server 启动慢或系统代理刷新导致连接被拒绝 (-102 ERR_CONNECTION_REFUSED) 时，执行渐进延迟自动重试
    if (!app.isPackaged && devServerUrl && !isLoadedSuccessfully) {
      if (devLoadRetries < maxDevRetries) {
        devLoadRetries++;
        const delay = Math.min(300 * devLoadRetries, 1500);
        console.log(`[NexLink] 开发服务器尚未就绪或连接断开，${delay}ms 后进行第 ${devLoadRetries} 次重连...`);
        setTimeout(() => {
          loadDevServer();
        }, delay);
      } else {
        console.warn('[NexLink] 开发服务器多次重试均未就绪，自动平滑降级至本地 dist/index.html 杜绝黑屏');
        loadFallbackHtml();
      }
    }
  });

  // 安全过滤：拦截同窗口导航逃逸，防止外部页面继承 window.nexlinkAPI
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const isAllowedDev =
      !app.isPackaged &&
      devServerUrl &&
      (/^https?:\/\/(localhost|127\.0\.0\.1):5173\b/i.test(targetUrl) || targetUrl.startsWith(devServerUrl));
    const isAllowedLocal = targetUrl.startsWith('file://');
    if (!isAllowedDev && !isAllowedLocal) {
      event.preventDefault();
      if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) {
        shell.openExternal(targetUrl);
      } else {
        console.warn('[Security] 拒绝非安全导航:', targetUrl);
      }
    }
  });

  // 安全过滤：严格限制仅通过默认浏览器打开外部安全 HTTP/HTTPS 链接
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = details.url;
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    } else {
      console.warn('[Security] 拒绝打开非安全外部协议:', url);
    }
    return { action: 'deny' };
  });

  registerIpcHandlers(mainWindow, {
    onSettingsUpdated: () => {
      updateTrayState(dir);
    },
  });

  loadDevServer();
}

/**
 * 异步获取单实例锁：
 * 1. 先同步尝试 requestSingleInstanceLock()
 * 2. 失败时，若命令行参数包含 '--relaunch'，则每 250ms 重试一次，最多 40 次（共 10 秒）
 * 3. 仍失败或无 '--relaunch' 参数则直接返回 false（退出应用）
 */
export async function acquireSingleInstanceLock(
  appInst: any = app,
  argv: string[] = process.argv,
  options?: { intervalMs?: number; maxRetries?: number }
): Promise<boolean> {
  if (!appInst?.requestSingleInstanceLock) return true;

  let gotLock = appInst.requestSingleInstanceLock();
  if (gotLock) return true;

  if (!argv.includes('--relaunch')) {
    return false;
  }

  const intervalMs = options?.intervalMs ?? 250;
  const maxRetries = options?.maxRetries ?? 40;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    gotLock = appInst.requestSingleInstanceLock();
    if (gotLock) {
      return true;
    }
  }

  return false;
}

export async function bootstrap(): Promise<void> {
  console.log('[NexLink] Main starting...');

  // 对标 Clash Verge Rev：客户端 GUI 始终以普通用户身份启动（零 UAC 弹窗、保障开机自启与拖拽），
  // 顺手清理旧版遗留的 RUNASADMIN 标记，TUN 高权限交由后台 NexLinkCoreService 服务承载。
  if (process.platform === 'win32') {
    cleanupLegacyRunAsAdminRegistry();
  }

  const gotTheLock = await acquireSingleInstanceLock();
  console.log('[NexLink] Got instance lock:', gotTheLock);

  if (!gotTheLock) {
    console.log('[NexLink] Exiting because lock was not acquired.');
    app?.quit();
    return;
  }

  console.log('[NexLink] Acquired lock. Waiting for ready...');
  app?.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app?.whenReady().then(async () => {
    console.log('[NexLink] App ready. Creating window...');
    const userDataDir = app.getPath('userData');
    const resourcesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'resources')
      : path.resolve(app.getAppPath(), 'resources');
    const storageDir = path.join(userDataDir, 'database');
    const runtimeDir = path.join(userDataDir, 'runtime');

    storageManager.initialize(storageDir);
    systemProxyManager.initialize(userDataDir);
    mihomoManager.initialize(runtimeDir, resourcesDir);
    subscriptionManager.startScheduler();

    // 启动前自检：必须 await 执行完毕，彻底在启动内核前清理掉上次崩溃残留代理
    const currentSettings = storageManager.getSettings();
    try {
      await systemProxyManager.cleanStaleProxyIfPresent(currentSettings.mixedPort || 7890);
    } catch (err: any) {
      console.warn('[NexLink] 启动自检残留系统代理提示:', err.message);
    }

    createWindow(resourcesDir);
    createTray(resourcesDir);

    if (mainWindow) {
      updateService.startAutoCheck(mainWindow);
    }

    // 随后自动启动 Mihomo 内核与系统代理联动
    try {
      const settings = storageManager.getSettings();
      const nodes = storageManager.getNodes();
      const state = storageManager.getState();
      const selectedNodeName =
        state.selectedNodeName ||
        (state.activeNodeId ? nodes.find((n) => n.id === state.activeNodeId)?.name : undefined);

      console.log('[NexLink] 正在自动启动代理内核...', {
        nodeCount: nodes.length,
        selectedNodeName,
      });

      const startRes = await mihomoManager.start({
        nodes,
        settings,
        selectedNodeName,
      });

      if (startRes.success) {
        console.log('[NexLink] 代理内核自启动成功');
        // 注意：mihomoManager.start 内部已根据 settings.systemProxy 联动调用过 enableProxy，无需在此重复调用
      } else {
        console.warn('[NexLink] 代理内核自启动遇到提示:', startRes.error);
      }
    } catch (err: any) {
      console.error('[NexLink] 代理内核自启动异常:', err.message);
    }

    app?.on('activate', () => {
      if (BrowserWindow?.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  let isGracefulQuitDone = false;
  let isGracefulQuitting = false;
  let isFinalCleanupDone = false;

  const runEmergencyCleanupOnce = () => {
    if (isFinalCleanupDone) return;
    isFinalCleanupDone = true;
    const currentSettings = storageManager.getSettings();
    const mixedPort = mihomoManager.getStatus().mixedPort || currentSettings?.mixedPort || 7890;
    try {
      systemProxyManager.restoreProxySync(mixedPort);
    } catch (_e) {
      void _e;
    }
    mihomoManager.cleanupTunRoutesSync();
    mihomoManager.forceKillAllSync();
  };

  process.on('uncaughtException', (err) => {
    console.error('[NexLink FATAL] 未捕获主进程异常:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[NexLink FATAL] 未处理 Promise 拒绝:', reason);
  });

  app?.on('before-quit', async (event) => {
    if (isGracefulQuitDone) return;
    event.preventDefault();
    if (isGracefulQuitting) return;
    isGracefulQuitting = true;
    isQuitting = true;

    if (trayTimer) {
      clearInterval(trayTimer);
      trayTimer = null;
    }

    console.log('[NexLink] 正在安全退出，按需回滚代理并停止 Mihomo 内核...');
    subscriptionManager.stopScheduler();
    updateService.stopAutoCheck();

    const quitRes = await stopWithTimeoutAndFallback(
      () => mihomoManager.stop(),
      runEmergencyCleanupOnce,
      5500
    );
    if (!quitRes.timedOut && quitRes.stopped) {
      isFinalCleanupDone = true;
    } else {
      runEmergencyCleanupOnce();
    }

    isGracefulQuitDone = true;
    app.quit();
  });

  app?.on('will-quit', () => {
    runEmergencyCleanupOnce();
  });

  // --------------------------------------------------------------------------
  // 终端强关、Ctrl+C 与系统信号紧急保障 (Terminal Exit & Signal Protection)
  // --------------------------------------------------------------------------
  let isHandlingSignal = false;
  const handleProcessSignal = (signal: string) => {
    if (isHandlingSignal) return;
    isHandlingSignal = true;
    console.log(`[NexLink] 捕获到终端退出信号 (${signal})，正在同步紧急恢复网络与关闭核心...`);
    runEmergencyCleanupOnce();
    process.exit(0);
  };

  process.once('SIGINT', () => handleProcessSignal('SIGINT'));
  process.once('SIGTERM', () => handleProcessSignal('SIGTERM'));
  if (process.platform === 'win32') {
    process.once('SIGBREAK', () => handleProcessSignal('SIGBREAK'));
  }
  process.on('exit', () => {
    runEmergencyCleanupOnce();
  });

  app?.on('window-all-closed', () => {
    console.log('[NexLink] Window all closed.');
    if (process.platform !== 'darwin') {
      app?.quit();
    }
  });
}

if (app) {
  bootstrap().catch((err) => {
    console.error('[NexLink] Bootstrap fatal error:', err);
  });
}
// Hot update trigger for NetworkTester & multi-mode delay testing
