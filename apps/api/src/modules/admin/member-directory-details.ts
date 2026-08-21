import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export async function createMemberDirectoryDetails(
  transaction: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly organizationId: string;
    readonly employmentId: string;
    readonly directManagerUserId?: string;
    readonly dottedLineManagerUserId?: string;
  },
): Promise<void> {
  const managerRequests = [
    { userId: input.directManagerUserId, relationType: 'DIRECT' as const },
    { userId: input.dottedLineManagerUserId, relationType: 'DOTTED_LINE' as const },
  ].filter(
    (candidate): candidate is { userId: string; relationType: 'DIRECT' | 'DOTTED_LINE' } =>
      candidate.userId !== undefined,
  );

  if (managerRequests.length > 0) {
    const managerEmployments = await transaction.employment.findMany({
      where: {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        userId: { in: managerRequests.map(({ userId }) => userId) },
        status: 'ACTIVE',
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, userId: true },
    });
    const employmentByUserId = new Map(
      managerEmployments.map((employment) => [employment.userId, employment.id]),
    );
    const missingManager = managerRequests.find(
      ({ userId }) => employmentByUserId.get(userId) === undefined,
    );
    if (missingManager !== undefined) {
      throw new BadRequestException('The selected manager has no active employment.');
    }
    await transaction.managerRelation.createMany({
      data: managerRequests.map(({ userId, relationType }) => ({
        tenantId: input.tenantId,
        employmentId: input.employmentId,
        managerEmploymentId: employmentByUserId.get(userId)!,
        relationType,
      })),
    });
  }
}
