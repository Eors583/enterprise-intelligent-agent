import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

/**
 * Dedicated SCIM capability. Callers must hash the bearer before entering this
 * boundary. The only pre-tenant operation is a least-privilege definer function
 * that returns one capability summary; app.tenant_id is set only after it
 * succeeds. The SCIM role has no direct token/connector table access.
 */
@Injectable()
export class ScimPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const datasourceUrl = config.get('SCIM_DATABASE_URL', { infer: true });
    super(datasourceUrl === undefined ? undefined : { datasourceUrl });
    this.enabled = config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.$disconnect();
  }

  async withToken<T>(
    tokenHash: string,
    connectorKey: string,
    operation: (transaction: Prisma.TransactionClient, capability: ScimCapability) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error('SCIM persistence requires the Prisma repository adapter.');
    }
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      throw new TypeError('SCIM bearer digest must be a SHA-256 HMAC hex value.');
    }
    // Resolve and record token use in a short transaction. PostgreSQL retains
    // UPDATE row locks until transaction end, so keeping this separate avoids
    // serializing every operation made with the same SCIM bearer.
    const capability = await this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_scim');
      const rows = await transaction.$queryRaw<ScimCapabilityRow[]>`
        SELECT *
        FROM public.resolve_scim_capability(${tokenHash}, ${connectorKey})
      `;
      const row = rows[0];
      if (row === undefined) throw new InvalidScimCapabilityError();
      return mapCapability(row);
    });

    return this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_scim');
      // This ordering is security-sensitive: no tenant context is set before
      // the opaque digest lookup above. The capability is an authorization
      // snapshot for this one request, matching normal bearer-token semantics.
      await transaction.$queryRaw`
        SELECT set_config('app.tenant_id', ${capability.tenantId}, true)
      `;
      return operation(transaction, capability);
    });
  }
}

interface ScimCapabilityRow {
  readonly service_token_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly connector_key: string;
  readonly scopes: string[];
  readonly allow_user_create: boolean;
  readonly allow_group_create: boolean;
  readonly deactivate_user_on_scim_disable: boolean;
}

export interface ScimCapability {
  readonly serviceTokenId: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly connectorKey: string;
  readonly scopes: readonly string[];
  readonly allowUserCreate: boolean;
  readonly allowGroupCreate: boolean;
  readonly deactivateUserOnDisable: boolean;
}

function mapCapability(row: ScimCapabilityRow): ScimCapability {
  return {
    serviceTokenId: row.service_token_id,
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    connectorKey: row.connector_key,
    scopes: row.scopes,
    allowUserCreate: row.allow_user_create,
    allowGroupCreate: row.allow_group_create,
    deactivateUserOnDisable: row.deactivate_user_on_scim_disable,
  };
}

export class InvalidScimCapabilityError extends Error {
  constructor() {
    super('SCIM bearer capability is invalid.');
    this.name = 'InvalidScimCapabilityError';
  }
}
