import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BindLexiangUserRequest,
  KnowledgeProviderUserBindingsResponse,
} from '@enterprise/contracts';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';

@Injectable()
export class KnowledgeProviderIdentityService {
  constructor(@Inject(AdminPrismaService) private readonly prisma: AdminPrismaService) {}

  list(tenantId: string): Promise<KnowledgeProviderUserBindingsResponse> {
    return this.prisma.withTenant(tenantId, (transaction) =>
      this.listInTransaction(transaction, tenantId),
    );
  }

  bind(
    tenantId: string,
    actorUserId: string,
    request: BindLexiangUserRequest,
  ): Promise<KnowledgeProviderUserBindingsResponse> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const [connection, user, conflictingBinding] = await Promise.all([
        transaction.knowledgeProviderConnection.findFirst({
          where: { tenantId, provider: 'LEXIANG', status: 'ACTIVE' },
          select: { id: true },
        }),
        transaction.user.findFirst({
          where: {
            tenantId,
            id: request.userId,
            status: 'ACTIVE',
            employments: { some: { status: 'ACTIVE' } },
          },
          select: { id: true },
        }),
        transaction.knowledgeProviderUserBinding.findFirst({
          where: {
            tenantId,
            provider: 'LEXIANG',
            externalStaffId: request.externalStaffId,
            userId: { not: request.userId },
            status: 'ACTIVE',
          },
          select: { id: true },
        }),
      ]);
      if (connection === null) throw new NotFoundException('Active Lexiang connection not found.');
      if (user === null) throw new NotFoundException('Active employee not found.');
      if (conflictingBinding !== null) {
        throw new ConflictException(
          'This Lexiang staff identity is already bound to another user.',
        );
      }

      await transaction.knowledgeProviderUserBinding.upsert({
        where: {
          tenantId_connectionId_userId: {
            tenantId,
            connectionId: connection.id,
            userId: request.userId,
          },
        },
        create: {
          tenantId,
          connectionId: connection.id,
          provider: 'LEXIANG',
          userId: request.userId,
          externalStaffId: request.externalStaffId,
          status: 'ACTIVE',
        },
        update: { externalStaffId: request.externalStaffId, status: 'ACTIVE' },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'USER',
          actorId: actorUserId,
          action: 'knowledge.provider.user_binding.updated',
          resourceType: 'user',
          resourceId: request.userId,
          metadata: { provider: 'LEXIANG' },
        },
      });
      return this.listInTransaction(transaction, tenantId);
    });
  }

  disable(
    tenantId: string,
    actorUserId: string,
    userId: string,
  ): Promise<KnowledgeProviderUserBindingsResponse> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const result = await transaction.knowledgeProviderUserBinding.updateMany({
        where: { tenantId, provider: 'LEXIANG', userId, status: 'ACTIVE' },
        data: { status: 'DISABLED' },
      });
      if (result.count === 0) throw new NotFoundException('Active Lexiang user binding not found.');
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'USER',
          actorId: actorUserId,
          action: 'knowledge.provider.user_binding.disabled',
          resourceType: 'user',
          resourceId: userId,
          metadata: { provider: 'LEXIANG' },
        },
      });
      return this.listInTransaction(transaction, tenantId);
    });
  }

  private async listInTransaction(
    transaction: Parameters<Parameters<AdminPrismaService['withTenant']>[1]>[0],
    tenantId: string,
  ): Promise<KnowledgeProviderUserBindingsResponse> {
    const bindings = await transaction.knowledgeProviderUserBinding.findMany({
      where: { tenantId, provider: 'LEXIANG' },
      select: {
        userId: true,
        externalStaffId: true,
        status: true,
        updatedAt: true,
        user: { select: { displayName: true } },
      },
      orderBy: [{ user: { displayName: 'asc' } }, { userId: 'asc' }],
    });
    return {
      bindings: bindings.map((binding) => ({
        userId: binding.userId,
        displayName: binding.user.displayName,
        externalStaffId: binding.externalStaffId,
        status: binding.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED',
        updatedAt: binding.updatedAt.toISOString(),
      })),
    };
  }
}
