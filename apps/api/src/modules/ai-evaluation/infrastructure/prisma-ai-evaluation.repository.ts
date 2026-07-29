import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  aiEvaluationBadCaseSchema,
  aiEvaluationCaseSchema,
  aiEvaluationDatasetSchema,
  aiEvaluationDatasetVersionSchema,
  aiEvaluationRunSchema,
  aiEvaluationRunnerSchema,
  type AiEvaluationBadCase,
  type AiEvaluationCase,
  type AiEvaluationDataset,
  type AiEvaluationDatasetVersion,
  type AiEvaluationListQuery,
  type AiEvaluationRunListQuery,
  type AiEvaluationMetricResult,
  type AiEvaluationReadinessQuery,
  type AiEvaluationRun,
  type AiEvaluationRunner,
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
import { Prisma } from '@prisma/client';

import {
  AiEvaluationRepository,
  type CursorPage,
  type EvaluationRunRecord,
  type ReleaseReadinessRecord,
} from '../ai-evaluation.repository.js';
import type { DatasetTransitionProof } from '../domain/evaluation-state-machine.js';
import type {
  EvaluationRunnerAttestation,
  EvaluationRunnerExecutionRequest,
} from '../ai-evaluation-runner.client.js';
import { evaluationExecutionRequestHash } from './http-ai-evaluation-runner.client.js';
import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../admin/admin-access.service.js';
import {
  readModelRouteRequest,
  resolveTrustedModelRouteSnapshot,
} from '../../ai-safety-model-routing/model-route-execution.js';
import { runtimeHash } from '../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

type Transaction = Parameters<Parameters<AdminPrismaService['withTenant']>[1]>[0];

@Injectable()
export class PrismaAiEvaluationRepository extends AiEvaluationRepository {
  constructor(@Inject(AdminPrismaService) private readonly prisma: AdminPrismaService) {
    super();
  }

