import type {
  AiEvaluationBadCase,
  AiEvaluationCase,
  AiEvaluationDataset,
  AiEvaluationDatasetVersion,
  AiEvaluationListQuery,
  AiEvaluationRunListQuery,
  AiEvaluationReadinessQuery,
  AiEvaluationRunner,
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

import type { AdminPrincipal } from '../admin/admin-access.service.js';
import type {
  EvaluationRunnerAttestation,
  EvaluationRunnerExecutionRequest,
} from './ai-evaluation-runner.client.js';
import type { DatasetTransitionProof } from './domain/evaluation-state-machine.js';

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface EvaluationRunRecord {
  readonly run: AiEvaluationRun;
  readonly resultSubmittedByRunnerId: string | null;
  readonly resultSubmittedByUserId: string | null;
  readonly runnerEvidenceVerified: boolean;
}

export interface ReleaseReadinessRecord {
  readonly dataset: AiEvaluationDatasetVersion | null;
  readonly caseCategories: readonly string[];
  readonly run: AiEvaluationRun | null;
  readonly runnerEvidenceVerified: boolean;
  readonly currentSnapshotHash: string;
}

export abstract class AiEvaluationRepository {
  abstract listDatasets(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationDataset>>;
  abstract createDataset(
    principal: AdminPrincipal,
    request: CreateAiEvaluationDatasetRequest,
  ): Promise<AiEvaluationDataset>;
  abstract createDatasetVersion(
    principal: AdminPrincipal,
    datasetId: string,
    request: CreateAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion>;
  abstract listDatasetVersions(
    principal: AdminPrincipal,
    datasetId: string,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationDatasetVersion>>;
  abstract findDatasetVersion(
    principal: AdminPrincipal,
    versionId: string,
  ): Promise<AiEvaluationDatasetVersion | null>;
  abstract datasetTransitionProof(
    principal: AdminPrincipal,
    versionId: string,
  ): Promise<DatasetTransitionProof>;
  abstract transitionDatasetVersion(
    principal: AdminPrincipal,
    versionId: string,
    nextStatus: AiEvaluationDatasetVersion['status'],
    request: TransitionAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion>;
  abstract createCase(
    principal: AdminPrincipal,
    versionId: string,
    request: CreateAiEvaluationCaseRequest,
  ): Promise<AiEvaluationCase>;
  abstract listCases(
    principal: AdminPrincipal,
    versionId: string,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationCase>>;
  abstract annotateCase(
    principal: AdminPrincipal,
    caseId: string,
    request: AnnotateAiEvaluationCaseRequest,
  ): Promise<void>;
  abstract createRun(
    principal: AdminPrincipal,
    request: CreateAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun>;
  abstract listRuns(
    principal: AdminPrincipal,
    query: AiEvaluationRunListQuery,
  ): Promise<CursorPage<AiEvaluationRun>>;
  abstract listRunners(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationRunner>>;
  abstract listBadCases(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationBadCase>>;
  abstract createRunner(
    principal: AdminPrincipal,
    request: CreateAiEvaluationRunnerRequest,
  ): Promise<AiEvaluationRunner>;
  abstract findRun(principal: AdminPrincipal, runId: string): Promise<EvaluationRunRecord | null>;
  abstract startRun(
    principal: AdminPrincipal,
    runId: string,
    request: StartAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun>;
  abstract prepareRunExecution(
    principal: AdminPrincipal,
    runId: string,
    request: StartAiEvaluationRunRequest,
  ): Promise<
    | { readonly state: 'already_submitted'; readonly run: AiEvaluationRun }
    | { readonly state: 'prepared'; readonly request: EvaluationRunnerExecutionRequest }
  >;
  abstract commitAttestedRun(
    principal: AdminPrincipal,
    attestation: EvaluationRunnerAttestation,
  ): Promise<AiEvaluationRun>;
  abstract submitRun(
    principal: AdminPrincipal,
    runId: string,
    request: SubmitAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun>;
  abstract verifyRun(
    principal: AdminPrincipal,
    runId: string,
    status: 'PASSED' | 'FAILED',
    request: VerifyAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun>;
  abstract ingestBadCase(
    principal: AdminPrincipal,
    request: IngestAiEvaluationBadCaseRequest,
  ): Promise<{ readonly id: string; readonly status: string; readonly revision: number }>;
  abstract triageBadCase(
    principal: AdminPrincipal,
    badCaseId: string,
    request: TriageAiEvaluationBadCaseRequest,
  ): Promise<{ readonly id: string; readonly status: string; readonly revision: number }>;
  abstract loadReadiness(
    principal: AdminPrincipal,
    query: AiEvaluationReadinessQuery,
  ): Promise<ReleaseReadinessRecord>;
  abstract recordReadiness(
    principal: AdminPrincipal,
    query: AiEvaluationReadinessQuery,
    readiness: {
      readonly ready: boolean;
      readonly passingRunId: string | null;
      readonly evaluatedSnapshotHash: string | null;
      readonly blockers: readonly unknown[];
      readonly checkedAt: string;
    },
  ): Promise<void>;
}
