import { contextBridge, ipcRenderer } from 'electron';
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
  type DesktopImRealtimeRequest,
  type DesktopImRealtimeStartRequest,
  type DesktopImRealtimeUpdate,
  type DesktopOidcLoginRequest,
  type DesktopRuntimeInfo,
} from '../shared/desktop-api';
import { createSubscriptionId } from './subscription-id';

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
    const subscriptionId = createSubscriptionId();
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
  subscribeImRealtime: (
    request: DesktopImRealtimeRequest,
    listener: (update: DesktopImRealtimeUpdate) => void,
  ) => {
    const subscriptionId = createSubscriptionId();
    let stopped = false;
    const wrapped = (_event: Electron.IpcRendererEvent, update: DesktopImRealtimeUpdate): void => {
      if (update.subscriptionId === subscriptionId) listener(update);
    };
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.imRealtimeUpdate, wrapped);
    const startRequest: DesktopImRealtimeStartRequest = { ...request, subscriptionId };
    void ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startImRealtime, startRequest).catch((error) => {
      if (stopped) return;
      listener({
        subscriptionId,
        kind: 'state',
        state: 'closed',
        error: error instanceof Error ? error.message : 'Realtime messaging could not start.',
      });
    });
    return () => {
      if (stopped) return;
      stopped = true;
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.imRealtimeUpdate, wrapped);
      void ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.stopImRealtime, subscriptionId);
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
