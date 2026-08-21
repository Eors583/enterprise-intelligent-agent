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
  createValueDefinitionRequestSchema,
  createValueVersionRequestSchema,
  transitionValueVersionRequestSchema,
  updateValueDefinitionRequestSchema,
  updateValueVersionRequestSchema,
  type CreateValueDefinitionRequest,
  type CreateValueVersionRequest,
  type TransitionValueVersionRequest,
  type UpdateValueDefinitionRequest,
  type UpdateValueVersionRequest,
  type ValueDefinition,
  type ValueVersion,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { ValueAdminService } from './value-admin.service.js';

@Controller('admin/business-semantics/values')
export class ValueAdminController {
  constructor(
    @Inject(ValueAdminService)
    private readonly semantics: ValueAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: ValueDefinition[] }> {
    return this.semantics.listValues();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createValueDefinitionRequestSchema))
    request: CreateValueDefinitionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ValueDefinition> {
    return this.semantics.createValue(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateValueDefinitionRequestSchema))
    request: UpdateValueDefinitionRequest,
  ): Promise<ValueDefinition> {
    return this.semantics.updateValue(id, request);
  }

  @Post(':definitionId/versions')
  createVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Body(new SchemaValidationPipe(createValueVersionRequestSchema))
    request: CreateValueVersionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ValueVersion> {
    return this.semantics.createValueVersion(definitionId, request, idempotencyKey);
  }

  @Patch(':definitionId/versions/:versionId')
  updateVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(updateValueVersionRequestSchema))
    request: UpdateValueVersionRequest,
  ): Promise<ValueVersion> {
    return this.semantics.updateValueVersion(definitionId, versionId, request);
  }

  @Post(':definitionId/versions/:versionId/transition')
  transitionVersion(
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(transitionValueVersionRequestSchema))
    request: TransitionValueVersionRequest,
  ): Promise<ValueVersion> {
    return this.semantics.transitionValueVersion(definitionId, versionId, request);
  }
}
