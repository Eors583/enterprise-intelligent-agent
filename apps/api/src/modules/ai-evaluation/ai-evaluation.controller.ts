import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  aiEvaluationListQuerySchema,
  aiEvaluationRunListQuerySchema,
  aiEvaluationReadinessQuerySchema,
  annotateAiEvaluationCaseRequestSchema,
  createAiEvaluationCaseRequestSchema,
  createAiEvaluationDatasetRequestSchema,
  createAiEvaluationDatasetVersionRequestSchema,
  createAiEvaluationRunRequestSchema,
  createAiEvaluationRunnerRequestSchema,
  ingestAiEvaluationBadCaseRequestSchema,
  startAiEvaluationRunRequestSchema,
  submitAiEvaluationRunRequestSchema,
  transitionAiEvaluationDatasetVersionRequestSchema,
  triageAiEvaluationBadCaseRequestSchema,
  verifyAiEvaluationRunRequestSchema,
  type AiEvaluationListQuery,
  type AiEvaluationRunListQuery,
  type AiEvaluationReadinessQuery,
  type AnnotateAiEvaluationCaseRequest,
  type CreateAiEvaluationCaseRequest,
  type CreateAiEvaluationDatasetRequest,
  type CreateAiEvaluationDatasetVersionRequest,
  type CreateAiEvaluationRunRequest,
  type CreateAiEvaluationRunnerRequest,
  type IngestAiEvaluationBadCaseRequest,
  type StartAiEvaluationRunRequest,
  type SubmitAiEvaluationRunRequest,
  type TransitionAiEvaluationDatasetVersionRequest,
  type TriageAiEvaluationBadCaseRequest,
  type VerifyAiEvaluationRunRequest,
} from '@enterprise/contracts';

import { AiEvaluationService } from './ai-evaluation.service.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';

@Controller('admin/ai-evaluations')
export class AiEvaluationController {
  constructor(
    @Inject(AiEvaluationService)
    private readonly evaluations: AiEvaluationService,
  ) {}

  @Get('datasets')
  listDatasets(
    @Query(new SchemaValidationPipe(aiEvaluationListQuerySchema))
    query: AiEvaluationListQuery,
  ) {
    return this.evaluations.listDatasets(query);
  }

  @Post('datasets')
  createDataset(
    @Body(new SchemaValidationPipe(createAiEvaluationDatasetRequestSchema))
    request: CreateAiEvaluationDatasetRequest,
  ) {
    return this.evaluations.createDataset(request);
  }

  @Post('datasets/:datasetId/versions')
  createDatasetVersion(
    @Param('datasetId', new ParseUUIDPipe()) datasetId: string,
    @Body(new SchemaValidationPipe(createAiEvaluationDatasetVersionRequestSchema))
    request: CreateAiEvaluationDatasetVersionRequest,
  ) {
    return this.evaluations.createDatasetVersion(datasetId, request);
  }

  @Get('datasets/:datasetId/versions')
  listDatasetVersions(
    @Param('datasetId', new ParseUUIDPipe()) datasetId: string,
    @Query(new SchemaValidationPipe(aiEvaluationListQuerySchema))
    query: AiEvaluationListQuery,
  ) {
    return this.evaluations.listDatasetVersions(datasetId, query);
  }

  @Get('dataset-versions/:versionId')
  getDatasetVersion(@Param('versionId', new ParseUUIDPipe()) versionId: string) {
    return this.evaluations.getDatasetVersion(versionId);
  }

