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
  createObjectiveRelationRequestSchema,
  createObjectiveRequestSchema,
  transitionObjectiveRelationRequestSchema,
  transitionObjectiveRequestSchema,
  updateObjectiveRelationRequestSchema,
  updateObjectiveRequestSchema,
  type CreateObjectiveRelationRequest,
  type CreateObjectiveRequest,
  type Objective,
  type ObjectiveRelation,
  type TransitionObjectiveRelationRequest,
  type TransitionObjectiveRequest,
  type UpdateObjectiveRelationRequest,
  type UpdateObjectiveRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ObjectiveAdminService } from './objective-admin.service.js';
import { ObjectiveRelationAdminService } from './objective-relation-admin.service.js';

@Controller('admin/business-semantics/objectives/relations')
export class ObjectiveRelationAdminController {
  constructor(
    @Inject(ObjectiveRelationAdminService)
    private readonly relations: ObjectiveRelationAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: ObjectiveRelation[] }> {
    return this.relations.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createObjectiveRelationRequestSchema))
    request: CreateObjectiveRelationRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ObjectiveRelation> {
    return this.relations.create(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateObjectiveRelationRequestSchema))
    request: UpdateObjectiveRelationRequest,
  ): Promise<ObjectiveRelation> {
    return this.relations.update(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionObjectiveRelationRequestSchema))
    request: TransitionObjectiveRelationRequest,
  ): Promise<ObjectiveRelation> {
    return this.relations.transition(id, request);
  }
}

@Controller('admin/business-semantics/objectives')
export class ObjectiveAdminController {
  constructor(
    @Inject(ObjectiveAdminService)
    private readonly semantics: ObjectiveAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: Objective[] }> {
    return this.semantics.listObjectives();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createObjectiveRequestSchema))
    request: CreateObjectiveRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Objective> {
    return this.semantics.createObjective(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateObjectiveRequestSchema))
    request: UpdateObjectiveRequest,
  ): Promise<Objective> {
    return this.semantics.updateObjective(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionObjectiveRequestSchema))
    request: TransitionObjectiveRequest,
  ): Promise<Objective> {
    return this.semantics.transitionObjective(id, request);
  }
}
