import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  aiModelRoutingListQuerySchema,
  createAiModelConnectivityProbeRequestSchema,
  createAiModelCatalogVersionRequestSchema,
  createAiModelRoutePolicyVersionRequestSchema,
  transitionAiGovernanceVersionRequestSchema,
  type AiModelRoutingListQuery,
  type CreateAiModelConnectivityProbeRequest,
  type CreateAiModelCatalogVersionRequest,
  type CreateAiModelRoutePolicyVersionRequest,
  type TransitionAiGovernanceVersionRequest,
} from '@enterprise/contracts';

import { AiSafetyModelRoutingService } from './ai-safety-model-routing.service.js';
import { AiModelConnectivityProbeService } from './ai-model-connectivity-probe.service.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';

@Controller('admin/ai-model-routing')
export class AiSafetyModelRoutingController {
  constructor(
    @Inject(AiSafetyModelRoutingService)
    private readonly routing: AiSafetyModelRoutingService,
    @Inject(AiModelConnectivityProbeService)
    private readonly connectivityProbe: AiModelConnectivityProbeService,
  ) {}

  @Get()
  dashboard(
    @Query(new SchemaValidationPipe(aiModelRoutingListQuerySchema))
    query: AiModelRoutingListQuery,
  ) {
    return this.routing.dashboard(query);
  }

  @Post('connectivity-probes')
  runConnectivityProbe(
    @Body(new SchemaValidationPipe(createAiModelConnectivityProbeRequestSchema))
    request: CreateAiModelConnectivityProbeRequest,
  ) {
    return this.connectivityProbe.run(request);
  }

  @Post('catalog-versions')
  createCatalogVersion(
    @Body(new SchemaValidationPipe(createAiModelCatalogVersionRequestSchema))
    request: CreateAiModelCatalogVersionRequest,
  ) {
    return this.routing.createCatalogVersion(request);
  }

  @Post('catalog-versions/:id/transitions')
  transitionCatalogVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionAiGovernanceVersionRequestSchema))
    request: TransitionAiGovernanceVersionRequest,
  ) {
    return this.routing.transitionCatalogVersion(id, request);
  }

  @Post('route-policy-versions')
  createRoutePolicyVersion(
    @Body(new SchemaValidationPipe(createAiModelRoutePolicyVersionRequestSchema))
    request: CreateAiModelRoutePolicyVersionRequest,
  ) {
    return this.routing.createRoutePolicyVersion(request);
  }

  @Post('route-policy-versions/:id/transitions')
  transitionRoutePolicyVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionAiGovernanceVersionRequestSchema))
    request: TransitionAiGovernanceVersionRequest,
  ) {
    return this.routing.transitionRoutePolicyVersion(id, request);
  }
}