  async listDatasets(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationDataset>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<DatasetRow[]>(Prisma.sql`
        SELECT
          dataset."id", dataset."tenant_id", dataset."code", dataset."name",
          dataset."description", dataset."latest_version",
          dataset."current_published_version_id", dataset."created_at", dataset."updated_at"
        FROM public."ai_evaluation_datasets" dataset
        WHERE dataset."tenant_id" = ${principal.tenantId}::uuid
          AND (${query.cursor ?? null}::uuid IS NULL OR dataset."id" < ${query.cursor ?? null}::uuid)
        ORDER BY dataset."id" DESC
        LIMIT ${query.limit + 1}
      `);
      return page(rows.map(mapDataset), query.limit);
    });
  }

  async listRuns(
    principal: AdminPrincipal,
    query: AiEvaluationRunListQuery,
  ): Promise<CursorPage<AiEvaluationRun>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<RunRow[]>(Prisma.sql`
        SELECT run.*
        FROM public."ai_evaluation_runs" run
        WHERE run."tenant_id" = ${principal.tenantId}::uuid
          AND (${query.cursor ?? null}::uuid IS NULL OR run."id" < ${query.cursor ?? null}::uuid)
          AND (${query.subjectType ?? null}::text IS NULL OR run."subject_type"::text = ${query.subjectType ?? null})
          AND (${query.subjectId ?? null}::uuid IS NULL OR run."subject_id" = ${query.subjectId ?? null}::uuid)
          AND (${query.subjectVersion ?? null}::integer IS NULL OR run."subject_version" = ${query.subjectVersion ?? null})
          AND (${query.status ?? null}::text IS NULL OR run."status"::text = ${query.status ?? null})
        ORDER BY run."id" DESC
        LIMIT ${query.limit + 1}
      `);
      const items = await Promise.all(
        rows.map(async (row) =>
          mapRun(row, await metricResultRows(transaction, principal.tenantId, row.id)),
        ),
      );
      return page(items, query.limit);
    });
  }

  async listDatasetVersions(
    principal: AdminPrincipal,
    datasetId: string,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationDatasetVersion>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<VersionRow[]>(Prisma.sql`
        SELECT version.*, coalesce(
          (
            SELECT jsonb_agg(review."evidence_id" ORDER BY review."evidence_id")
            FROM public."ai_evaluation_review_evidence" review
            WHERE review."tenant_id" = version."tenant_id"
              AND review."dataset_version_id" = version."id"
          ),
          '[]'::jsonb
        ) AS review_evidence_ids
        FROM public."ai_evaluation_dataset_versions" version
        WHERE version."tenant_id" = ${principal.tenantId}::uuid
          AND version."dataset_id" = ${datasetId}::uuid
          AND (${query.cursor ?? null}::uuid IS NULL OR version."id" < ${query.cursor ?? null}::uuid)
        ORDER BY version."id" DESC
        LIMIT ${query.limit + 1}
      `);
      const items = await Promise.all(
        rows.map(async (row) =>
          mapDatasetVersion(row, await thresholdRows(transaction, principal.tenantId, row.id)),
        ),
      );
      return page(items, query.limit);
    });
  }

  async listCases(
    principal: AdminPrincipal,
    versionId: string,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationCase>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT test_case."id"
        FROM public."ai_evaluation_cases" test_case
        WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
          AND test_case."dataset_version_id" = ${versionId}::uuid
          AND (${query.cursor ?? null}::uuid IS NULL OR test_case."id" < ${query.cursor ?? null}::uuid)
        ORDER BY test_case."id" DESC
        LIMIT ${query.limit + 1}
      `);
      const items = await Promise.all(
        rows.map(({ id }) => loadCase(transaction, principal.tenantId, id)),
      );
      return page(items, query.limit);
    });
  }

  async listRunners(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationRunner>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<RunnerRow[]>(Prisma.sql`
        SELECT *
        FROM public."ai_evaluation_runners" runner
        WHERE runner."tenant_id" = ${principal.tenantId}::uuid
          AND runner."status" = 'ACTIVE'
          AND (${query.cursor ?? null}::uuid IS NULL OR runner."id" < ${query.cursor ?? null}::uuid)
        ORDER BY runner."id" DESC
        LIMIT ${query.limit + 1}
      `);
      return page(rows.map(mapRunner), query.limit);
    });
  }

  async listBadCases(
    principal: AdminPrincipal,
    query: AiEvaluationListQuery,
  ): Promise<CursorPage<AiEvaluationBadCase>> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<BadCaseRow[]>(Prisma.sql`
        SELECT
          bad_case.*,
          feedback_source."feedback_id" AS "feedback_source_feedback_id",
          feedback_source."conversation_id" AS "feedback_source_conversation_id",
          feedback_source."message_id" AS "feedback_source_message_id",
          feedback_source."input_message_id" AS "feedback_source_input_message_id",
          feedback_source."agent_run_id" AS "feedback_source_agent_run_id",
          feedback_source."agent_id" AS "feedback_source_agent_id",
          feedback_source."agent_version_id" AS "feedback_source_agent_version_id",
          feedback_source."reported_by_user_id" AS "feedback_source_reported_by_user_id",
          feedback_source."feedback_reason"::text AS "feedback_source_feedback_reason",
          feedback_source."feedback_recorded_at" AS "feedback_source_feedback_recorded_at",
          feedback_source."prompt_snapshot_hash" AS "feedback_source_prompt_snapshot_hash",
          feedback_source."answer_snapshot_hash" AS "feedback_source_answer_snapshot_hash",
          feedback_source."citations_snapshot_hash" AS "feedback_source_citations_snapshot_hash",
          feedback_source."citations" AS "feedback_source_citations"
        FROM public."ai_evaluation_bad_cases" bad_case
        LEFT JOIN public."ai_evaluation_answer_feedback_sources" feedback_source
          ON feedback_source."tenant_id" = bad_case."tenant_id"
         AND feedback_source."bad_case_id" = bad_case."id"
        WHERE bad_case."tenant_id" = ${principal.tenantId}::uuid
          AND (
            ${query.cursor ?? null}::uuid IS NULL
            OR bad_case."id" < ${query.cursor ?? null}::uuid
          )
        ORDER BY bad_case."id" DESC
        LIMIT ${query.limit + 1}
      `);
      return page(rows.map(mapBadCaseDetail), query.limit);
    });
  }

  async createDataset(
    principal: AdminPrincipal,
    request: CreateAiEvaluationDatasetRequest,
  ): Promise<AiEvaluationDataset> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const replay = await findDatasetByIdempotency(
        transaction,
        principal.tenantId,
        request.idempotencyKey,
      );
      if (replay !== null) {
        requireSameHash(replay.request_hash, hash);
        return mapDataset(replay);
      }
      const id = randomUUID();
      const rows = await transaction.$queryRaw<DatasetRow[]>(Prisma.sql`
        INSERT INTO public."ai_evaluation_datasets" (
          "id", "tenant_id", "code", "name", "description", "created_by_user_id",
          "idempotency_key", "request_hash", "created_at", "updated_at"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${request.code}, ${request.name},
          ${request.description}, ${principal.userId}::uuid, ${request.idempotencyKey},
          ${hash}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING
          "id", "tenant_id", "code", "name", "description", "latest_version",
          "current_published_version_id", "created_at", "updated_at", "request_hash"
      `);
      return mapDataset(required(rows[0], 'Created Evaluation Dataset was not returned.'));
    });
  }

  async createDatasetVersion(
    principal: AdminPrincipal,
    datasetId: string,
    request: CreateAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const replay = await findDatasetVersionByIdempotency(
        transaction,
        principal.tenantId,
        request.idempotencyKey,
      );
      if (replay !== null) {
        requireSameHash(replay.request_hash, hash);
        return loadDatasetVersion(transaction, principal.tenantId, replay.id);
      }
      const datasets = await transaction.$queryRaw<Array<{ latest_version: number }>>(Prisma.sql`
        SELECT "latest_version"
        FROM public."ai_evaluation_datasets"
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${datasetId}::uuid
        FOR UPDATE
      `);
      const dataset = datasets[0];
      if (dataset === undefined) throw new NotFoundException('Evaluation Dataset was not found.');
      const version = dataset.latest_version + 1;
      const id = randomUUID();
      const contentHash = runtimeHash({
        description: request.description,
        requiredCategories: request.requiredCategories,
        targets: request.targets,
        thresholds: request.thresholds,
      });
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_evaluation_dataset_versions" (
          "id", "tenant_id", "dataset_id", "version", "description", "targets",
          "required_categories", "content_hash", "idempotency_key", "request_hash",
          "created_by_user_id", "created_at", "updated_at"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${datasetId}::uuid, ${version},
          ${request.description}, ${JSON.stringify(request.targets)}::jsonb,
          ${JSON.stringify(request.requiredCategories)}::jsonb, ${contentHash},
          ${request.idempotencyKey}, ${hash}, ${principal.userId}::uuid,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);
      for (const threshold of request.thresholds) {
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."ai_evaluation_thresholds" (
            "tenant_id", "dataset_version_id", "metric", "direction", "threshold",
            "minimum_sample_count", "required"
          ) VALUES (
            ${principal.tenantId}::uuid, ${id}::uuid,
            ${threshold.metric}::public."AiEvaluationMetric",
            ${threshold.direction}::public."AiEvaluationThresholdDirection",
            ${threshold.threshold}, ${threshold.minimumSampleCount}, ${threshold.required}
          )
        `);
      }
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_datasets"
        SET "latest_version" = ${version}, "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${datasetId}::uuid
      `);
      return loadDatasetVersion(transaction, principal.tenantId, id);
    });
  }

  async findDatasetVersion(
    principal: AdminPrincipal,
    versionId: string,
  ): Promise<AiEvaluationDatasetVersion | null> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await datasetVersionRows(transaction, principal.tenantId, versionId);
      return rows[0] === undefined
        ? null
        : mapDatasetVersion(
            rows[0],
            await thresholdRows(transaction, principal.tenantId, versionId),
          );
    });
  }

  async datasetTransitionProof(
    principal: AdminPrincipal,
    versionId: string,
  ): Promise<DatasetTransitionProof> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<ProofRow[]>(Prisma.sql`
        SELECT
          version."case_count",
          version."submitted_by_user_id",
          (
            SELECT count(DISTINCT test_case."id")::integer
            FROM public."ai_evaluation_cases" test_case
            WHERE test_case."tenant_id" = version."tenant_id"
              AND test_case."dataset_version_id" = version."id"
              AND EXISTS (
                SELECT 1
                FROM public."ai_evaluation_annotations" annotation
                WHERE annotation."tenant_id" = test_case."tenant_id"
                  AND annotation."case_id" = test_case."id"
                  AND annotation."label" <> 'ABSTAIN'
              )
          ) AS annotated_case_count,
          (
            SELECT coalesce(jsonb_agg(DISTINCT test_case."category"::text), '[]'::jsonb)
            FROM public."ai_evaluation_cases" test_case
            WHERE test_case."tenant_id" = version."tenant_id"
              AND test_case."dataset_version_id" = version."id"
          ) AS categories,
          (
            SELECT coalesce(jsonb_agg(threshold."metric"::text), '[]'::jsonb)
            FROM public."ai_evaluation_thresholds" threshold
            WHERE threshold."tenant_id" = version."tenant_id"
              AND threshold."dataset_version_id" = version."id"
              AND threshold."required"
          ) AS metrics,
          (
            SELECT coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'metric', threshold."metric"::text,
                  'direction', threshold."direction"::text,
                  'threshold', threshold."threshold",
                  'required', threshold."required"
                )
                ORDER BY threshold."metric"::text
              ),
              '[]'::jsonb
            )
            FROM public."ai_evaluation_thresholds" threshold
            WHERE threshold."tenant_id" = version."tenant_id"
              AND threshold."dataset_version_id" = version."id"
          ) AS thresholds,
          (
            SELECT count(*)::integer
            FROM public."ai_evaluation_review_evidence" review
            WHERE review."tenant_id" = version."tenant_id"
              AND review."dataset_version_id" = version."id"
          ) AS review_evidence_count
        FROM public."ai_evaluation_dataset_versions" version
        WHERE version."tenant_id" = ${principal.tenantId}::uuid
          AND version."id" = ${versionId}::uuid
      `);
      const proof = rows[0];
      if (proof === undefined)
        throw new NotFoundException('Evaluation Dataset Version was not found.');
      return {
        caseCount: proof.case_count,
        annotatedCaseCount: proof.annotated_case_count,
        categories: jsonStrings(proof.categories),
        metrics: jsonStrings(proof.metrics) as DatasetTransitionProof['metrics'],
        thresholds: Array.isArray(proof.thresholds)
          ? (proof.thresholds as DatasetTransitionProof['thresholds'])
          : [],
        submitterUserId: proof.submitted_by_user_id,
        reviewEvidenceCount: proof.review_evidence_count,
      };
    });
  }

  async transitionDatasetVersion(
    principal: AdminPrincipal,
    versionId: string,
    nextStatus: AiEvaluationDatasetVersion['status'],
    request: TransitionAiEvaluationDatasetVersionRequest,
  ): Promise<AiEvaluationDatasetVersion> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<VersionRow[]>(Prisma.sql`
        SELECT *
        FROM public."ai_evaluation_dataset_versions"
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${versionId}::uuid
        FOR UPDATE
      `);
      const version = rows[0];
      if (version === undefined)
        throw new NotFoundException('Evaluation Dataset Version was not found.');
      if (version.revision !== request.expectedRevision) throw stale('Evaluation Dataset Version');
      const now = new Date();
      const nextRevision = version.revision + 1;
      let contentHash = version.content_hash;
      if (request.action === 'SUBMIT') {
        contentHash = await sealedDatasetHash(transaction, principal.tenantId, versionId);
      }
      if (request.action === 'APPROVE' || request.action === 'REJECT') {
        await insertTrustedEvidence(
          transaction,
          'ai_evaluation_review_evidence',
          'dataset_version_id',
          versionId,
          principal.tenantId,
          request.evidenceIds,
        );
      }
      if (request.action === 'PUBLISH') {
        const published = await transaction.$queryRaw<
          Array<{ id: string; revision: number }>
        >(Prisma.sql`
          SELECT "id", "revision"
          FROM public."ai_evaluation_dataset_versions"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "dataset_id" = ${version.dataset_id}::uuid
            AND "status" = 'PUBLISHED'
            AND "id" <> ${versionId}::uuid
          FOR UPDATE
        `);
        for (const current of published) {
          await transaction.$executeRaw(Prisma.sql`
            UPDATE public."ai_evaluation_dataset_versions"
            SET "status" = 'RETIRED', "retired_at" = ${now},
                "revision" = ${current.revision + 1}, "updated_at" = ${now}
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "id" = ${current.id}::uuid
              AND "revision" = ${current.revision}
          `);
        }
      }
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_dataset_versions"
        SET
          "status" = ${nextStatus}::public."AiEvaluationDatasetStatus",
          "revision" = ${nextRevision},
          "content_hash" = ${contentHash},
          "case_count" = (
            SELECT count(*)::integer FROM public."ai_evaluation_cases" test_case
            WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
              AND test_case."dataset_version_id" = ${versionId}::uuid
          ),
          "annotation_coverage" = (
            SELECT CASE WHEN count(*) = 0 THEN 0
              ELSE count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM public."ai_evaluation_annotations" annotation
                  WHERE annotation."tenant_id" = test_case."tenant_id"
                    AND annotation."case_id" = test_case."id"
                    AND annotation."label" <> 'ABSTAIN'
                )
              )::numeric / count(*)::numeric END
            FROM public."ai_evaluation_cases" test_case
            WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
              AND test_case."dataset_version_id" = ${versionId}::uuid
          ),
          "submitted_by_user_id" = CASE WHEN ${request.action} = 'SUBMIT'
            THEN ${principal.userId}::uuid ELSE "submitted_by_user_id" END,
          "submitted_at" = CASE WHEN ${request.action} = 'SUBMIT'
            THEN ${now} ELSE "submitted_at" END,
          "reviewed_by_user_id" = CASE WHEN ${request.action} IN ('APPROVE', 'REJECT')
            THEN ${principal.userId}::uuid ELSE "reviewed_by_user_id" END,
          "reviewed_at" = CASE WHEN ${request.action} IN ('APPROVE', 'REJECT')
            THEN ${now} ELSE "reviewed_at" END,
          "published_by_user_id" = CASE WHEN ${request.action} = 'PUBLISH'
            THEN ${principal.userId}::uuid ELSE "published_by_user_id" END,
          "published_at" = CASE WHEN ${request.action} = 'PUBLISH'
            THEN ${now} ELSE "published_at" END,
          "retired_at" = CASE WHEN ${request.action} = 'RETIRE'
            THEN ${now} ELSE "retired_at" END,
          "updated_at" = ${now}
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${versionId}::uuid
          AND "revision" = ${request.expectedRevision}
      `);
      if (changed !== 1) throw stale('Evaluation Dataset Version');
      if (request.action === 'PUBLISH') {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."ai_evaluation_datasets"
          SET "current_published_version_id" = ${versionId}::uuid, "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${version.dataset_id}::uuid
        `);
      } else if (request.action === 'RETIRE') {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."ai_evaluation_datasets"
          SET "current_published_version_id" = NULL, "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${version.dataset_id}::uuid
            AND "current_published_version_id" = ${versionId}::uuid
        `);
      }
      return loadDatasetVersion(transaction, principal.tenantId, versionId);
    });
  }

  async createCase(
    principal: AdminPrincipal,
    versionId: string,
    request: CreateAiEvaluationCaseRequest,
  ): Promise<AiEvaluationCase> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const replay = await transaction.$queryRaw<CaseRow[]>(Prisma.sql`
        SELECT * FROM public."ai_evaluation_cases"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "idempotency_key" = ${request.idempotencyKey}
      `);
      if (replay[0] !== undefined) {
        requireSameHash(replay[0].request_hash, hash);
        return loadCase(transaction, principal.tenantId, replay[0].id);
      }
      const versions = await transaction.$queryRaw<
        Array<{ revision: number; status: string }>
      >(Prisma.sql`
        SELECT "revision", "status"::text
        FROM public."ai_evaluation_dataset_versions"
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${versionId}::uuid
        FOR UPDATE
      `);
      const version = versions[0];
      if (version === undefined)
        throw new NotFoundException('Evaluation Dataset Version was not found.');
      if (version.status !== 'DRAFT')
        throw new ConflictException('Only draft datasets can accept cases.');
      if (request.sourceBadCaseId !== undefined) {
        const badCases = await transaction.$queryRaw<
          Array<{ status: string; mapped_dataset_version_id: string | null }>
        >(Prisma.sql`
          SELECT "status"::text, "mapped_dataset_version_id"
          FROM public."ai_evaluation_bad_cases"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${request.sourceBadCaseId}::uuid
          FOR UPDATE
        `);
        const badCase = badCases[0];
        if (
          badCase === undefined ||
          badCase.status !== 'TRIAGED' ||
          badCase.mapped_dataset_version_id !== versionId
        ) {
          throw new ConflictException(
            'Bad Case must be independently triaged into this draft first.',
          );
        }
      }
      const id = randomUUID();
      const contentHash = runtimeHash({
        caseKey: request.caseKey,
        category: request.category,
        context: request.context,
        expectedBehavior: request.expectedBehavior,
        forbiddenBehaviors: request.forbiddenBehaviors,
        input: request.input,
        requiredEvidenceIds: request.requiredEvidenceIds,
        scoring: request.scoring,
      });
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_evaluation_cases" (
          "id", "tenant_id", "dataset_version_id", "case_key", "category", "input",
          "context", "expected_behavior", "forbidden_behaviors", "scoring",
          "source_bad_case_id", "content_hash", "created_by_user_id",
          "idempotency_key", "request_hash"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${versionId}::uuid,
          ${request.caseKey}, ${request.category}::public."AiEvaluationCategory",
          ${request.input}, ${JSON.stringify(request.context)}::jsonb,
          ${request.expectedBehavior}, ${JSON.stringify(request.forbiddenBehaviors)}::jsonb,
          ${JSON.stringify(request.scoring)}::jsonb, ${request.sourceBadCaseId ?? null}::uuid,
          ${contentHash}, ${principal.userId}::uuid, ${request.idempotencyKey}, ${hash}
        )
      `);
      await insertTrustedEvidence(
        transaction,
        'ai_evaluation_case_evidence',
        'case_id',
        id,
        principal.tenantId,
        request.requiredEvidenceIds,
      );
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_dataset_versions"
        SET "case_count" = "case_count" + 1, "revision" = "revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${versionId}::uuid
          AND "revision" = ${version.revision}
      `);
      if (request.sourceBadCaseId !== undefined) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."ai_evaluation_bad_cases"
          SET "status" = 'ADDED_TO_DATASET', "mapped_case_id" = ${id}::uuid,
              "revision" = "revision" + 1, "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${request.sourceBadCaseId}::uuid
            AND "status" = 'TRIAGED'
        `);
      }
      return loadCase(transaction, principal.tenantId, id);
    });
  }

  async annotateCase(
    principal: AdminPrincipal,
    caseId: string,
    request: AnnotateAiEvaluationCaseRequest,
  ): Promise<void> {
    await this.withPrincipal(principal, async (transaction) => {
      const cases = await transaction.$queryRaw<
        Array<{ dataset_version_id: string; version_revision: number; status: string }>
      >(Prisma.sql`
        SELECT test_case."dataset_version_id", version."revision" AS version_revision,
               version."status"::text
        FROM public."ai_evaluation_cases" test_case
        JOIN public."ai_evaluation_dataset_versions" version
          ON version."tenant_id" = test_case."tenant_id"
         AND version."id" = test_case."dataset_version_id"
        WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
          AND test_case."id" = ${caseId}::uuid
        FOR UPDATE OF version
      `);
      const testCase = cases[0];
      if (testCase === undefined) throw new NotFoundException('Evaluation Case was not found.');
      if (testCase.status !== 'DRAFT')
        throw new ConflictException('Submitted annotations are immutable.');
      const existing = await transaction.$queryRaw<
        Array<{ id: string; revision: number; request_hash: string; idempotency_key: string }>
      >(Prisma.sql`
        SELECT "id", "revision", "request_hash", "idempotency_key"
        FROM public."ai_evaluation_annotations"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "case_id" = ${caseId}::uuid
          AND "annotator_user_id" = ${principal.userId}::uuid
        FOR UPDATE
      `);
      const current = existing[0];
      const hash = runtimeHash(request);
      if (current?.idempotency_key === request.idempotencyKey) {
        requireSameHash(current.request_hash, hash);
        return;
      }
      if ((current?.revision ?? 0) !== request.expectedRevision)
        throw stale('Evaluation Annotation');
      const annotationId = current?.id ?? randomUUID();
      if (current === undefined) {
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."ai_evaluation_annotations" (
            "id", "tenant_id", "dataset_version_id", "case_id", "annotator_user_id",
            "label", "expected_score", "rationale", "revision", "idempotency_key", "request_hash"
          ) VALUES (
            ${annotationId}::uuid, ${principal.tenantId}::uuid,
            ${testCase.dataset_version_id}::uuid, ${caseId}::uuid, ${principal.userId}::uuid,
            ${request.label}, ${request.expectedScore}, ${request.rationale}, 1,
            ${request.idempotencyKey}, ${hash}
          )
        `);
      } else {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."ai_evaluation_annotations"
          SET "label" = ${request.label}, "expected_score" = ${request.expectedScore},
              "rationale" = ${request.rationale}, "revision" = "revision" + 1,
              "idempotency_key" = ${request.idempotencyKey}, "request_hash" = ${hash},
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${annotationId}::uuid
            AND "revision" = ${request.expectedRevision}
        `);
      }
      await insertTrustedEvidence(
        transaction,
        'ai_evaluation_annotation_evidence',
        'annotation_id',
        annotationId,
        principal.tenantId,
        request.evidenceIds,
      );
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_dataset_versions"
        SET "annotation_coverage" = (
          SELECT CASE WHEN count(*) = 0 THEN 0
            ELSE count(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM public."ai_evaluation_annotations" annotation
                WHERE annotation."tenant_id" = test_case."tenant_id"
                  AND annotation."case_id" = test_case."id"
                  AND annotation."label" <> 'ABSTAIN'
              )
            )::numeric / count(*)::numeric END
          FROM public."ai_evaluation_cases" test_case
          WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
            AND test_case."dataset_version_id" = ${testCase.dataset_version_id}::uuid
        ),
        "revision" = "revision" + 1, "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${testCase.dataset_version_id}::uuid
          AND "revision" = ${testCase.version_revision}
      `);
    });
  }

  async createRun(
    principal: AdminPrincipal,
    request: CreateAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const replay = await findRunByIdempotency(
        transaction,
        principal.tenantId,
        request.idempotencyKey,
      );
      if (replay !== null) {
        requireSameHash(replay.request_hash, hash);
        return loadRun(transaction, principal.tenantId, replay.id);
      }
      const versions = await transaction.$queryRaw<
        Array<{ case_count: number; targets: unknown; status: string }>
      >(Prisma.sql`
        SELECT "case_count", "targets", "status"::text
        FROM public."ai_evaluation_dataset_versions"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${request.datasetVersionId}::uuid
      `);
      const version = versions[0];
      if (version === undefined || version.status !== 'PUBLISHED') {
        throw new ConflictException('Evaluation Runs require a published dataset version.');
      }
      const targets = object(version.targets);
      const key =
        request.subjectType === 'KNOWLEDGE_VERSION' ? 'knowledgeVersionIds' : 'agentVersionIds';
      if (!jsonStrings(targets[key]).includes(request.subjectId)) {
        throw new ConflictException('The evaluation dataset does not bind this subject version.');
      }
      const runners = await transaction.$queryRaw<
        Array<{ name: string; attestation_key_fingerprint: string }>
      >(Prisma.sql`
        SELECT "name", "attestation_key_fingerprint"
        FROM public."ai_evaluation_runners"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${request.runnerId}::uuid AND "status" = 'ACTIVE'
      `);
      if (runners[0] === undefined || runners[0].name !== request.runnerName) {
        throw new ConflictException('The registered evaluation runner is unavailable.');
      }
      const id = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_evaluation_runs" (
          "id", "tenant_id", "dataset_version_id", "subject_type", "subject_id",
          "subject_version", "subject_snapshot_hash", "runner_id", "runner_name",
          "runner_attestation_key_fingerprint", "external_run_id", "expected_case_count",
          "idempotency_key", "request_hash", "created_by_user_id"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${request.datasetVersionId}::uuid,
          ${request.subjectType}::public."AiEvaluationSubjectType", ${request.subjectId}::uuid,
          ${request.subjectVersion}, ${request.subjectSnapshotHash}, ${request.runnerId}::uuid,
          ${request.runnerName}, ${runners[0].attestation_key_fingerprint},
          ${request.externalRunId}, ${version.case_count}, ${request.idempotencyKey},
          ${hash}, ${principal.userId}::uuid
        )
      `);
      return loadRun(transaction, principal.tenantId, id);
    });
  }

  async createRunner(
    principal: AdminPrincipal,
    request: CreateAiEvaluationRunnerRequest,
  ): Promise<AiEvaluationRunner> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const replay = await transaction.$queryRaw<RunnerRow[]>(Prisma.sql`
        SELECT * FROM public."ai_evaluation_runners"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "idempotency_key" = ${request.idempotencyKey}
      `);
      if (replay[0] !== undefined) {
        requireSameHash(replay[0].request_hash, hash);
        return mapRunner(replay[0]);
      }
      const id = randomUUID();
      const rows = await transaction.$queryRaw<RunnerRow[]>(Prisma.sql`
        INSERT INTO public."ai_evaluation_runners" (
          "id", "tenant_id", "name", "attestation_key_fingerprint",
          "allowed_evidence_origins", "created_by_user_id", "idempotency_key", "request_hash"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${request.name},
          ${request.attestationKeyFingerprint}, ${JSON.stringify(request.allowedEvidenceOrigins)}::jsonb,
          ${principal.userId}::uuid, ${request.idempotencyKey}, ${hash}
        )
        RETURNING *
      `);
      return mapRunner(required(rows[0], 'Created Evaluation Runner was not returned.'));
    });
  }

  async findRun(principal: AdminPrincipal, runId: string): Promise<EvaluationRunRecord | null> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await runRows(transaction, principal.tenantId, runId);
      const row = rows[0];
      if (row === undefined) return null;
      const trustedAttestation = await hasTrustedAttestation(
        transaction,
        principal.tenantId,
        runId,
      );
      return {
        run: mapRun(row, await metricResultRows(transaction, principal.tenantId, runId)),
        resultSubmittedByRunnerId: row.result_submitted_by_runner_id,
        resultSubmittedByUserId: row.result_submitted_by_user_id,
        runnerEvidenceVerified:
          row.runner_evidence_verified && row.execution_attestation_required && trustedAttestation,
      };
    });
  }

  async startRun(
    principal: AdminPrincipal,
    runId: string,
    request: StartAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun> {
    const prepared = await this.prepareRunExecution(principal, runId, request);
    if (prepared.state === 'already_submitted') return prepared.run;
    return this.findRun(principal, runId).then((record) =>
      required(record?.run, 'Prepared Evaluation Run was not returned.'),
    );
  }

  async prepareRunExecution(
    principal: AdminPrincipal,
    runId: string,
    request: StartAiEvaluationRunRequest,
  ): Promise<
    | { readonly state: 'already_submitted'; readonly run: AiEvaluationRun }
    | { readonly state: 'prepared'; readonly request: EvaluationRunnerExecutionRequest }
  > {
    return this.withPrincipal(
      principal,
      async (transaction) => {
        const rows = await transaction.$queryRaw<RunRow[]>(Prisma.sql`
          SELECT *
          FROM public."ai_evaluation_runs"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${runId}::uuid
          FOR UPDATE
        `);
        const run = rows[0];
        if (run === undefined) throw new NotFoundException('Evaluation Run was not found.');
        if (
          run.execution_idempotency_key === request.idempotencyKey &&
          ['SUBMITTED', 'PASSED', 'FAILED'].includes(run.status)
        ) {
          return {
            state: 'already_submitted',
            run: await loadRun(transaction, principal.tenantId, runId),
          };
        }
        if (
          run.status !== 'CREATED' &&
          !(run.status === 'RUNNING' && run.execution_idempotency_key === request.idempotencyKey)
        ) {
          throw new ConflictException(
            'Evaluation Run execution already uses another request or has finished.',
          );
        }
        if (run.status === 'CREATED' && run.revision !== request.expectedRevision) {
          throw stale('Evaluation Run');
        }
        const nonce = run.execution_nonce ?? randomBytes(32).toString('hex');
        const unsigned = await buildExecutionRequest(transaction, principal.tenantId, run, nonce);
        const requestHash = evaluationExecutionRequestHash(unsigned);
        if (run.status === 'RUNNING') {
          if (run.execution_request_hash !== requestHash) {
            throw new ConflictException(
              'The sealed Evaluation Run execution request no longer matches its persisted hash.',
            );
          }
        } else {
          const count = await transaction.$executeRaw(Prisma.sql`
            UPDATE public."ai_evaluation_runs"
            SET "status" = 'RUNNING',
                "revision" = "revision" + 1,
                "started_at" = CURRENT_TIMESTAMP,
                "execution_attestation_required" = true,
                "execution_nonce" = ${nonce},
                "execution_request_hash" = ${requestHash},
                "execution_idempotency_key" = ${request.idempotencyKey},
                "execution_requested_at" = CURRENT_TIMESTAMP,
                "updated_at" = CURRENT_TIMESTAMP
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "id" = ${runId}::uuid
              AND "status" = 'CREATED'
              AND "revision" = ${request.expectedRevision}
          `);
          if (count !== 1) throw stale('Evaluation Run');
        }
        return {
          state: 'prepared',
          request: { ...unsigned, requestHash },
        };
      },
      { timeout: 30_000 },
    );
  }

  async commitAttestedRun(
    principal: AdminPrincipal,
    attestation: EvaluationRunnerAttestation,
  ): Promise<AiEvaluationRun> {
    return this.withPrincipal(
      principal,
      async (transaction) => {
        const rows = await transaction.$queryRaw<RunRow[]>(Prisma.sql`
          SELECT *
          FROM public."ai_evaluation_runs"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${attestation.runId}::uuid
          FOR UPDATE
        `);
        const run = rows[0];
        if (run === undefined) throw new NotFoundException('Evaluation Run was not found.');
        const existing = await transaction.$queryRaw<
          Array<{ result_payload_hash: string }>
        >(Prisma.sql`
          SELECT btrim("result_payload_hash") AS "result_payload_hash"
          FROM public."ai_evaluation_runner_attestations"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "run_id" = ${attestation.runId}::uuid
        `);
        if (run.status !== 'RUNNING') {
          if (
            ['SUBMITTED', 'PASSED', 'FAILED'].includes(run.status) &&
            existing[0]?.result_payload_hash === attestation.resultPayloadHash
          ) {
            return loadRun(transaction, principal.tenantId, run.id);
          }
          throw new ConflictException('Evaluation Run is no longer accepting runner results.');
        }
        if (
          run.runner_id !== attestation.runnerId ||
          run.execution_nonce !== attestation.nonce ||
          run.execution_request_hash !== attestation.requestHash ||
          run.runner_attestation_key_fingerprint !== attestation.keyFingerprint
        ) {
          throw new ConflictException(
            'Runner attestation does not bind the sealed Evaluation Run request.',
          );
        }
        const registered = await transaction.$queryRaw<
          Array<{ allowed_evidence_origins: unknown }>
        >(Prisma.sql`
          SELECT "allowed_evidence_origins"
          FROM public."ai_evaluation_runners"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${run.runner_id}::uuid
            AND "status" = 'ACTIVE'
        `);
        const evidenceOrigin = `${new URL(attestation.evidenceBundleUri).origin}/`;
        if (
          registered[0] === undefined ||
          !jsonStrings(registered[0].allowed_evidence_origins).includes(evidenceOrigin)
        ) {
          throw new ConflictException(
            'Evaluation evidence must come from an origin registered for the active runner.',
          );
        }
        const verifiedAt = new Date();
        await transaction.$queryRaw`
          SELECT set_config('app.evaluation_runner_id', ${run.runner_id}, true)
        `;
        await transaction.$queryRaw`
          SELECT set_config(
            'app.evaluation_attestation_result_hash',
            ${attestation.resultPayloadHash},
            true
          )
        `;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."ai_evaluation_runner_attestations" (
            "id", "tenant_id", "run_id", "runner_id", "nonce",
            "execution_request_hash", "result_payload_hash",
            "evidence_bundle_uri", "evidence_bundle_hash", "evidence_bundle",
            "algorithm", "key_fingerprint", "signature",
            "issued_at", "verified_at", "consumed_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${principal.tenantId}::uuid,
            ${run.id}::uuid, ${run.runner_id}::uuid, ${attestation.nonce},
            ${attestation.requestHash}, ${attestation.resultPayloadHash},
            ${attestation.evidenceBundleUri}, ${attestation.evidenceBundleHash},
            ${JSON.stringify(evidenceBundleJson(attestation))}::jsonb,
            ${attestation.algorithm}, ${attestation.keyFingerprint},
            ${attestation.signature}, ${new Date(attestation.issuedAt)},
            ${verifiedAt}, ${verifiedAt}
          )
        `);
        for (const result of attestation.evidenceBundle.caseResults) {
          const resultId = randomUUID();
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."ai_evaluation_case_results" (
              "id", "tenant_id", "run_id", "case_id", "judge_type", "passed", "score",
              "actual_behavior_hash", "detail"
            ) VALUES (
              ${resultId}::uuid, ${principal.tenantId}::uuid, ${run.id}::uuid,
              ${result.caseId}::uuid,
              ${result.judgeType}::public."AiEvaluationJudgeType",
              ${result.passed}, ${result.score}, ${result.actualBehaviorHash}, ${result.detail}
            )
          `);
          await insertTrustedEvidence(
            transaction,
            'ai_evaluation_case_result_evidence',
            'case_result_id',
            resultId,
            principal.tenantId,
            result.evidenceIds,
          );
        }
        for (const metric of attestation.evidenceBundle.metrics) {
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."ai_evaluation_metric_results" (
              "tenant_id", "run_id", "metric", "numerator", "denominator", "value",
              "threshold", "direction", "sample_count", "minimum_sample_count", "passed"
            ) VALUES (
              ${principal.tenantId}::uuid, ${run.id}::uuid,
              ${metric.metric}::public."AiEvaluationMetric", ${metric.numerator},
              ${metric.denominator}, ${metric.value}, ${metric.threshold},
              ${metric.direction}::public."AiEvaluationThresholdDirection",
              ${metric.sampleCount}, ${metric.minimumSampleCount}, ${metric.passed}
            )
          `);
          await insertMetricEvidence(
            transaction,
            principal.tenantId,
            run.id,
            metric.metric,
            metric.evidenceIds,
          );
        }
        const count = await transaction.$executeRaw(Prisma.sql`
          UPDATE public."ai_evaluation_runs"
          SET "status" = 'SUBMITTED',
              "revision" = "revision" + 1,
              "submitted_case_count" = ${attestation.evidenceBundle.caseResults.length},
              "evidence_bundle_uri" = ${attestation.evidenceBundleUri},
              "evidence_bundle_hash" = ${attestation.evidenceBundleHash},
              "runner_attestation" = ${JSON.stringify(attestationEnvelope(attestation))},
              "runner_evidence_verified" = true,
              "result_submitted_by_runner_id" = "runner_id",
              "result_submitted_by_user_id" = NULL,
              "submitted_at" = CURRENT_TIMESTAMP,
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${run.id}::uuid
            AND "status" = 'RUNNING'
            AND "revision" = ${run.revision}
        `);
        if (count !== 1) throw stale('Evaluation Run');
        return loadRun(transaction, principal.tenantId, run.id);
      },
      { timeout: 30_000 },
    );
  }

  async submitRun(
    principal: AdminPrincipal,
    runId: string,
    request: SubmitAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun> {
    return this.withPrincipal(
      principal,
      async (transaction) => {
        const runs = await transaction.$queryRaw<RunRow[]>(Prisma.sql`
        SELECT * FROM public."ai_evaluation_runs"
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `);
        const run = runs[0];
        if (run === undefined) throw new NotFoundException('Evaluation Run was not found.');
        if (run.status !== 'RUNNING' || run.revision !== request.expectedRevision) {
          throw stale('Evaluation Run');
        }
        const registeredRunners = await transaction.$queryRaw<
          Array<{ allowed_evidence_origins: unknown }>
        >(Prisma.sql`
          SELECT "allowed_evidence_origins"
          FROM public."ai_evaluation_runners"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${run.runner_id}::uuid
            AND "status" = 'ACTIVE'
        `);
        const evidenceOrigin = `${new URL(request.evidenceBundleUri).origin}/`;
        if (
          registeredRunners[0] === undefined ||
          !jsonStrings(registeredRunners[0].allowed_evidence_origins).includes(evidenceOrigin)
        ) {
          throw new ConflictException(
            'Evaluation evidence must come from an origin registered for the active runner.',
          );
        }
        const validCases = await transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count(*)::integer AS count
        FROM public."ai_evaluation_cases" test_case
        WHERE test_case."tenant_id" = ${principal.tenantId}::uuid
          AND test_case."dataset_version_id" = ${run.dataset_version_id}::uuid
          AND test_case."id" IN (${Prisma.join(request.caseResults.map(({ caseId }) => Prisma.sql`${caseId}::uuid`))})
      `);
        if (
          request.caseResults.length !== run.expected_case_count ||
          validCases[0]?.count !== run.expected_case_count
        ) {
          throw new ConflictException(
            'Run submission must cover every sealed dataset case exactly once.',
          );
        }
        for (const result of request.caseResults) {
          const resultId = randomUUID();
          await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."ai_evaluation_case_results" (
            "id", "tenant_id", "run_id", "case_id", "judge_type", "passed", "score",
            "actual_behavior_hash", "detail"
          ) VALUES (
            ${resultId}::uuid, ${principal.tenantId}::uuid, ${runId}::uuid,
            ${result.caseId}::uuid, ${result.judgeType}::public."AiEvaluationJudgeType",
            ${result.passed}, ${result.score}, ${result.actualBehaviorHash}, ${result.detail}
          )
        `);
          await insertTrustedEvidence(
            transaction,
            'ai_evaluation_case_result_evidence',
            'case_result_id',
            resultId,
            principal.tenantId,
            result.evidenceIds,
          );
        }
        for (const metric of request.metrics) {
          await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."ai_evaluation_metric_results" (
            "tenant_id", "run_id", "metric", "numerator", "denominator", "value",
            "threshold", "direction", "sample_count", "minimum_sample_count", "passed"
          ) VALUES (
            ${principal.tenantId}::uuid, ${runId}::uuid,
            ${metric.metric}::public."AiEvaluationMetric", ${metric.numerator},
            ${metric.denominator}, ${metric.value}, ${metric.threshold},
            ${metric.direction}::public."AiEvaluationThresholdDirection",
            ${metric.sampleCount}, ${metric.minimumSampleCount}, ${metric.passed}
          )
        `);
          await insertMetricEvidence(
            transaction,
            principal.tenantId,
            runId,
            metric.metric,
            metric.evidenceIds,
          );
        }
        const count = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_runs"
        SET "status" = 'SUBMITTED', "revision" = "revision" + 1,
            "submitted_case_count" = ${request.caseResults.length},
            "evidence_bundle_uri" = ${request.evidenceBundleUri},
            "evidence_bundle_hash" = ${request.evidenceBundleHash},
            "runner_attestation" = ${request.runnerAttestation},
            "result_submitted_by_runner_id" = "runner_id",
            "result_submitted_by_user_id" = ${principal.userId}::uuid,
            "submitted_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${runId}::uuid
          AND "status" = 'RUNNING' AND "revision" = ${request.expectedRevision}
      `);
        if (count !== 1) throw stale('Evaluation Run');
        return loadRun(transaction, principal.tenantId, runId);
      },
      { timeout: 30_000 },
    );
  }

  async verifyRun(
    principal: AdminPrincipal,
    runId: string,
    status: 'PASSED' | 'FAILED',
    request: VerifyAiEvaluationRunRequest,
  ): Promise<AiEvaluationRun> {
    return this.withPrincipal(principal, async (transaction) => {
      await insertTrustedEvidence(
        transaction,
        'ai_evaluation_verification_evidence',
        'run_id',
        runId,
        principal.tenantId,
        request.evidenceIds,
      );
      const count = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_runs"
        SET "status" = ${status}::public."AiEvaluationRunStatus",
            "runner_evidence_verified" = true,
            "verified_by_user_id" = ${principal.userId}::uuid,
            "verification_evidence_count" = ${request.evidenceIds.length},
            "verified_at" = CURRENT_TIMESTAMP, "finished_at" = CURRENT_TIMESTAMP,
            "revision" = "revision" + 1, "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${runId}::uuid
          AND "status" = 'SUBMITTED' AND "revision" = ${request.expectedRevision}
          AND "result_submitted_by_user_id" IS DISTINCT FROM ${principal.userId}::uuid
      `);
      if (count !== 1) throw stale('Evaluation Run');
      return loadRun(transaction, principal.tenantId, runId);
    });
  }

  async ingestBadCase(
    principal: AdminPrincipal,
    request: IngestAiEvaluationBadCaseRequest,
  ): Promise<{ readonly id: string; readonly status: string; readonly revision: number }> {
    return this.withPrincipal(principal, async (transaction) => {
      const hash = runtimeHash(request);
      const rows = await transaction.$queryRaw<BadCaseRow[]>(Prisma.sql`
        SELECT * FROM public."ai_evaluation_bad_cases"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "idempotency_key" = ${request.idempotencyKey}
      `);
      if (rows[0] !== undefined) {
        requireSameHash(rows[0].request_hash, hash);
        return mapBadCase(rows[0]);
      }
      const id = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_evaluation_bad_cases" (
          "id", "tenant_id", "source_type", "source_id", "source_version", "category",
          "sanitized_input", "source_snapshot_hash", "reported_by_user_id",
          "idempotency_key", "request_hash"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${request.sourceType},
          ${request.sourceId}::uuid, ${request.sourceVersion},
          ${request.category}::public."AiEvaluationCategory", ${request.sanitizedInput},
          ${request.sourceSnapshotHash}, ${principal.userId}::uuid,
          ${request.idempotencyKey}, ${hash}
        )
      `);
      await insertTrustedEvidence(
        transaction,
        'ai_evaluation_bad_case_evidence',
        'bad_case_id',
        id,
        principal.tenantId,
        request.evidenceIds,
      );
      return { id, status: 'RECEIVED', revision: 1 };
    });
  }

  async triageBadCase(
    principal: AdminPrincipal,
    badCaseId: string,
    request: TriageAiEvaluationBadCaseRequest,
  ): Promise<{ readonly id: string; readonly status: string; readonly revision: number }> {
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<BadCaseRow[]>(Prisma.sql`
        SELECT * FROM public."ai_evaluation_bad_cases"
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${badCaseId}::uuid
        FOR UPDATE
      `);
      const badCase = rows[0];
      if (badCase === undefined) throw new NotFoundException('Evaluation Bad Case was not found.');
      if (badCase.status !== 'RECEIVED' || badCase.revision !== request.expectedRevision) {
        throw stale('Evaluation Bad Case');
      }
      if (badCase.reported_by_user_id === principal.userId) {
        throw new ConflictException('Bad Case triage must be independent from reporting.');
      }
      if (request.action === 'ADD_TO_DATASET') {
        const targets = await transaction.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT "status"::text
          FROM public."ai_evaluation_dataset_versions"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${request.datasetVersionId}::uuid
        `);
        if (targets[0]?.status !== 'DRAFT') {
          throw new ConflictException('Bad Cases can only be routed to a draft dataset.');
        }
      }
      const status = request.action === 'DISMISS' ? 'DISMISSED' : 'TRIAGED';
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_evaluation_bad_cases"
        SET "status" = ${status}::public."AiEvaluationBadCaseStatus",
            "mapped_dataset_version_id" = ${request.action === 'ADD_TO_DATASET' ? request.datasetVersionId : null}::uuid,
            "triaged_by_user_id" = ${principal.userId}::uuid,
            "triage_reason" = ${request.reason},
            "revision" = "revision" + 1, "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid AND "id" = ${badCaseId}::uuid
          AND "revision" = ${request.expectedRevision}
      `);
      return { id: badCaseId, status, revision: request.expectedRevision + 1 };
    });
  }

  async loadReadiness(
    principal: AdminPrincipal,
    query: AiEvaluationReadinessQuery,
  ): Promise<ReleaseReadinessRecord> {
    return this.withPrincipal(principal, async (transaction) => {
      const versions = await datasetVersionRows(
        transaction,
        principal.tenantId,
        query.datasetVersionId,
      );
      const dataset =
        versions[0] === undefined
          ? null
          : mapDatasetVersion(
              versions[0],
              await thresholdRows(transaction, principal.tenantId, query.datasetVersionId),
            );
      const categories = await transaction.$queryRaw<Array<{ category: string }>>(Prisma.sql`
        SELECT DISTINCT "category"::text AS category
        FROM public."ai_evaluation_cases"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "dataset_version_id" = ${query.datasetVersionId}::uuid
        ORDER BY "category"::text
      `);
      const runs = await transaction.$queryRaw<RunRow[]>(Prisma.sql`
        SELECT *
        FROM public."ai_evaluation_runs"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "dataset_version_id" = ${query.datasetVersionId}::uuid
          AND "subject_type" = ${query.subjectType}::public."AiEvaluationSubjectType"
          AND "subject_id" = ${query.subjectId}::uuid
          AND "subject_version" = ${query.subjectVersion}
          AND (${query.evaluationRunId ?? null}::uuid IS NULL
            OR "id" = ${query.evaluationRunId ?? null}::uuid)
          AND "status" = 'PASSED'
          AND "execution_attestation_required"
          AND EXISTS (
            SELECT 1
            FROM public."ai_evaluation_runner_attestations" attestation
            WHERE attestation."tenant_id" = "ai_evaluation_runs"."tenant_id"
              AND attestation."run_id" = "ai_evaluation_runs"."id"
              AND attestation."runner_id" = "ai_evaluation_runs"."runner_id"
              AND btrim(attestation."nonce") = btrim("ai_evaluation_runs"."execution_nonce")
              AND btrim(attestation."execution_request_hash")
                = btrim("ai_evaluation_runs"."execution_request_hash")
          )
        ORDER BY "finished_at" DESC, "id" DESC
        LIMIT 1
      `);
      const runRow = runs[0];
      const run =
        runRow === undefined
          ? null
          : mapRun(runRow, await metricResultRows(transaction, principal.tenantId, runRow.id));
      const currentSnapshotHash = await resolveSubjectSnapshotHash(
        transaction,
        principal.tenantId,
        query,
        dataset,
      );
      return {
        dataset,
        caseCategories: categories.map(({ category }) => category),
        run,
        runnerEvidenceVerified:
          runRow?.runner_evidence_verified === true &&
          runRow.execution_attestation_required === true,
        currentSnapshotHash,
      };
    });
  }

  async recordReadiness(
    principal: AdminPrincipal,
    query: AiEvaluationReadinessQuery,
    readiness: {
      readonly ready: boolean;
      readonly passingRunId: string | null;
      readonly evaluatedSnapshotHash: string | null;
      readonly blockers: readonly unknown[];
      readonly checkedAt: string;
    },
  ): Promise<void> {
    await this.withPrincipal(principal, async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_evaluation_release_checks" (
          "id", "tenant_id", "subject_type", "subject_id", "subject_version",
          "dataset_version_id", "run_id", "current_snapshot_hash",
          "evaluated_snapshot_hash", "ready", "blockers", "checked_by_user_id", "checked_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${principal.tenantId}::uuid,
          ${query.subjectType}::public."AiEvaluationSubjectType", ${query.subjectId}::uuid,
          ${query.subjectVersion}, ${query.datasetVersionId}::uuid,
          ${readiness.passingRunId}::uuid, ${query.currentSnapshotHash},
          ${readiness.evaluatedSnapshotHash}, ${readiness.ready},
          ${JSON.stringify(readiness.blockers)}::jsonb, ${principal.userId}::uuid,
          ${new Date(readiness.checkedAt)}
        )
      `);
    });
  }

  private withPrincipal<T>(
    principal: AdminPrincipal,
    operation: (transaction: Transaction) => Promise<T>,
    options?: { readonly timeout?: number },
  ): Promise<T> {
    return this.prisma.withTenant(
      principal.tenantId,
      async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
        return operation(transaction);
      },
      options,
    );
  }
}

async function loadDatasetVersion(
  transaction: Transaction,
  tenantId: string,
  versionId: string,
): Promise<AiEvaluationDatasetVersion> {
  const rows = await datasetVersionRows(transaction, tenantId, versionId);
  return mapDatasetVersion(
    required(rows[0], 'Evaluation Dataset Version was not found.'),
    await thresholdRows(transaction, tenantId, versionId),
  );
}

async function buildExecutionRequest(
  transaction: Transaction,
  tenantId: string,
  run: RunRow,
  nonce: string,
): Promise<Omit<EvaluationRunnerExecutionRequest, 'requestHash'>> {
  const version = await loadDatasetVersion(transaction, tenantId, run.dataset_version_id);
  if (version.status !== 'PUBLISHED') {
    throw new ConflictException('Evaluation execution requires a published dataset version.');
  }
  const sealedHash = await sealedDatasetHash(transaction, tenantId, version.id);
  if (sealedHash !== version.contentHash) {
    throw new ConflictException(
      'Evaluation Dataset Version content no longer matches its sealed snapshot.',
    );
  }
  const currentSubjectHash = await resolveSubjectSnapshotHash(
    transaction,
    tenantId,
    {
      subjectType: run.subject_type as AiEvaluationReadinessQuery['subjectType'],
      subjectId: run.subject_id,
      subjectVersion: run.subject_version,
      datasetVersionId: run.dataset_version_id,
      currentSnapshotHash: run.subject_snapshot_hash,
    },
    version,
  );
  if (currentSubjectHash !== run.subject_snapshot_hash) {
    throw new ConflictException(
      'Evaluation subject changed after Run creation. Create a new Run for the new snapshot.',
    );
  }
  const runners = await transaction.$queryRaw<
    Array<{ status: string; allowed_evidence_origins: unknown }>
  >(Prisma.sql`
    SELECT "status", "allowed_evidence_origins"
    FROM public."ai_evaluation_runners"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${run.runner_id}::uuid
  `);
  const runner = runners[0];
  const evidenceOrigins = runner === undefined ? [] : jsonStrings(runner.allowed_evidence_origins);
  if (runner?.status !== 'ACTIVE' || evidenceOrigins[0] === undefined) {
    throw new ConflictException('The registered evaluation runner is unavailable.');
  }
  const caseRows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM public."ai_evaluation_cases"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "dataset_version_id" = ${version.id}::uuid
    ORDER BY "case_key", "id"
  `);
  if (caseRows.length !== version.caseCount || caseRows.length !== run.expected_case_count) {
    throw new ConflictException('The sealed Evaluation Dataset case coverage changed.');
  }
  const cases = await Promise.all(
    caseRows.map(async ({ id }) => {
      const testCase = await loadCase(transaction, tenantId, id);
      const evidenceIds = await executionEvidenceIds(transaction, tenantId, id);
      if (evidenceIds.length === 0) {
        throw new ConflictException(
          `Evaluation Case ${testCase.caseKey} has no active verified execution evidence.`,
        );
      }
      return {
        caseId: testCase.id,
        category: testCase.category,
        input: testCase.input,
        context: testCase.context,
        expectedBehavior: testCase.expectedBehavior,
        forbiddenBehaviors: testCase.forbiddenBehaviors,
        metricWeights: testCase.scoring.metricWeights,
        evidenceIds,
      };
    }),
  );
  const subject = await loadExecutionSubject(transaction, tenantId, run, version);
  return {
    schemaVersion: 1,
    tenantId,
    runId: run.id,
    runnerId: run.runner_id,
    runnerName: run.runner_name,
    nonce,
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    subjectType: run.subject_type as EvaluationRunnerExecutionRequest['subjectType'],
    subjectId: run.subject_id,
    subjectVersion: run.subject_version,
    subjectSnapshotHash: run.subject_snapshot_hash,
    systemPrompt: subject.systemPrompt,
    knowledgeContext: subject.knowledgeContext,
    modelRoute: subject.modelRoute,
    cases,
    thresholds: version.thresholds.map((threshold) => ({
      metric: threshold.metric,
      direction: threshold.direction,
      threshold: threshold.threshold,
      minimumSampleCount: threshold.minimumSampleCount,
      required: threshold.required,
    })),
    evidenceOrigin: evidenceOrigins[0],
  };
}

