import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopApiRequest,
  type DesktopRuntimeInfo,
} from '../shared/desktop-api';
import { AccountStore } from './account-store';
import { DesktopAuthManager } from './desktop-auth-manager';
import { createPasswordRecoveryUrl } from './recovery-url';

let mainWindow: BrowserWindow | null = null;
let authManager: DesktopAuthManager | null = null;

function normalizePlatform(platform: NodeJS.Platform): DesktopRuntimeInfo['platform'] {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'other';
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const trustedContents = mainWindow?.webContents;
  const isMainFrame = event.senderFrame === trustedContents?.mainFrame;

  if (!trustedContents || event.sender !== trustedContents || !isMainFrame) {
    throw new Error('Rejected IPC request from an untrusted renderer');
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.getRuntimeInfo, (event) => {
    assertTrustedIpcSender(event);

    return {
      appVersion: app.getVersion(),
      platform: normalizePlatform(process.platform),
    } satisfies DesktopRuntimeInfo;
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.getAuthState, async (event) => {
    assertTrustedIpcSender(event);
    return requireAuthManager().state();
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.login, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return requireAuthManager().login(request as never);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.registerTenant, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return requireAuthManager().registerTenant(request as never);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.changePassword, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return requireAuthManager().changePassword(request as never);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.openPasswordRecovery, async (event) => {
    assertTrustedIpcSender(event);
    await shell.openExternal(createPasswordRecoveryUrl(__AUTH_PUBLIC_APP_URL__, app.isPackaged));
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.switchAccount, async (event, sessionId: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof sessionId !== 'string') throw new Error('sessionId must be a string.');
    return requireAuthManager().switchAccount(sessionId);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.logout, async (event, sessionId: unknown) => {
    assertTrustedIpcSender(event);
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      throw new Error('sessionId must be a string.');
    }
    return requireAuthManager().logout(sessionId as string | undefined);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.apiRequest, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    if (!request || typeof request !== 'object') throw new Error('Invalid desktop API request.');
    return requireAuthManager().apiRequest(request as DesktopApiRequest);
  });
}

function requireAuthManager(): DesktopAuthManager {
  if (!authManager) throw new Error('Desktop authentication is not initialized.');
  return authManager;
}

function addConnectOrigin(origins: Set<string>, value: string | undefined): void {
  if (!value) return;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    origins.add(parsed.origin);
    if (!app.isPackaged) {
      const websocketProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      origins.add(`${websocketProtocol}//${parsed.host}`);
    }
  } catch {
    // Invalid values are handled as a renderer configuration error as well.
  }
}

function configureSessionSecurity(): void {
  const connectOrigins = new Set<string>(["'self'"]);
  addConnectOrigin(connectOrigins, __RENDERER_API_ORIGIN__);
  addConnectOrigin(connectOrigins, process.env.ELECTRON_RENDERER_URL);

  // @vitejs/plugin-react injects its Fast Refresh preamble as an inline
  // module in development. Keep packaged builds strict while allowing only
  // the local development renderer to bootstrap React correctly.
  const usesViteDevelopmentRenderer = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
  const scriptSources = usesViteDevelopmentRenderer ? ["'self'", "'unsafe-inline'"] : ["'self'"];

  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${[...connectOrigins].join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    for (const headerName of Object.keys(responseHeaders)) {
      if (headerName.toLowerCase() === 'content-security-policy') {
        delete responseHeaders[headerName];
      }
    }

    callback({
      responseHeaders: {
        ...responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });

  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function lockDownWebContents(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  window.webContents.on('will-redirect', (event) => {
    event.preventDefault();
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f6f8',
    title: '企业 AI 协同',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      spellcheck: true,
    },
  });

  lockDownWebContents(window);

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    configureSessionSecurity();
    authManager = new DesktopAuthManager(
      new AccountStore(join(app.getPath('userData'), 'accounts.v1.json')),
      __RENDERER_API_BASE_URL__,
      (state) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          mainWindow.webContents.send(DESKTOP_IPC_CHANNELS.authStateChanged, state);
        } catch {
          // The renderer can disappear between the destroyed check and send.
        }
      },
    );
    await authManager.initialize();
    registerIpcHandlers();
    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) mainWindow = createMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