  @Post('dataset-versions/:versionId/transitions')
  transitionDatasetVersion(
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(transitionAiEvaluationDatasetVersionRequestSchema))
    request: TransitionAiEvaluationDatasetVersionRequest,
  ) {
    return this.evaluations.transitionDatasetVersion(versionId, request);
  }

  @Post('dataset-versions/:versionId/cases')
  createCase(
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(createAiEvaluationCaseRequestSchema))
    request: CreateAiEvaluationCaseRequest,
  ) {
    return this.evaluations.createCase(versionId, request);
  }

  @Get('dataset-versions/:versionId/cases')
  listCases(
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Query(new SchemaValidationPipe(aiEvaluationListQuerySchema))
    query: AiEvaluationListQuery,
  ) {
    return this.evaluations.listCases(versionId, query);
  }

  @Post('cases/:caseId/annotations')
  annotateCase(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body(new SchemaValidationPipe(annotateAiEvaluationCaseRequestSchema))
    request: AnnotateAiEvaluationCaseRequest,
  ) {
    return this.evaluations.annotateCase(caseId, request);
  }

  @Post('runs')
  createRun(
    @Body(new SchemaValidationPipe(createAiEvaluationRunRequestSchema))
    request: CreateAiEvaluationRunRequest,
  ) {
    return this.evaluations.createRun(request);
  }

  @Get('runs')
  listRuns(
    @Query(new SchemaValidationPipe(aiEvaluationRunListQuerySchema))
    query: AiEvaluationRunListQuery,
  ) {
    return this.evaluations.listRuns(query);
  }

  @Get('runners')
  listRunners(
    @Query(new SchemaValidationPipe(aiEvaluationListQuerySchema))
    query: AiEvaluationListQuery,
  ) {
    return this.evaluations.listRunners(query);
  }

  @Post('runners')
  createRunner(
    @Body(new SchemaValidationPipe(createAiEvaluationRunnerRequestSchema))
    request: CreateAiEvaluationRunnerRequest,
  ) {
    return this.evaluations.createRunner(request);
  }

  @Get('runs/:runId')
  getRun(@Param('runId', new ParseUUIDPipe()) runId: string) {
    return this.evaluations.getRun(runId);
  }

  @Post('runs/:runId/start')
  startRun(
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new SchemaValidationPipe(startAiEvaluationRunRequestSchema))
    request: StartAiEvaluationRunRequest,
  ) {
    return this.evaluations.startRun(runId, request);
  }

  @Post('runs/:runId/results')
  submitRun(
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new SchemaValidationPipe(submitAiEvaluationRunRequestSchema))
    request: SubmitAiEvaluationRunRequest,
  ) {
    return this.evaluations.submitRun(runId, request);
  }

  @Post('runs/:runId/verify')
  verifyRun(
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new SchemaValidationPipe(verifyAiEvaluationRunRequestSchema))
    request: VerifyAiEvaluationRunRequest,
  ) {
    return this.evaluations.verifyRun(runId, request);
  }

  @Post('bad-cases')
  ingestBadCase(
    @Body(new SchemaValidationPipe(ingestAiEvaluationBadCaseRequestSchema))
    request: IngestAiEvaluationBadCaseRequest,
  ) {
    return this.evaluations.ingestBadCase(request);
  }

  @Get('bad-cases')
  listBadCases(
    @Query(new SchemaValidationPipe(aiEvaluationListQuerySchema))
    query: AiEvaluationListQuery,
  ) {
    return this.evaluations.listBadCases(query);
  }

  @Post('bad-cases/:badCaseId/triage')
  triageBadCase(
    @Param('badCaseId', new ParseUUIDPipe()) badCaseId: string,
    @Body(new SchemaValidationPipe(triageAiEvaluationBadCaseRequestSchema))
    request: TriageAiEvaluationBadCaseRequest,
  ) {
    return this.evaluations.triageBadCase(badCaseId, request);
  }

  @Get('readiness')
  readiness(
    @Query(new SchemaValidationPipe(aiEvaluationReadinessQuerySchema))
    query: AiEvaluationReadinessQuery,
  ) {
    return this.evaluations.readiness(query);
  }

  @Post('readiness/assert')
  assertReadiness(
    @Body(new SchemaValidationPipe(aiEvaluationReadinessQuerySchema))
    query: AiEvaluationReadinessQuery,
  ) {
    return this.evaluations.requireReleaseReady(query);
  }
}
