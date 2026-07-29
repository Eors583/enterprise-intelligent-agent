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
  createAcceptanceRequestSchema,
  createDeliverableRequestSchema,
  transitionAcceptanceRequestSchema,
  transitionDeliverableRequestSchema,
  updateAcceptanceRequestSchema,
  updateDeliverableRequestSchema,
  type Acceptance,
  type CreateAcceptanceRequest,
  type CreateDeliverableRequest,
  type Deliverable,
  type TransitionAcceptanceRequest,
  type TransitionDeliverableRequest,
  type UpdateAcceptanceRequest,
  type UpdateDeliverableRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { DeliverableAcceptanceAdminService } from './deliverable-acceptance-admin.service.js';

@Controller('admin/business-semantics/tasks/:taskId/deliverables')
export class DeliverableAcceptanceAdminController {
  constructor(
    @Inject(DeliverableAcceptanceAdminService)
    private readonly artifacts: DeliverableAcceptanceAdminService,
  ) {}

  @Get()
  listDeliverables(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<{ items: Deliverable[] }> {
    return this.artifacts.listDeliverables(taskId);
  }

  @Post()
  createDeliverable(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaValidationPipe(createDeliverableRequestSchema))
    request: CreateDeliverableRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Deliverable> {
    return this.artifacts.createDeliverable(taskId, request, idempotencyKey);
  }

  @Patch(':deliverableId')
  updateDeliverable(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(updateDeliverableRequestSchema))
    request: UpdateDeliverableRequest,
  ): Promise<Deliverable> {
    return this.artifacts.updateDeliverable(taskId, deliverableId, request);
  }

  @Post(':deliverableId/transition')
  transitionDeliverable(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(transitionDeliverableRequestSchema))
    request: TransitionDeliverableRequest,
  ): Promise<Deliverable> {
    return this.artifacts.transitionDeliverable(taskId, deliverableId, request);
  }

  @Get(':deliverableId/acceptances')
  listAcceptances(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
  ): Promise<{ items: Acceptance[] }> {
    return this.artifacts.listAcceptances(taskId, deliverableId);
  }

  @Post(':deliverableId/acceptances')
  createAcceptance(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Body(new SchemaValidationPipe(createAcceptanceRequestSchema))
    request: CreateAcceptanceRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Acceptance> {
    return this.artifacts.createAcceptance(taskId, deliverableId, request, idempotencyKey);
  }

  @Patch(':deliverableId/acceptances/:acceptanceId')
  updateAcceptance(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Param('acceptanceId', new ParseUUIDPipe()) acceptanceId: string,
    @Body(new SchemaValidationPipe(updateAcceptanceRequestSchema))
    request: UpdateAcceptanceRequest,
  ): Promise<Acceptance> {
    return this.artifacts.updateAcceptance(taskId, deliverableId, acceptanceId, request);
  }

  @Post(':deliverableId/acceptances/:acceptanceId/transition')
  transitionAcceptance(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('deliverableId', new ParseUUIDPipe()) deliverableId: string,
    @Param('acceptanceId', new ParseUUIDPipe()) acceptanceId: string,
    @Body(new SchemaValidationPipe(transitionAcceptanceRequestSchema))
    request: TransitionAcceptanceRequest,
  ): Promise<Acceptance> {
    return this.artifacts.transitionAcceptance(taskId, deliverableId, acceptanceId, request);
  }
}