async function executionEvidenceIds(
  transaction: Transaction,
  tenantId: string,
  caseId: string,
): Promise<string[]> {
  const rows = await transaction.$queryRaw<Array<{ evidence_id: string }>>(Prisma.sql`
    SELECT DISTINCT source."evidence_id"
    FROM (
      SELECT link."evidence_id", link."evidence_version"
      FROM public."ai_evaluation_case_evidence" link
      WHERE link."tenant_id" = ${tenantId}::uuid
        AND link."case_id" = ${caseId}::uuid
      UNION
      SELECT link."evidence_id", link."evidence_version"
      FROM public."ai_evaluation_annotations" annotation
      JOIN public."ai_evaluation_annotation_evidence" link
        ON link."tenant_id" = annotation."tenant_id"
       AND link."annotation_id" = annotation."id"
      WHERE annotation."tenant_id" = ${tenantId}::uuid
        AND annotation."case_id" = ${caseId}::uuid
        AND annotation."label" <> 'ABSTAIN'
    ) source
    JOIN public."evidence" evidence
      ON evidence."tenant_id" = ${tenantId}::uuid
     AND evidence."id" = source."evidence_id"
     AND evidence."version" = source."evidence_version"
     AND evidence."status" = 'ACTIVE'
     AND evidence."trust_level" = 'VERIFIED'
     AND evidence."verified_at" IS NOT NULL
    ORDER BY source."evidence_id"
  `);
  return rows.map(({ evidence_id }) => evidence_id);
}

