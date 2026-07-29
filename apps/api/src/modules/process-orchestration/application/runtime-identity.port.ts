import type { TenantRole } from '@enterprise/contracts';

export interface TrustedRuntimePrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly tenantRole: TenantRole;
  readonly authenticationSource: 'session' | 'development-header' | 'trusted-proxy';
}

/**
 * Trusted request identity boundary. Implementations must derive identity from
 * the authenticated request context and must never accept actor identifiers
 * supplied in an HTTP body.
 */
export abstract class RuntimeIdentityPort {
  abstract current(): TrustedRuntimePrincipal;
}
