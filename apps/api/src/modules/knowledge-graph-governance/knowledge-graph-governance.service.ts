import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateKnowledgeGraphConflictRequest,
  CreateKnowledgeGraphCorrectionRequest,
  CreateKnowledgeOntologyRequest,
  CreateKnowledgeOntologyVersionRequest,
  KnowledgeEntityAlias,
  KnowledgeEntityMerge,
  KnowledgeGraphConflict,
  KnowledgeGraphCorrection,
  KnowledgeGraphGovernanceOverview,
  KnowledgeOntology,
  KnowledgeOntologyEntityTypeInput,
  KnowledgeOntologyPredicateInput,
  KnowledgeOntologyVersion,
  TransitionKnowledgeGraphCorrectionRequest,
  TransitionKnowledgeOntologyVersionRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';

interface CommandRow {
  readonly request_hash: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly result_revision: number;
}

interface OntologyRow {
  readonly id: string;
  readonly knowledge_base_id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: number;
  readonly created_by_user_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface OntologyVersionRow {
  readonly id: string;
  readonly ontology_id: string;
  readonly version_number: number;
  readonly revision: number;
  readonly status: KnowledgeOntologyVersion['status'];
  readonly change_summary: string;
  readonly schema_hash: string;
  readonly created_by_user_id: string;
  readonly submitted_by_user_id: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly review_comment: string | null;
  readonly submitted_at: Date | null;
  readonly reviewed_at: Date | null;
  readonly published_at: Date | null;
  readonly retired_at: Date | null;
  readonly system_bootstrap: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface EntityTypeRow {
  readonly id: string;
  readonly ontology_version_id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly attributes_schema: Prisma.JsonValue;
}

interface PredicateRow {
  readonly id: string;
  readonly ontology_version_id: string;
  readonly key: string;
  readonly predicate: string;
  readonly label: string;
  readonly domain_type_key: string;
  readonly range_type_key: string;
  readonly inverse_predicate_key: string | null;
  readonly symmetric: boolean;
  readonly functional: boolean;
  readonly allow_self_loop: boolean;
  readonly temporal: boolean;
  readonly attributes_schema: Prisma.JsonValue;
}

interface ConflictRow {
  readonly id: string;
  readonly knowledge_base_id: string;
  readonly projection_id: string | null;
  readonly document_version_id: string | null;
  readonly projection_status: KnowledgeGraphConflict['projectionStatus'];
  readonly target_type: KnowledgeGraphConflict['targetType'];
  readonly target_id: string;
  readonly conflict_key: string;
  readonly conflict_type: string;
  readonly schema_predicate: string | null;
  readonly schema_subject_type: string | null;
  readonly schema_object_type: string | null;
  readonly occurrence_count: number;
  readonly details: Prisma.JsonValue;
  readonly evidence: Prisma.JsonValue;
  readonly status: KnowledgeGraphConflict['status'];
  readonly revision: number;
  readonly detected_by_user_id: string;
  readonly reviewed_by_user_id: string | null;
  readonly resolution_correction_id: string | null;
  readonly review_comment: string | null;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CorrectionRow {
  readonly id: string;
  readonly knowledge_base_id: string;
  readonly action: KnowledgeGraphCorrection['action'];
  readonly patch: Prisma.JsonValue;
  readonly evidence: Prisma.JsonValue;
  readonly evidence_hash: string;
  readonly status: KnowledgeGraphCorrection['status'];
  readonly revision: number;
  readonly proposed_by_user_id: string;
  readonly reviewed_by_user_id: string | null;
  readonly review_comment: string | null;
  readonly reviewed_at: Date | null;
  readonly applied_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MergeRow {
  readonly id: string;
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly correction_id: string;
  readonly reason: string;
  readonly evidence_hash: string;
  readonly approved_by_user_id: string;
  readonly created_at: Date;
}

interface AliasRow {
  readonly id: string;
  readonly entity_id: string;
  readonly alias: string;
  readonly normalized_alias: string;
  readonly active: boolean;
  readonly correction_id: string | null;
  readonly created_at: Date;
  readonly retired_at: Date | null;
}

@Injectable()
export class KnowledgeGraphGovernanceService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async overview(knowledgeBaseId: string): Promise<KnowledgeGraphGovernanceOverview> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      return loadOverview(transaction, principal.tenantId, knowledgeBaseId);
    });
  }

