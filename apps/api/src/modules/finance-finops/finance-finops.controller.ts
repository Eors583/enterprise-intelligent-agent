import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  acknowledgeFinopsAlertRequestSchema,
  approveFinopsAllocationRuleRequestSchema,
  approveFinopsBudgetRequestSchema,
  approveFinopsPriceSnapshotRequestSchema,
  approveFinopsRoiFormulaVersionRequestSchema,
  createFinopsAllocationRuleRequestSchema,
  createFinopsAllocationSetRequestSchema,
  createFinopsBenefitClaimRequestSchema,
  createFinopsBudgetEventRequestSchema,
  createFinopsBudgetRequestSchema,
  createFinopsDimensionMemberRequestSchema,
  createFinopsPriceSnapshotRequestSchema,
  createFinopsRoiFormulaVersionRequestSchema,
  createFinopsRoutingSuggestionRequestSchema,
  decideFinopsRoutingSuggestionRequestSchema,
  finopsDashboardQuerySchema,
  recomputeFinopsRoiRequestSchema,
  recordFinopsCostRequestSchema,
  reviewFinopsCostRequestSchema,
  reviewFinopsAllocationSetRequestSchema,
  reviewFinopsBenefitClaimRequestSchema,
  type AcknowledgeFinopsAlertRequest,
  type ApproveFinopsAllocationRuleRequest,
  type ApproveFinopsBudgetRequest,
  type ApproveFinopsPriceSnapshotRequest,
  type ApproveFinopsRoiFormulaVersionRequest,
  type CreateFinopsAllocationRuleRequest,
  type CreateFinopsAllocationSetRequest,
  type CreateFinopsBenefitClaimRequest,
  type CreateFinopsBudgetEventRequest,
  type CreateFinopsBudgetRequest,
  type CreateFinopsDimensionMemberRequest,
  type CreateFinopsPriceSnapshotRequest,
  type CreateFinopsRoiFormulaVersionRequest,
  type CreateFinopsRoutingSuggestionRequest,
  type DecideFinopsRoutingSuggestionRequest,
  type RecomputeFinopsRoiRequest,
  type RecordFinopsCostRequest,
  type ReviewFinopsCostRequest,
  type ReviewFinopsAllocationSetRequest,
  type ReviewFinopsBenefitClaimRequest,
} from '@enterprise/contracts';

import { FinopsCatalogService } from './finops-catalog.service.js';
import { FinopsGovernanceService } from './finops-governance.service.js';
import { FinopsLedgerService } from './finops-ledger.service.js';
import { FinopsQueryService } from './finops-query.service.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';

@Controller('admin/finops')
export class FinanceFinopsController {
  constructor(
    @Inject(FinopsQueryService) private readonly query: FinopsQueryService,
    @Inject(FinopsCatalogService) private readonly catalog: FinopsCatalogService,
    @Inject(FinopsLedgerService) private readonly ledger: FinopsLedgerService,
    @Inject(FinopsGovernanceService)
    private readonly governance: FinopsGovernanceService,
  ) {}

  @Get('dashboard')
  dashboard(
    @Query(new SchemaValidationPipe(finopsDashboardQuerySchema))
    query: {
      readonly currency: string;
    },
  ) {
    return this.query.dashboard(query.currency);
  }

  @Post('price-snapshots')
  createPrice(
    @Body(new SchemaValidationPipe(createFinopsPriceSnapshotRequestSchema))
    request: CreateFinopsPriceSnapshotRequest,
  ) {
    return this.catalog.createPrice(request);
  }

