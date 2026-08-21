import { createHash, randomUUID } from 'node:crypto';

import { ConflictException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AdminPrincipal } from '../admin/admin-access.service.js';

export interface FinopsRequestIdentity {
  readonly key: string;
  readonly requestHash: string;
}

export function finopsRequestIdentity<T extends { readonly idempotencyKey: string }>(
  request: T,
): FinopsRequestIdentity {
  const { idempotencyKey: key, ...content } = request;
  return {
    key,
    requestHash: hashStable(content),
  };
}

export function hashStable(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function beginFinopsCommand(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  identity: FinopsRequestIdentity,
): Promise<{
  readonly requestHash: string;
  readonly replay: {
    readonly resourceType: string;
    readonly resourceId: string;
    readonly resultRevision: number;
  } | null;
}> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:finops:${identity.key}`}, 0)
    )
  `;
  const existing = await transaction.finopsCommand.findFirst({
    where: { tenantId, idempotencyKey: identity.key },
  });
  if (existing !== null && existing.requestHash !== identity.requestHash) {
    throw new ConflictException(
      'The FinOps idempotency key was already used for a different command.',
    );
  }
  return {
    requestHash: identity.requestHash,
    replay:
      existing === null
        ? null
        : {
            resourceType: existing.resourceType,
            resourceId: existing.resourceId,
            resultRevision: existing.resultRevision,
          },
  };
}

export async function recordFinopsMutation(
  transaction: Prisma.TransactionClient,
  principal: Pick<AdminPrincipal, 'tenantId' | 'userId'>,
  command: {
    readonly commandType: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly resultRevision: number;
    readonly action: string;
    readonly metadata?: Prisma.InputJsonObject;
  },
): Promise<void> {
  const eventId = randomUUID();
  const metadata = command.metadata ?? {};
  await Promise.all([
    transaction.finopsCommand.create({
      data: {
        id: randomUUID(),
        tenantId: principal.tenantId,
        commandType: command.commandType,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        resourceType: command.resourceType,
        resourceId: command.resourceId,
        resultRevision: command.resultRevision,
        actorUserId: principal.userId,
      },
    }),
    transaction.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'USER',
        actorId: principal.userId,
        action: command.action,
        resourceType: command.resourceType,
        resourceId: command.resourceId,
        metadata,
      },
    }),
    transaction.outboxEvent.create({
      data: {
        id: eventId,
        tenantId: principal.tenantId,
        aggregateType: command.resourceType,
        aggregateId: command.resourceId,
        eventType: command.action,
        payload: {
          eventId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          action: command.action,
          resourceType: command.resourceType,
          resourceId: command.resourceId,
          revision: command.resultRevision,
          metadata,
        },
      },
    }),
  ]);
}

export async function lockFinopsRecord(
  transaction: Prisma.TransactionClient,
  table:
    | 'finops_price_snapshots'
    | 'finops_allocation_rules'
    | 'finops_allocation_sets'
    | 'finops_benefit_claims'
    | 'finops_roi_formula_versions'
    | 'finops_budgets'
    | 'finops_budget_alerts'
    | 'finops_model_routing_suggestions',
  tenantId: string,
  id: string,
): Promise<void> {
  await transaction.$executeRawUnsafe(
    `SELECT 1 FROM public.${table} WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    tenantId,
    id,
  );
}

export function mapFinopsWriteError(error: unknown, label: string): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictException(`${label} conflicts with an existing governed record.`);
    }
    if (error.code === 'P2003' || error.code === 'P2025') {
      throw new ConflictException(`${label} references stale or unavailable tenant data.`);
    }
  }
  throw error;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