  async createOntology(
    knowledgeBaseId: string,
    request: CreateKnowledgeOntologyRequest,
  ): Promise<KnowledgeOntology> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_ontology');
          return requireOntologyFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
        const ontologyId = randomUUID();
        const versionId = randomUUID();
        const schemaHash = ontologySchemaHash(request.entityTypes, request.predicates);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_ontologies(
            id, tenant_id, knowledge_base_id, code, name, description,
            created_by_user_id, idempotency_key, request_hash
          ) VALUES (
            ${ontologyId}::uuid, ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${request.code}, ${request.name}, ${request.description},
            ${principal.userId}::uuid, ${request.idempotencyKey}, ${identity}
          )
        `);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_ontology_versions(
            id, tenant_id, knowledge_base_id, ontology_id, version_number,
            change_summary, schema_hash, created_by_user_id,
            idempotency_key, request_hash
          ) VALUES (
            ${versionId}::uuid, ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${ontologyId}::uuid, 1, ${request.changeSummary}, ${schemaHash},
            ${principal.userId}::uuid, ${`${request.idempotencyKey}:version`}, ${identity}
          )
        `);
        await insertOntologyDefinitions(
          transaction,
          principal.tenantId,
          knowledgeBaseId,
          versionId,
          request.entityTypes,
          request.predicates,
        );
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: 'ONTOLOGY_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_ontology',
          resourceId: ontologyId,
          resultRevision: 1,
          action: 'knowledge.graph.ontology.created',
          metadata: { code: request.code, versionId, schemaHash },
        });
        return requireOntologyFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          ontologyId,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Ontology');
    }
  }

  async createOntologyVersion(
    knowledgeBaseId: string,
    ontologyId: string,
    request: CreateKnowledgeOntologyVersionRequest,
  ): Promise<KnowledgeOntologyVersion> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity({ ...request, ontologyId });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_ontology_version');
          return requireVersionFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        const ontologyRows = await transaction.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
          SELECT revision
          FROM public.knowledge_ontologies
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND id = ${ontologyId}::uuid
          FOR UPDATE
        `);
        const ontology = ontologyRows[0];
        if (ontology === undefined)
          throw new NotFoundException('Knowledge Ontology was not found.');
        if (ontology.revision !== request.expectedOntologyRevision) {
          throw new ConflictException('Knowledge Ontology changed. Refresh and try again.');
        }
        const latestRows = await transaction.$queryRaw<Array<{ version_number: number }>>(
          Prisma.sql`
            SELECT coalesce(max(version_number), 0)::int AS version_number
            FROM public.knowledge_ontology_versions
            WHERE tenant_id = ${principal.tenantId}::uuid
              AND knowledge_base_id = ${knowledgeBaseId}::uuid
              AND ontology_id = ${ontologyId}::uuid
          `,
        );
        const versionNumber = (latestRows[0]?.version_number ?? 0) + 1;
        const versionId = randomUUID();
        const schemaHash = ontologySchemaHash(request.entityTypes, request.predicates);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_ontology_versions(
            id, tenant_id, knowledge_base_id, ontology_id, version_number,
            change_summary, schema_hash, created_by_user_id,
            idempotency_key, request_hash
          ) VALUES (
            ${versionId}::uuid, ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${ontologyId}::uuid, ${versionNumber}, ${request.changeSummary}, ${schemaHash},
            ${principal.userId}::uuid, ${request.idempotencyKey}, ${identity}
          )
        `);
        await insertOntologyDefinitions(
          transaction,
          principal.tenantId,
          knowledgeBaseId,
          versionId,
          request.entityTypes,
          request.predicates,
        );
        const changed = await transaction.$executeRaw(Prisma.sql`
          UPDATE public.knowledge_ontologies
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND id = ${ontologyId}::uuid
            AND revision = ${request.expectedOntologyRevision}
        `);
        if (changed !== 1) {
          throw new ConflictException('Knowledge Ontology changed. Refresh and try again.');
        }
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: 'ONTOLOGY_VERSION_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_ontology_version',
          resourceId: versionId,
          resultRevision: 1,
          action: 'knowledge.graph.ontology_version.created',
          metadata: { ontologyId, versionNumber, schemaHash },
        });
        return requireVersionFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          versionId,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Ontology Version');
    }
  }

  async transitionOntologyVersion(
    knowledgeBaseId: string,
    versionId: string,
    request: TransitionKnowledgeOntologyVersionRequest,
  ): Promise<KnowledgeOntologyVersion> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity({ ...request, versionId });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_ontology_version');
          return requireVersionFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        const rows = await transaction.$queryRaw<
          Array<{
            ontology_id: string;
            created_by_user_id: string;
            status: KnowledgeOntologyVersion['status'];
          }>
        >(Prisma.sql`
          SELECT ontology_id, created_by_user_id, status
          FROM public.knowledge_ontology_versions
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND id = ${versionId}::uuid
            AND revision = ${request.expectedRevision}
          FOR UPDATE
        `);
        const current = rows[0];
        if (current === undefined) {
          throw new ConflictException('Ontology Version changed or was not found.');
        }
        if (
          (request.action === 'PUBLISH' || request.action === 'REQUEST_CHANGES') &&
          current.created_by_user_id === principal.userId
        ) {
          throw new ConflictException('The Ontology Version maker cannot act as its checker.');
        }
        const now = new Date();
        if (request.action === 'PUBLISH') {
          const published = await transaction.$queryRaw<
            Array<{ id: string; created_by_user_id: string }>
          >(
            Prisma.sql`
              SELECT id, created_by_user_id
              FROM public.knowledge_ontology_versions
              WHERE tenant_id = ${principal.tenantId}::uuid
                AND knowledge_base_id = ${knowledgeBaseId}::uuid
                AND ontology_id = ${current.ontology_id}::uuid
                AND status = 'PUBLISHED'
              FOR UPDATE
            `,
          );
          for (const prior of published) {
            if (prior.created_by_user_id === principal.userId) {
              throw new ConflictException(
                'The current checker cannot retire a published version they created.',
              );
            }
            await transaction.$executeRaw(Prisma.sql`
              UPDATE public.knowledge_ontology_versions
              SET status = 'RETIRED', revision = revision + 1,
                  reviewed_by_user_id = ${principal.userId}::uuid,
                  review_comment = ${`Superseded: ${request.comment}`},
                  reviewed_at = ${now}, retired_at = ${now}
              WHERE tenant_id = ${principal.tenantId}::uuid
                AND knowledge_base_id = ${knowledgeBaseId}::uuid
                AND id = ${prior.id}::uuid
            `);
          }
        }
        const update = ontologyTransitionSql(principal, knowledgeBaseId, versionId, request, now);
        const changed = await transaction.$executeRaw(update);
        if (changed !== 1) {
          throw new ConflictException('Ontology Version changed. Refresh and try again.');
        }
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: `ONTOLOGY_VERSION_${request.action}`,
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_ontology_version',
          resourceId: versionId,
          resultRevision: request.expectedRevision + 1,
          action: `knowledge.graph.ontology_version.${request.action.toLowerCase()}`,
          metadata: { comment: request.comment, expectedRevision: request.expectedRevision },
        });
        return requireVersionFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          versionId,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Ontology Version transition');
    }
  }

  async createConflict(
    knowledgeBaseId: string,
    request: CreateKnowledgeGraphConflictRequest,
  ): Promise<KnowledgeGraphConflict> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_graph_conflict');
          return requireConflictFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
        const id = randomUUID();
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_graph_conflicts(
            id, tenant_id, knowledge_base_id, target_type, target_id,
            conflict_key, conflict_type, details, evidence, detected_by_user_id,
            idempotency_key, request_hash
          ) VALUES (
            ${id}::uuid, ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${request.targetType}::public."KnowledgeGraphConflictTargetType",
            ${request.targetId}::uuid, ${request.conflictKey}, ${request.conflictType},
            ${JSON.stringify(request.details)}::jsonb,
            ${JSON.stringify(request.evidence)}::jsonb,
            ${principal.userId}::uuid, ${request.idempotencyKey}, ${identity}
          )
        `);
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: 'GRAPH_CONFLICT_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_graph_conflict',
          resourceId: id,
          resultRevision: 1,
          action: 'knowledge.graph.conflict.created',
          metadata: {
            targetType: request.targetType,
            targetId: request.targetId,
            conflictType: request.conflictType,
          },
        });
        return requireConflictFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          id,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Graph Conflict');
    }
  }

  async createCorrection(
    knowledgeBaseId: string,
    request: CreateKnowledgeGraphCorrectionRequest,
  ): Promise<KnowledgeGraphCorrection> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity(request);
    const evidenceHash = stableHash(request.evidence);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_graph_correction');
          return requireCorrectionFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        await requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
        const id = randomUUID();
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_graph_corrections(
            id, tenant_id, knowledge_base_id, action, patch, evidence,
            evidence_hash, proposed_by_user_id, idempotency_key, request_hash
          ) VALUES (
            ${id}::uuid, ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${request.action}::public."KnowledgeGraphCorrectionAction",
            ${JSON.stringify(request.patch)}::jsonb,
            ${JSON.stringify(request.evidence)}::jsonb,
            ${evidenceHash}, ${principal.userId}::uuid,
            ${request.idempotencyKey}, ${identity}
          )
        `);
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: 'GRAPH_CORRECTION_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_graph_correction',
          resourceId: id,
          resultRevision: 1,
          action: 'knowledge.graph.correction.created',
          metadata: { correctionAction: request.action, evidenceHash },
        });
        return requireCorrectionFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          id,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Graph Correction');
    }
  }

  async transitionCorrection(
    knowledgeBaseId: string,
    correctionId: string,
    request: TransitionKnowledgeGraphCorrectionRequest,
  ): Promise<KnowledgeGraphCorrection> {
    const principal = this.access.requireKnowledgeWrite();
    const identity = requestIdentity({ ...request, correctionId });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const replay = await beginCommand(
          transaction,
          principal.tenantId,
          request.idempotencyKey,
          identity,
        );
        if (replay !== null) {
          requireReplayType(replay, 'knowledge_graph_correction');
          return requireCorrectionFromOverview(
            await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
            replay.resource_id,
          );
        }
        const rows = await transaction.$queryRaw<CorrectionRow[]>(Prisma.sql`
          SELECT *
          FROM public.knowledge_graph_corrections
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND id = ${correctionId}::uuid
            AND revision = ${request.expectedRevision}
          FOR UPDATE
        `);
        const current = rows[0];
        if (current === undefined) {
          throw new ConflictException('Graph Correction changed or was not found.');
        }
        if (
          (request.action === 'APPROVE' || request.action === 'REJECT') &&
          current.proposed_by_user_id === principal.userId
        ) {
          throw new ConflictException('The Graph Correction maker cannot act as its checker.');
        }
        const now = new Date();
        const changed = await transaction.$executeRaw(
          correctionTransitionSql(principal, knowledgeBaseId, correctionId, request, now),
        );
        if (changed !== 1) {
          throw new ConflictException('Graph Correction changed. Refresh and try again.');
        }
        if (request.action === 'APPLY') {
          await applyCorrection(
            transaction,
            principal,
            knowledgeBaseId,
            { ...current, status: 'APPLIED', revision: current.revision + 1 },
            request.comment,
            now,
          );
        }
        await recordMutation(transaction, principal, {
          knowledgeBaseId,
          commandType: `GRAPH_CORRECTION_${request.action}`,
          idempotencyKey: request.idempotencyKey,
          requestHash: identity,
          resourceType: 'knowledge_graph_correction',
          resourceId: correctionId,
          resultRevision: request.expectedRevision + 1,
          action: `knowledge.graph.correction.${request.action.toLowerCase()}`,
          metadata: {
            correctionAction: current.action,
            comment: request.comment,
            expectedRevision: request.expectedRevision,
          },
        });
        return requireCorrectionFromOverview(
          await loadOverview(transaction, principal.tenantId, knowledgeBaseId),
          correctionId,
        );
      });
    } catch (error) {
      throw mapWriteError(error, 'Knowledge Graph Correction transition');
    }
  }
}

