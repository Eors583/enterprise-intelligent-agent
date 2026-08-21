import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { BusinessOwner } from '@enterprise/contracts';

import { isConstraintConflict, isUniqueConflict } from './business-semantics.mutation.js';

const LOCKABLE_TABLES = new Set([
  'value_definitions',
  'value_versions',
  'strategies',
  'objectives',
  'objective_relations',
  'metric_definitions',
  'metric_observations',
  'process_definitions',
  'process_versions',
  'tasks',
  'task_dependencies',
  'deliverables',
  'acceptances',
  'evidence',
  'evidence_links',
]);

export async function lockBusinessSemanticEntity(
  transaction: Prisma.TransactionClient,
  table: string,
  tenantId: string,
  id: string,
): Promise<void> {
  if (!LOCKABLE_TABLES.has(table)) {
    throw new Error(`Unsupported semantic entity lock: ${table}.`);
  }
  await transaction.$queryRawUnsafe(
    `SELECT id FROM public."${table}" WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    tenantId,
    id,
  );
}

export function semanticNotFound(resource: string): NotFoundException {
  return new NotFoundException(`${resource} was not found.`);
}

export function staleSemanticRevision(resource: string): ConflictException {
  return new ConflictException(`${resource} revision is stale.`);
}

export function illegalSemanticTransition(resource: string): ConflictException {
  return new ConflictException(`${resource} status transition is not allowed.`);
}

export function mapSemanticWriteError(error: unknown, resource: string): unknown {
  if (error instanceof ConflictException || error instanceof NotFoundException) return error;
  if (isUniqueConflict(error)) {
    return new ConflictException(`${resource} code, version, or idempotency key already exists.`);
  }
  if (isConstraintConflict(error)) {
    return new ConflictException(
      `${resource} references an invalid tenant-scoped identity or violates a business invariant.`,
    );
  }
  return error;
}

export function nullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Expected a JSON string array.');
  }
  return [...value];
}

export function businessOwnerFromColumns(record: {
  readonly ownerUserId: string | null;
  readonly ownerRoleAssignmentId: string | null;
  readonly ownerRoleTemplateId: string | null;
  readonly ownerOrgUnitId: string | null;
}): BusinessOwner {
  if (record.ownerUserId !== null) return { type: 'USER', id: record.ownerUserId };
  if (record.ownerRoleAssignmentId !== null) {
    return { type: 'ROLE_ASSIGNMENT', id: record.ownerRoleAssignmentId };
  }
  if (record.ownerRoleTemplateId !== null) {
    return { type: 'ROLE_BLUEPRINT', id: record.ownerRoleTemplateId };
  }
  if (record.ownerOrgUnitId !== null) return { type: 'ORG_UNIT', id: record.ownerOrgUnitId };
  throw new Error('Business owner columns violate the exactly-one invariant.');
}

export function nextVersionIdentity(current: { readonly id: string; readonly version: number }) {
  return {
    version: current.version + 1,
    previousVersionId: current.id,
    previousVersionNumber: current.version,
  };
}
