import { contextBridge, ipcRenderer } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  ChangePasswordRequest,
  LoginRequest,
  MfaLoginVerifyRequest,
  RegisterTenantRequest,
} from '@enterprise/contracts';
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopApiRequest,
  type DesktopAgentRunStreamRequest,
  type DesktopAgentRunStreamStartRequest,
  type DesktopAgentRunStreamUpdate,
  type DesktopAuthState,
  type DesktopBridge,
  type DesktopOidcLoginRequest,
  type DesktopRuntimeInfo,
} from '../shared/desktop-api';

const desktopBridge: DesktopBridge = Object.freeze({
  getRuntimeInfo: async (): Promise<DesktopRuntimeInfo> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getRuntimeInfo) as Promise<DesktopRuntimeInfo>,
  getAuthState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getAuthState),
  login: (request: LoginRequest) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.login, request),
  verifyMfaLogin: (request: MfaLoginVerifyRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.verifyMfaLogin, request),
  listOidcProviders: (tenantSlug: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listOidcProviders, tenantSlug),
  loginWithOidc: (request: DesktopOidcLoginRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.loginWithOidc, request),
  registerTenant: (request: RegisterTenantRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.registerTenant, request),
  changePassword: (request: ChangePasswordRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.changePassword, request),
  openPasswordRecovery: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openPasswordRecovery),
  switchAccount: (sessionId: string) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.switchAccount, sessionId),
  logout: (sessionId?: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.logout, sessionId),
  apiRequest: (request: DesktopApiRequest) =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.apiRequest, request),
  subscribeAgentRunStream: (
    request: DesktopAgentRunStreamRequest,
    listener: (update: DesktopAgentRunStreamUpdate) => void,
  ) => {
    const subscriptionId = randomUUID();
    let stopped = false;
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      update: DesktopAgentRunStreamUpdate,
    ): void => {
      if (update.subscriptionId === subscriptionId) listener(update);
    };
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.agentRunStreamUpdate, wrapped);
    const startRequest: DesktopAgentRunStreamStartRequest = { ...request, subscriptionId };
    void ipcRenderer
      .invoke(DESKTOP_IPC_CHANNELS.startAgentRunStream, startRequest)
      .catch((error: unknown) => {
        if (stopped) return;
        listener({
          subscriptionId,
          kind: 'state',
          state: 'closed',
          cursor: request.cursor,
          error: error instanceof Error ? error.message : 'Agent Run stream could not start.',
        });
      });
    return () => {
      if (stopped) return;
      stopped = true;
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.agentRunStreamUpdate, wrapped);
      void ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopAgentRunStream, subscriptionId);
    };
  },
  onAuthStateChanged: (listener: (state: DesktopAuthState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopAuthState): void =>
      listener(state);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.authStateChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.authStateChanged, wrapped);
  },
});

contextBridge.exposeInMainWorld('enterpriseDesktop', desktopBridge);