async function insertOntologyDefinitions(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
  versionId: string,
  entityTypes: readonly KnowledgeOntologyEntityTypeInput[],
  predicates: readonly KnowledgeOntologyPredicateInput[],
): Promise<void> {
  for (const entityType of entityTypes) {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public.knowledge_ontology_entity_types(
        tenant_id, knowledge_base_id, ontology_version_id,
        key, name, description, attributes_schema
      ) VALUES (
        ${tenantId}::uuid, ${knowledgeBaseId}::uuid, ${versionId}::uuid,
        ${entityType.key}, ${entityType.name}, ${entityType.description},
        ${JSON.stringify(entityType.attributesSchema)}::jsonb
      )
    `);
  }
  for (const predicate of predicates) {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public.knowledge_ontology_predicates(
        tenant_id, knowledge_base_id, ontology_version_id,
        key, predicate, label, domain_type_key, range_type_key,
        inverse_predicate_key, "symmetric", functional, allow_self_loop,
        temporal, attributes_schema
      ) VALUES (
        ${tenantId}::uuid, ${knowledgeBaseId}::uuid, ${versionId}::uuid,
        ${predicate.key}, ${predicate.predicate}, ${predicate.label},
        ${predicate.domainTypeKey}, ${predicate.rangeTypeKey},
        ${predicate.inversePredicateKey}, ${predicate.symmetric},
        ${predicate.functional}, ${predicate.allowSelfLoop},
        ${predicate.temporal}, ${JSON.stringify(predicate.attributesSchema)}::jsonb
      )
    `);
  }
}

