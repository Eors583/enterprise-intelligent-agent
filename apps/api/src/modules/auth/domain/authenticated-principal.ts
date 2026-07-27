import type { TenantRole } from '@enterprise/contracts';

export interface AuthenticatedPrincipal {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: TenantRole;
  readonly passwordChangeRequired: boolean;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly authenticationSource: 'session';
}
