import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createMarketingActionItemContributorRequestSchema,
  createMarketingActionItemDependencyRequestSchema,
  createMarketingActionItemRequestSchema,
  createMarketingActionPlanRequestSchema,
  createMarketingInsightRequestSchema,
  createMarketingMasterDataRequestSchema,
  createMarketingObservationRequestSchema,
  createMarketingTargetRequestSchema,
  transitionMarketingActionItemRequestSchema,
  transitionMarketingActionPlanRequestSchema,
  transitionMarketingInsightRequestSchema,
  transitionMarketingTargetRequestSchema,
  updateMarketingMasterDataRequestSchema,
  type CreateMarketingActionItemContributorRequest,
  type CreateMarketingActionItemDependencyRequest,
  type CreateMarketingActionItemRequest,
  type CreateMarketingActionPlanRequest,
  type CreateMarketingInsightRequest,
  type CreateMarketingMasterDataRequest,
  type CreateMarketingObservationRequest,
  type CreateMarketingTargetRequest,
  type TransitionMarketingActionItemRequest,
  type TransitionMarketingActionPlanRequest,
  type TransitionMarketingInsightRequest,
  type TransitionMarketingTargetRequest,
  type UpdateMarketingMasterDataRequest,
} from '@enterprise/contracts';

import { MarketingEvidenceService } from './marketing-evidence.service.js';
import {
  MarketingMasterDataService,
  type MarketingMasterDataKind,
} from './marketing-master-data.service.js';
import { MarketingPlanningService } from './marketing-planning.service.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';

@Controller('admin/marketing')
export class MarketingManagementController {
  constructor(
    @Inject(MarketingEvidenceService)
    private readonly evidence: MarketingEvidenceService,
    @Inject(MarketingMasterDataService)
    private readonly masterData: MarketingMasterDataService,
    @Inject(MarketingPlanningService)
    private readonly planning: MarketingPlanningService,
  ) {}

  @Get('observations')
  listObservations() {
    return this.evidence.listObservations();
  }

  @Post('observations')
  createObservation(
    @Body(new SchemaValidationPipe(createMarketingObservationRequestSchema))
    request: CreateMarketingObservationRequest,
  ) {
    return this.evidence.createObservation(request);
  }

  @Get('insights')
  listInsights() {
    return this.evidence.listInsights();
  }

  @Post('insights')
  createInsight(
    @Body(new SchemaValidationPipe(createMarketingInsightRequestSchema))
    request: CreateMarketingInsightRequest,
  ) {
    return this.evidence.createInsight(request);
  }

  @Post('insights/:id/transition')
  transitionInsight(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionMarketingInsightRequestSchema))
    request: TransitionMarketingInsightRequest,
  ) {
    return this.evidence.transitionInsight(id, request);
  }

  @Get('products')
  listProducts() {
    return this.masterData.list('PRODUCT');
  }

  @Post('products')
  createProduct(
    @Body(new SchemaValidationPipe(createMarketingMasterDataRequestSchema))
    request: CreateMarketingMasterDataRequest,
  ) {
    return this.masterData.create('PRODUCT', request);
  }

  @Patch('products/:id')
  updateProduct(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMarketingMasterDataRequestSchema))
    request: UpdateMarketingMasterDataRequest,
  ) {
    return this.masterData.update('PRODUCT', id, request);
  }

  @Get('regions')
  listRegions() {
    return this.masterData.list('REGION');
  }

  @Post('regions')
  createRegion(
    @Body(new SchemaValidationPipe(createMarketingMasterDataRequestSchema))
    request: CreateMarketingMasterDataRequest,
  ) {
    return this.masterData.create('REGION', request);
  }

  @Patch('regions/:id')
  updateRegion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMarketingMasterDataRequestSchema))
    request: UpdateMarketingMasterDataRequest,
  ) {
    return this.masterData.update('REGION', id, request);
  }

  @Get('customer-segments')
  listSegments() {
    return this.masterData.list('CUSTOMER_SEGMENT');
  }

  @Post('customer-segments')
  createSegment(
    @Body(new SchemaValidationPipe(createMarketingMasterDataRequestSchema))
    request: CreateMarketingMasterDataRequest,
  ) {
    return this.masterData.create('CUSTOMER_SEGMENT', request);
  }

  @Patch('customer-segments/:id')
  updateSegment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMarketingMasterDataRequestSchema))
    request: UpdateMarketingMasterDataRequest,
  ) {
    return this.masterData.update('CUSTOMER_SEGMENT', id, request);
  }

  @Get('targets')
  listTargets() {
    return this.planning.listTargets();
  }

  @Post('targets')
  createTarget(
    @Body(new SchemaValidationPipe(createMarketingTargetRequestSchema))
    request: CreateMarketingTargetRequest,
  ) {
    return this.planning.createTarget(request);
  }

  @Post('targets/:id/transition')
  transitionTarget(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionMarketingTargetRequestSchema))
    request: TransitionMarketingTargetRequest,
  ) {
    return this.planning.transitionTarget(id, request);
  }

  @Get('action-plans')
  listPlans() {
    return this.planning.listPlans();
  }

  @Post('action-plans')
  createPlan(
    @Body(new SchemaValidationPipe(createMarketingActionPlanRequestSchema))
    request: CreateMarketingActionPlanRequest,
  ) {
    return this.planning.createPlan(request);
  }

  @Post('action-plans/:id/transition')
  transitionPlan(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionMarketingActionPlanRequestSchema))
    request: TransitionMarketingActionPlanRequest,
  ) {
    return this.planning.transitionPlan(id, request);
  }

  @Post('action-plans/:id/items')
  createItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(createMarketingActionItemRequestSchema))
    request: CreateMarketingActionItemRequest,
  ) {
    return this.planning.createItem(id, request);
  }

  @Post('action-items/:id/transition')
  transitionItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(transitionMarketingActionItemRequestSchema))
    request: TransitionMarketingActionItemRequest,
  ) {
    return this.planning.transitionItem(id, request);
  }

  @Post('action-items/:id/contributors')
  addContributor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(createMarketingActionItemContributorRequestSchema))
    request: CreateMarketingActionItemContributorRequest,
  ) {
    return this.planning.addContributor(id, request);
  }

  @Post('action-plans/:id/dependencies')
  createDependency(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(createMarketingActionItemDependencyRequestSchema))
    request: CreateMarketingActionItemDependencyRequest,
  ) {
    return this.planning.createDependency(id, request);
  }
}

export const MARKETING_MASTER_DATA_KINDS: readonly MarketingMasterDataKind[] = [
  'PRODUCT',
  'REGION',
  'CUSTOMER_SEGMENT',
];