function ontologyTransitionSql(
  principal: AdminPrincipal,
  knowledgeBaseId: string,
  versionId: string,
  request: TransitionKnowledgeOntologyVersionRequest,
  now: Date,
): Prisma.Sql {
  const base = Prisma.sql`
    UPDATE public.knowledge_ontology_versions
    SET revision = revision + 1, updated_at = ${now}
  `;
  const where = Prisma.sql`
    WHERE tenant_id = ${principal.tenantId}::uuid
      AND knowledge_base_id = ${knowledgeBaseId}::uuid
      AND id = ${versionId}::uuid
      AND revision = ${request.expectedRevision}
  `;
  switch (request.action) {
    case 'SUBMIT':
      return Prisma.sql`${base},
        status = 'IN_REVIEW', submitted_by_user_id = ${principal.userId}::uuid,
        submitted_at = ${now}
        ${where} AND status = 'DRAFT'`;
    case 'REQUEST_CHANGES':
      return Prisma.sql`${base},
        status = 'DRAFT', reviewed_by_user_id = ${principal.userId}::uuid,
        review_comment = ${request.comment}, reviewed_at = ${now}
        ${where} AND status = 'IN_REVIEW'`;
    case 'PUBLISH':
      return Prisma.sql`${base},
        status = 'PUBLISHED', reviewed_by_user_id = ${principal.userId}::uuid,
        review_comment = ${request.comment}, reviewed_at = ${now}, published_at = ${now}
        ${where} AND status = 'IN_REVIEW'`;
    case 'RETIRE':
      return Prisma.sql`${base},
        status = 'RETIRED', reviewed_by_user_id = ${principal.userId}::uuid,
        review_comment = ${request.comment}, reviewed_at = ${now}, retired_at = ${now}
        ${where} AND status = 'PUBLISHED'`;
  }
}

