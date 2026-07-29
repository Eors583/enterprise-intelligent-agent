import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AiEvaluationBadCase,
  AiEvaluationCase,
  AiEvaluationDataset,
  AiEvaluationDatasetVersion,
  AiEvaluationListQuery,
  AiEvaluationRunListQuery,
  AiEvaluationReadiness,
  AiEvaluationReadinessQuery,
  AiEvaluationRun,
  AnnotateAiEvaluationCaseRequest,
  CreateAiEvaluationCaseRequest,
  CreateAiEvaluationDatasetRequest,
  CreateAiEvaluationDatasetVersionRequest,
  CreateAiEvaluationRunRequest,
  CreateAiEvaluationRunnerRequest,
  IngestAiEvaluationBadCaseRequest,
  StartAiEvaluationRunRequest,
  SubmitAiEvaluationRunRequest,
  TransitionAiEvaluationDatasetVersionRequest,
  TriageAiEvaluationBadCaseRequest,
  VerifyAiEvaluationRunRequest,
} from '@enterprise/contracts';

import { AiEvaluationRepository, type CursorPage } from './ai-evaluation.repository.js';
import {
  AiEvaluationRunnerClient,
  EvaluationRunnerUnavailableError,
} from './ai-evaluation-runner.client.js';
import {
  evaluateReleaseReadiness,
  InvalidEvaluationTransitionError,
  transitionEvaluationDatasetVersion,
  verifyEvaluationRun,
} from './domain/evaluation-state-machine.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';

@Injectable()
export class AiEvaluationService {
  constructor(
    @Inject(AiEvaluationRepository)
    private readonly repository: AiEvaluationRepository,
    @Inject(AdminAccessService)
    private readonly access: AdminAccessService,
    @Inject(AiEvaluationRunnerClient)
    private readonly runner: AiEvaluationRunnerClient,
  ) {}

  listDatasets(query: AiEvaluationListQuery): Promise<CursorPage<AiEvaluationDataset>> {
    return this.repository.listDatasets(this.principal(), query);
  }

  createDataset(request: CreateAiEvaluationDatasetRequest): Promise<AiEvaluationDataset> {
    return this.repository.createDataset(this.principal(), request);
  }