  @Post('price-snapshots/:id/review')
  approvePrice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(approveFinopsPriceSnapshotRequestSchema))
    request: ApproveFinopsPriceSnapshotRequest,
  ) {
    return this.catalog.approvePrice(id, request);
  }

  @Post('allocation-rules')
  createAllocationRule(
    @Body(new SchemaValidationPipe(createFinopsAllocationRuleRequestSchema))
    request: CreateFinopsAllocationRuleRequest,
  ) {
    return this.catalog.createAllocationRule(request);
  }

  @Post('allocation-rules/:id/review')
  approveAllocationRule(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(approveFinopsAllocationRuleRequestSchema))
    request: ApproveFinopsAllocationRuleRequest,
  ) {
    return this.catalog.approveAllocationRule(id, request);
  }

  @Post('dimension-members')
  createDimensionMember(
    @Body(new SchemaValidationPipe(createFinopsDimensionMemberRequestSchema))
    request: CreateFinopsDimensionMemberRequest,
  ) {
    return this.catalog.createDimensionMember(request);
  }

  @Post('cost-entries')
  recordCost(
    @Body(new SchemaValidationPipe(recordFinopsCostRequestSchema))
    request: RecordFinopsCostRequest,
  ) {
    return this.ledger.recordCost(request);
  }

  @Post('cost-entries/:id/review')
  reviewCost(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(reviewFinopsCostRequestSchema))
    request: ReviewFinopsCostRequest,
  ) {
    return this.ledger.reviewCost(id, request);
  }

  @Post('allocation-sets')
  createAllocation(
    @Body(new SchemaValidationPipe(createFinopsAllocationSetRequestSchema))
    request: CreateFinopsAllocationSetRequest,
  ) {
    return this.ledger.createAllocation(request);
  }

  @Post('allocation-sets/:id/review')
  reviewAllocation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(reviewFinopsAllocationSetRequestSchema))
    request: ReviewFinopsAllocationSetRequest,
  ) {
    return this.ledger.reviewAllocation(id, request);
  }

  @Post('benefit-claims')
  createBenefit(
    @Body(new SchemaValidationPipe(createFinopsBenefitClaimRequestSchema))
    request: CreateFinopsBenefitClaimRequest,
  ) {
    return this.ledger.createBenefit(request);
  }

  @Post('benefit-claims/:id/review')
  reviewBenefit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(reviewFinopsBenefitClaimRequestSchema))
    request: ReviewFinopsBenefitClaimRequest,
  ) {
    return this.ledger.reviewBenefit(id, request);
  }

  @Post('roi-formulas')
  createRoiFormula(
    @Body(new SchemaValidationPipe(createFinopsRoiFormulaVersionRequestSchema))
    request: CreateFinopsRoiFormulaVersionRequest,
  ) {
    return this.catalog.createRoiFormula(request);
  }

  @Post('roi-formulas/:id/review')
  approveRoiFormula(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(approveFinopsRoiFormulaVersionRequestSchema))
    request: ApproveFinopsRoiFormulaVersionRequest,
  ) {
    return this.catalog.approveRoiFormula(id, request);
  }

  @Post('roi/recompute')
  recomputeRoi(
    @Body(new SchemaValidationPipe(recomputeFinopsRoiRequestSchema))
    request: RecomputeFinopsRoiRequest,
  ) {
    return this.governance.recomputeRoi(request);
  }

  @Post('budgets')
  createBudget(
    @Body(new SchemaValidationPipe(createFinopsBudgetRequestSchema))
    request: CreateFinopsBudgetRequest,
  ) {
    return this.governance.createBudget(request);
  }

  @Post('budgets/:id/review')
  approveBudget(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(approveFinopsBudgetRequestSchema))
    request: ApproveFinopsBudgetRequest,
  ) {
    return this.governance.approveBudget(id, request);
  }

  @Post('budgets/:id/events')
  createBudgetEvent(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(createFinopsBudgetEventRequestSchema))
    request: CreateFinopsBudgetEventRequest,
  ) {
    return this.governance.createBudgetEvent(id, request);
  }

  @Post('alerts/:id/acknowledge')
  acknowledgeAlert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(acknowledgeFinopsAlertRequestSchema))
    request: AcknowledgeFinopsAlertRequest,
  ) {
    return this.governance.acknowledgeAlert(id, request);
  }

  @Post('routing-suggestions')
  createRoutingSuggestion(
    @Body(new SchemaValidationPipe(createFinopsRoutingSuggestionRequestSchema))
    request: CreateFinopsRoutingSuggestionRequest,
  ) {
    return this.governance.createRoutingSuggestion(request);
  }

  @Post('routing-suggestions/:id/decide')
  decideRoutingSuggestion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(decideFinopsRoutingSuggestionRequestSchema))
    request: DecideFinopsRoutingSuggestionRequest,
  ) {
    return this.governance.decideRoutingSuggestion(id, request);
  }
}
