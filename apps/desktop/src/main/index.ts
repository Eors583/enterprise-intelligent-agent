import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopAgentRunStreamPayload,
  type DesktopAgentRunStreamStartRequest,
  type DesktopAgentRunStreamUpdate,
  type DesktopApiRequest,
  type DesktopAuthState,
  type DesktopOidcLoginRequest,
  type DesktopRuntimeInfo,
} from '../shared/desktop-api';
import { AccountStore } from './account-store';
import { DesktopAuthManager } from './desktop-auth-manager';
import { createPasswordRecoveryUrl } from './recovery-url';

let mainWindow: BrowserWindow | null = null;
let oidcLoginWindow: BrowserWindow | null = null;
let authManager: DesktopAuthManager | null = null;
const agentRunStreams = new Map<
  string,
  { readonly controller: AbortController; readonly senderId: number }
>();

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
  ipcMain.handle(DESKTOP_IPC_CHANNELS.verifyMfaLogin, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return requireAuthManager().verifyMfaLogin(request as never);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.listOidcProviders, async (event, tenantSlug: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof tenantSlug !== 'string') throw new Error('tenantSlug must be a string.');
    return requireAuthManager().listOidcProviders(tenantSlug);
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.loginWithOidc, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof Reflect.get(request, 'tenantSlug') !== 'string' ||
      typeof Reflect.get(request, 'providerKey') !== 'string'
    ) {
      throw new Error('Invalid OIDC login request.');
    }
    return runOidcLogin(request as DesktopOidcLoginRequest);
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
  ipcMain.handle(DESKTOP_IPC_CHANNELS.startAgentRunStream, async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const stream = parseAgentRunStreamStartRequest(request);
    if (agentRunStreams.has(stream.subscriptionId)) {
      throw new Error('Agent Run stream subscription already exists.');
    }
    const controller = new AbortController();
    const registration = { controller, senderId: event.sender.id };
    agentRunStreams.set(stream.subscriptionId, registration);
    let cursor = stream.cursor;
    const send = (update: DesktopAgentRunStreamPayload): void => {
      if (
        agentRunStreams.get(stream.subscriptionId) !== registration ||
        event.sender.isDestroyed()
      ) {
        return;
      }
      if (update.kind === 'state') cursor = update.cursor;
      else cursor = update.event.sequence;
      event.sender.send(DESKTOP_IPC_CHANNELS.agentRunStreamUpdate, {
        ...update,
        subscriptionId: stream.subscriptionId,
      } satisfies DesktopAgentRunStreamUpdate);
    };
    void requireAuthManager()
      .streamAgentRun(stream, send, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          send({
            kind: 'state',
            state: 'closed',
            cursor,
            error: error instanceof Error ? error.message : 'Agent Run stream failed.',
          });
        }
      })
      .finally(() => {
        if (agentRunStreams.get(stream.subscriptionId) === registration) {
          agentRunStreams.delete(stream.subscriptionId);
        }
      });
  });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.stopAgentRunStream, (event, subscriptionId: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof subscriptionId !== 'string' || !UUID_PATTERN.test(subscriptionId)) {
      throw new Error('Invalid Agent Run stream subscription id.');
    }
    const active = agentRunStreams.get(subscriptionId);
    if (active?.senderId === event.sender.id) {
      active.controller.abort(new Error('Agent Run stream subscription stopped.'));
      agentRunStreams.delete(subscriptionId);
    }
  });
}