  createDatasetVersion(
    datasetId: string,
    request: CreateAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion> {
    return this.repository.createDatasetVersion(this.principal(), datasetId, request);
  }

  listDatasetVersions(datasetId: string, query: AiEvaluationListQuery) {
    return this.repository.listDatasetVersions(this.principal(), datasetId, query);
  }

  async getDatasetVersion(versionId: string): Promise<AiEvaluationDatasetVersion> {
    const principal = this.principal();
    const version = await this.repository.findDatasetVersion(principal, versionId);
    if (version === null) throw new NotFoundException('Evaluation Dataset Version was not found.');
    return version;
  }

  async transitionDatasetVersion(
    versionId: string,
    request: TransitionAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion> {
    const principal = this.principal();
    const version = await this.repository.findDatasetVersion(principal, versionId);
    if (version === null) throw new NotFoundException('Evaluation Dataset Version was not found.');
    if (version.revision !== request.expectedRevision) {
      throw new ConflictException('Evaluation Dataset Version changed. Refresh and try again.');
    }
    const proof = await this.repository.datasetTransitionProof(principal, versionId);
    const effectiveProof =
      request.action === 'APPROVE' || request.action === 'REJECT'
        ? { ...proof, reviewEvidenceCount: request.evidenceIds.length }
        : proof;
    try {
      const next = transitionEvaluationDatasetVersion(
        version.status,
        request,
        {
          tenantId: principal.tenantId,
          userId: principal.userId,
          tenantRole: principal.role,
        },
        effectiveProof,
      );
      return await this.repository.transitionDatasetVersion(principal, versionId, next, request);
    } catch (error) {
      if (error instanceof InvalidEvaluationTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  createCase(versionId: string, request: CreateAiEvaluationCaseRequest): Promise<AiEvaluationCase> {
    return this.repository.createCase(this.principal(), versionId, request);
  }

  listCases(versionId: string, query: AiEvaluationListQuery) {
    return this.repository.listCases(this.principal(), versionId, query);
  }

  annotateCase(
    caseId: string,
    request: AnnotateAiEvaluationCaseRequest,
  ): Promise<{ readonly accepted: true }> {
    return this.repository.annotateCase(this.principal(), caseId, request).then(() => ({
      accepted: true,
    }));
  }

  async createRun(request: CreateAiEvaluationRunRequest): Promise<AiEvaluationRun> {
    const principal = this.principal();
    const snapshot = await this.repository.loadReadiness(principal, {
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      subjectVersion: request.subjectVersion,
      datasetVersionId: request.datasetVersionId,
      currentSnapshotHash: request.subjectSnapshotHash,
    });
    if (snapshot.currentSnapshotHash !== request.subjectSnapshotHash) {
      throw new ConflictException(
        'The requested Evaluation Run snapshot does not match the current trusted subject.',
      );
    }
    return this.repository.createRun(principal, request);
  }

  listRuns(query: AiEvaluationRunListQuery): Promise<CursorPage<AiEvaluationRun>> {
    return this.repository.listRuns(this.principal(), query);
  }

  listRunners(query: AiEvaluationListQuery) {
    return this.repository.listRunners(this.principal(), query);
  }

  listBadCases(query: AiEvaluationListQuery): Promise<CursorPage<AiEvaluationBadCase>> {
    return this.repository.listBadCases(this.principal(), query);
  }

  createRunner(request: CreateAiEvaluationRunnerRequest) {
    return this.repository.createRunner(this.access.requireDirectoryWrite(), request);
  }

  async getRun(runId: string): Promise<AiEvaluationRun> {
    const record = await this.repository.findRun(this.principal(), runId);
    if (record === null) throw new NotFoundException('Evaluation Run was not found.');
    return record.run;
  }

  async startRun(runId: string, request: StartAiEvaluationRunRequest): Promise<AiEvaluationRun> {
    const principal = this.principal();
    const prepared = await this.repository.prepareRunExecution(principal, runId, request);
    if (prepared.state === 'already_submitted') return prepared.run;
    try {
      const attestation = await this.runner.execute(prepared.request);
      return await this.repository.commitAttestedRun(principal, attestation);
    } catch (error) {
      if (error instanceof EvaluationRunnerUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'Service Unavailable',
          code: error.code,
          retryable: error.retryable,
          message: 'The trusted evaluation runner could not complete this Run.',
        });
      }
      throw error;
    }
  }

  submitRun(runId: string, request: SubmitAiEvaluationRunRequest): never {
    void runId;
    void request;
    throw new ForbiddenException(
      'Administrative clients cannot submit evaluation results; only a verified runtime attestation is accepted.',
    );
  }

  async verifyRun(runId: string, request: VerifyAiEvaluationRunRequest): Promise<AiEvaluationRun> {
    const principal = this.principal();
    const record = await this.repository.findRun(principal, runId);
    if (record === null) throw new NotFoundException('Evaluation Run was not found.');
    if (record.resultSubmittedByRunnerId === null) {
      throw new ConflictException('Evaluation Run has no externally submitted result.');
    }
    try {
      const status = verifyEvaluationRun(
        record.run,
        request,
        {
          tenantId: principal.tenantId,
          userId: principal.userId,
          tenantRole: principal.role,
        },
        record.resultSubmittedByUserId,
      );
      return await this.repository.verifyRun(principal, runId, status, request);
    } catch (error) {
      if (error instanceof InvalidEvaluationTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  ingestBadCase(request: IngestAiEvaluationBadCaseRequest) {
    return this.repository.ingestBadCase(this.principal(), request);
  }

  triageBadCase(badCaseId: string, request: TriageAiEvaluationBadCaseRequest) {
    return this.repository.triageBadCase(this.principal(), badCaseId, request);
  }

  async readiness(query: AiEvaluationReadinessQuery): Promise<AiEvaluationReadiness> {
    const principal = this.principal();
    const record = await this.repository.loadReadiness(principal, query);
    const trustedQuery = { ...query, currentSnapshotHash: record.currentSnapshotHash };
    const readiness = evaluateReleaseReadiness({
      query: trustedQuery,
      dataset: record.dataset,
      caseCategories: record.caseCategories,
      run: record.run,
      runnerEvidenceVerified: record.runnerEvidenceVerified,
      checkedAt: new Date(),
    });
    await this.repository.recordReadiness(principal, trustedQuery, readiness);
    return readiness;
  }

  /**
   * Mandatory application-layer publication gate. Agent and Knowledge
   * publication paths use this method instead of trusting a client supplied
   * score or Run status.
   */
  async requireReleaseReady(query: AiEvaluationReadinessQuery): Promise<AiEvaluationReadiness> {
    const readiness = await this.readiness(query);
    if (!readiness.ready) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'The release candidate did not pass the governed AI evaluation gate.',
        readiness,
      });
    }
    return readiness;
  }

  async requireReferencedRunReady(input: {
    readonly evaluationRunId: string;
    readonly subjectType: AiEvaluationReadinessQuery['subjectType'];
    readonly subjectId: string;
    readonly subjectVersion: number;
  }): Promise<AiEvaluationReadiness> {
    const principal = this.principal();
    const record = await this.repository.findRun(principal, input.evaluationRunId);
    if (record === null)
      throw new ConflictException('The referenced Evaluation Run was not found.');
    if (
      record.run.subjectType !== input.subjectType ||
      record.run.subjectId !== input.subjectId ||
      record.run.subjectVersion !== input.subjectVersion
    ) {
      throw new ConflictException(
        'The referenced Evaluation Run does not bind the exact release candidate.',
      );
    }
    const readiness = await this.readiness({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectVersion: input.subjectVersion,
      datasetVersionId: record.run.datasetVersionId,
      currentSnapshotHash: record.run.subjectSnapshotHash,
      evaluationRunId: input.evaluationRunId,
    });
    if (!readiness.ready || readiness.passingRunId !== input.evaluationRunId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'The referenced Evaluation Run is not ready for publication.',
        readiness,
      });
    }
    return readiness;
  }

  private principal(): AdminPrincipal {
    return this.access.requireKnowledgeWrite();
  }
}
