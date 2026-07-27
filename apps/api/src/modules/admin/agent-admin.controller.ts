import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  type AdminAgent,
  type AdminAgentListResponse,
  type AdminAgentUsageSummary,
  type AgentRunResponse,
  type AgentUsageLimits,
  type UpdateAgentUsageLimitsRequest,
  type UpdateAdminAgentRequest,
  updateAdminAgentRequestSchema,
  updateAgentUsageLimitsRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { AgentRunControlService } from '../agent-run/application/agent-run-control.service.js';
import { AdminAccessService } from './admin-access.service.js';
import { AgentAdminService } from './agent-admin.service.js';

@Controller('admin/agents')
export class AgentAdminController {
  constructor(
    @Inject(AgentAdminService) private readonly agents: AgentAdminService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(AgentRunControlService) private readonly runs: AgentRunControlService,
  ) {}

  @Get()
  list(): Promise<AdminAgentListResponse> {
    return this.agents.list();
  }

  @Get('usage-summary')
  usageSummary(): Promise<AdminAgentUsageSummary> {
    return this.agents.usageSummary();
  }

  @Patch('usage-limits')
  updateUsageLimits(
    @Body(new SchemaValidationPipe(updateAgentUsageLimitsRequestSchema))
    request: UpdateAgentUsageLimitsRequest,
  ): Promise<AgentUsageLimits> {
    return this.agents.updateUsageLimits(request);
  }

  @Post('runs/:runId/reconcile')
  reconcileUnknown(@Param('runId', new ParseUUIDPipe()) runId: string): Promise<AgentRunResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.runs.reconcileUnknown(principal.tenantId, principal.userId, runId);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateAdminAgentRequestSchema)) request: UpdateAdminAgentRequest,
  ): Promise<AdminAgent> {
    return this.agents.update(id, request);
  }
}
