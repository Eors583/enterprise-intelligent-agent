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
  createMetricDefinitionRequestSchema,
  createMetricObservationRequestSchema,
  transitionMetricDefinitionRequestSchema,
  updateMetricDefinitionRequestSchema,
  updateMetricObservationRequestSchema,
  type CreateMetricDefinitionRequest,
  type CreateMetricObservationRequest,
  type MetricDefinition,
  type MetricObservation,
  type TransitionMetricDefinitionRequest,
  type UpdateMetricDefinitionRequest,
  type UpdateMetricObservationRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { MetricAdminService } from './metric-admin.service.js';
import { MetricObservationAdminService } from './metric-observation-admin.service.js';

@Controller('admin/business-semantics/metrics/observations')
export class MetricObservationAdminController {
  constructor(
    @Inject(MetricObservationAdminService)
    private readonly observations: MetricObservationAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: MetricObservation[] }> {
    return this.observations.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createMetricObservationRequestSchema))
    request: CreateMetricObservationRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MetricObservation> {
    return this.observations.create(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMetricObservationRequestSchema))
    request: UpdateMetricObservationRequest,
  ): Promise<MetricObservation> {
    return this.observations.update(id, request);
  }
}

@Controller('admin/business-semantics/metrics')
export class MetricAdminController {
  constructor(
    @Inject(MetricAdminService)
    private readonly semantics: MetricAdminService,
  ) {}

  @Get()
  list(): Promise<{ items: MetricDefinition[] }> {
    return this.semantics.listMetrics();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createMetricDefinitionRequestSchema))
    request: CreateMetricDefinitionRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MetricDefinition> {
    return this.semantics.createMetric(request, idempotencyKey);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMetricDefinitionRequestSchema))
    request: UpdateMetricDefinitionRequest,
  ): Promise<MetricDefinition> {
    return this.semantics.updateMetric(id, request);
  }

  @Post(':id/transition')
  transition(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionMetricDefinitionRequestSchema))
    request: TransitionMetricDefinitionRequest,
  ): Promise<MetricDefinition> {
    return this.semantics.transitionMetric(id, request);
  }
}
