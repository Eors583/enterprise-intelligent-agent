import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  processCommandSchema,
  processStepCommandSchema,
  type ProcessCommand,
  type ProcessInstance,
  type ProcessInstanceDetailResponse,
  type ProcessInstanceListResponse,
  type ProcessStepCommand,
  type ProcessStepInstance,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

@Controller('admin/process-runtime')
export class ProcessRuntimeController {
  constructor(
    @Inject(ProcessRuntimeService)
    private readonly runtime: ProcessRuntimeService,
  ) {}

  @Get('instances')
  listInstances(@Query('cursor') cursor?: string): Promise<ProcessInstanceListResponse> {
    return this.runtime.listInstances(cursor);
  }

  @Get('instances/:instanceId')
  getInstance(
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
  ): Promise<ProcessInstanceDetailResponse> {
    return this.runtime.getInstance(instanceId);
  }

  @Post('instances/:instanceId/commands')
  executeProcessCommand(
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Body(new SchemaValidationPipe(processCommandSchema))
    command: ProcessCommand,
  ): Promise<ProcessInstance> {
    return this.runtime.executeProcessCommand(instanceId, command);
  }

  @Post('instances/:instanceId/steps/:stepId/commands')
  executeStepCommand(
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Param('stepId', new ParseUUIDPipe()) stepId: string,
    @Body(new SchemaValidationPipe(processStepCommandSchema))
    command: ProcessStepCommand,
  ): Promise<ProcessStepInstance> {
    return this.runtime.executeStepCommand(instanceId, stepId, command);
  }
}