async function loadExecutionSubject(
  transaction: Transaction,
  tenantId: string,
  run: RunRow,
  dataset: AiEvaluationDatasetVersion,
): Promise<{
  readonly systemPrompt: string | null;
  readonly knowledgeContext: string | null;
  readonly modelRoute: EvaluationRunnerExecutionRequest['modelRoute'];
}> {
  if (run.subject_type === 'KNOWLEDGE_VERSION') {
    return {
      systemPrompt: null,
      knowledgeContext: await sealedKnowledgeContext(transaction, tenantId, [run.subject_id], true),
      modelRoute: null,
    };
  }
  const rows = await transaction.$queryRaw<
    Array<{ system_prompt: string; model_policy: Prisma.JsonValue }>
  >(Prisma.sql`
    SELECT "system_prompt", "model_policy"
    FROM public."agent_versions"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${run.subject_id}::uuid
      AND "version" = ${run.subject_version}
  `);
  const agent = rows[0];
  if (agent === undefined) throw new NotFoundException('Agent Version was not found.');
  const modelRoute = await resolveTrustedModelRouteSnapshot(transaction, {
    tenantId,
    existingSnapshot: null,
    modelPolicy: agent.model_policy,
    effectiveClassification: readModelRouteRequest(agent.model_policy).classification,
  });
  if (modelRoute === null) {
    throw new ConflictException('Evaluation execution requires a trusted model route.');
  }
  const knowledgeIds =
    run.subject_type === 'COMPOSITE_RELEASE' ? dataset.targets.knowledgeVersionIds : [];
  return {
    systemPrompt: agent.system_prompt,
    knowledgeContext:
      knowledgeIds.length === 0
        ? null
        : await sealedKnowledgeContext(transaction, tenantId, knowledgeIds, false),
    modelRoute,
  };
}

