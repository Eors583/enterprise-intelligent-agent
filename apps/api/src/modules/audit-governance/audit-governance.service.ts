import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AuditEventFilter,
  AuditEventListQuery,
  AuditEventListResponse,
  AuditEventRecord,
  AuditExportResponse,
  AuditIntegrityResponse,
  CreateAuditExportRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';
import { recordAdminAudit } from '../admin/admin-audit.js';

interface AuditRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly actor_type: 'USER' | 'AGENT' | 'SERVICE';
  readonly actor_id: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly metadata: Prisma.JsonValue;
  readonly occurred_at: Date;
  readonly chain_sequence: bigint;
  readonly previous_hash: string | null;
  readonly event_hash: string;
}

interface IntegrityRow {
  readonly checked_records: bigint;
  readonly first_invalid_event_id: string | null;
  readonly head_sequence: bigint;
  readonly head_hash: string | null;
}

interface AuditCursor {
  readonly occurredAt: string;
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditGovernanceService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async list(query: AuditEventListQuery): Promise<AuditEventListResponse> {
    const principal = this.access.requireAuditRead();
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await queryAuditRows(transaction, principal.tenantId, query, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: query.limit + 1,
        order: 'DESC',
      });
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map(mapAuditRow),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ occurredAt: last.occurred_at.toISOString(), id: last.id })
            : null,
      };
    });
  }

  async verifyIntegrity(): Promise<AuditIntegrityResponse> {
    const principal = this.access.requireAuditRead();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const [result] = await transaction.$queryRaw<IntegrityRow[]>`
        SELECT *
        FROM public.verify_audit_event_chain(${principal.tenantId}::uuid)
      `;
      const row = result ?? {
        checked_records: 0n,
        first_invalid_event_id: null,
        head_sequence: 0n,
        head_hash: null,
      };
      return {
        checkedAt: new Date().toISOString(),
        checkedRecords: safeNumber(row.checked_records),
        valid: row.first_invalid_event_id === null,
        firstInvalidEventId: row.first_invalid_event_id,
        headSequence: row.head_sequence.toString(),
        headHash: normalizedHash(row.head_hash),
      };
    });
  }

  async export(request: CreateAuditExportRequest): Promise<AuditExportResponse> {
    const principal = this.access.requireAuditExport();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await queryAuditRows(transaction, principal.tenantId, request, {
        limit: request.maximumRecords + 1,
        order: 'ASC',
      });
      const truncated = rows.length > request.maximumRecords;
      const exportedRows = truncated ? rows.slice(0, request.maximumRecords) : rows;
      const csv = renderAuditCsv(exportedRows.map(mapAuditRow));
      const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const exportId = randomUUID();
      const generatedAt = new Date();
      await recordAdminAudit(
        transaction,
        principal,
        'admin.audit.exported',
        'audit_export',
        exportId,
        {
          reason: request.reason,
          filter: jsonObject(filterOnly(request)),
          recordCount: exportedRows.length,
          truncated,
          sha256,
        },
      );
      return {
        exportId,
        generatedAt: generatedAt.toISOString(),
        recordCount: exportedRows.length,
        truncated,
        sha256,
        mediaType: 'text/csv; charset=utf-8',
        fileName: `audit-${principal.tenantId}-${generatedAt.toISOString().replaceAll(':', '-')}.csv`,
        csv,
      };
    });
  }
}

async function queryAuditRows(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  filter: AuditEventFilter,
  options: {
    readonly cursor?: AuditCursor;
    readonly limit: number;
    readonly order: 'ASC' | 'DESC';
  },
): Promise<AuditRow[]> {
  const clauses: Prisma.Sql[] = [Prisma.sql`"tenant_id" = ${tenantId}::uuid`];
  if (filter.actorType !== undefined) {
    clauses.push(Prisma.sql`"actor_type" = ${filter.actorType}::public."AuditActorType"`);
  }
  if (filter.actorId !== undefined) clauses.push(Prisma.sql`"actor_id" = ${filter.actorId}::uuid`);
  if (filter.action !== undefined) clauses.push(Prisma.sql`"action" = ${filter.action}`);
  if (filter.resourceType !== undefined) {
    clauses.push(Prisma.sql`"resource_type" = ${filter.resourceType}`);
  }
  if (filter.resourceId !== undefined) {
    clauses.push(Prisma.sql`"resource_id" = ${filter.resourceId}::uuid`);
  }
  if (filter.occurredFrom !== undefined) {
    clauses.push(Prisma.sql`"occurred_at" >= ${new Date(filter.occurredFrom)}`);
  }
  if (filter.occurredTo !== undefined) {
    clauses.push(Prisma.sql`"occurred_at" < ${new Date(filter.occurredTo)}`);
  }
  if (options.cursor !== undefined) {
    clauses.push(
      Prisma.sql`("occurred_at", "id") < (${new Date(options.cursor.occurredAt)}, ${options.cursor.id}::uuid)`,
    );
  }
  const direction = options.order === 'ASC' ? Prisma.raw('ASC') : Prisma.raw('DESC');
  return transaction.$queryRaw<AuditRow[]>(Prisma.sql`
    SELECT
      "id",
      "tenant_id",
      "actor_type",
      "actor_id",
      "action",
      "resource_type",
      "resource_id",
      "metadata",
      "occurred_at",
      "chain_sequence",
      "previous_hash",
      "event_hash"
    FROM public."audit_events"
    WHERE ${Prisma.join(clauses, ' AND ')}
    ORDER BY "occurred_at" ${direction}, "id" ${direction}
    LIMIT ${options.limit}
  `);
}

function mapAuditRow(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: jsonRecord(row.metadata),
    occurredAt: row.occurred_at.toISOString(),
    chainSequence: row.chain_sequence.toString(),
    previousHash: normalizedHash(row.previous_hash),
    eventHash: normalizedHash(row.event_hash) ?? '0'.repeat(64),
  };
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('occurredAt' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.occurredAt)) ||
      !UUID.test(parsed.id)
    ) {
      throw new Error('invalid cursor');
    }
    return { occurredAt: new Date(parsed.occurredAt).toISOString(), id: parsed.id };
  } catch {
    throw new BadRequestException('The audit cursor is invalid or expired.');
  }
}

function renderAuditCsv(records: readonly AuditEventRecord[]): string {
  const header = [
    'chainSequence',
    'eventHash',
    'previousHash',
    'occurredAt',
    'actorType',
    'actorId',
    'action',
    'resourceType',
    'resourceId',
    'metadata',
  ];
  const lines = records.map((record) =>
    [
      record.chainSequence,
      record.eventHash,
      record.previousHash ?? '',
      record.occurredAt,
      record.actorType,
      record.actorId,
      record.action,
      record.resourceType,
      record.resourceId,
      JSON.stringify(record.metadata),
    ]
      .map(csvField)
      .join(','),
  );
  return `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function filterOnly(request: CreateAuditExportRequest): AuditEventFilter {
  const { maximumRecords: _maximumRecords, reason: _reason, ...filter } = request;
  return filter;
}

function normalizedHash(value: string | null): string | null {
  return value?.trim() ?? null;
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The audit record count exceeds the supported response range.');
  }
  return Number(value);
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function jsonObject(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

export const auditGovernanceTestSupport = {
  decodeCursor,
  encodeCursor,
  renderAuditCsv,
};