function correctionTransitionSql(
  principal: AdminPrincipal,
  knowledgeBaseId: string,
  correctionId: string,
  request: TransitionKnowledgeGraphCorrectionRequest,
  now: Date,
): Prisma.Sql {
  const base = Prisma.sql`
    UPDATE public.knowledge_graph_corrections
    SET revision = revision + 1, updated_at = ${now}
  `;
  const where = Prisma.sql`
    WHERE tenant_id = ${principal.tenantId}::uuid
      AND knowledge_base_id = ${knowledgeBaseId}::uuid
      AND id = ${correctionId}::uuid
      AND revision = ${request.expectedRevision}
  `;
  switch (request.action) {
    case 'SUBMIT':
      return Prisma.sql`${base}, status = 'IN_REVIEW'
        ${where} AND status = 'DRAFT'`;
    case 'APPROVE':
      return Prisma.sql`${base},
        status = 'APPROVED', reviewed_by_user_id = ${principal.userId}::uuid,
        review_comment = ${request.comment}, reviewed_at = ${now}
        ${where} AND status = 'IN_REVIEW'`;
    case 'REJECT':
      return Prisma.sql`${base},
        status = 'REJECTED', reviewed_by_user_id = ${principal.userId}::uuid,
        review_comment = ${request.comment}, reviewed_at = ${now}
        ${where} AND status = 'IN_REVIEW'`;
    case 'APPLY':
      return Prisma.sql`${base}, status = 'APPLIED', applied_at = ${now}
        ${where} AND status = 'APPROVED'`;
  }
}

async function applyCorrection(
  transaction: Prisma.TransactionClient,
  principal: AdminPrincipal,
  knowledgeBaseId: string,
  correction: CorrectionRow,
  comment: string,
  now: Date,
): Promise<void> {
  const patch = requireJsonObject(correction.patch);
  switch (correction.action) {
    case 'MERGE_ENTITY': {
      const sourceEntityId = requireUuidField(patch, 'sourceEntityId');
      const targetEntityId = requireUuidField(patch, 'targetEntityId');
      const reason = requireStringField(patch, 'reason');
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public.knowledge_entity_merges(
          tenant_id, knowledge_base_id, source_entity_id, target_entity_id,
          correction_id, reason, evidence_hash, approved_by_user_id
        ) VALUES (
          ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
          ${sourceEntityId}::uuid, ${targetEntityId}::uuid,
          ${correction.id}::uuid, ${reason}, ${correction.evidence_hash},
          ${correction.reviewed_by_user_id}::uuid
        )
      `);
      break;
    }
    case 'ADD_ALIAS': {
      const entityId = requireUuidField(patch, 'entityId');
      const alias = requireStringField(patch, 'alias');
      const sourceEvidence = requireJsonObject(patch.sourceEvidence);
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public.knowledge_entity_aliases(
          tenant_id, knowledge_base_id, entity_id, alias, normalized_alias,
          source_evidence, correction_id, created_by_user_id
        ) VALUES (
          ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid, ${entityId}::uuid,
          ${alias}, ${normalizeAlias(alias)}, ${JSON.stringify(sourceEvidence)}::jsonb,
          ${correction.id}::uuid, ${principal.userId}::uuid
        )
      `);
      break;
    }
    case 'UPSERT_RELATION_VALIDITY': {
      const relationId = requireUuidField(patch, 'relationId');
      const ontologyVersionId = requireUuidField(patch, 'ontologyVersionId');
      const predicateDefinitionId = requireUuidField(patch, 'predicateDefinitionId');
      const validFrom = new Date(requireStringField(patch, 'validFrom'));
      const validToValue = patch.validTo;
      const validTo = validToValue === null ? null : new Date(requireStringField(patch, 'validTo'));
      const existing = await transaction.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
        SELECT revision
        FROM public.knowledge_relation_governance
        WHERE tenant_id = ${principal.tenantId}::uuid
          AND knowledge_base_id = ${knowledgeBaseId}::uuid
          AND relation_id = ${relationId}::uuid
        FOR UPDATE
      `);
      if (existing[0] === undefined) {
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public.knowledge_relation_governance(
            tenant_id, knowledge_base_id, relation_id, ontology_version_id,
            predicate_definition_id, valid_from, valid_to, correction_id,
            approved_by_user_id
          ) VALUES (
            ${principal.tenantId}::uuid, ${knowledgeBaseId}::uuid,
            ${relationId}::uuid, ${ontologyVersionId}::uuid,
            ${predicateDefinitionId}::uuid, ${validFrom}, ${validTo},
            ${correction.id}::uuid, ${correction.reviewed_by_user_id}::uuid
          )
        `);
      } else {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public.knowledge_relation_governance
          SET ontology_version_id = ${ontologyVersionId}::uuid,
              predicate_definition_id = ${predicateDefinitionId}::uuid,
              valid_from = ${validFrom}, valid_to = ${validTo},
              correction_id = ${correction.id}::uuid,
              approved_by_user_id = ${correction.reviewed_by_user_id}::uuid,
              revision = revision + 1
          WHERE tenant_id = ${principal.tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND relation_id = ${relationId}::uuid
            AND revision = ${existing[0].revision}
        `);
      }
      break;
    }
    case 'RESOLVE_CONFLICT': {
      const conflictId = requireUuidField(patch, 'conflictId');
      const resolution = requireStringField(patch, 'resolution');
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE public.knowledge_graph_conflicts
        SET status = 'RESOLVED', revision = revision + 1,
            reviewed_by_user_id = ${correction.reviewed_by_user_id}::uuid,
            resolution_correction_id = ${correction.id}::uuid,
            review_comment = ${`${comment}: ${resolution}`},
            resolved_at = ${now}, updated_at = ${now}
        WHERE tenant_id = ${principal.tenantId}::uuid
          AND knowledge_base_id = ${knowledgeBaseId}::uuid
          AND id = ${conflictId}::uuid
          AND status IN ('OPEN', 'IN_REVIEW')
      `);
      if (changed !== 1) {
        throw new ConflictException('Graph Conflict changed or was already resolved.');
      }
      break;
    }
  }
}

