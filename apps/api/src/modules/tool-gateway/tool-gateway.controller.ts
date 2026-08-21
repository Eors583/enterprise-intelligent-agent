import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  createToolCompensationRequestSchema,
  createToolDefinitionRequestSchema,
  createToolInvocationRequestSchema,
  createToolVersionRequestSchema,
  toolInvocationDecisionRequestSchema,
  toolVersionLifecycleRequestSchema,
  type CreateToolDefinitionRequest,
  type CreateToolCompensationRequest,
  type CreateToolInvocationRequest,
  type CreateToolVersionRequest,
  type ToolDefinition,
  type ToolDefinitionDetail,
  type ToolDefinitionListResponse,
  type ToolInvocation,
  type ToolInvocationDecisionRequest,
  type ToolInvocationListResponse,
  type ToolReconciliationStatus,
  type ToolVersion,
  type ToolVersionLifecycleRequest,
  type AvailableToolListResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ToolGatewayService } from './tool-gateway.service.js';
import { ToolReconciliationStatusService } from './application/tool-reconciliation-status.service.js';

@Controller('admin/tool-definitions')
export class AdminToolGatewayController {
  constructor(
    @Inject(ToolGatewayService)
    private readonly gateway: ToolGatewayService,
  ) {}

  @Get()
  list(@Query('cursor') cursor?: string): Promise<ToolDefinitionListResponse> {
    return this.gateway.listDefinitions(cursor);
  }

  @Get(':toolId')
  get(@Param('toolId', new ParseUUIDPipe()) toolId: string): Promise<ToolDefinitionDetail> {
    return this.gateway.getDefinition(toolId);
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createToolDefinitionRequestSchema))
    request: CreateToolDefinitionRequest,
  ): Promise<ToolDefinition> {
    return this.gateway.createDefinition(request);
  }

  @Post(':toolId/versions')
  createVersion(
    @Param('toolId', new ParseUUIDPipe()) toolId: string,
    @Body(new SchemaValidationPipe(createToolVersionRequestSchema))
    request: CreateToolVersionRequest,
  ): Promise<ToolVersion> {
    return this.gateway.createVersion(toolId, request);
  }

  @Post(':toolId/versions/:toolVersionId/lifecycle')
  transitionVersion(
    @Param('toolId', new ParseUUIDPipe()) toolId: string,
    @Param('toolVersionId', new ParseUUIDPipe()) toolVersionId: string,
    @Body(new SchemaValidationPipe(toolVersionLifecycleRequestSchema))
    request: ToolVersionLifecycleRequest,
  ): Promise<ToolDefinitionDetail> {
    return this.gateway.transitionVersion(toolId, toolVersionId, request);
  }
}

@Controller('workbench/tool-invocations')
export class WorkbenchToolGatewayController {
  constructor(
    @Inject(ToolGatewayService)
    private readonly gateway: ToolGatewayService,
  ) {}

  @Get()
  list(@Query('cursor') cursor?: string): Promise<ToolInvocationListResponse> {
    return this.gateway.listInvocations(cursor);
  }

  @Get(':invocationId')
  get(@Param('invocationId', new ParseUUIDPipe()) invocationId: string): Promise<ToolInvocation> {
    return this.gateway.getInvocation(invocationId);
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createToolInvocationRequestSchema))
    request: CreateToolInvocationRequest,
  ): Promise<ToolInvocation> {
    return this.gateway.createInvocation(request);
  }

  @Post(':invocationId/actions')
  decide(
    @Param('invocationId', new ParseUUIDPipe()) invocationId: string,
    @Body(new SchemaValidationPipe(toolInvocationDecisionRequestSchema))
    request: ToolInvocationDecisionRequest,
  ): Promise<ToolInvocation> {
    return this.gateway.decideInvocation(invocationId, request);
  }

  @Post(':invocationId/compensations')
  compensate(
    @Param('invocationId', new ParseUUIDPipe()) invocationId: string,
    @Body(new SchemaValidationPipe(createToolCompensationRequestSchema))
    request: CreateToolCompensationRequest,
  ): Promise<ToolInvocation> {
    return this.gateway.createCompensation(invocationId, request);
  }
}

@Controller('workbench/tool-invocations')
export class WorkbenchToolReconciliationController {
  constructor(
    @Inject(ToolReconciliationStatusService)
    private readonly reconciliation: ToolReconciliationStatusService,
  ) {}

  @Get(':invocationId/reconciliation')
  get(
    @Param('invocationId', new ParseUUIDPipe()) invocationId: string,
  ): Promise<ToolReconciliationStatus> {
    return this.reconciliation.get(invocationId);
  }
}

@Controller('workbench/tools')
export class WorkbenchAvailableToolsController {
  constructor(
    @Inject(ToolGatewayService)
    private readonly gateway: ToolGatewayService,
  ) {}

  @Get()
  list(@Query('taskId', new ParseUUIDPipe()) taskId: string): Promise<AvailableToolListResponse> {
    return this.gateway.listAvailableTools(taskId);
  }
}

@Controller('workbench/tool-approvals')
export class WorkbenchToolApprovalsController {
  constructor(
    @Inject(ToolGatewayService)
    private readonly gateway: ToolGatewayService,
  ) {}

  @Get()
  list(@Query('taskId', new ParseUUIDPipe()) taskId: string): Promise<ToolInvocationListResponse> {
    return this.gateway.listReviewableInvocations(taskId);
  }
}
