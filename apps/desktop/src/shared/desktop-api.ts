export const DESKTOP_IPC_CHANNELS = {
  getRuntimeInfo: 'desktop:get-runtime-info',
  getAuthState: 'desktop:get-auth-state',
  login: 'desktop:login',
  verifyMfaLogin: 'desktop:verify-mfa-login',
  listOidcProviders: 'desktop:list-oidc-providers',
  loginWithOidc: 'desktop:login-with-oidc',
  registerTenant: 'desktop:register-tenant',
  changePassword: 'desktop:change-password',
  openPasswordRecovery: 'desktop:open-password-recovery',
  switchAccount: 'desktop:switch-account',
  logout: 'desktop:logout',
  apiRequest: 'desktop:api-request',
  openKnowledgeSource: 'desktop:open-knowledge-source',
  startAgentRunStream: 'desktop:start-agent-run-stream',
  stopAgentRunStream: 'desktop:stop-agent-run-stream',
  agentRunStreamUpdate: 'desktop:agent-run-stream-update',
  startImRealtime: 'desktop:start-im-realtime',
  stopImRealtime: 'desktop:stop-im-realtime',
  imRealtimeUpdate: 'desktop:im-realtime-update',
  authStateChanged: 'desktop:auth-state-changed',
} as const;

import type {
  AuthAccount,
  ChangePasswordRequest,
  LoginRequest,
  MfaLoginChallengeResponse,
  MfaLoginVerifyRequest,
  OidcPublicProviderListResponse,
  RegisterTenantRequest,
  AgentRunStreamEvent,
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

export type DesktopLoginResult = DesktopAuthState | MfaLoginChallengeResponse;

export interface DesktopOidcLoginRequest {
  readonly tenantSlug: string;
  readonly providerKey: string;
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

export interface DesktopOpenKnowledgeSourceRequest {
  readonly expectedSessionId: string;
  readonly messageId: string;
  readonly documentVersionId: string;
  readonly chunkId: string;
  readonly fileName: string;
}

export interface DesktopAgentRunStreamRequest {
  readonly conversationId: string;
  readonly runId: string;
  readonly expectedSessionId: string;
  readonly cursor: number;
}

export interface DesktopAgentRunStreamStartRequest extends DesktopAgentRunStreamRequest {
  readonly subscriptionId: string;
}

export type DesktopAgentRunStreamPayload =
  | {
      readonly kind: 'state';
      readonly state: 'connecting' | 'connected' | 'reconnecting' | 'closed';
      readonly cursor: number;
      readonly error?: string;
    }
  | {
      readonly kind: 'event';
      readonly event: AgentRunStreamEvent;
    };

export type DesktopAgentRunStreamUpdate = DesktopAgentRunStreamPayload & {
  readonly subscriptionId: string;
};

export interface DesktopImRealtimeRequest {
  readonly expectedSessionId: string;
}

export interface DesktopImRealtimeStartRequest extends DesktopImRealtimeRequest {
  readonly subscriptionId: string;
}

export type DesktopImRealtimePayload =
  | {
      readonly kind: 'state';
      readonly state: 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'closed';
      readonly error?: string;
    }
  | {
      readonly kind: 'message';
      readonly conversationId: string | null;
      readonly messageId: string | null;
      readonly eventId: string | null;
      readonly receivedAt: string;
    };

export type DesktopImRealtimeUpdate = DesktopImRealtimePayload & {
  readonly subscriptionId: string;
};

export interface DesktopPasswordChangeResult {
  readonly state: DesktopAuthState;
  readonly revokedSessionCount: number;
}

export interface DesktopBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  getAuthState(): Promise<DesktopAuthState>;
  login(request: LoginRequest): Promise<DesktopLoginResult>;
  verifyMfaLogin(request: MfaLoginVerifyRequest): Promise<DesktopAuthState>;
  listOidcProviders(tenantSlug: string): Promise<OidcPublicProviderListResponse>;
  loginWithOidc(request: DesktopOidcLoginRequest): Promise<DesktopAuthState>;
  registerTenant(request: RegisterTenantRequest): Promise<DesktopAuthState>;
  changePassword(request: ChangePasswordRequest): Promise<DesktopPasswordChangeResult>;
  openPasswordRecovery(): Promise<void>;
  switchAccount(sessionId: string): Promise<DesktopAuthState>;
  logout(sessionId?: string): Promise<DesktopAuthState>;
  apiRequest(request: DesktopApiRequest): Promise<DesktopApiResponse>;
  openKnowledgeSource(request: DesktopOpenKnowledgeSourceRequest): Promise<void>;
  subscribeAgentRunStream(
    request: DesktopAgentRunStreamRequest,
    listener: (update: DesktopAgentRunStreamUpdate) => void,
  ): () => void;
  subscribeImRealtime(
    request: DesktopImRealtimeRequest,
    listener: (update: DesktopImRealtimeUpdate) => void,
  ): () => void;
  onAuthStateChanged(listener: (state: DesktopAuthState) => void): () => void;
}