async function beginCommand(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<CommandRow | null> {
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:${idempotencyKey}`}, 0)
    )
  `);
  const rows = await transaction.$queryRaw<CommandRow[]>(Prisma.sql`
    SELECT request_hash, resource_type, resource_id, result_revision
    FROM public.knowledge_graph_commands
    WHERE tenant_id = ${tenantId}::uuid
      AND idempotency_key = ${idempotencyKey}
  `);
  const existing = rows[0] ?? null;
  if (existing !== null && existing.request_hash !== requestHash) {
    throw new ConflictException('Idempotency key was already used for a different request.');
  }
  return existing;
}

async function recordMutation(
  transaction: Prisma.TransactionClient,
  principal: AdminPrincipal,
  input: {
    readonly knowledgeBaseId: string;
    readonly commandType: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly resultRevision: number;
    readonly action: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public.knowledge_graph_commands(
      tenant_id, knowledge_base_id, command_type, idempotency_key,
      request_hash, resource_type, resource_id, result_revision, actor_user_id
    ) VALUES (
      ${principal.tenantId}::uuid, ${input.knowledgeBaseId}::uuid,
      ${input.commandType}, ${input.idempotencyKey}, ${input.requestHash},
      ${input.resourceType}, ${input.resourceId}::uuid, ${input.resultRevision},
      ${principal.userId}::uuid
    )
  `);
  await transaction.auditEvent.create({
    data: {
      tenantId: principal.tenantId,
      actorType: 'USER',
      actorId: principal.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata as Prisma.InputJsonObject,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      tenantId: principal.tenantId,
      aggregateType: input.resourceType,
      aggregateId: input.resourceId,
      eventType: input.action,
      payload: {
        ...input.metadata,
        knowledgeBaseId: input.knowledgeBaseId,
        revision: input.resultRevision,
      } as Prisma.InputJsonObject,
    },
  });
}

async function requireKnowledgeBase(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT true AS present
    FROM public.knowledge_bases
    WHERE tenant_id = ${tenantId}::uuid AND id = ${knowledgeBaseId}::uuid
  `);
  if (rows[0] === undefined) throw new NotFoundException('Knowledge Base was not found.');
}

