import { createHash, randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AdminPrincipal } from '../admin/admin-access.service.js';

export function peopleRequestIdentity(request: { readonly idempotencyKey: string }): {
  readonly key: string;
  readonly requestHash: string;
} {
  const { idempotencyKey: _, ...content } = request;
  return {
    key: request.idempotencyKey,
    requestHash: createHash('sha256').update(stableJson(content)).digest('hex'),
  };
}

export function assertPeopleReplay(
  existing: { readonly requestHash: string },
  requestHash: string,
): void {
  if (existing.requestHash !== requestHash) {
    throw new ConflictException(
      'The idempotency key was already used for a different people or organization request.',
    );
  }
}

export async function lockPeopleKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  scope: string,
  key: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:people-organization:${scope}:${key}`}, 0)
    )
  `;
}

export async function recordPeopleMutation(
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
          action,
          resourceType,
          resourceId,
          metadata,
        },
      },
    }),
  ]);
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
