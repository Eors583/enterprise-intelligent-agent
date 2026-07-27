import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface ManagedAgent {
  readonly id: string;
  readonly key: string;
  readonly ownerUserId: string | null;
}

export interface DirectoryAgentProvisioningPlan {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly versionId: string;
  readonly agentsByOwner: Map<string, ManagedAgent>;
}

export interface DirectoryAgentMember {
  readonly userId: string;
  readonly displayName: string;
  readonly active: boolean;
}

/**
 * Agent-domain adapter used by directory integrations.
 *
 * Directory sync supplies only tenant/member facts; template/version/instance
 * persistence stays encapsulated in the agent-control module. The caller passes
 * its transaction so member and agent reconciliation remain atomic.
 */
@Injectable()
export class DirectoryPersonalAgentProvisioner {
  async prepare(
    transaction: Prisma.TransactionClient,
    input: { readonly tenantId: string; readonly actorUserId: string; readonly publishedAt: Date },
  ): Promise<DirectoryAgentProvisioningPlan> {
    const template = await transaction.agentTemplate.upsert({
      where: {
        tenantId_key: { tenantId: input.tenantId, key: 'personal-work-assistant' },
      },
      update: {},
      create: {
        tenantId: input.tenantId,
        key: 'personal-work-assistant',
        name: '个人工作助手',
        description: '企业成员的个人工作智能体模板。',
      },
      select: { id: true },
    });
    let version = await transaction.agentVersion.findFirst({
      where: { tenantId: input.tenantId, templateId: template.id, status: 'PUBLISHED' },
      orderBy: [{ version: 'desc' }, { publishedAt: 'desc' }],
      select: { id: true },
    });
    if (version === null) {
      const latest = await transaction.agentVersion.findFirst({
        where: { tenantId: input.tenantId, templateId: template.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      version = await transaction.agentVersion.create({
        data: {
          tenantId: input.tenantId,
          templateId: template.id,
          version: (latest?.version ?? 0) + 1,
          status: 'PUBLISHED',
          systemPrompt:
            '你是该企业成员的个人工作智能体。仅在租户权限和用户授权范围内提供工作协助；回答应准确、简洁，不得泄露其他成员或租户的数据。',
          modelPolicy: { route: 'default' },
          toolPolicy: { allow: [] },
          knowledgeScope: { mode: 'owner-authorized' },
          publishedAt: input.publishedAt,
        },
        select: { id: true },
      });
    }
    const agents = await transaction.agentInstance.findMany({
      where: { tenantId: input.tenantId, ownerUserId: { not: null } },
      select: { id: true, key: true, ownerUserId: true },
    });
    return {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      versionId: version.id,
      agentsByOwner: new Map(
        agents.flatMap((agent) =>
          agent.ownerUserId === null ? [] : ([[agent.ownerUserId, agent]] as const),
        ),
      ),
    };
  }

  async reconcileMember(
    transaction: Prisma.TransactionClient,
    plan: DirectoryAgentProvisioningPlan,
    member: DirectoryAgentMember,
  ): Promise<void> {
    const managedKey = `feishu-personal-${member.userId}`;
    const existing = plan.agentsByOwner.get(member.userId);
    if (existing !== undefined) {
      if (existing.key !== managedKey) return;
      await transaction.agentInstance.update({
        where: { id: existing.id },
        data: {
          name: `${member.displayName}的智能体`,
          summary: `可在企业授权范围内代表 ${member.displayName} 提供工作协助。`,
          status: member.active ? 'ONLINE' : 'OFFLINE',
          settings: { visibility: 'tenant', provisionedBy: 'feishu-directory' },
        },
      });
      return;
    }
    if (!member.active) return;

    const agent = await transaction.agentInstance.create({
      data: {
        tenantId: plan.tenantId,
        key: managedKey,
        versionId: plan.versionId,
        ownerUserId: member.userId,
        createdById: plan.actorUserId,
        name: `${member.displayName}的智能体`,
        summary: `可在企业授权范围内代表 ${member.displayName} 提供工作协助。`,
        status: 'ONLINE',
        settings: { visibility: 'tenant', provisionedBy: 'feishu-directory' },
      },
      select: { id: true, key: true, ownerUserId: true },
    });
    plan.agentsByOwner.set(member.userId, agent);
  }
}
