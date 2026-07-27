import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChangePasswordRequest,
  LoginRequest,
  RegisterTenantRequest,
} from '@enterprise/contracts';
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopApiRequest,
  type DesktopAuthState,
  type DesktopBridge,
  type DesktopRuntimeInfo,
} from '../shared/desktop-api';

const desktopBridge: DesktopBridge = Object.freeze({
  getRuntimeInfo: async (): Promise<DesktopRuntimeInfo> =>
    ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getRuntimeInfo) as Promise<DesktopRuntimeInfo>,
  getAuthState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getAuthState),
  login: (request: LoginRequest) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.login, request),
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
  onAuthStateChanged: (listener: (state: DesktopAuthState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopAuthState): void =>
      listener(state);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.authStateChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.authStateChanged, wrapped);
  },
});

contextBridge.exposeInMainWorld('enterpriseDesktop', desktopBridge);