async function sealedKnowledgeContext(
  transaction: Transaction,
  tenantId: string,
  versionIds: readonly string[],
  allowUnpublishedCandidate: boolean,
): Promise<string> {
  const publicationBoundary = allowUnpublishedCandidate
    ? Prisma.empty
    : Prisma.sql`AND version."published_at" IS NOT NULL`;
  const rows = await transaction.$queryRaw<
    Array<{ document_version_id: string; chunk_index: number; content: string }>
  >(Prisma.sql`
    SELECT chunk."document_version_id", chunk."chunk_index", chunk."content"
    FROM public."knowledge_chunks" chunk
    JOIN public."knowledge_document_versions" version
      ON version."tenant_id" = chunk."tenant_id"
     AND version."id" = chunk."document_version_id"
    WHERE chunk."tenant_id" = ${tenantId}::uuid
      AND chunk."document_version_id" IN (
        ${Prisma.join(versionIds.map((id) => Prisma.sql`${id}::uuid`))}
      )
      AND version."status" = 'READY'
      AND version."governance_review_status" = 'APPROVED'
      AND (
        version."source_type" NOT IN ('FILE', 'WEB')
        OR version."parse_review_status" = 'APPROVED'
      )
      ${publicationBoundary}
      AND version."effective_from" <= CURRENT_TIMESTAMP
      AND (version."expires_at" IS NULL OR version."expires_at" > CURRENT_TIMESTAMP)
    ORDER BY chunk."document_version_id", chunk."chunk_index"
  `);
  if (
    rows.length === 0 ||
    new Set(rows.map(({ document_version_id }) => document_version_id)).size !== versionIds.length
  ) {
    throw new ConflictException(
      allowUnpublishedCandidate
        ? 'Knowledge evaluation requires an approved, effective, non-empty READY candidate.'
        : 'Knowledge evaluation requires published, approved, non-empty knowledge chunks.',
    );
  }
  const content = rows
    .map(
      ({ document_version_id, chunk_index, content: chunk }) =>
        `[${document_version_id}:${chunk_index}]\n${chunk}`,
    )
    .join('\n\n');
  if (Buffer.byteLength(content, 'utf8') > 1_000_000) {
    throw new ConflictException(
      'The sealed knowledge evaluation corpus exceeds the trusted runner payload limit.',
    );
  }
  return content;
}