async function runOidcLogin(request: DesktopOidcLoginRequest): Promise<DesktopAuthState> {
  if (oidcLoginWindow && !oidcLoginWindow.isDestroyed()) {
    oidcLoginWindow.focus();
    throw new Error('An OIDC login is already in progress.');
  }
  const callbackUrl = registeredOidcCallbackUrl();
  const started = await requireAuthManager().startOidcLogin({
    tenantSlug: request.tenantSlug,
    providerKey: request.providerKey,
    redirectUri: callbackUrl.toString(),
    sessionLabel: '桌面应用',
  });
  const authorizationUrl = new URL(started.authorizationUrl);
  assertSafeOidcNavigation(authorizationUrl);

  return new Promise<DesktopAuthState>((resolve, reject) => {
    let completed = false;
    const finish = (operation: Promise<DesktopAuthState>): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (oidcLoginWindow && !oidcLoginWindow.isDestroyed()) oidcLoginWindow.hide();
      void operation.then(resolve, reject).finally(() => {
        if (oidcLoginWindow && !oidcLoginWindow.isDestroyed()) oidcLoginWindow.close();
      });
    };
    const fail = (error: Error): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      reject(error);
      if (oidcLoginWindow && !oidcLoginWindow.isDestroyed()) oidcLoginWindow.close();
    };
    const partition = `oidc-auth-${randomUUID()}`;
    const authWindow = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 520,
      minHeight: 620,
      ...(mainWindow === null ? {} : { parent: mainWindow }),
      modal: mainWindow !== null,
      show: false,
      autoHideMenuBar: true,
      title: '企业单点登录',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
      },
    });
    oidcLoginWindow = authWindow;
    authWindow.webContents.session.setPermissionCheckHandler(() => false);
    authWindow.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    authWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

    const inspectNavigation = (event: Electron.Event, value: string): void => {
      let destination: URL;
      try {
        destination = new URL(value);
      } catch {
        event.preventDefault();
        fail(new Error('OIDC provider attempted an invalid navigation.'));
        return;
      }
      if (
        destination.origin === callbackUrl.origin &&
        destination.pathname === callbackUrl.pathname
      ) {
        event.preventDefault();
        const state = destination.searchParams.get('state');
        const code = destination.searchParams.get('code');
        const providerError = destination.searchParams.get('error');
        if (providerError || !state || !code) {
          fail(new Error('OIDC provider denied or returned an incomplete authorization response.'));
          return;
        }
        finish(
          requireAuthManager().completeOidcLogin({
            state,
            code,
            sessionLabel: '桌面应用',
          }),
        );
        return;
      }
      try {
        assertSafeOidcNavigation(destination);
      } catch (error) {
        event.preventDefault();
        fail(error instanceof Error ? error : new Error('OIDC navigation was rejected.'));
      }
    };
    authWindow.webContents.on('will-navigate', inspectNavigation);
    authWindow.webContents.on('will-redirect', inspectNavigation);
    authWindow.once('ready-to-show', () => authWindow.show());
    authWindow.once('closed', () => {
      oidcLoginWindow = null;
      void authWindow.webContents.session.clearStorageData().catch(() => undefined);
      if (!completed) fail(new Error('OIDC login was cancelled.'));
    });
    const timeout = setTimeout(
      () => fail(new Error('OIDC login expired before the provider returned.')),
      10 * 60 * 1_000,
    );
    void authWindow.loadURL(authorizationUrl.toString()).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error('OIDC provider could not be opened.'));
    });
  });
}

function registeredOidcCallbackUrl(): URL {
  const configured = new URL(__AUTH_PUBLIC_APP_URL__);
  if (
    configured.protocol !== 'https:' &&
    !(
      !app.isPackaged &&
      configured.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)
    )
  ) {
    throw new Error(
      'Desktop OIDC callback must use HTTPS (local development may use loopback HTTP).',
    );
  }
  return new URL('/oidc/callback', configured.origin);
}

function assertSafeOidcNavigation(url: URL): void {
  if (url.username || url.password) {
    throw new Error('OIDC navigation URLs must not contain embedded credentials.');
  }
  if (url.protocol === 'https:') return;
  if (
    !app.isPackaged &&
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    return;
  }
  throw new Error('OIDC navigation was rejected because it is not HTTPS.');
}

function requireAuthManager(): DesktopAuthManager {
  if (!authManager) throw new Error('Desktop authentication is not initialized.');
  return authManager;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseAgentRunStreamStartRequest(value: unknown): DesktopAgentRunStreamStartRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof Reflect.get(value, 'subscriptionId') !== 'string' ||
    typeof Reflect.get(value, 'conversationId') !== 'string' ||
    typeof Reflect.get(value, 'runId') !== 'string' ||
    typeof Reflect.get(value, 'expectedSessionId') !== 'string' ||
    typeof Reflect.get(value, 'cursor') !== 'number'
  ) {
    throw new Error('Invalid Agent Run stream subscription.');
  }
  const request = value as DesktopAgentRunStreamStartRequest;
  if (
    !UUID_PATTERN.test(request.subscriptionId) ||
    !UUID_PATTERN.test(request.conversationId) ||
    !UUID_PATTERN.test(request.runId) ||
    !UUID_PATTERN.test(request.expectedSessionId) ||
    !Number.isSafeInteger(request.cursor) ||
    request.cursor < 0 ||
    request.cursor > 10_001
  ) {
    throw new Error('Invalid Agent Run stream subscription.');
  }
  return request;
}

function abortAgentRunStreams(reason: string): void {
  for (const active of agentRunStreams.values()) {
    active.controller.abort(new Error(reason));
  }
  agentRunStreams.clear();
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
        abortAgentRunStreams('The active desktop account changed.');
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
  abortAgentRunStreams('The desktop window closed.');
  if (process.platform !== 'darwin') app.quit();
});
