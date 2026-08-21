import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ToolReconciliationStatus } from '@enterprise/contracts';

import { PrismaService } from '../../../database/prisma.service.js';
import { RuntimeIdentityPort } from '../../process-orchestration/application/runtime-identity.port.js';

interface StatusRow {
  readonly invocation_id: string;
  readonly attempt_id: string | null;
  readonly eligibility: 'READ_ONLY' | 'PROVIDER_IDEMPOTENT' | 'INELIGIBLE' | null;
  readonly resolution: 'SUCCEEDED' | 'FAILED' | 'INCONCLUSIVE' | null;
  readonly reason_code: string | null;
  readonly requested_at: Date | null;
  readonly completed_at: Date | null;
}

@Injectable()
export class ToolReconciliationStatusService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RuntimeIdentityPort) private readonly identity: RuntimeIdentityPort,
  ) {}

  get(invocationId: string): Promise<ToolReconciliationStatus> {
    const principal = this.identity.current();
    if (!this.prisma.enabled) {
      throw new Error('Tool reconciliation status requires the Prisma adapter.');
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`;
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      const rows = await transaction.$queryRaw<StatusRow[]>(Prisma.sql`
        SELECT
          invocation."id"::text AS invocation_id,
          attempt."id"::text AS attempt_id,
          attempt."eligibility"::text AS eligibility,
          receipt."resolution"::text AS resolution,
          receipt."reason_code",
          attempt."requested_at",
          receipt."completed_at"
        FROM public."tool_invocations" invocation
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM public."tool_reconciliation_attempts" candidate
          WHERE candidate."tenant_id" = invocation."tenant_id"
            AND candidate."tool_invocation_id" = invocation."id"
          ORDER BY candidate."created_at" DESC, candidate."id" DESC
          LIMIT 1
        ) attempt ON true
        LEFT JOIN public."tool_reconciliation_receipts" receipt
          ON receipt."tenant_id" = attempt."tenant_id"
         AND receipt."attempt_id" = attempt."id"
        WHERE invocation."tenant_id" = ${principal.tenantId}::uuid
          AND invocation."id" = ${invocationId}::uuid
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) throw new NotFoundException('Tool Invocation was not found.');
      const state =
        row.attempt_id === null
          ? 'NONE'
          : row.resolution === null
            ? 'PENDING'
            : row.resolution === 'INCONCLUSIVE'
              ? 'INCONCLUSIVE'
              : 'RESOLVED';
      return {
        invocationId: row.invocation_id,
        state,
        attemptId: row.attempt_id,
        eligibility: row.eligibility,
        resolution: row.resolution,
        reasonCode: row.reason_code,
        requestedAt: row.requested_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
      };
    });
  }
}
