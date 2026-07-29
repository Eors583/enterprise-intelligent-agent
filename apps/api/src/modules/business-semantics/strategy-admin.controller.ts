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
  createStrategyRequestSchema,
  transitionStrategyRequestSchema,
  updateStrategyRequestSchema,
  type CreateStrategyRequest,
  type Strategy,
  type TransitionStrategyRequest,
  type UpdateStrategyRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { StrategyAdminService } from './strategy-admin.service.js';

@Controller('admin/business-semantics/strategies')
export class StrategyAdminController {
  constructor(
    @Inject(StrategyAdminService)
    private readonly semantics: StrategyAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: Strategy[] }> {
    return this.semantics.listStrategies();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createStrategyRequestSchema))
    request: CreateStrategyRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Strategy> {
    return this.semantics.createStrategy(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateStrategyRequestSchema))
    request: UpdateStrategyRequest,
  ): Promise<Strategy> {
    return this.semantics.updateStrategy(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionStrategyRequestSchema))
    request: TransitionStrategyRequest,
  ): Promise<Strategy> {
    return this.semantics.transitionStrategy(id, request);
  }
}
