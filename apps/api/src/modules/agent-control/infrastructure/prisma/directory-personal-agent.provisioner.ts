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
  readonly versionPublished: boolean;
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
    input: { readonly tenantId: string; readonly actorUserId: string },
  ): Promise<DirectoryAgentProvisioningPlan> {
    const roleDefinition = personalAgentRoleDefinition();
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
        ...roleDefinition,
      },
      select: { id: true },
    });
    await transaction.agentTemplate.updateMany({
      where: { id: template.id, tenantId: input.tenantId, mission: '' },
      data: roleDefinition,
    });
    const publishedVersion = await transaction.agentVersion.findFirst({
      where: { tenantId: input.tenantId, templateId: template.id, status: 'PUBLISHED' },
      orderBy: [{ version: 'desc' }, { publishedAt: 'desc' }],
      select: { id: true },
    });
    const versionPublished = publishedVersion !== null;
    let version = publishedVersion;
    if (version === null) {
      version = await transaction.agentVersion.findFirst({
        where: {
          tenantId: input.tenantId,
          templateId: template.id,
          status: { in: ['DRAFT', 'TESTING'] },
        },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
    }
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
          status: 'DRAFT',
          reviewStatus: 'NOT_SUBMITTED',
          systemPrompt:
            '你是该企业成员的个人工作智能体。仅在租户权限和用户授权范围内提供工作协助；回答应准确、简洁，不得泄露其他成员或租户的数据。',
          modelPolicy: { route: 'default' },
          toolPolicy: { allow: [] },
          knowledgeScope: { mode: 'owner-authorized' },
          roleDefinitionSnapshot: roleDefinition,
          blueprintRevision: 1,
          changeSummary: 'Initial governed personal assistant draft.',
          createdById: input.actorUserId,
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
      versionPublished,
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
          versionId: plan.versionId,
          name: `${member.displayName}的智能体`,
          summary: `可在企业授权范围内代表 ${member.displayName} 提供工作协助。`,
          status: member.active && plan.versionPublished ? 'ONLINE' : 'OFFLINE',
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
        status: plan.versionPublished ? 'ONLINE' : 'OFFLINE',
        settings: { visibility: 'tenant', provisionedBy: 'feishu-directory' },
      },
      select: { id: true, key: true, ownerUserId: true },
    });
    plan.agentsByOwner.set(member.userId, agent);
  }
}

function personalAgentRoleDefinition() {
  return {
    mission: '在成员授权范围内提供可追溯、安全且高质量的日常工作协助。',
    responsibilities: [
      {
        key: 'member-assistance',
        name: '成员工作协助',
        description: '根据成员权限、企业知识和已批准工具协助处理日常工作。',
        outcomes: ['输出可验证且不越权的工作结果。'],
      },
    ],
    valueDefinition: {
      statement: '在不突破权限和安全边界的前提下提升成员工作效率。',
      stakeholderOutcomes: ['成员获得可靠、可追溯的工作协助。'],
      measures: ['评测门禁通过率', '引用完整率', '越权事件数'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  };
}