function evidenceBundleJson(attestation: EvaluationRunnerAttestation): unknown {
  const bundle = attestation.evidenceBundle;
  return {
    schema_version: 1,
    tenant_id: bundle.tenantId,
    run_id: bundle.runId,
    runner_id: bundle.runnerId,
    nonce: bundle.nonce,
    request_hash: bundle.requestHash,
    subject_snapshot_hash: bundle.subjectSnapshotHash,
    dataset_content_hash: bundle.datasetContentHash,
    case_results: bundle.caseResults.map((result) => ({
      case_id: result.caseId,
      judge_type: result.judgeType,
      passed: result.passed,
      score: result.score,
      actual_behavior_hash: result.actualBehaviorHash,
      evidence_ids: result.evidenceIds,
      detail: result.detail,
    })),
    metrics: bundle.metrics.map((metric) => ({
      metric: metric.metric,
      numerator: metric.numerator,
      denominator: metric.denominator,
      value: metric.value,
      threshold: metric.threshold,
      direction: metric.direction,
      sample_count: metric.sampleCount,
      minimum_sample_count: metric.minimumSampleCount,
      passed: metric.passed,
      evidence_ids: metric.evidenceIds,
    })),
    generated_at: bundle.generatedAt,
  };
}

function attestationEnvelope(attestation: EvaluationRunnerAttestation): unknown {
  return {
    schemaVersion: 1,
    algorithm: attestation.algorithm,
    keyFingerprint: attestation.keyFingerprint,
    runnerId: attestation.runnerId,
    nonce: attestation.nonce,
    requestHash: attestation.requestHash,
    resultPayloadHash: attestation.resultPayloadHash,
    evidenceBundleHash: attestation.evidenceBundleHash,
    issuedAt: attestation.issuedAt,
    signature: attestation.signature,
  };
}

function datasetVersionRows(transaction: Transaction, tenantId: string, versionId: string) {
  return transaction.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT version.*, coalesce(
      (
        SELECT jsonb_agg(review."evidence_id" ORDER BY review."evidence_id")
        FROM public."ai_evaluation_review_evidence" review
        WHERE review."tenant_id" = version."tenant_id"
          AND review."dataset_version_id" = version."id"
      ),
      '[]'::jsonb
    ) AS review_evidence_ids
    FROM public."ai_evaluation_dataset_versions" version
    WHERE version."tenant_id" = ${tenantId}::uuid AND version."id" = ${versionId}::uuid
  `);
}

function thresholdRows(transaction: Transaction, tenantId: string, versionId: string) {
  return transaction.$queryRaw<ThresholdRow[]>(Prisma.sql`
    SELECT "metric"::text, "direction"::text, "threshold", "minimum_sample_count", "required"
    FROM public."ai_evaluation_thresholds"
    WHERE "tenant_id" = ${tenantId}::uuid AND "dataset_version_id" = ${versionId}::uuid
    ORDER BY "metric"::text
  `);
}

async function loadCase(
  transaction: Transaction,
  tenantId: string,
  caseId: string,
): Promise<AiEvaluationCase> {
  const rows = await transaction.$queryRaw<CaseRow[]>(Prisma.sql`
    SELECT * FROM public."ai_evaluation_cases"
    WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${caseId}::uuid
  `);
  const row = required(rows[0], 'Evaluation Case was not found.');
  const evidence = await transaction.$queryRaw<Array<{ evidence_id: string }>>(Prisma.sql`
    SELECT "evidence_id" FROM public."ai_evaluation_case_evidence"
    WHERE "tenant_id" = ${tenantId}::uuid AND "case_id" = ${caseId}::uuid
    ORDER BY "evidence_id"
  `);
  return aiEvaluationCaseSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    datasetVersionId: row.dataset_version_id,
    caseKey: row.case_key,
    category: row.category,
    input: row.input,
    context: row.context,
    expectedBehavior: row.expected_behavior,
    requiredEvidenceIds: evidence.map(({ evidence_id }) => evidence_id),
    forbiddenBehaviors: row.forbidden_behaviors,
    scoring: row.scoring,
    sourceBadCaseId: row.source_bad_case_id,
    contentHash: row.content_hash,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
  });
}

async function loadRun(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<AiEvaluationRun> {
  const rows = await runRows(transaction, tenantId, runId);
  return mapRun(
    required(rows[0], 'Evaluation Run was not found.'),
    await metricResultRows(transaction, tenantId, runId),
  );
}

async function hasTrustedAttestation(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ trusted: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM public."ai_evaluation_runs" run
      JOIN public."ai_evaluation_runner_attestations" attestation
        ON attestation."tenant_id" = run."tenant_id"
       AND attestation."run_id" = run."id"
       AND attestation."runner_id" = run."runner_id"
       AND btrim(attestation."nonce") = btrim(run."execution_nonce")
       AND btrim(attestation."execution_request_hash") = btrim(run."execution_request_hash")
      WHERE run."tenant_id" = ${tenantId}::uuid
        AND run."id" = ${runId}::uuid
        AND run."execution_attestation_required"
    ) AS trusted
  `);
  return rows[0]?.trusted === true;
}

function runRows(transaction: Transaction, tenantId: string, runId: string) {
  return transaction.$queryRaw<RunRow[]>(Prisma.sql`
    SELECT * FROM public."ai_evaluation_runs"
    WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${runId}::uuid
  `);
}

async function metricResultRows(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<MetricRow[]> {
  return transaction.$queryRaw<MetricRow[]>(Prisma.sql`
    SELECT metric.*, coalesce(
      (
        SELECT jsonb_agg(evidence."evidence_id" ORDER BY evidence."evidence_id")
        FROM public."ai_evaluation_metric_result_evidence" evidence
        WHERE evidence."tenant_id" = metric."tenant_id"
          AND evidence."run_id" = metric."run_id"
          AND evidence."metric" = metric."metric"
      ),
      '[]'::jsonb
    ) AS evidence_ids
    FROM public."ai_evaluation_metric_results" metric
    WHERE metric."tenant_id" = ${tenantId}::uuid AND metric."run_id" = ${runId}::uuid
    ORDER BY metric."metric"::text
  `);
}

async function insertTrustedEvidence(
  transaction: Transaction,
  table: EvidenceTable,
  parentColumn: EvidenceParentColumn,
  parentId: string,
  tenantId: string,
  evidenceIds: readonly string[],
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    const count = await transaction.$executeRawUnsafe(
      `INSERT INTO public."${table}" (
         "tenant_id", "${parentColumn}", "evidence_id", "evidence_version"
       )
       SELECT $1::uuid, $2::uuid, evidence."id", evidence."version"
       FROM public."evidence" evidence
       WHERE evidence."tenant_id" = $1::uuid
         AND evidence."id" = $3::uuid
         AND evidence."status" = 'ACTIVE'
         AND evidence."trust_level" = 'VERIFIED'
         AND evidence."verified_at" IS NOT NULL
       ON CONFLICT DO NOTHING`,
      tenantId,
      parentId,
      evidenceId,
    );
    if (count !== 1) {
      const exists = await transaction.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM public."${table}"
           WHERE "tenant_id" = $1::uuid AND "${parentColumn}" = $2::uuid
             AND "evidence_id" = $3::uuid
         ) AS present`,
        tenantId,
        parentId,
        evidenceId,
      );
      if (exists[0]?.present !== true) {
        throw new ConflictException(
          'Evaluation evidence must be active, verified and tenant-scoped.',
        );
      }
    }
  }
}

async function insertMetricEvidence(
  transaction: Transaction,
  tenantId: string,
  runId: string,
  metric: string,
  evidenceIds: readonly string[],
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    const count = await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."ai_evaluation_metric_result_evidence" (
        "tenant_id", "run_id", "metric", "evidence_id", "evidence_version"
      )
      SELECT ${tenantId}::uuid, ${runId}::uuid,
             ${metric}::public."AiEvaluationMetric", evidence."id", evidence."version"
      FROM public."evidence" evidence
      WHERE evidence."tenant_id" = ${tenantId}::uuid
        AND evidence."id" = ${evidenceId}::uuid
        AND evidence."status" = 'ACTIVE'
        AND evidence."trust_level" = 'VERIFIED'
        AND evidence."verified_at" IS NOT NULL
    `);
    if (count !== 1) {
      throw new ConflictException('Metric evidence must be active, verified and tenant-scoped.');
    }
  }
}

async function sealedDatasetHash(
  transaction: Transaction,
  tenantId: string,
  versionId: string,
): Promise<string> {
  const version = await datasetVersionRows(transaction, tenantId, versionId);
  const cases = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT test_case."id", test_case."case_key", test_case."content_hash",
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'evidenceId', case_evidence."evidence_id",
                 'evidenceVersion', case_evidence."evidence_version"
               )
               ORDER BY case_evidence."evidence_id", case_evidence."evidence_version"
             ) FILTER (WHERE case_evidence."evidence_id" IS NOT NULL),
             '[]'::jsonb
           ) AS evidence
    FROM public."ai_evaluation_cases" test_case
    LEFT JOIN public."ai_evaluation_case_evidence" case_evidence
      ON case_evidence."tenant_id" = test_case."tenant_id"
     AND case_evidence."case_id" = test_case."id"
    WHERE test_case."tenant_id" = ${tenantId}::uuid
      AND test_case."dataset_version_id" = ${versionId}::uuid
    GROUP BY test_case."id"
    ORDER BY test_case."case_key", test_case."id"
  `);
  const annotations = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT annotation."id", annotation."case_id", annotation."annotator_user_id",
           annotation."label", annotation."expected_score"::text AS expected_score,
           annotation."rationale", annotation."revision",
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'evidenceId', annotation_evidence."evidence_id",
                 'evidenceVersion', annotation_evidence."evidence_version"
               )
               ORDER BY annotation_evidence."evidence_id",
                        annotation_evidence."evidence_version"
             ) FILTER (WHERE annotation_evidence."evidence_id" IS NOT NULL),
             '[]'::jsonb
           ) AS evidence
    FROM public."ai_evaluation_annotations" annotation
    LEFT JOIN public."ai_evaluation_annotation_evidence" annotation_evidence
      ON annotation_evidence."tenant_id" = annotation."tenant_id"
     AND annotation_evidence."annotation_id" = annotation."id"
    WHERE annotation."tenant_id" = ${tenantId}::uuid
      AND annotation."dataset_version_id" = ${versionId}::uuid
    GROUP BY annotation."id"
    ORDER BY annotation."case_id", annotation."id"
  `);
  const thresholds = await thresholdRows(transaction, tenantId, versionId);
  const row = required(version[0], 'Evaluation Dataset Version was not found.');
  return runtimeHash({
    annotations,
    cases,
    description: row.description,
    requiredCategories: row.required_categories,
    targets: row.targets,
    thresholds: thresholds.map(mapThreshold),
  });
}

