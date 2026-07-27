export const DESKTOP_IPC_CHANNELS = {
  getRuntimeInfo: 'desktop:get-runtime-info',
  getAuthState: 'desktop:get-auth-state',
  login: 'desktop:login',
  registerTenant: 'desktop:register-tenant',
  changePassword: 'desktop:change-password',
  openPasswordRecovery: 'desktop:open-password-recovery',
  switchAccount: 'desktop:switch-account',
  logout: 'desktop:logout',
  apiRequest: 'desktop:api-request',
  authStateChanged: 'desktop:auth-state-changed',
} as const;

import type {
  AuthAccount,
  ChangePasswordRequest,
  LoginRequest,
  RegisterTenantRequest,
} from '@enterprise/contracts';

export interface DesktopRuntimeInfo {
  appVersion: string;
  platform: 'win32' | 'darwin' | 'linux' | 'other';
}

export interface DesktopAuthState {
  readonly accounts: readonly AuthAccount[];
  readonly activeSessionId: string | null;
  readonly persistentStorageAvailable: boolean;
}

export interface DesktopApiRequest {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly expectedSessionId: string;
  readonly body?: unknown;
}

export interface DesktopApiResponse {
  readonly status: number;
  readonly requestId?: string;
  readonly body: unknown;
}

export interface DesktopPasswordChangeResult {
  readonly state: DesktopAuthState;
  readonly revokedSessionCount: number;
}

export interface DesktopBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  getAuthState(): Promise<DesktopAuthState>;
  login(request: LoginRequest): Promise<DesktopAuthState>;
  registerTenant(request: RegisterTenantRequest): Promise<DesktopAuthState>;
  changePassword(request: ChangePasswordRequest): Promise<DesktopPasswordChangeResult>;
  openPasswordRecovery(): Promise<void>;
  switchAccount(sessionId: string): Promise<DesktopAuthState>;
  logout(sessionId?: string): Promise<DesktopAuthState>;
  apiRequest(request: DesktopApiRequest): Promise<DesktopApiResponse>;
  onAuthStateChanged(listener: (state: DesktopAuthState) => void): () => void;
}
