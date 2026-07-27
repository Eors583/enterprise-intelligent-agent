import { Prisma } from '@prisma/client';

/**
 * Serialize organization-tree and membership mutations across manual admin
 * requests and external-directory reconciliation.
 */
export async function lockOrganizationDirectory(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  const key = `organization-directory:${tenantId}:${organizationId}`;
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
