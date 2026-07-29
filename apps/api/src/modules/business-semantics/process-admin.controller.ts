import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createProcessDefinitionRequestSchema,
  createProcessVersionRequestSchema,
  transitionProcessVersionRequestSchema,
  updateProcessDefinitionRequestSchema,
  updateProcessVersionRequestSchema,
  type CreateProcessDefinitionRequest,
  type CreateProcessVersionRequest,
  type ProcessDefinition,
  type ProcessVersion,
  type TransitionProcessVersionRequest,
  type UpdateProcessDefinitionRequest,
  type UpdateProcessVersionRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ProcessAdminService } from './process-admin.service.js';

@Controller('admin/business-semantics/processes')
export class ProcessAdminController {
  constructor(
    @Inject(ProcessAdminService)
    private readonly semantics: ProcessAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: ProcessDefinition[] }> {
    return this.semantics.listProcesses();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createProcessDefinitionRequestSchema))
    request: CreateProcessDefinitionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ProcessDefinition> {
    return this.semantics.createProcess(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateProcessDefinitionRequestSchema))
    request: UpdateProcessDefinitionRequest,
  ): Promise<ProcessDefinition> {
    return this.semantics.updateProcess(id, request);
  }

  @Post(':definitionId/versions')
  createVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Body(new SchemaValidationPipe(createProcessVersionRequestSchema))
    request: CreateProcessVersionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ProcessVersion> {
    return this.semantics.createProcessVersion(definitionId, request, idempotencyKey);
  }

  @Patch(':definitionId/versions/:versionId')
  updateVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(updateProcessVersionRequestSchema))
    request: UpdateProcessVersionRequest,
  ): Promise<ProcessVersion> {
    return this.semantics.updateProcessVersion(definitionId, versionId, request);
  }

  @Post(':definitionId/versions/:versionId/transition')
  transitionVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(transitionProcessVersionRequestSchema))
    request: TransitionProcessVersionRequest,
  ): Promise<ProcessVersion> {
    return this.semantics.transitionProcessVersion(definitionId, versionId, request);
  }
}
