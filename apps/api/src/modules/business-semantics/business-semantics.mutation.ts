import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AdminPrincipal } from '../admin/admin-access.service.js';

export interface IdempotencyIdentity {
  readonly key: string;
  readonly requestHash: string;
}

export function idempotencyIdentity(request: unknown, suppliedKey?: string): IdempotencyIdentity {
  const requestHash = createHash('sha256').update(stableJson(request)).digest('hex');
  const key = suppliedKey?.trim() || `auto:${requestHash}`;
  if (key.length > 200) {
    throw new BadRequestException('Idempotency-Key must not exceed 200 characters.');
  }
  return { key, requestHash };
}

export async function lockIdempotency(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  resource: string,
  key: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:business-semantics:${resource}:${key}`}, 0)
    )
  `;
}

export async function lockSemanticGraph(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  graph: 'objective-parent' | 'task-dependency',
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:business-semantics:${graph}`}, 0)
    )
  `;
}

export function assertIdempotentReplay(
  existing: { readonly requestHash: string },
  expectedHash: string,
): void {
  if (existing.requestHash !== expectedHash) {
    throw new ConflictException('The idempotency key was already used for a different request.');
  }
}

export async function recordBusinessMutation(
  transaction: Prisma.TransactionClient,
  principal: Pick<AdminPrincipal, 'tenantId' | 'userId'>,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Prisma.InputJsonObject = {},
): Promise<void> {
  const eventId = randomUUID();
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'USER',
        actorId: principal.userId,
        action,
        resourceType,
        resourceId,
        metadata,
      },
    }),
    transaction.outboxEvent.create({
      data: {
        id: eventId,
        tenantId: principal.tenantId,
        aggregateType: resourceType,
        aggregateId: resourceId,
        eventType: action,
        payload: {
          eventId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          resourceType,
          resourceId,
          action,
          metadata,
        },
      },
    }),
  ]);
}

export function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isConstraintConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === 'P2003' || error.code === 'P2004' || error.code === 'P2014';
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
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
