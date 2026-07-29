import { Injectable } from '@nestjs/common';

import type { MemberAgent } from '../../domain/agent.models.js';
import { AgentRepository } from '../../domain/agent.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';

/** Development seed adapter. Production runtimes plug in behind AgentRepository. */
@Injectable()
export class DevAgentRepository extends AgentRepository {
  private readonly agents: readonly MemberAgent[] = [
    {
      id: '00000000-0000-7000-8000-000000000301',
      tenantId: TENANT_ID,
      ownerUserId: '00000000-0000-7000-8000-000000000101',
      name: '林晓的产品助手',
      status: 'online',
      versionStatus: 'published',
      visibility: 'tenant',
      assignedToPrincipal: false,
      requiresActiveAssignment: false,
      summary: '可协助查询产品路线、需求背景和会议结论。',
    },
    {
      id: '00000000-0000-7000-8000-000000000302',
      tenantId: TENANT_ID,
      ownerUserId: '00000000-0000-7000-8000-000000000102',
      name: '周睿的研发助手',
      status: 'online',
      versionStatus: 'published',
      visibility: 'tenant',
      assignedToPrincipal: false,
      requiresActiveAssignment: false,
      summary: '可协助定位系统模块、接口约定和研发进度。',
    },
  ];

  async listMemberAgents(
    tenantId: string,
    _principalUserId: string,
  ): Promise<readonly MemberAgent[]> {
    return this.agents.filter((agent) => agent.tenantId === tenantId);
  }
}
