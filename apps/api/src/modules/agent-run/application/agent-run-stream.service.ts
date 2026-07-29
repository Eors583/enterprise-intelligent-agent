import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AgentRunStreamPage } from '@enterprise/contracts';

import { AgentRunStreamRepository } from '../domain/agent-run-stream.repository.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { IdentityService } from '../../identity/application/identity.service.js';

@Injectable()
export class AgentRunStreamService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(AgentRunStreamRepository)
    private readonly streams: AgentRunStreamRepository,
  ) {}

  async list(
    conversationId: string,
    runId: string,
    cursor: number,
    limit = 128,
  ): Promise<AgentRunStreamPage> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.read',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'LOW',
    });
    const page = await this.streams.listForParticipant({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId,
      runId,
      cursor,
      limit: Math.min(256, Math.max(1, limit)),
    });
    if (page === null) {
      // Cross-tenant, non-participant, wrong-conversation, and missing Runs
      // deliberately share the same default-deny response.
      throw new NotFoundException('Agent Run stream was not found.');
    }
    return page;
  }
}