async function loadOverview(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
): Promise<KnowledgeGraphGovernanceOverview> {
  const [
    ontologies,
    versions,
    entityTypes,
    predicates,
    conflicts,
    corrections,
    merges,
    aliases,
    counts,
  ] = await Promise.all([
    transaction.$queryRaw<OntologyRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_ontologies
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY updated_at DESC, id
    `),
    transaction.$queryRaw<OntologyVersionRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_ontology_versions
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY ontology_id, version_number DESC
    `),
    transaction.$queryRaw<EntityTypeRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_ontology_entity_types
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY ontology_version_id, key
    `),
    transaction.$queryRaw<PredicateRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_ontology_predicates
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY ontology_version_id, key
    `),
    transaction.$queryRaw<ConflictRow[]>(Prisma.sql`
      SELECT
        conflict.*,
        projection.status::text AS projection_status
      FROM public.knowledge_graph_conflicts conflict
      LEFT JOIN public.knowledge_graph_projections projection
        ON projection.tenant_id = conflict.tenant_id
       AND projection.knowledge_base_id = conflict.knowledge_base_id
       AND projection.id = conflict.projection_id
      WHERE conflict.tenant_id = ${tenantId}::uuid
        AND conflict.knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY conflict.created_at DESC, conflict.id
      LIMIT 200
    `),
    transaction.$queryRaw<CorrectionRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_graph_corrections
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY created_at DESC, id
      LIMIT 200
    `),
    transaction.$queryRaw<MergeRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_entity_merges
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY created_at DESC, id
      LIMIT 200
    `),
    transaction.$queryRaw<AliasRow[]>(Prisma.sql`
      SELECT * FROM public.knowledge_entity_aliases
      WHERE tenant_id = ${tenantId}::uuid AND knowledge_base_id = ${knowledgeBaseId}::uuid
      ORDER BY created_at DESC, id
      LIMIT 500
    `),
    transaction.$queryRaw<
      Array<{
        eligible_relation_count: number;
        excluded_conflict_count: number;
        merged_entity_count: number;
        published_ontology_version_count: number;
      }>
    >(Prisma.sql`
      SELECT
        (
          SELECT count(*)::int FROM public.knowledge_graph_retrieval_relations
          WHERE knowledge_base_id = ${knowledgeBaseId}::uuid
        ) AS eligible_relation_count,
        (
          SELECT count(*)::int FROM public.knowledge_graph_conflicts
          JOIN public.knowledge_graph_projections projection
            ON projection.tenant_id = knowledge_graph_conflicts.tenant_id
           AND projection.knowledge_base_id = knowledge_graph_conflicts.knowledge_base_id
           AND projection.id = knowledge_graph_conflicts.projection_id
           AND projection.status = 'ACTIVE'
          WHERE knowledge_graph_conflicts.tenant_id = ${tenantId}::uuid
            AND knowledge_graph_conflicts.knowledge_base_id = ${knowledgeBaseId}::uuid
            AND knowledge_graph_conflicts.status IN ('OPEN', 'IN_REVIEW')
        ) AS excluded_conflict_count,
        (
          SELECT count(*)::int FROM public.knowledge_entity_merges
          WHERE tenant_id = ${tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
        ) AS merged_entity_count,
        (
          SELECT count(*)::int FROM public.knowledge_ontology_versions
          WHERE tenant_id = ${tenantId}::uuid
            AND knowledge_base_id = ${knowledgeBaseId}::uuid
            AND status = 'PUBLISHED'
        ) AS published_ontology_version_count
    `),
  ]);
  const mappedVersions = new Map<string, KnowledgeOntologyVersion>();
  for (const row of versions) {
    mappedVersions.set(row.id, {
      id: row.id,
      ontologyId: row.ontology_id,
      versionNumber: row.version_number,
      revision: row.revision,
      status: row.status,
      changeSummary: row.change_summary,
      schemaHash: row.schema_hash,
      createdByUserId: row.created_by_user_id,
      submittedByUserId: row.submitted_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id,
      reviewComment: row.review_comment,
      submittedAt: iso(row.submitted_at),
      reviewedAt: iso(row.reviewed_at),
      publishedAt: iso(row.published_at),
      retiredAt: iso(row.retired_at),
      systemBootstrap: row.system_bootstrap,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      entityTypes: entityTypes
        .filter((item) => item.ontology_version_id === row.id)
        .map((item) => ({
          id: item.id,
          key: item.key,
          name: item.name,
          description: item.description,
          attributesSchema: requireJsonObject(item.attributes_schema),
        })),
      predicates: predicates
        .filter((item) => item.ontology_version_id === row.id)
        .map((item) => ({
          id: item.id,
          key: item.key,
          predicate: item.predicate,
          label: item.label,
          domainTypeKey: item.domain_type_key,
          rangeTypeKey: item.range_type_key,
          inversePredicateKey: item.inverse_predicate_key,
          symmetric: item.symmetric,
          functional: item.functional,
          allowSelfLoop: item.allow_self_loop,
          temporal: item.temporal,
          attributesSchema: requireJsonObject(item.attributes_schema),
        })),
    });
  }
  const count = counts[0] ?? {
    eligible_relation_count: 0,
    excluded_conflict_count: 0,
    merged_entity_count: 0,
    published_ontology_version_count: 0,
  };
  return {
    knowledgeBaseId,
    ontologies: ontologies.map((row) => ({
      id: row.id,
      knowledgeBaseId: row.knowledge_base_id,
      code: row.code,
      name: row.name,
      description: row.description,
      revision: row.revision,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      versions: versions
        .filter((version) => version.ontology_id === row.id)
        .flatMap((version) => {
          const mapped = mappedVersions.get(version.id);
          return mapped === undefined ? [] : [mapped];
        }),
    })),
    conflicts: conflicts.map(mapConflict),
    corrections: corrections.map(mapCorrection),
    merges: merges.map(mapMerge),
    aliases: aliases.map(mapAlias),
    retrieval: {
      eligibleRelationCount: count.eligible_relation_count,
      excludedConflictCount: count.excluded_conflict_count,
      mergedEntityCount: count.merged_entity_count,
      publishedOntologyVersionCount: count.published_ontology_version_count,
    },
  };
}

