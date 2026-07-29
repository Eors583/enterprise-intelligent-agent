import { createHash, randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../../database/prisma.service.js';
import type { TrustedRuntimePrincipal } from '../../application/runtime-identity.port.js';

export async function withProcessTenant<T>(
  prisma: PrismaService,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  actorUserId?: string,
): Promise<T> {
  if (!prisma.enabled) {
    throw new Error('Prisma process-runtime access is disabled for the current adapter.');
  }
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_process');
    await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (actorUserId !== undefined) {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${actorUserId}, true)`;
    }
    return operation(transaction);
  });
}

export async function appendRuntimeAuditAndOutbox(
  transaction: Prisma.TransactionClient,
  principal: TrustedRuntimePrincipal,
  input: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  // The capability role deliberately cannot mutate these shared ledgers.
  // Switch to the tenant-bound app role only after all process-owned writes.
  await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
  await transaction.auditEvent.create({
    data: {
      id: randomUUID(),
      tenantId: principal.tenantId,
      actorType: 'USER',
      actorId: principal.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.payload as Prisma.InputJsonValue,
      occurredAt: input.occurredAt,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      id: randomUUID(),
      tenantId: principal.tenantId,
      aggregateType: input.resourceType,
      aggregateId: input.resourceId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
      availableAt: input.occurredAt,
    },
  });
}

export function runtimeHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function encodeRuntimeCursor(timestamp: Date, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp: timestamp.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeRuntimeCursor(
  cursor: string | null,
): { readonly timestamp: Date; readonly id: string } | null {
  if (cursor === null) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !isRecord(value) ||
      typeof value.timestamp !== 'string' ||
      typeof value.id !== 'string' ||
      !UUID_PATTERN.test(value.id)
    ) {
      throw new Error('invalid cursor shape');
    }
    const timestamp = new Date(value.timestamp);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error('invalid cursor timestamp');
    }
    return { timestamp, id: value.id };
  } catch {
    throw new ConflictException('The runtime cursor is invalid or expired.');
  }
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConflictException('A persisted runtime JSON object is invalid.');
  }
  return { ...value };
}

export function nullableJsonObject(value: unknown): Record<string, unknown> | null {
  return value === null ? null : jsonObject(value);
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ConflictException('A persisted runtime string array is invalid.');
  }
  return [...value];
}

export function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConflictException('A persisted runtime JSON array is invalid.');
  }
  return [...value];
}

export function databaseErrorText(error: unknown): string {
  if (error instanceof Error) {
    const metadata = isRecord(error) && 'meta' in error ? error.meta : null;
    return `${error.message} ${safeJson(metadata)}`.toLowerCase();
  }
  return safeJson(error).toLowerCase();
}

export function isDatabaseConflict(error: unknown): boolean {
  const text = databaseErrorText(error);
  return (
    text.includes('40001') ||
    text.includes('revision_cas') ||
    text.includes('unique constraint') ||
    text.includes('23505')
  );
}

export function isDatabaseRejection(error: unknown): boolean {
  const text = databaseErrorText(error);
  return (
    text.includes('23514') ||
    text.includes('status_transition') ||
    text.includes('evidence_required') ||
    text.includes('actor_')
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