async function resolveSubjectSnapshotHash(
  transaction: Transaction,
  tenantId: string,
  query: AiEvaluationReadinessQuery,
  dataset: AiEvaluationDatasetVersion | null,
): Promise<string> {
  if (query.subjectType === 'KNOWLEDGE_VERSION') {
    const rows = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT version."id", version."version_number", version."checksum",
             version."status"::text AS status, version."knowledge_base_id",
             version."document_id", btrim(version."governance_hash") AS governance_hash,
             version."governance_revision", version."governance_review_status",
             version."governance_reviewed_by_id", version."governance_reviewed_at",
             version."classification", version."scope_mode",
             version."organization_scope_ids", version."project_scope_ids",
             version."task_scope_ids", version."role_template_scope_ids",
             version."data_labels", version."supersedes_version_id",
             version."effective_from", version."expires_at",
             version."retention_until", version."retention_action",
             version."source_type"::text AS source_type, version."object_sha256",
             version."parser_name", version."parse_quality_score"::text AS parse_quality_score,
             version."parse_review_status"::text AS parse_review_status,
             version."parse_review_revision", version."parse_reviewed_by_id",
             version."parse_reviewed_at", version."parse_diagnostics"
      FROM public."knowledge_document_versions" version
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."id" = ${query.subjectId}::uuid
        AND version."version_number" = ${query.subjectVersion}
    `);
    const version = required(rows[0], 'Knowledge Version was not found.');
    const artifacts = await loadKnowledgeArtifacts(transaction, tenantId, [query.subjectId]);
    return hashTrustedSnapshot({ version, ...artifacts });
  }
  const agentRows = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT version."id", version."version",
           version."system_prompt", version."model_policy", version."tool_policy",
           version."knowledge_scope", version."role_definition_snapshot",
           version."blueprint_revision"
    FROM public."agent_versions" version
    WHERE version."tenant_id" = ${tenantId}::uuid
      AND version."id" = ${query.subjectId}::uuid
      AND version."version" = ${query.subjectVersion}
  `);
  const agent = required(agentRows[0], 'Agent Version was not found.');
  if (query.subjectType === 'AGENT_VERSION') return hashTrustedSnapshot(agent);
  const knowledgeIds = dataset?.targets.knowledgeVersionIds ?? [];
  const knowledge =
    knowledgeIds.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT version."id", version."version_number", version."checksum",
               version."status"::text AS status,
               btrim(version."governance_hash") AS governance_hash,
               version."governance_revision", version."governance_review_status",
               version."governance_reviewed_by_id", version."governance_reviewed_at",
               version."classification", version."scope_mode",
               version."organization_scope_ids", version."project_scope_ids",
               version."task_scope_ids", version."role_template_scope_ids",
               version."data_labels", version."supersedes_version_id",
               version."effective_from", version."expires_at",
               version."retention_until", version."retention_action",
               version."source_type"::text AS source_type, version."object_sha256",
               version."parser_name", version."parse_quality_score"::text AS parse_quality_score,
               version."parse_review_status"::text AS parse_review_status,
               version."parse_review_revision", version."parse_reviewed_by_id",
               version."parse_reviewed_at", version."parse_diagnostics"
        FROM public."knowledge_document_versions" version
        WHERE version."tenant_id" = ${tenantId}::uuid
          AND version."id" IN (${Prisma.join(knowledgeIds.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY version."id"
      `);
  if (knowledge.length !== knowledgeIds.length) {
    throw new NotFoundException(
      'One or more Knowledge Versions in the composite release snapshot were not found.',
    );
  }
  const toolIds = dataset?.targets.toolVersionIds ?? [];
  const tools =
    toolIds.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT version."id", version."tool_id", version."version",
               version."status"::text AS status, version."configuration_hash"
        FROM public."tool_versions" version
        WHERE version."tenant_id" = ${tenantId}::uuid
          AND version."id" IN (${Prisma.join(toolIds.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY version."id"
      `);
  if (tools.length !== toolIds.length) {
    throw new NotFoundException(
      'One or more Tool Versions in the composite release snapshot were not found.',
    );
  }
  const knowledgeArtifacts = await loadKnowledgeArtifacts(transaction, tenantId, knowledgeIds);
  return hashTrustedSnapshot({
    agent,
    knowledge,
    ...knowledgeArtifacts,
    tools,
    modelRoutes: [...(dataset?.targets.modelRoutes ?? [])].sort(),
    promptHashes: [...(dataset?.targets.promptHashes ?? [])].sort(),
  });
}

async function loadKnowledgeArtifacts(
  transaction: Transaction,
  tenantId: string,
  versionIds: readonly string[],
): Promise<{
  readonly chunks: readonly Record<string, unknown>[];
  readonly embeddings: readonly Record<string, unknown>[];
  readonly graphConflicts: readonly Record<string, unknown>[];
  readonly graphProjections: readonly Record<string, unknown>[];
  readonly ontologyEntityTypes: readonly Record<string, unknown>[];
  readonly ontologyPredicates: readonly Record<string, unknown>[];
  readonly ontologyVersions: readonly Record<string, unknown>[];
  readonly relations: readonly Record<string, unknown>[];
  readonly relationGovernance: readonly Record<string, unknown>[];
}> {
  if (versionIds.length === 0) {
    return {
      chunks: [],
      embeddings: [],
      graphConflicts: [],
      graphProjections: [],
      ontologyEntityTypes: [],
      ontologyPredicates: [],
      ontologyVersions: [],
      relations: [],
      relationGovernance: [],
    };
  }
  const ids = versionIds.map((id) => Prisma.sql`${id}::uuid`);
  const chunks = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT chunk."id", chunk."document_version_id", chunk."chunk_index",
           chunk."heading_path", chunk."content_hash", chunk."token_count",
           chunk."metadata"
    FROM public."knowledge_chunks" chunk
    WHERE chunk."tenant_id" = ${tenantId}::uuid
      AND chunk."document_version_id" IN (${Prisma.join(ids)})
    ORDER BY chunk."document_version_id", chunk."chunk_index", chunk."id"
  `);
  const embeddings = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT embedding."chunk_id", chunk."document_version_id",
           embedding."embedding_model", embedding."embedding_dimension",
           embedding."content_hash",
           encode(
             digest(convert_to(embedding."embedding"::text, 'UTF8'), 'sha256'),
             'hex'
           ) AS embedding_hash
    FROM public."knowledge_chunk_embeddings" embedding
    JOIN public."knowledge_chunks" chunk
      ON chunk."tenant_id" = embedding."tenant_id"
     AND chunk."id" = embedding."chunk_id"
    WHERE embedding."tenant_id" = ${tenantId}::uuid
      AND chunk."document_version_id" IN (${Prisma.join(ids)})
    ORDER BY chunk."document_version_id", embedding."chunk_id",
             embedding."embedding_model"
  `);
  const graphProjections = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT projection."id", projection."knowledge_base_id",
           projection."document_id", projection."document_version_id",
           projection."status"::text AS status, btrim(projection."graph_hash") AS graph_hash,
           projection."entity_count", projection."mention_count",
           projection."relation_count", projection."evidence_count",
           projection."candidate_at", projection."activated_at",
           projection."obsoleted_at"
    FROM public."knowledge_graph_projections" projection
    WHERE projection."tenant_id" = ${tenantId}::uuid
      AND projection."document_version_id" IN (${Prisma.join(ids)})
    ORDER BY projection."document_version_id", projection."id"
  `);
  const relations = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT relation."id", relation_evidence."document_version_id",
           relation_evidence."projection_id",
           relation."subject_entity_id", relation."normalized_predicate",
           relation."object_entity_id", relation."attributes",
           relation."confidence"::text AS relation_confidence,
           relation."status"::text AS relation_status,
           relation_evidence."id" AS evidence_id,
           relation_evidence."chunk_id", relation_evidence."excerpt",
           relation_evidence."start_offset", relation_evidence."end_offset",
           relation_evidence."confidence"::text AS evidence_confidence,
           relation_evidence."extractor", relation_evidence."metadata"
    FROM public."knowledge_relation_evidence" relation_evidence
    JOIN public."knowledge_relations" relation
      ON relation."tenant_id" = relation_evidence."tenant_id"
     AND relation."knowledge_base_id" = relation_evidence."knowledge_base_id"
     AND relation."id" = relation_evidence."relation_id"
    WHERE relation_evidence."tenant_id" = ${tenantId}::uuid
      AND relation_evidence."document_version_id" IN (${Prisma.join(ids)})
    ORDER BY relation_evidence."document_version_id", relation."id",
             relation_evidence."id"
  `);
  const relationGovernance = await transaction.$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`
      SELECT DISTINCT governance."id", governance."knowledge_base_id",
             governance."relation_id", governance."ontology_version_id",
             governance."predicate_definition_id",
             governance."valid_from", governance."valid_to",
             governance."correction_id", governance."approved_by_user_id",
             governance."revision"
      FROM public."knowledge_relation_governance" governance
      JOIN public."knowledge_relation_evidence" relation_evidence
        ON relation_evidence."tenant_id" = governance."tenant_id"
       AND relation_evidence."knowledge_base_id" = governance."knowledge_base_id"
       AND relation_evidence."relation_id" = governance."relation_id"
      WHERE governance."tenant_id" = ${tenantId}::uuid
        AND relation_evidence."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY governance."knowledge_base_id", governance."relation_id",
               governance."id"
    `,
  );
  const ontologyVersionIds = relationGovernance
    .map((row) => row.ontology_version_id)
    .filter((id): id is string => typeof id === 'string');
  const ontologyVersionSql = ontologyVersionIds.map((id) => Prisma.sql`${id}::uuid`);
  const ontologyVersions =
    ontologyVersionSql.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT version."id", version."knowledge_base_id", version."ontology_id",
                 version."version_number", version."revision",
                 version."status"::text AS status, version."change_summary",
                 btrim(version."schema_hash") AS schema_hash,
                 version."submitted_by_user_id", version."reviewed_by_user_id",
                 version."review_comment", version."submitted_at",
                 version."reviewed_at", version."published_at",
                 version."retired_at", version."system_bootstrap"
          FROM public."knowledge_ontology_versions" version
          WHERE version."tenant_id" = ${tenantId}::uuid
            AND version."id" IN (${Prisma.join(ontologyVersionSql)})
          ORDER BY version."knowledge_base_id", version."ontology_id",
                   version."version_number", version."id"
        `);
  const ontologyEntityTypes =
    ontologyVersionSql.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT entity_type."id", entity_type."knowledge_base_id",
                 entity_type."ontology_version_id", entity_type."key",
                 entity_type."name", entity_type."description",
                 entity_type."attributes_schema"
          FROM public."knowledge_ontology_entity_types" entity_type
          WHERE entity_type."tenant_id" = ${tenantId}::uuid
            AND entity_type."ontology_version_id" IN (${Prisma.join(ontologyVersionSql)})
          ORDER BY entity_type."ontology_version_id", entity_type."key",
                   entity_type."id"
        `);
  const ontologyPredicates =
    ontologyVersionSql.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT predicate."id", predicate."knowledge_base_id",
                 predicate."ontology_version_id", predicate."key",
                 predicate."predicate", predicate."label",
                 predicate."domain_type_key", predicate."range_type_key",
                 predicate."inverse_predicate_key", predicate."symmetric",
                 predicate."functional", predicate."allow_self_loop",
                 predicate."temporal", predicate."attributes_schema"
          FROM public."knowledge_ontology_predicates" predicate
          WHERE predicate."tenant_id" = ${tenantId}::uuid
            AND predicate."ontology_version_id" IN (${Prisma.join(ontologyVersionSql)})
          ORDER BY predicate."ontology_version_id", predicate."key",
                   predicate."id"
        `);
  const projectionIds = graphProjections
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string');
  const projectionSql = projectionIds.map((id) => Prisma.sql`${id}::uuid`);
  const graphConflicts =
    projectionSql.length === 0
      ? []
      : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT conflict."id", conflict."knowledge_base_id",
                 conflict."projection_id", conflict."document_version_id",
                 conflict."conflict_key", conflict."conflict_type",
                 conflict."schema_predicate", conflict."schema_subject_type",
                 conflict."schema_object_type", conflict."occurrence_count",
                 conflict."details", conflict."evidence",
                 conflict."status"::text AS status, conflict."revision",
                 conflict."resolution_correction_id", conflict."review_comment",
                 conflict."resolved_at"
          FROM public."knowledge_graph_conflicts" conflict
          WHERE conflict."tenant_id" = ${tenantId}::uuid
            AND conflict."projection_id" IN (${Prisma.join(projectionSql)})
          ORDER BY conflict."projection_id", conflict."conflict_key",
                   conflict."id"
        `);
  return {
    chunks,
    embeddings,
    graphConflicts,
    graphProjections,
    ontologyEntityTypes,
    ontologyPredicates,
    ontologyVersions,
    relations,
    relationGovernance,
  };
}

