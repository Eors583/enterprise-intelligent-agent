import { Prisma } from '@prisma/client';

import type { AdminPrincipal } from './admin-access.service.js';

export async function recordAdminAudit(
  transaction: Prisma.TransactionClient,
  principal: Pick<AdminPrincipal, 'tenantId' | 'userId'>,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Prisma.InputJsonObject = {},
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId: principal.tenantId,
      actorType: 'USER',
      actorId: principal.userId,
      action,
      resourceType,
      resourceId,
      metadata,
    },
  });
}