function mapConflict(row: ConflictRow): KnowledgeGraphConflict {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    projectionId: row.projection_id,
    documentVersionId: row.document_version_id,
    projectionStatus: row.projection_status,
    targetType: row.target_type,
    targetId: row.target_id,
    conflictKey: row.conflict_key,
    conflictType: row.conflict_type,
    schemaPredicate: row.schema_predicate,
    schemaSubjectType: row.schema_subject_type,
    schemaObjectType: row.schema_object_type,
    occurrenceCount: row.occurrence_count,
    details: requireJsonObject(row.details),
    evidence: requireJsonObjectArray(row.evidence),
    status: row.status,
    revision: row.revision,
    detectedByUserId: row.detected_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    resolutionCorrectionId: row.resolution_correction_id,
    reviewComment: row.review_comment,
    resolvedAt: iso(row.resolved_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCorrection(row: CorrectionRow): KnowledgeGraphCorrection {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    action: row.action,
    patch: requireJsonObject(row.patch),
    evidence: requireJsonObjectArray(row.evidence),
    evidenceHash: row.evidence_hash,
    status: row.status,
    revision: row.revision,
    proposedByUserId: row.proposed_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewComment: row.review_comment,
    reviewedAt: iso(row.reviewed_at),
    appliedAt: iso(row.applied_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMerge(row: MergeRow): KnowledgeEntityMerge {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    correctionId: row.correction_id,
    reason: row.reason,
    evidenceHash: row.evidence_hash,
    approvedByUserId: row.approved_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mapAlias(row: AliasRow): KnowledgeEntityAlias {
  return {
    id: row.id,
    entityId: row.entity_id,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    active: row.active,
    correctionId: row.correction_id,
    createdAt: row.created_at.toISOString(),
    retiredAt: iso(row.retired_at),
  };
}

function requireOntologyFromOverview(
  overview: KnowledgeGraphGovernanceOverview,
  id: string,
): KnowledgeOntology {
  const value = overview.ontologies.find((item) => item.id === id);
  if (value === undefined) throw new NotFoundException('Knowledge Ontology was not found.');
  return value;
}

function requireVersionFromOverview(
  overview: KnowledgeGraphGovernanceOverview,
  id: string,
): KnowledgeOntologyVersion {
  for (const ontology of overview.ontologies) {
    const value = ontology.versions.find((item) => item.id === id);
    if (value !== undefined) return value;
  }
  throw new NotFoundException('Knowledge Ontology Version was not found.');
}

function requireConflictFromOverview(
  overview: KnowledgeGraphGovernanceOverview,
  id: string,
): KnowledgeGraphConflict {
  const value = overview.conflicts.find((item) => item.id === id);
  if (value === undefined) throw new NotFoundException('Knowledge Graph Conflict was not found.');
  return value;
}

function requireCorrectionFromOverview(
  overview: KnowledgeGraphGovernanceOverview,
  id: string,
): KnowledgeGraphCorrection {
  const value = overview.corrections.find((item) => item.id === id);
  if (value === undefined) throw new NotFoundException('Knowledge Graph Correction was not found.');
  return value;
}

function requireReplayType(command: CommandRow, expected: string): void {
  if (command.resource_type !== expected) {
    throw new ConflictException('Idempotency replay resolved to a different resource type.');
  }
}

function requestIdentity(value: unknown): string {
  return stableHash(value);
}

function ontologySchemaHash(
  entityTypes: readonly KnowledgeOntologyEntityTypeInput[],
  predicates: readonly KnowledgeOntologyPredicateInput[],
): string {
  return stableHash({ entityTypes, predicates });
}

export function stableKnowledgeGraphHash(value: unknown): string {
  return stableHash(value);
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new UnprocessableEntityException('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireJsonObjectArray(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || Array.isArray(item) || typeof item !== 'object')
  ) {
    throw new UnprocessableEntityException('Expected an array of JSON evidence objects.');
  }
  return value as Record<string, unknown>[];
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UnprocessableEntityException(`Correction patch.${key} must be text.`);
  }
  return value;
}

function requireUuidField(record: Record<string, unknown>, key: string): string {
  const value = requireStringField(record, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new UnprocessableEntityException(`Correction patch.${key} must be a UUID.`);
  }
  return value;
}

function normalizeAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapWriteError(error: unknown, resource: string): unknown {
  if (error instanceof HttpException) return error;
  const clientCode = readErrorField(error, 'code');
  const databaseCode = readErrorMetaField(error, 'code') ?? clientCode;
  const databaseMessage =
    readErrorMetaField(error, 'message') ??
    (error instanceof Error ? error.message : `${resource} mutation failed unexpectedly.`);
  if (clientCode === 'P2002' || databaseCode === '23505') {
    return new ConflictException(`${resource} already exists or the idempotency key was reused.`);
  }
  if (databaseCode === '40001') {
    return new ConflictException(`${resource} changed concurrently. Refresh and try again.`);
  }
  if (clientCode === 'P2003' || databaseCode === '23503') {
    return new NotFoundException(`${resource} references a missing record.`);
  }
  if (databaseCode === '23514' || databaseCode === '55000') {
    return new UnprocessableEntityException(databaseMessage);
  }
  return error;
}

function readErrorField(error: unknown, key: string): string | null {
  if (error === null || typeof error !== 'object' || !(key in error)) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readErrorMetaField(error: unknown, key: string): string | null {
  if (error === null || typeof error !== 'object' || !('meta' in error)) return null;
  const meta = (error as { readonly meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || !(key in meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
