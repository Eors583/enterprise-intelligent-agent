import { createHmac } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createScimServiceTokenRequestSchema,
  type CreateScimServiceTokenRequest,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';
import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';
import { IdentityGovernanceAdminService } from './identity-governance-admin.service.js';
import type { IdentitySecretVault } from './identity-secret-vault.js';
import type { OidcDiscoveryClient } from './oidc-discovery.client.js';

const TENANT_ID = '00000000-0000-7000-8000-00000000d001';
const CONNECTOR_ID = '00000000-0000-7000-8000-00000000d101';
const USER_ID = '00000000-0000-7000-8000-00000000d201';
const SESSION_ID = '00000000-0000-7000-8000-00000000d301';
const PEPPER = 'unit-test-scim-admin-pepper';

describe('IdentityGovernanceAdminService SCIM lifecycle', () => {
  it('issues only a one-time bearer while persisting the exact SCIM runtime hash', async () => {
    const database = fakeScimDatabase();
    const service = createService(database.prisma);
    const request: CreateScimServiceTokenRequest = {
      scopes: ['scim.users.read', 'scim.groups.read'],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'issue-token-once',
    };

    const created = await service.createScimServiceToken(CONNECTOR_ID, request, principal());

    expect(created.token).toMatch(/^ea_scim_[A-Za-z0-9_-]{32,}$/);
    expect(created.tokenHint).toBe(created.token.slice(-8));
    const expectedHash = createHmac('sha256', PEPPER)
      .update('enterprise-agent:scim-service-token:v1\0')
      .update(created.token)
      .digest('hex');
    const tokenInsert = database.queryRaw.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray)
        .join(' ')
        .includes('INSERT INTO public."scim_service_tokens"'),
    );
    expect(tokenInsert?.[4]).toBe(expectedHash);
    for (const call of [...database.queryRaw.mock.calls, ...database.executeRaw.mock.calls]) {
      expect(call.slice(1)).not.toContain(created.token);
    }

    await expect(
      service.createScimServiceToken(CONNECTOR_ID, request, principal()),
    ).rejects.toThrow('plaintext cannot be shown again');
    expect(
      database.queryRaw.mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray)
          .join(' ')
          .includes('INSERT INTO public."scim_service_tokens"'),
      ),
    ).toHaveLength(1);
  });

  it('enforces active-connector issuance, bounded expiry, and the fixed scope allowlist', async () => {
    const suspended = fakeScimDatabase({ connectorStatus: 'SUSPENDED' });
    await expect(
      createService(suspended.prisma).createScimServiceToken(
        CONNECTOR_ID,
        {
          scopes: ['scim.users.read'],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          idempotencyKey: 'suspended-token',
        },
        principal(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const untouched = fakeScimDatabase();
    await expect(
      createService(untouched.prisma).createScimServiceToken(
        CONNECTOR_ID,
        {
          scopes: ['scim.users.read'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: 'short-expiry',
        },
        principal(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(untouched.prisma.withTenant).not.toHaveBeenCalled();

    expect(
      createScimServiceTokenRequestSchema.safeParse({
        scopes: ['scim.users.read', 'tenant.admin'],
        expiresAt: null,
        idempotencyKey: 'invalid-scope',
      }).success,
    ).toBe(false);
    expect(
      createScimServiceTokenRequestSchema.safeParse({
        scopes: ['scim.users.read', 'scim.users.read'],
        expiresAt: null,
        idempotencyKey: 'duplicate-scope',
      }).success,
    ).toBe(false);
  });

  it('requires a different administrator for activation and blocks non-admin callers', async () => {
    const sameProposer = fakeScimDatabase({
      connectorStatus: 'IN_REVIEW',
      proposedByUserId: USER_ID,
    });
    await expect(
      createService(sameProposer.prisma).transitionScimConnector(
        CONNECTOR_ID,
        'ACTIVATE',
        { expectedRevision: 2, idempotencyKey: 'activate-same-maker' },
        principal(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sameProposer.executeRaw).not.toHaveBeenCalled();

    const forbidden = fakeScimDatabase();
    await expect(
      createService(forbidden.prisma).listScimConnectors(principal({ role: 'MEMBER' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(forbidden.prisma.withTenant).not.toHaveBeenCalled();
  });
});

function createService(prisma: { withTenant: ReturnType<typeof vi.fn> }) {
  return new IdentityGovernanceAdminService(
    prisma as unknown as AdminPrismaService,
    {} as IdentitySecretVault,
    {} as OidcDiscoveryClient,
    new ConfigService<EnvironmentVariables, true>({
      AUTH_TOKEN_PEPPER: PEPPER,
    } as EnvironmentVariables),
  );
}

function principal(overrides?: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return {
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    tenantSlug: 'test',
    tenantName: 'Test',
    userId: USER_ID,
    email: 'admin@example.test',
    displayName: 'Admin',
    role: 'ADMIN',
    passwordChangeRequired: false,
    accessExpiresAt: '2031-01-01T00:00:00.000Z',
    refreshExpiresAt: '2031-01-02T00:00:00.000Z',
    authenticationSource: 'session',
    ...overrides,
  };
}

function fakeScimDatabase(options?: {
  connectorStatus?: 'ACTIVE' | 'SUSPENDED' | 'IN_REVIEW';
  proposedByUserId?: string;
}) {
  let command:
    | {
        resource_type: string;
        resource_id: string;
        action: string;
        request_hash: string;
        status: 'APPLIED';
      }
    | undefined;
  const connectorStatus = options?.connectorStatus ?? 'ACTIVE';
  const queryRaw = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const sql = strings.join(' ');
      if (sql.includes('SELECT "revision", "status", "proposed_by_user_id"')) {
        return [
          {
            revision: connectorStatus === 'IN_REVIEW' ? 2 : 3,
            status: connectorStatus,
            proposed_by_user_id:
              options?.proposedByUserId ?? '00000000-0000-7000-8000-00000000d999',
          },
        ];
      }
      if (sql.includes('FROM public."identity_governance_commands"')) {
        return command === undefined ? [] : [command];
      }
      if (sql.includes('INSERT INTO public."scim_service_tokens"')) {
        return [
          {
            id: values[0],
            connector_id: values[2],
            token_hint: values[4],
            status: 'ACTIVE',
            scopes: values[5],
            created_by_user_id: values[6],
            expires_at: values[7],
            last_used_at: null,
            revoked_at: null,
            revision: 1,
            created_at: new Date('2031-01-01T00:00:00.000Z'),
          },
        ];
      }
      return [];
    },
  );
  const executeRaw = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const sql = strings.join(' ');
      if (sql.includes('INSERT INTO public."identity_governance_commands"')) {
        command = {
          resource_type: String(values[1]),
          resource_id: String(values[2]),
          action: String(values[3]),
          request_hash: String(values[7]),
          status: 'APPLIED',
        };
      }
      return 1;
    },
  );
  const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const prisma = {
    withTenant: vi.fn(
      async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  return { prisma, queryRaw, executeRaw };
}