function hashTrustedSnapshot(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

function mapDataset(row: DatasetRow): AiEvaluationDataset {
  return aiEvaluationDatasetSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    latestVersion: row.latest_version,
    currentPublishedVersionId: row.current_published_version_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapDatasetVersion(row: VersionRow, thresholds: readonly ThresholdRow[]) {
  return aiEvaluationDatasetVersionSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    datasetId: row.dataset_id,
    version: row.version,
    revision: row.revision,
    status: row.status,
    description: row.description,
    targets: row.targets,
    thresholds: thresholds.map(mapThreshold),
    requiredCategories: row.required_categories,
    caseCount: row.case_count,
    annotationCoverage: Number(row.annotation_coverage),
    contentHash: row.content_hash,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: iso(row.submitted_at),
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: iso(row.reviewed_at),
    reviewEvidenceIds: jsonStrings(row.review_evidence_ids),
    publishedByUserId: row.published_by_user_id,
    publishedAt: iso(row.published_at),
    retiredAt: iso(row.retired_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapThreshold(row: ThresholdRow) {
  return {
    metric: row.metric,
    direction: row.direction,
    threshold: Number(row.threshold),
    minimumSampleCount: row.minimum_sample_count,
    required: row.required,
  };
}

function mapRun(row: RunRow, metricRows: readonly MetricRow[]): AiEvaluationRun {
  const metrics = metricRows.map((metric): AiEvaluationMetricResult => ({
    metric: metric.metric as AiEvaluationMetricResult['metric'],
    numerator: Number(metric.numerator),
    denominator: Number(metric.denominator),
    value: Number(metric.value),
    threshold: Number(metric.threshold),
    direction: metric.direction as AiEvaluationMetricResult['direction'],
    sampleCount: metric.sample_count,
    minimumSampleCount: metric.minimum_sample_count,
    passed: metric.passed,
    evidenceIds: jsonStrings(metric.evidence_ids),
  }));
  return aiEvaluationRunSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    datasetVersionId: row.dataset_version_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectVersion: row.subject_version,
    subjectSnapshotHash: row.subject_snapshot_hash,
    status: row.status,
    runnerId: row.runner_id,
    runnerName: row.runner_name,
    runnerAttestationKeyFingerprint: row.runner_attestation_key_fingerprint,
    externalRunId: row.external_run_id,
    expectedCaseCount: row.expected_case_count,
    submittedCaseCount: row.submitted_case_count,
    evidenceBundleUri: row.evidence_bundle_uri,
    evidenceBundleHash: row.evidence_bundle_hash,
    runnerAttestation: row.runner_attestation,
    metrics,
    revision: row.revision,
    startedAt: iso(row.started_at),
    submittedAt: iso(row.submitted_at),
    verifiedByUserId: row.verified_by_user_id,
    verifiedAt: iso(row.verified_at),
    finishedAt: iso(row.finished_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapBadCase(row: BadCaseRow) {
  return { id: row.id, status: row.status, revision: row.revision };
}

function mapBadCaseDetail(row: BadCaseRow): AiEvaluationBadCase {
  return aiEvaluationBadCaseSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    category: row.category,
    sanitizedInput: row.sanitized_input,
    sourceSnapshotHash: row.source_snapshot_hash,
    answerFeedbackSource:
      row.feedback_source_feedback_id === null || row.feedback_source_feedback_id === undefined
        ? null
        : {
            feedbackId: row.feedback_source_feedback_id,
            conversationId: row.feedback_source_conversation_id,
            messageId: row.feedback_source_message_id,
            inputMessageId: row.feedback_source_input_message_id,
            agentRunId: row.feedback_source_agent_run_id,
            agentId: row.feedback_source_agent_id,
            agentVersionId: row.feedback_source_agent_version_id,
            reportedByUserId: row.feedback_source_reported_by_user_id,
            feedbackReason: row.feedback_source_feedback_reason,
            feedbackRecordedAt: row.feedback_source_feedback_recorded_at?.toISOString(),
            promptSnapshotHash: row.feedback_source_prompt_snapshot_hash,
            answerSnapshotHash: row.feedback_source_answer_snapshot_hash,
            citationsSnapshotHash: row.feedback_source_citations_snapshot_hash,
            citations: row.feedback_source_citations,
          },
    status: row.status,
    mappedDatasetVersionId: row.mapped_dataset_version_id,
    mappedCaseId: row.mapped_case_id,
    reportedByUserId: row.reported_by_user_id,
    triagedByUserId: row.triaged_by_user_id,
    triageReason: row.triage_reason,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapRunner(row: RunnerRow) {
  return aiEvaluationRunnerSchema.parse({
    id: row.id,
    name: row.name,
    status: 'ACTIVE' as const,
    attestationKeyFingerprint: row.attestation_key_fingerprint,
    allowedEvidenceOrigins: jsonStrings(row.allowed_evidence_origins),
  });
}

function findDatasetByIdempotency(transaction: Transaction, tenantId: string, key: string) {
  return transaction
    .$queryRaw<DatasetRow[]>(
      Prisma.sql`
      SELECT * FROM public."ai_evaluation_datasets"
      WHERE "tenant_id" = ${tenantId}::uuid AND "idempotency_key" = ${key}
    `,
    )
    .then((rows) => rows[0] ?? null);
}

function findDatasetVersionByIdempotency(transaction: Transaction, tenantId: string, key: string) {
  return transaction
    .$queryRaw<VersionRow[]>(
      Prisma.sql`
      SELECT * FROM public."ai_evaluation_dataset_versions"
      WHERE "tenant_id" = ${tenantId}::uuid AND "idempotency_key" = ${key}
    `,
    )
    .then((rows) => rows[0] ?? null);
}

function findRunByIdempotency(transaction: Transaction, tenantId: string, key: string) {
  return transaction
    .$queryRaw<RunRow[]>(
      Prisma.sql`
      SELECT * FROM public."ai_evaluation_runs"
      WHERE "tenant_id" = ${tenantId}::uuid AND "idempotency_key" = ${key}
    `,
    )
    .then((rows) => rows[0] ?? null);
}

function page<T extends { id: string }>(items: readonly T[], limit: number): CursorPage<T> {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? (items[limit - 1]?.id ?? null) : null,
  };
}

function requireSameHash(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ConflictException('The idempotency key is already bound to another request.');
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new NotFoundException(message);
  return value;
}

function stale(resource: string): ConflictException {
  return new ConflictException(`${resource} changed. Refresh and try again.`);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

type EvidenceTable =
  | 'ai_evaluation_case_evidence'
  | 'ai_evaluation_annotation_evidence'
  | 'ai_evaluation_review_evidence'
  | 'ai_evaluation_case_result_evidence'
  | 'ai_evaluation_verification_evidence'
  | 'ai_evaluation_bad_case_evidence';
type EvidenceParentColumn =
  'case_id' | 'annotation_id' | 'dataset_version_id' | 'case_result_id' | 'run_id' | 'bad_case_id';

interface DatasetRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly latest_version: number;
  readonly current_published_version_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly request_hash: string;
}

interface VersionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly dataset_id: string;
  readonly version: number;
  readonly revision: number;
  readonly status: AiEvaluationDatasetVersion['status'];
  readonly description: string;
  readonly targets: unknown;
  readonly required_categories: unknown;
  readonly case_count: number;
  readonly annotation_coverage: Prisma.Decimal;
  readonly content_hash: string;
  readonly submitted_by_user_id: string | null;
  readonly submitted_at: Date | null;
  readonly reviewed_by_user_id: string | null;
  readonly reviewed_at: Date | null;
  readonly published_by_user_id: string | null;
  readonly published_at: Date | null;
  readonly retired_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly request_hash: string;
  readonly review_evidence_ids: unknown;
}

interface ThresholdRow {
  readonly metric: AiEvaluationMetricResult['metric'];
  readonly direction: AiEvaluationMetricResult['direction'];
  readonly threshold: Prisma.Decimal;
  readonly minimum_sample_count: number;
  readonly required: boolean;
}

interface CaseRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly dataset_version_id: string;
  readonly case_key: string;
  readonly category: string;
  readonly input: string;
  readonly context: unknown;
  readonly expected_behavior: string;
  readonly forbidden_behaviors: unknown;
  readonly scoring: unknown;
  readonly source_bad_case_id: string | null;
  readonly content_hash: string;
  readonly revision: number;
  readonly created_at: Date;
  readonly request_hash: string;
}

interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly dataset_version_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_version: number;
  readonly subject_snapshot_hash: string;
  readonly status: string;
  readonly runner_id: string;
  readonly runner_name: string;
  readonly runner_attestation_key_fingerprint: string;
  readonly external_run_id: string;
  readonly expected_case_count: number;
  readonly submitted_case_count: number;
  readonly evidence_bundle_uri: string | null;
  readonly evidence_bundle_hash: string | null;
  readonly runner_attestation: string | null;
  readonly runner_evidence_verified: boolean;
  readonly execution_attestation_required: boolean;
  readonly result_submitted_by_runner_id: string | null;
  readonly result_submitted_by_user_id: string | null;
  readonly verified_by_user_id: string | null;
  readonly revision: number;
  readonly started_at: Date | null;
  readonly submitted_at: Date | null;
  readonly verified_at: Date | null;
  readonly finished_at: Date | null;
  readonly execution_nonce: string | null;
  readonly execution_request_hash: string | null;
  readonly execution_idempotency_key: string | null;
  readonly execution_requested_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly request_hash: string;
}

interface MetricRow {
  readonly metric: string;
  readonly numerator: Prisma.Decimal;
  readonly denominator: Prisma.Decimal;
  readonly value: Prisma.Decimal;
  readonly threshold: Prisma.Decimal;
  readonly direction: string;
  readonly sample_count: number;
  readonly minimum_sample_count: number;
  readonly passed: boolean;
  readonly evidence_ids: unknown;
}

interface ProofRow {
  readonly case_count: number;
  readonly annotated_case_count: number;
  readonly categories: unknown;
  readonly metrics: unknown;
  readonly thresholds: unknown;
  readonly submitted_by_user_id: string | null;
  readonly review_evidence_count: number;
}

interface BadCaseRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly source_version: number;
  readonly category: string;
  readonly sanitized_input: string;
  readonly source_snapshot_hash: string;
  readonly status: string;
  readonly revision: number;
  readonly reported_by_user_id: string;
  readonly mapped_dataset_version_id: string | null;
  readonly mapped_case_id: string | null;
  readonly triaged_by_user_id: string | null;
  readonly triage_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly request_hash: string;
  readonly feedback_source_feedback_id: string | null;
  readonly feedback_source_conversation_id: string | null;
  readonly feedback_source_message_id: string | null;
  readonly feedback_source_input_message_id: string | null;
  readonly feedback_source_agent_run_id: string | null;
  readonly feedback_source_agent_id: string | null;
  readonly feedback_source_agent_version_id: string | null;
  readonly feedback_source_reported_by_user_id: string | null;
  readonly feedback_source_feedback_reason: string | null;
  readonly feedback_source_feedback_recorded_at: Date | null;
  readonly feedback_source_prompt_snapshot_hash: string | null;
  readonly feedback_source_answer_snapshot_hash: string | null;
  readonly feedback_source_citations_snapshot_hash: string | null;
  readonly feedback_source_citations: unknown;
}

interface RunnerRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly attestation_key_fingerprint: string;
  readonly allowed_evidence_origins: unknown;
  readonly request_hash: string;
}
