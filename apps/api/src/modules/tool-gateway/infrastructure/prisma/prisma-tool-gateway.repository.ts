import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  AvailableTool,
  CreateToolInvocationRequest,
  ToolDefinition,
  ToolDefinitionDetail,
  ToolInvocation,
  ToolInvocationDecisionRequest,
  ToolVersion,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../../../process-orchestration/application/runtime-mutation-result.js';
import {
  appendRuntimeAuditAndOutbox,
  databaseErrorText,
  decodeRuntimeCursor,
  encodeRuntimeCursor,
  isDatabaseConflict,
  isDatabaseRejection,
  jsonObject,
  runtimeHash,
  stringArray,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import {
  decideToolInvocationPolicy,
  type ToolInvocationPolicyDecision,
  type TrustedToolAssignment,
  type TrustedToolTask,
} from '../../domain/tool-invocation.policy.js';
import {
  decideToolInvocationTransition,
  type ToolInvocationCommand,
  type TrustedToolTransitionActor,
} from '../../domain/tool-invocation-state-machine.js';
import { validateToolJsonInput } from '../../domain/tool-json-schema.validator.js';
import {
  ToolGatewayRepository,
  type CreateToolCompensationInput,
  type CreateToolDefinitionInput,
  type CreateToolInvocationInput,
  type CreateToolVersionInput,
  type DecideToolInvocationInput,
  type TransitionToolVersionInput,
} from '../../tool-gateway.repository.js';
import {
  mapToolDefinitionRow,
  mapToolInvocationRow,
  mapToolVersionRow,
  type ToolDefinitionRow,
  type ToolInvocationRow,
  type ToolVersionRow,
  withToolTenant,
} from './tool-gateway-prisma.support.js';

const TOOL_GATEWAY_SERVICE_PRINCIPAL_ID = '00000000-0000-7000-8000-00000000a004';
const PROOF_TTL_MS = 10 * 60 * 1_000;

interface InvocationLineage {
  readonly retryOfInvocationId: string | null;
  readonly compensationOriginal: ToolInvocationRow | null;
  readonly compensationRequestHash: string | null;
}

@Injectable()
export class PrismaToolGatewayRepository extends ToolGatewayRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async listAvailableTools(
    principal: CreateToolInvocationInput['principal'],
    taskId: string,
  ): Promise<readonly AvailableTool[]> {
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const tasks = await transaction.$queryRaw<TaskContextRow[]>`
          SELECT "id", "tenant_id", "status", "owner_role_assignment_id",
                 "permission_labels"
          FROM public."tasks"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${taskId}::uuid
          LIMIT 1
          FOR SHARE
        `;
        const task = tasks[0];
        if (
          task === undefined ||
          task.owner_role_assignment_id === null ||
          !['READY', 'IN_PROGRESS'].includes(task.status)
        ) {
          return [];
        }
        const assignment = await loadAssignmentById(
          transaction,
          principal.tenantId,
          task.owner_role_assignment_id,
        );
        if (assignment === null || assignment.userId !== principal.userId) return [];

        const tools = await transaction.$queryRaw<ToolContextRow[]>`
          SELECT version.*, definition."status" AS "definition_status"
          FROM public."tool_versions" version
          JOIN public."tool_definitions" definition
            ON definition."tenant_id" = version."tenant_id"
           AND definition."id" = version."tool_id"
          WHERE version."tenant_id" = ${principal.tenantId}::uuid
            AND definition."status" = 'PUBLISHED'
            AND definition."current_version_id" = version."id"
            AND definition."current_version" = version."version"
            AND version."status" = 'PUBLISHED'
          ORDER BY version."name" ASC, version."id" ASC
          FOR SHARE OF version, definition
        `;
        const now = new Date();
        const available: AvailableTool[] = [];
        for (const tool of tools) {
          const context: InvocationContext = { tool, task, assignment };
          const policy = decideToolInvocationPolicy(
            policyInputFromContext({
              invocationId: randomUUID(),
              principal,
              context,
              inputHash: '0'.repeat(64),
              policyDecisionId: `available-tool:${tool.id}`,
              dryRun: false,
              now,
            }),
          );
          if (policy.kind === 'deny') continue;
          available.push({
            toolId: tool.tool_id,
            toolVersionId: tool.id,
            key: tool.key,
            name: tool.name,
            description: tool.description,
            version: tool.version,
            inputSchema: jsonObject(tool.input_schema),
            outputSchema: jsonObject(tool.output_schema),
            riskClass: tool.risk_class,
            dataClassification: tool.data_classification,
            dryRunMode: tool.dry_run_mode,
            requiresConfirmation: ['CONFIRM_REQUIRED', 'HIGH_RISK_APPROVAL'].includes(
              tool.risk_class,
            ),
            requiresApproval: tool.risk_class === 'HIGH_RISK_APPROVAL',
          });
        }
        return available;
      },
    );
  }

  async listReviewableInvocations(
    principal: CreateToolInvocationInput['principal'],
    taskId: string,
  ): Promise<readonly ToolInvocation[]> {
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const rows = await transaction.$queryRaw<ToolInvocationRow[]>`
          SELECT *
          FROM public."tool_invocations"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "task_id" = ${taskId}::uuid
            AND "status" = 'PENDING_APPROVAL'
            AND "requester_user_id" <> ${principal.userId}::uuid
          ORDER BY "created_at" ASC, "id" ASC
          LIMIT 500
          FOR SHARE
        `;
        const reviewable: ToolInvocation[] = [];
        for (const row of rows) {
          const assignment = await loadReviewerAssignment(transaction, row, principal.userId);
          if (assignment !== null) reviewable.push(mapToolInvocationRow(row));
        }
        return reviewable;
      },
    );
  }

  async listDefinitions(
    principal: CreateToolDefinitionInput['principal'],
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<ToolDefinition>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_admin',
      async (transaction) => {
        const rows = await transaction.$queryRaw<ToolDefinitionRow[]>(Prisma.sql`
          SELECT *
          FROM public."tool_definitions"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            ${
              cursor === null
                ? Prisma.empty
                : Prisma.sql`
                  AND ("updated_at", "id") <
                      (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)
                `
            }
          ORDER BY "updated_at" DESC, "id" DESC
          LIMIT ${page.limit + 1}
        `);
        const visible = rows.slice(0, page.limit);
        const last = visible.at(-1);
        return {
          items: visible.map(mapToolDefinitionRow),
          nextCursor:
            rows.length > page.limit && last !== undefined
              ? encodeRuntimeCursor(last.updated_at, last.id)
              : null,
        };
      },
    );
  }

  async findDefinition(
    principal: CreateToolDefinitionInput['principal'],
    toolId: string,
  ): Promise<ToolDefinitionDetail | null> {
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_admin',
      (transaction) => loadDefinitionDetail(transaction, principal.tenantId, toolId),
    );
  }

  async createDefinition(
    input: CreateToolDefinitionInput,
  ): Promise<RuntimeMutationResult<ToolDefinition>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_admin',
        async (transaction) => {
          const ownerUserId = input.request.ownerUserId ?? input.principal.userId;
          await transaction.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtextextended(
                ${`tool-definition-key:${input.principal.tenantId}`},
                0
              )
            )
          `;
          const candidates = await transaction.$queryRaw<ToolDefinitionRow[]>`
            SELECT *
            FROM public."tool_definitions"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND (
                "key" = ${input.request.key}
                OR (
                  ${input.keyWasGenerated}
                  AND "key" LIKE ${`${input.request.key}-%`}
                )
              )
            ORDER BY "created_at" ASC, "id" ASC
          `;
          const replay = candidates.find((candidate) =>
            definitionRequestMatches(candidate, input.request, ownerUserId),
          );
          if (replay !== undefined) {
            return { kind: 'IDEMPOTENT_REPLAY', value: mapToolDefinitionRow(replay) };
          }
          if (!input.keyWasGenerated && candidates.length > 0) {
            return { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          const definitionKey = input.keyWasGenerated
            ? nextGeneratedDefinitionKey(
                input.request.key,
                new Set(candidates.map((candidate) => candidate.key)),
              )
            : input.request.key;
          const id = randomUUID();
          const createdRows = await transaction.$queryRaw<ToolDefinitionRow[]>(Prisma.sql`
            INSERT INTO public."tool_definitions" (
              "id", "tenant_id", "key", "name", "description",
              "owner_user_id", "permission_labels"
            ) VALUES (
              ${id}::uuid,
              ${input.principal.tenantId}::uuid,
              ${definitionKey},
              ${input.request.name},
              ${input.request.description},
              ${ownerUserId}::uuid,
              ${JSON.stringify(input.request.permissionLabels)}::jsonb
            )
            RETURNING *
          `);
          const created = createdRows[0];
          if (created === undefined) throw new Error('Tool Definition INSERT returned no row.');
          await appendRuntimeAuditAndOutbox(transaction, input.principal, {
            action: 'tool.definition.create',
            resourceType: 'TOOL_DEFINITION',
            resourceId: id,
            eventType: 'ToolDefinition.Created',
            payload: {
              toolDefinitionId: id,
              key: definitionKey,
              keySource: input.keyWasGenerated ? 'SERVER_GENERATED' : 'EXPLICIT',
              idempotencyKey: input.request.idempotencyKey,
            },
            occurredAt: created.created_at,
          });
          return { kind: 'APPLIED', value: mapToolDefinitionRow(created) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async createVersion(input: CreateToolVersionInput): Promise<RuntimeMutationResult<ToolVersion>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_admin',
        async (transaction) => {
          const definitions = await transaction.$queryRaw<ToolDefinitionRow[]>`
            SELECT *
            FROM public."tool_definitions"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "id" = ${input.toolId}::uuid
            FOR UPDATE
          `;
          const definition = definitions[0];
          if (definition === undefined) return { kind: 'NOT_FOUND' };
          if (definition.status === 'RETIRED') {
            return rejected('A retired Tool Definition cannot receive a new version.');
          }
          const ownerUserId = input.request.ownerUserId ?? definition.owner_user_id;
          const configuration = versionConfiguration(definition.key, ownerUserId, input.request);
          const configurationHash = runtimeHash(configuration);
          const latest = await transaction.$queryRaw<ToolVersionRow[]>`
            SELECT *
            FROM public."tool_versions"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "tool_id" = ${input.toolId}::uuid
            ORDER BY "version" DESC
            LIMIT 1
          `;
          if (latest[0]?.status === 'DRAFT' && latest[0].configuration_hash === configurationHash) {
            return {
              kind: 'IDEMPOTENT_REPLAY',
              value: mapToolVersionRow(latest[0]),
            };
          }
          const version = (latest[0]?.version ?? 0) + 1;
          const id = randomUUID();
          const createdRows = await transaction.$queryRaw<ToolVersionRow[]>(Prisma.sql`
            INSERT INTO public."tool_versions" (
              "id", "tenant_id", "tool_id", "version", "key",
              "name", "description", "owner_user_id", "adapter", "endpoint_ref",
              "input_schema", "output_schema", "risk_class", "data_classification",
              "timeout_ms", "max_attempts", "idempotency_mode", "dry_run_mode",
              "allowed_http_methods", "allowed_host_patterns", "sensitive_input_paths",
              "compensation_tool_version_id", "configuration_hash",
              "effective_from", "effective_to", "created_by_user_id"
            ) VALUES (
              ${id}::uuid,
              ${input.principal.tenantId}::uuid,
              ${input.toolId}::uuid,
              ${version},
              ${definition.key},
              ${input.request.name},
              ${input.request.description},
              ${ownerUserId}::uuid,
              ${input.request.adapter}::public."ToolExecutionAdapter",
              ${input.request.endpointRef},
              ${JSON.stringify(input.request.inputSchema)}::jsonb,
              ${JSON.stringify(input.request.outputSchema)}::jsonb,
              ${input.request.riskClass}::public."ToolRiskClass",
              ${input.request.dataClassification}::public."ToolDataClassification",
              ${input.request.timeoutMs},
              ${input.request.maxAttempts},
              ${input.request.idempotencyMode}::public."ToolIdempotencyMode",
              ${input.request.dryRunMode}::public."ToolDryRunMode",
              ${JSON.stringify(input.request.allowedHttpMethods)}::jsonb,
              ${JSON.stringify(input.request.allowedHostPatterns)}::jsonb,
              ${JSON.stringify(input.request.sensitiveInputPaths)}::jsonb,
              ${input.request.compensationToolVersionId ?? null}::uuid,
              ${configurationHash},
              ${new Date(input.request.effectiveFrom)},
              ${
                input.request.effectiveTo === undefined ? null : new Date(input.request.effectiveTo)
              },
              ${input.principal.userId}::uuid
            )
            RETURNING *
          `);
          const created = createdRows[0];
          if (created === undefined) throw new Error('Tool Version INSERT returned no row.');
          await appendRuntimeAuditAndOutbox(transaction, input.principal, {
            action: 'tool.version.create',
            resourceType: 'TOOL_VERSION',
            resourceId: id,
            eventType: 'ToolVersion.DraftCreated',
            payload: {
              toolDefinitionId: input.toolId,
              toolVersionId: id,
              version,
              configurationHash,
              idempotencyKey: input.request.idempotencyKey,
            },
            occurredAt: created.created_at,
          });
          return { kind: 'APPLIED', value: mapToolVersionRow(created) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async transitionVersion(
    input: TransitionToolVersionInput,
  ): Promise<RuntimeMutationResult<ToolDefinitionDetail>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_admin',
        async (transaction) => {
          const definitions = await transaction.$queryRaw<ToolDefinitionRow[]>`
            SELECT *
            FROM public."tool_definitions"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "id" = ${input.toolId}::uuid
            FOR UPDATE
          `;
          const definition = definitions[0];
          if (definition === undefined) return { kind: 'NOT_FOUND' };
          const versions = await transaction.$queryRaw<ToolVersionRow[]>`
            SELECT *
            FROM public."tool_versions"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "tool_id" = ${input.toolId}::uuid
              AND "id" = ${input.toolVersionId}::uuid
            FOR UPDATE
          `;
          const version = versions[0];
          if (version === undefined) return { kind: 'NOT_FOUND' };
          if (definition.revision !== input.request.expectedDefinitionRevision) {
            if (version.status === lifecycleStatus(input.request.action)) {
              const detail = await loadDefinitionDetail(
                transaction,
                input.principal.tenantId,
                input.toolId,
              );
              if (detail === null) return { kind: 'NOT_FOUND' };
              return { kind: 'IDEMPOTENT_REPLAY', value: detail };
            }
            return {
              kind: 'STALE_REVISION',
              currentRevision: definition.revision,
            };
          }
          const lifecycle = lifecycleMutation(definition, version, input.request.action);
          if (lifecycle === null) {
            return rejected('The requested Tool Version lifecycle transition is invalid.');
          }
          await transaction.$executeRaw(Prisma.sql`
            UPDATE public."tool_versions"
            SET "status" = ${lifecycle.versionStatus}::public."ToolDefinitionStatus",
                "published_at" = CASE
                  WHEN ${lifecycle.versionStatus === 'PUBLISHED'}
                    THEN CURRENT_TIMESTAMP
                  ELSE "published_at"
                END,
                "retired_at" = CASE
                  WHEN ${lifecycle.versionStatus === 'RETIRED'}
                    THEN CURRENT_TIMESTAMP
                  ELSE "retired_at"
                END
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "id" = ${input.toolVersionId}::uuid
          `);
          if (lifecycle.updateDefinition) {
            await transaction.$executeRaw(Prisma.sql`
              UPDATE public."tool_definitions"
              SET "status" = ${lifecycle.definitionStatus}::public."ToolDefinitionStatus",
                  "current_version_id" = ${lifecycle.currentVersionId}::uuid,
                  "current_version" = ${lifecycle.currentVersion},
                  "revision" = "revision" + 1
              WHERE "tenant_id" = ${input.principal.tenantId}::uuid
                AND "id" = ${input.toolId}::uuid
                AND "revision" = ${input.request.expectedDefinitionRevision}
            `);
          }
          const detail = await loadDefinitionDetail(
            transaction,
            input.principal.tenantId,
            input.toolId,
          );
          if (detail === null) throw new Error('Tool lifecycle result was not found.');
          await appendRuntimeAuditAndOutbox(transaction, input.principal, {
            action: `tool.version.${input.request.action.toLowerCase()}`,
            resourceType: 'TOOL_VERSION',
            resourceId: input.toolVersionId,
            eventType: `ToolVersion.${lifecycle.versionStatus}`,
            payload: {
              toolDefinitionId: input.toolId,
              toolVersionId: input.toolVersionId,
              version: version.version,
              reason: input.request.reason,
              idempotencyKey: input.request.idempotencyKey,
            },
            occurredAt: new Date(),
          });
          return { kind: 'APPLIED', value: detail };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async listInvocations(
    principal: CreateToolInvocationInput['principal'],
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<ToolInvocation>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const rows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
          SELECT *
          FROM public."tool_invocations"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "requester_user_id" = ${principal.userId}::uuid
            ${
              cursor === null
                ? Prisma.empty
                : Prisma.sql`
                  AND ("created_at", "id") <
                      (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)
                `
            }
          ORDER BY "created_at" DESC, "id" DESC
          LIMIT ${page.limit + 1}
        `);
        const visible = rows.slice(0, page.limit);
        const last = visible.at(-1);
        return {
          items: visible.map(mapToolInvocationRow),
          nextCursor:
            rows.length > page.limit && last !== undefined
              ? encodeRuntimeCursor(last.created_at, last.id)
              : null,
        };
      },
    );
  }

  async findInvocation(
    principal: CreateToolInvocationInput['principal'],
    invocationId: string,
  ): Promise<ToolInvocation | null> {
    return withToolTenant(
      this.prisma,
      principal.tenantId,
      principal.userId,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const row = await findInvocationRow(transaction, principal.tenantId, invocationId, false);
        return row === null || row.requester_user_id !== principal.userId
          ? null
          : mapToolInvocationRow(row);
      },
    );
  }

  async createInvocation(
    input: CreateToolInvocationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_tool_gateway',
        (transaction) =>
          createInvocationInTransaction(transaction, input.principal, input.request, {
            retryOfInvocationId: null,
            compensationOriginal: null,
            compensationRequestHash: null,
          }),
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async createCompensation(
    input: CreateToolCompensationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_tool_gateway',
        (transaction) => createCompensationInTransaction(transaction, input),
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async decideInvocation(
    input: DecideToolInvocationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>> {
    try {
      return await withToolTenant(
        this.prisma,
        input.principal.tenantId,
        input.principal.userId,
        'enterprise_agent_tool_gateway',
        (transaction) => decideInvocationInTransaction(transaction, input),
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
}

async function loadDefinitionDetail(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  toolId: string,
): Promise<ToolDefinitionDetail | null> {
  const definitions = await transaction.$queryRaw<ToolDefinitionRow[]>`
    SELECT *
    FROM public."tool_definitions"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${toolId}::uuid
    LIMIT 1
  `;
  const definition = definitions[0];
  if (definition === undefined) return null;
  const versions = await transaction.$queryRaw<ToolVersionRow[]>`
    SELECT *
    FROM public."tool_versions"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "tool_id" = ${toolId}::uuid
    ORDER BY "version" DESC
  `;
  return {
    definition: mapToolDefinitionRow(definition),
    versions: versions.map(mapToolVersionRow),
  };
}

function versionConfiguration(
  key: string,
  ownerUserId: string,
  request: CreateToolVersionInput['request'],
): Record<string, unknown> {
  return {
    key,
    ownerUserId,
    name: request.name,
    description: request.description,
    adapter: request.adapter,
    endpointRef: request.endpointRef,
    inputSchema: request.inputSchema,
    outputSchema: request.outputSchema,
    riskClass: request.riskClass,
    dataClassification: request.dataClassification,
    timeoutMs: request.timeoutMs,
    maxAttempts: request.maxAttempts,
    idempotencyMode: request.idempotencyMode,
    dryRunMode: request.dryRunMode,
    allowedHttpMethods: request.allowedHttpMethods,
    allowedHostPatterns: request.allowedHostPatterns,
    sensitiveInputPaths: request.sensitiveInputPaths,
    compensationToolVersionId: request.compensationToolVersionId ?? null,
    effectiveFrom: request.effectiveFrom,
    effectiveTo: request.effectiveTo ?? null,
  };
}

function lifecycleStatus(
  action: TransitionToolVersionInput['request']['action'],
): ToolVersion['status'] {
  if (action === 'TEST') return 'TESTING';
  if (action === 'PUBLISH') return 'PUBLISHED';
  return 'RETIRED';
}

function lifecycleMutation(
  definition: ToolDefinitionRow,
  version: ToolVersionRow,
  action: TransitionToolVersionInput['request']['action'],
): {
  readonly versionStatus: ToolVersion['status'];
  readonly updateDefinition: boolean;
  readonly definitionStatus: ToolDefinition['status'];
  readonly currentVersionId: string | null;
  readonly currentVersion: number | null;
} | null {
  if (action === 'TEST') {
    if (version.status !== 'DRAFT') return null;
    return {
      versionStatus: 'TESTING',
      updateDefinition: true,
      definitionStatus: definition.status === 'DRAFT' ? 'TESTING' : definition.status,
      currentVersionId: definition.current_version_id,
      currentVersion: definition.current_version,
    };
  }
  if (action === 'PUBLISH') {
    if (version.status !== 'TESTING' || version.risk_class === 'FORBIDDEN') return null;
    if (!['TESTING', 'PUBLISHED'].includes(definition.status)) return null;
    return {
      versionStatus: 'PUBLISHED',
      updateDefinition: true,
      definitionStatus: 'PUBLISHED',
      currentVersionId: version.id,
      currentVersion: version.version,
    };
  }
  if (!['TESTING', 'PUBLISHED'].includes(version.status)) return null;
  const current = definition.current_version_id === version.id;
  return {
    versionStatus: 'RETIRED',
    updateDefinition: true,
    definitionStatus: current ? 'RETIRED' : definition.status,
    currentVersionId: current ? version.id : definition.current_version_id,
    currentVersion: current ? version.version : definition.current_version,
  };
}

async function createCompensationInTransaction(
  transaction: Prisma.TransactionClient,
  input: CreateToolCompensationInput,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`tool-compensation:${input.principal.tenantId}:${input.originalInvocationId}`},
        0
      )
    )
  `);
  const requestHash = runtimeHash({
    originalInvocationId: input.originalInvocationId,
    expectedRevision: input.request.expectedRevision,
    reason: input.request.reason,
    idempotencyKey: input.request.idempotencyKey,
  });
  const replayRows = await transaction.$queryRaw<
    Array<ToolInvocationRow & { compensation_request_hash: string }>
  >`
    SELECT invocation.*, binding."request_hash" AS compensation_request_hash
    FROM public."tool_invocations" invocation
    JOIN public."tool_compensation_bindings" binding
      ON binding."tenant_id" = invocation."tenant_id"
     AND binding."compensation_invocation_id" = invocation."id"
    WHERE invocation."tenant_id" = ${input.principal.tenantId}::uuid
      AND invocation."compensation_for_invocation_id" =
          ${input.originalInvocationId}::uuid
      AND invocation."idempotency_key" = ${input.request.idempotencyKey}
    LIMIT 1
  `;
  const replay = replayRows[0];
  if (replay !== undefined) {
    return replay.requester_user_id === input.principal.userId &&
      replay.compensation_request_hash === requestHash
      ? { kind: 'IDEMPOTENT_REPLAY', value: mapToolInvocationRow(replay) }
      : { kind: 'IDEMPOTENCY_CONFLICT' };
  }

  const original = await findInvocationRow(
    transaction,
    input.principal.tenantId,
    input.originalInvocationId,
    true,
  );
  if (original === null) return { kind: 'NOT_FOUND' };
  if (original.revision !== input.request.expectedRevision) {
    return { kind: 'STALE_REVISION', currentRevision: original.revision };
  }
  if (original.requester_user_id !== input.principal.userId || original.status !== 'SUCCEEDED') {
    return rejected('Only the requester may compensate their completed SUCCEEDED invocation.');
  }
  if (
    original.dry_run ||
    ['READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'].includes(original.risk_class) ||
    original.provider_request_id === null ||
    original.output === null ||
    original.output_hash === null
  ) {
    return rejected(
      'Only a trusted, side-effecting provider success with an immutable receipt can be compensated.',
    );
  }

  const versions = await transaction.$queryRaw<Array<{ compensation_tool_version_id: string }>>`
    SELECT source."compensation_tool_version_id"
    FROM public."tool_versions" source
    JOIN public."tool_versions" compensator
      ON compensator."tenant_id" = source."tenant_id"
     AND compensator."id" = source."compensation_tool_version_id"
    JOIN public."tool_definitions" definition
      ON definition."tenant_id" = compensator."tenant_id"
     AND definition."id" = compensator."tool_id"
    WHERE source."tenant_id" = ${original.tenant_id}::uuid
      AND source."id" = ${original.tool_version_id}::uuid
      AND source."tool_id" = ${original.tool_id}::uuid
      AND source."version" = ${original.tool_version}
      AND source."configuration_hash" = ${original.tool_configuration_hash}
      AND source."compensation_tool_version_id" IS NOT NULL
      AND compensator."status" = 'PUBLISHED'
      AND compensator."effective_from" <= CURRENT_TIMESTAMP
      AND (
        compensator."effective_to" IS NULL
        OR compensator."effective_to" > CURRENT_TIMESTAMP
      )
      AND compensator."risk_class" NOT IN (
        'READ_ONLY'::public."ToolRiskClass",
        'DRAFT_ONLY'::public."ToolRiskClass",
        'FORBIDDEN'::public."ToolRiskClass"
      )
      AND definition."status" = 'PUBLISHED'
      AND definition."current_version_id" = compensator."id"
      AND definition."current_version" = compensator."version"
    LIMIT 1
    FOR SHARE OF source, compensator, definition
  `;
  const binding = versions[0];
  if (binding === undefined) {
    return rejected(
      'The immutable original Tool Version has no current published compensation Tool Version.',
    );
  }

  const compensationInput = compensationEnvelope(original);
  return createInvocationInTransaction(
    transaction,
    input.principal,
    {
      toolVersionId: binding.compensation_tool_version_id,
      taskId: original.task_id,
      ...(original.process_instance_id === null
        ? {}
        : { processInstanceId: original.process_instance_id }),
      ...(original.agent_run_id === null ? {} : { agentRunId: original.agent_run_id }),
      correlationId: original.correlation_id,
      causationId: original.id,
      dryRun: false,
      input: compensationInput,
      reason: input.request.reason,
      idempotencyKey: input.request.idempotencyKey,
    },
    {
      retryOfInvocationId: null,
      compensationOriginal: original,
      compensationRequestHash: requestHash,
    },
  );
}

async function createInvocationInTransaction(
  transaction: Prisma.TransactionClient,
  principal: CreateToolInvocationInput['principal'],
  request: CreateToolInvocationRequest,
  lineage: InvocationLineage,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  const priorRows = await transaction.$queryRaw<ToolInvocationRow[]>`
    SELECT *
    FROM public."tool_invocations"
    WHERE "tenant_id" = ${principal.tenantId}::uuid
      AND "tool_version_id" = ${request.toolVersionId}::uuid
      AND "idempotency_key" = ${request.idempotencyKey}
    LIMIT 1
  `;
  const prior = priorRows[0];
  if (prior !== undefined) {
    const matches =
      prior.requester_user_id === principal.userId &&
      prior.task_id === request.taskId &&
      prior.correlation_id === request.correlationId &&
      prior.process_instance_id === (request.processInstanceId ?? null) &&
      prior.process_step_instance_id === (request.processStepInstanceId ?? null) &&
      prior.agent_run_id === (request.agentRunId ?? null) &&
      prior.dry_run === request.dryRun &&
      prior.input_hash === runtimeHash(request.input) &&
      prior.retry_of_invocation_id === lineage.retryOfInvocationId &&
      prior.compensation_for_invocation_id === (lineage.compensationOriginal?.id ?? null);
    return matches
      ? { kind: 'IDEMPOTENT_REPLAY', value: mapToolInvocationRow(prior) }
      : { kind: 'IDEMPOTENCY_CONFLICT' };
  }

  const context = await loadInvocationContext(
    transaction,
    principal.tenantId,
    principal.userId,
    request.toolVersionId,
    request.taskId,
  );
  if (context === null) {
    return rejected(
      'The published Tool Version, active Task, or requester Task-owner Assignment was not found.',
    );
  }
  const validation = validateToolJsonInput(jsonObject(context.tool.input_schema), request.input);
  if (!validation.valid) {
    return rejected(`Tool input validation failed: ${validation.errors.join(' ')}`);
  }
  const invocationId = randomUUID();
  const now = new Date();
  const inputHash = runtimeHash(request.input);
  const policyDecisionId = `tool-policy:${runtimeHash({
    invocationId,
    toolVersionId: context.tool.id,
    taskId: context.task.id,
    assignmentId: context.assignment.id,
    inputHash,
    dryRun: request.dryRun,
  })}`;
  const policyInput = policyInputFromContext({
    invocationId,
    principal,
    context,
    inputHash,
    policyDecisionId,
    dryRun: request.dryRun,
    now,
  });
  const policyDecision = decideToolInvocationPolicy(policyInput);
  const providerDispatchAllowed =
    context.tool.risk_class !== 'FORBIDDEN' &&
    (!request.dryRun || context.tool.dry_run_mode === 'NATIVE');
  const providerDryRun = request.dryRun && context.tool.dry_run_mode === 'NATIVE';
  const policySnapshot = {
    schemaVersion: 1,
    reasonCode: policyDecision.reasonCode,
    obligations: policyDecision.obligations,
    assignmentId: context.assignment.id,
    taskId: context.task.id,
    toolVersionId: context.tool.id,
    ...(lineage.compensationOriginal === null
      ? {}
      : {
          compensation: {
            originalInvocationId: lineage.compensationOriginal.id,
            originalToolVersionId: lineage.compensationOriginal.tool_version_id,
            originalInputHash: lineage.compensationOriginal.input_hash,
            originalProviderRequestId: lineage.compensationOriginal.provider_request_id,
            originalOutputHash: lineage.compensationOriginal.output_hash,
          },
        }),
    evaluatedAt: now.toISOString(),
  };
  const insertedRows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
    INSERT INTO public."tool_invocations" (
      "id", "tenant_id", "tool_id", "tool_version_id", "tool_version",
      "tool_configuration_hash", "adapter", "risk_class",
      "data_classification", "idempotency_mode", "dry_run_mode",
      "requester_user_id", "role_assignment_id", "task_id",
      "process_instance_id", "process_step_instance_id", "agent_run_id",
      "correlation_id", "causation_id", "retry_of_invocation_id",
      "compensation_for_invocation_id",
      "status", "revision", "dry_run", "provider_dispatch_allowed",
      "provider_dry_run", "input", "input_hash", "redacted_input_summary",
      "policy_decision_id", "policy_snapshot", "idempotency_key"
    ) VALUES (
      ${invocationId}::uuid,
      ${principal.tenantId}::uuid,
      ${context.tool.tool_id}::uuid,
      ${context.tool.id}::uuid,
      ${context.tool.version},
      ${context.tool.configuration_hash},
      ${context.tool.adapter}::public."ToolExecutionAdapter",
      ${context.tool.risk_class}::public."ToolRiskClass",
      ${context.tool.data_classification}::public."ToolDataClassification",
      ${context.tool.idempotency_mode}::public."ToolIdempotencyMode",
      ${context.tool.dry_run_mode}::public."ToolDryRunMode",
      ${principal.userId}::uuid,
      ${context.assignment.id}::uuid,
      ${context.task.id}::uuid,
      ${request.processInstanceId ?? null}::uuid,
      ${request.processStepInstanceId ?? null}::uuid,
      ${request.agentRunId ?? null}::uuid,
      ${request.correlationId}::uuid,
      ${request.causationId ?? null}::uuid,
      ${lineage.retryOfInvocationId}::uuid,
      ${lineage.compensationOriginal?.id ?? null}::uuid,
      'REQUESTED'::public."ToolInvocationStatus",
      1,
      ${request.dryRun},
      ${providerDispatchAllowed},
      ${providerDryRun},
      ${JSON.stringify(request.input)}::jsonb,
      ${inputHash},
      ${JSON.stringify(
        redactInput(request.input, stringArray(context.tool.sensitive_input_paths)),
      )}::jsonb,
      ${policyDecisionId},
      ${JSON.stringify(policySnapshot)}::jsonb,
      ${request.idempotencyKey}
    )
    RETURNING *
  `);
  const inserted = insertedRows[0];
  if (inserted === undefined) throw new Error('Tool Invocation INSERT returned no row.');
  if (lineage.compensationOriginal !== null) {
    if (
      lineage.compensationRequestHash === null ||
      lineage.compensationOriginal.provider_request_id === null ||
      lineage.compensationOriginal.output_hash === null
    ) {
      throw new Error('Compensation binding is missing its immutable original proof.');
    }
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."tool_compensation_bindings" (
        "id", "tenant_id", "original_invocation_id",
        "compensation_invocation_id", "original_tool_version_id",
        "compensation_tool_version_id", "original_input_hash",
        "original_provider_request_id", "original_output_hash",
        "compensation_input_hash", "requested_by_user_id",
        "requested_by_role_assignment_id", "idempotency_key",
        "request_hash", "created_at"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${inserted.tenant_id}::uuid,
        ${lineage.compensationOriginal.id}::uuid,
        ${inserted.id}::uuid,
        ${lineage.compensationOriginal.tool_version_id}::uuid,
        ${inserted.tool_version_id}::uuid,
        ${lineage.compensationOriginal.input_hash},
        ${lineage.compensationOriginal.provider_request_id},
        ${lineage.compensationOriginal.output_hash},
        ${inserted.input_hash},
        ${inserted.requester_user_id}::uuid,
        ${inserted.role_assignment_id}::uuid,
        ${inserted.idempotency_key},
        ${lineage.compensationRequestHash},
        ${now}
      )
    `);
  }
  const command = initialCommand(policyDecision);
  if (command === null) {
    return rejected('Tool policy returned an unsupported initial gate.');
  }
  const proof = policyProof(inserted, policyDecision, now);
  const transitioned = await transitionInvocation(transaction, inserted, {
    command,
    reason: request.reason,
    idempotencyKey: commandIdempotencyKey(
      inserted.id,
      inserted.revision,
      command,
      request.idempotencyKey,
    ),
    actor: systemActor(principal.tenantId),
    policyProof: proof,
    confirmationProof: null,
    approvalProof: null,
    providerProof: null,
    completedAt: command === 'DENY' ? now : null,
    now,
  });
  if (transitioned.kind !== 'APPLIED') return transitioned;
  if (
    transitioned.value.status === 'APPROVED' &&
    inserted.dry_run &&
    inserted.dry_run_mode === 'VALIDATE_ONLY'
  ) {
    return completeValidateOnly(transaction, transitioned.value, request.reason);
  }
  return transitioned;
}

async function decideInvocationInTransaction(
  transaction: Prisma.TransactionClient,
  input: DecideToolInvocationInput,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  const current = await findInvocationRow(
    transaction,
    input.principal.tenantId,
    input.invocationId,
    true,
  );
  if (current === null) return { kind: 'NOT_FOUND' };
  const directCommand = requestActionCommand(input.request.action);
  if (directCommand !== null) {
    const commandKey = commandIdempotencyKey(
      current.id,
      input.request.expectedRevision,
      directCommand,
      input.request.idempotencyKey,
    );
    const replayRows = await transaction.$queryRaw<
      Array<{
        tool_invocation_id: string;
        command: ToolInvocationCommand;
        expected_revision: number;
      }>
    >`
      SELECT "tool_invocation_id", "command", "expected_revision"
      FROM public."tool_invocation_commands"
      WHERE "tenant_id" = ${input.principal.tenantId}::uuid
        AND "idempotency_key" = ${commandKey}
      LIMIT 1
    `;
    const replay = replayRows[0];
    if (replay !== undefined) {
      return replay.tool_invocation_id === current.id &&
        replay.command === directCommand &&
        replay.expected_revision === input.request.expectedRevision
        ? { kind: 'IDEMPOTENT_REPLAY', value: mapToolInvocationRow(current) }
        : { kind: 'IDEMPOTENCY_CONFLICT' };
    }
  }
  if (current.revision !== input.request.expectedRevision) {
    return { kind: 'STALE_REVISION', currentRevision: current.revision };
  }
  if (input.request.action === 'RETRY') {
    if (current.requester_user_id !== input.principal.userId || current.status !== 'FAILED') {
      return rejected(
        'Only the requester may retry a confirmed FAILED Tool Invocation; UNKNOWN requires reconciliation.',
      );
    }
    if (current.compensation_for_invocation_id !== null) {
      return rejected(
        'A failed compensation cannot replay automatically; investigate its immutable receipt and use an approved recovery workflow.',
      );
    }
    if (!(await toolRetryBudgetAvailable(transaction, current))) {
      return rejected('The immutable Tool Version retry budget has been exhausted.');
    }
    return createInvocationInTransaction(
      transaction,
      input.principal,
      {
        toolVersionId: current.tool_version_id,
        taskId: current.task_id,
        ...(current.process_instance_id === null
          ? {}
          : { processInstanceId: current.process_instance_id }),
        ...(current.process_step_instance_id === null
          ? {}
          : { processStepInstanceId: current.process_step_instance_id }),
        ...(current.agent_run_id === null ? {} : { agentRunId: current.agent_run_id }),
        correlationId: current.correlation_id,
        causationId: current.id,
        dryRun: current.dry_run,
        input: jsonObject(current.input),
        reason: input.request.reason,
        idempotencyKey: input.request.idempotencyKey,
      },
      {
        retryOfInvocationId: current.id,
        compensationOriginal: null,
        compensationRequestHash: null,
      },
    );
  }
  if (input.request.action === 'RECONCILE') {
    if (
      current.status !== 'UNKNOWN' ||
      (current.requester_user_id !== input.principal.userId &&
        !['OWNER', 'ADMIN'].includes(input.principal.tenantRole))
    ) {
      return rejected('Only an authorized actor may reconcile an UNKNOWN Tool Invocation.');
    }
    await appendRuntimeAuditAndOutbox(transaction, input.principal, {
      action: 'tool.invocation.reconcile.request',
      resourceType: 'TOOL_INVOCATION',
      resourceId: current.id,
      eventType: 'ToolInvocation.ReconciliationRequested',
      payload: {
        invocationId: current.id,
        expectedRevision: current.revision,
        reason: input.request.reason,
        idempotencyKey: input.request.idempotencyKey,
      },
      occurredAt: new Date(),
    });
    return { kind: 'APPLIED', value: mapToolInvocationRow(current) };
  }
  if (
    input.request.action !== 'APPROVE' &&
    input.request.action !== 'REJECT' &&
    current.requester_user_id !== input.principal.userId
  ) {
    return rejected('Only the requester may confirm or cancel this Tool Invocation.');
  }
  const now = new Date();
  if (input.request.action === 'CONFIRM') {
    const assignment = await loadAssignmentById(
      transaction,
      input.principal.tenantId,
      current.role_assignment_id,
    );
    if (assignment === null || assignment.userId !== input.principal.userId) {
      return rejected('The requester Task-owner Assignment is no longer effective.');
    }
    const expiresAt = new Date(now.getTime() + PROOF_TTL_MS);
    const proof = {
      tenantId: current.tenant_id,
      invocationId: current.id,
      toolVersionId: current.tool_version_id,
      taskId: current.task_id,
      inputHash: current.input_hash,
      policyDecisionId: current.policy_decision_id,
      requesterUserId: current.requester_user_id,
      requesterRoleAssignmentId: current.role_assignment_id,
      confirmed: true,
      confirmedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const transitioned = await transitionInvocation(transaction, current, {
      command: 'CONFIRM',
      reason: input.request.reason,
      idempotencyKey: commandIdempotencyKey(
        current.id,
        current.revision,
        'CONFIRM',
        input.request.idempotencyKey,
      ),
      actor: userActor(input.principal.tenantId, assignment),
      policyProof: null,
      confirmationProof: proof,
      approvalProof: null,
      providerProof: null,
      confirmation: {
        userId: input.principal.userId,
        assignmentId: assignment.id,
        reason: input.request.reason,
        proofHash: runtimeHash(proof),
        issuedAt: now,
        expiresAt,
      },
      now,
    });
    if (
      transitioned.kind === 'APPLIED' &&
      transitioned.value.status === 'APPROVED' &&
      current.dry_run &&
      current.dry_run_mode === 'VALIDATE_ONLY'
    ) {
      return completeValidateOnly(transaction, transitioned.value, input.request.reason);
    }
    return transitioned;
  }
  if (input.request.action === 'APPROVE' || input.request.action === 'REJECT') {
    const assignment = await loadReviewerAssignment(transaction, current, input.principal.userId);
    if (assignment === null) {
      return rejected('No independent authorized reviewer Assignment is available.');
    }
    const expiresAt = new Date(now.getTime() + PROOF_TTL_MS);
    const decision: 'APPROVED' | 'REJECTED' =
      input.request.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const proof = {
      tenantId: current.tenant_id,
      invocationId: current.id,
      toolVersionId: current.tool_version_id,
      taskId: current.task_id,
      inputHash: current.input_hash,
      policyDecisionId: current.policy_decision_id,
      approverUserId: input.principal.userId,
      approverRoleAssignmentId: assignment.id,
      actorType: 'USER' as const,
      decision,
      approvedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const transitioned = await transitionInvocation(transaction, current, {
      command: input.request.action,
      reason: input.request.reason,
      idempotencyKey: commandIdempotencyKey(
        current.id,
        current.revision,
        input.request.action,
        input.request.idempotencyKey,
      ),
      actor: userActor(input.principal.tenantId, assignment),
      policyProof: null,
      confirmationProof: null,
      approvalProof: proof,
      providerProof: null,
      approval: {
        userId: input.principal.userId,
        assignmentId: assignment.id,
        decision,
        reason: input.request.reason,
        proofHash: runtimeHash(proof),
        issuedAt: now,
        expiresAt,
      },
      completedAt: decision === 'REJECTED' ? now : null,
      now,
    });
    if (
      transitioned.kind === 'APPLIED' &&
      transitioned.value.status === 'APPROVED' &&
      current.dry_run &&
      current.dry_run_mode === 'VALIDATE_ONLY'
    ) {
      return completeValidateOnly(transaction, transitioned.value, input.request.reason);
    }
    return transitioned;
  }
  return transitionInvocation(transaction, current, {
    command: 'CANCEL_CONFIRMED',
    reason: input.request.reason,
    idempotencyKey: commandIdempotencyKey(
      current.id,
      current.revision,
      'CANCEL_CONFIRMED',
      input.request.idempotencyKey,
    ),
    actor: userActor(
      input.principal.tenantId,
      (await loadAssignmentById(
        transaction,
        input.principal.tenantId,
        current.role_assignment_id,
      )) ?? invalidAssignment(current),
    ),
    policyProof: null,
    confirmationProof: null,
    approvalProof: null,
    providerProof: null,
    completedAt: now,
    now,
  });
}

function compensationEnvelope(original: ToolInvocationRow): Record<string, unknown> {
  if (
    original.provider_request_id === null ||
    original.output === null ||
    original.output_hash === null
  ) {
    throw new Error('Compensation requires a complete immutable provider result.');
  }
  return {
    operation: 'COMPENSATE',
    original: {
      invocationId: original.id,
      toolId: original.tool_id,
      toolVersionId: original.tool_version_id,
      toolVersion: original.tool_version,
      toolConfigurationHash: original.tool_configuration_hash,
      inputHash: original.input_hash,
      providerRequestId: original.provider_request_id,
      outputHash: original.output_hash,
    },
    payload: {
      input: jsonObject(original.input),
      output: jsonObject(original.output),
    },
  };
}

async function toolRetryBudgetAvailable(
  transaction: Prisma.TransactionClient,
  current: ToolInvocationRow,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ attempts: bigint; max_attempts: number }>>`
    WITH RECURSIVE retry_lineage AS (
      SELECT invocation."id", invocation."retry_of_invocation_id"
      FROM public."tool_invocations" invocation
      WHERE invocation."tenant_id" = ${current.tenant_id}::uuid
        AND invocation."id" = ${current.id}::uuid
      UNION ALL
      SELECT parent."id", parent."retry_of_invocation_id"
      FROM public."tool_invocations" parent
      JOIN retry_lineage child
        ON child."retry_of_invocation_id" = parent."id"
      WHERE parent."tenant_id" = ${current.tenant_id}::uuid
    )
    SELECT count(*)::bigint AS attempts, version."max_attempts"
    FROM retry_lineage
    JOIN public."tool_versions" version
      ON version."tenant_id" = ${current.tenant_id}::uuid
     AND version."id" = ${current.tool_version_id}::uuid
     AND version."tool_id" = ${current.tool_id}::uuid
     AND version."version" = ${current.tool_version}
     AND version."configuration_hash" = ${current.tool_configuration_hash}
    GROUP BY version."max_attempts"
  `;
  const budget = rows[0];
  return budget !== undefined && budget.attempts < BigInt(budget.max_attempts);
}

async function transitionInvocation(
  transaction: Prisma.TransactionClient,
  current: ToolInvocationRow,
  input: TransitionInput,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  const approvalPermissionAction =
    input.command === 'APPROVE' || input.command === 'REJECT'
      ? await loadApprovalPermissionAction(transaction, current)
      : null;
  if (
    (input.command === 'APPROVE' || input.command === 'REJECT') &&
    approvalPermissionAction === null
  ) {
    return rejected('The immutable Tool Version approval permission could not be resolved.');
  }
  const decision = decideToolInvocationTransition({
    tenantId: current.tenant_id,
    invocationId: current.id,
    inputHash: current.input_hash,
    policyDecisionId: current.policy_decision_id,
    dryRun: current.dry_run,
    status: current.status,
    command: input.command,
    riskClass: current.risk_class,
    requesterUserId: current.requester_user_id,
    requesterRoleAssignmentId: current.role_assignment_id,
    ...(approvalPermissionAction === null ? {} : { approvalPermissionAction }),
    actor: input.actor,
    policyProof: input.policyProof,
    confirmationProof: input.confirmationProof,
    approvalProof: input.approvalProof,
    providerProof: input.providerProof,
    now: input.now,
  });
  if (!decision.allowed) {
    return rejected(`Tool Invocation transition denied: ${decision.reasonCode}.`);
  }
  await insertInvocationCommand(transaction, current, input);
  const confirmation = input.confirmation;
  const approval = input.approval;
  const updatedRows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
    UPDATE public."tool_invocations"
    SET "status" = ${decision.nextStatus}::public."ToolInvocationStatus",
        "revision" = "revision" + 1,
        "confirmed_by_user_id" = CASE
          WHEN ${confirmation !== undefined}
            THEN ${confirmation?.userId ?? null}::uuid
          ELSE "confirmed_by_user_id"
        END,
        "confirmed_by_role_assignment_id" = CASE
          WHEN ${confirmation !== undefined}
            THEN ${confirmation?.assignmentId ?? null}::uuid
          ELSE "confirmed_by_role_assignment_id"
        END,
        "confirmed_at" = CASE
          WHEN ${confirmation !== undefined} THEN ${input.now}
          ELSE "confirmed_at"
        END,
        "confirmation_reason" = CASE
          WHEN ${confirmation !== undefined} THEN ${confirmation?.reason ?? null}
          ELSE "confirmation_reason"
        END,
        "confirmation_proof_hash" = CASE
          WHEN ${confirmation !== undefined} THEN ${confirmation?.proofHash ?? null}
          ELSE "confirmation_proof_hash"
        END,
        "confirmation_issued_at" = CASE
          WHEN ${confirmation !== undefined} THEN ${confirmation?.issuedAt ?? null}
          ELSE "confirmation_issued_at"
        END,
        "confirmation_expires_at" = CASE
          WHEN ${confirmation !== undefined} THEN ${confirmation?.expiresAt ?? null}
          ELSE "confirmation_expires_at"
        END,
        "approver_user_id" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.userId ?? null}::uuid
          ELSE "approver_user_id"
        END,
        "approver_role_assignment_id" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.assignmentId ?? null}::uuid
          ELSE "approver_role_assignment_id"
        END,
        "approval_decision" = CASE
          WHEN ${approval !== undefined}
            THEN ${approval?.decision ?? null}::public."ToolApprovalDecision"
          ELSE "approval_decision"
        END,
        "approval_decided_at" = CASE
          WHEN ${approval !== undefined} THEN ${input.now}
          ELSE "approval_decided_at"
        END,
        "approval_reason" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.reason ?? null}
          ELSE "approval_reason"
        END,
        "approval_proof_hash" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.proofHash ?? null}
          ELSE "approval_proof_hash"
        END,
        "approval_issued_at" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.issuedAt ?? null}
          ELSE "approval_issued_at"
        END,
        "approval_expires_at" = CASE
          WHEN ${approval !== undefined} THEN ${approval?.expiresAt ?? null}
          ELSE "approval_expires_at"
        END,
        "completed_at" = CASE
          WHEN ${input.completedAt !== undefined} THEN ${input.completedAt ?? null}
          ELSE "completed_at"
        END
    WHERE "tenant_id" = ${current.tenant_id}::uuid
      AND "id" = ${current.id}::uuid
      AND "revision" = ${current.revision}
    RETURNING *
  `);
  const updated = updatedRows[0];
  if (updated === undefined) {
    return { kind: 'STALE_REVISION', currentRevision: current.revision };
  }
  return { kind: 'APPLIED', value: mapToolInvocationRow(updated) };
}

async function loadApprovalPermissionAction(
  transaction: Prisma.TransactionClient,
  invocation: ToolInvocationRow,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ key: string }>>`
    SELECT "key"
    FROM public."tool_versions"
    WHERE "tenant_id" = ${invocation.tenant_id}::uuid
      AND "id" = ${invocation.tool_version_id}::uuid
      AND "tool_id" = ${invocation.tool_id}::uuid
      AND "version" = ${invocation.tool_version}
    LIMIT 1
    FOR SHARE
  `;
  return rows[0] === undefined ? null : `tool.approve:${rows[0].key}`;
}

async function completeValidateOnly(
  transaction: Prisma.TransactionClient,
  invocation: ToolInvocation,
  reason: string,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  const approved = await findInvocationRow(transaction, invocation.tenantId, invocation.id, true);
  if (approved === null) return { kind: 'NOT_FOUND' };
  if (
    approved.status !== 'APPROVED' ||
    !approved.dry_run ||
    approved.dry_run_mode !== 'VALIDATE_ONLY' ||
    approved.provider_dispatch_allowed
  ) {
    return rejected('Only a no-dispatch VALIDATE_ONLY Invocation can use gateway validation.');
  }
  const now = new Date();
  const policyDecision: ToolInvocationPolicyDecision = {
    kind: 'allow',
    reasonCode: 'ALLOW_DRY_RUN',
    obligations: ['VALIDATE_INPUT_SCHEMA', 'DO_NOT_DISPATCH_PROVIDER', 'PERSIST_AUDIT_AND_OUTBOX'],
  };
  const started = await transitionExecutionStart(
    transaction,
    approved,
    policyProof(approved, policyDecision, now),
    reason,
    now,
  );
  if (started.kind !== 'APPLIED') return started;
  const executing = await findInvocationRow(transaction, invocation.tenantId, invocation.id, true);
  if (executing === null) return { kind: 'NOT_FOUND' };
  const completedAt = new Date();
  const output =
    executing.risk_class === 'DRAFT_ONLY'
      ? { validation: { valid: true }, artifactMode: 'DRAFT' }
      : { validation: { valid: true }, mode: 'VALIDATE_ONLY' };
  const outputHash = runtimeHash(output);
  const executionRequestId = `gateway-validator:${executing.id}:${executing.execution_attempt}`;
  const receiptHash = runtimeHash({
    invocationId: executing.id,
    invocationRevision: executing.revision + 1,
    executionAttempt: executing.execution_attempt,
    inputHash: executing.input_hash,
    outputHash,
    startedAt: executing.started_at?.toISOString(),
    completedAt: completedAt.toISOString(),
  });
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."tool_execution_receipts" (
      "id", "tenant_id", "tool_invocation_id", "invocation_revision",
      "execution_attempt", "source", "outcome", "provider_request_id",
      "input_hash", "request_hash", "response_hash", "provider_dry_run",
      "draft_output", "started_at", "completed_at", "latency_ms",
      "cost_micros", "cost_attestation", "receipt_hash"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${executing.tenant_id}::uuid,
      ${executing.id}::uuid,
      ${executing.revision + 1},
      ${executing.execution_attempt},
      'GATEWAY_VALIDATOR'::public."ToolExecutionReceiptSource",
      'SUCCEEDED'::public."ToolExecutionReceiptOutcome",
      NULL,
      ${executing.input_hash},
      ${runtimeHash({ inputHash: executing.input_hash, mode: 'VALIDATE_ONLY' })},
      ${outputHash},
      false,
      ${executing.risk_class === 'DRAFT_ONLY'},
      ${executing.started_at ?? now},
      ${completedAt},
      ${Math.max(0, completedAt.getTime() - (executing.started_at ?? now).getTime())},
      0,
      'GATEWAY_ATTESTED'::public."ToolCostAttestation",
      ${receiptHash}
    )
  `);
  const providerProof = {
    tenantId: executing.tenant_id,
    invocationId: executing.id,
    toolVersionId: executing.tool_version_id,
    inputHash: executing.input_hash,
    providerRequestId: executionRequestId,
    outcome: 'SUCCEEDED' as const,
  };
  const actor = systemActor(executing.tenant_id);
  const transition = decideToolInvocationTransition({
    tenantId: executing.tenant_id,
    invocationId: executing.id,
    inputHash: executing.input_hash,
    policyDecisionId: executing.policy_decision_id,
    dryRun: executing.dry_run,
    status: executing.status,
    command: 'SUCCEED',
    riskClass: executing.risk_class,
    requesterUserId: executing.requester_user_id,
    requesterRoleAssignmentId: executing.role_assignment_id,
    actor,
    providerProof,
    now: completedAt,
  });
  if (!transition.allowed) {
    return rejected(`VALIDATE_ONLY completion denied: ${transition.reasonCode}.`);
  }
  await insertInvocationCommand(transaction, executing, {
    command: 'SUCCEED',
    reason: 'Gateway validation completed without provider dispatch.',
    idempotencyKey: `validate-only:${executing.id}:succeed`,
    actor,
    policyProof: null,
    confirmationProof: null,
    approvalProof: null,
    providerProof,
    now: completedAt,
  });
  const completedRows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
    UPDATE public."tool_invocations"
    SET "status" = 'SUCCEEDED'::public."ToolInvocationStatus",
        "revision" = "revision" + 1,
        "provider_request_id" = ${executionRequestId},
        "output" = ${JSON.stringify(output)}::jsonb,
        "output_hash" = ${outputHash},
        "completed_at" = ${completedAt}
    WHERE "tenant_id" = ${executing.tenant_id}::uuid
      AND "id" = ${executing.id}::uuid
      AND "revision" = ${executing.revision}
    RETURNING *
  `);
  const completed = completedRows[0];
  return completed === undefined
    ? { kind: 'STALE_REVISION', currentRevision: executing.revision }
    : { kind: 'APPLIED', value: mapToolInvocationRow(completed) };
}

async function transitionExecutionStart(
  transaction: Prisma.TransactionClient,
  current: ToolInvocationRow,
  policyProofValue: PolicyProof,
  reason: string,
  now: Date,
): Promise<RuntimeMutationResult<ToolInvocation>> {
  const actor = systemActor(current.tenant_id);
  const decision = decideToolInvocationTransition({
    tenantId: current.tenant_id,
    invocationId: current.id,
    inputHash: current.input_hash,
    policyDecisionId: current.policy_decision_id,
    dryRun: current.dry_run,
    status: current.status,
    command: 'START',
    riskClass: current.risk_class,
    requesterUserId: current.requester_user_id,
    requesterRoleAssignmentId: current.role_assignment_id,
    actor,
    policyProof: policyProofValue,
    now,
  });
  if (!decision.allowed) {
    return rejected(`Tool execution start denied: ${decision.reasonCode}.`);
  }
  await insertInvocationCommand(transaction, current, {
    command: 'START',
    reason,
    idempotencyKey: `tool-start:${current.id}:${current.revision}`,
    actor,
    policyProof: policyProofValue,
    confirmationProof: null,
    approvalProof: null,
    providerProof: null,
    now,
  });
  const rows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
    UPDATE public."tool_invocations"
    SET "status" = 'EXECUTING'::public."ToolInvocationStatus",
        "revision" = "revision" + 1,
        "execution_attempt" = "execution_attempt" + 1,
        "started_at" = ${now}
    WHERE "tenant_id" = ${current.tenant_id}::uuid
      AND "id" = ${current.id}::uuid
      AND "revision" = ${current.revision}
    RETURNING *
  `);
  const updated = rows[0];
  return updated === undefined
    ? { kind: 'STALE_REVISION', currentRevision: current.revision }
    : { kind: 'APPLIED', value: mapToolInvocationRow(updated) };
}

async function insertInvocationCommand(
  transaction: Prisma.TransactionClient,
  current: ToolInvocationRow,
  input: CommandInput,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."tool_invocation_commands" (
      "id", "tenant_id", "tool_invocation_id", "command",
      "expected_revision", "result_revision", "actor_type",
      "actor_user_id", "actor_role_assignment_id",
      "actor_service_principal_id", "reason", "policy_proof",
      "confirmation_proof", "approval_proof", "provider_proof",
      "compensation_proof", "idempotency_key", "request_hash", "occurred_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${current.tenant_id}::uuid,
      ${current.id}::uuid,
      ${input.command}::public."ToolInvocationCommandType",
      ${current.revision},
      ${current.revision + 1},
      ${input.actor.type}::public."ToolInvocationActorType",
      ${input.actor.userId}::uuid,
      ${input.actor.roleAssignment?.id ?? null}::uuid,
      ${input.actor.servicePrincipalId}::uuid,
      ${input.reason},
      ${jsonOrNull(input.policyProof)}::jsonb,
      ${jsonOrNull(input.confirmationProof)}::jsonb,
      ${jsonOrNull(input.approvalProof)}::jsonb,
      ${jsonOrNull(input.providerProof)}::jsonb,
      NULL,
      ${input.idempotencyKey},
      ${current.input_hash},
      ${input.now}
    )
  `);
}

async function findInvocationRow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  invocationId: string,
  lock: boolean,
): Promise<ToolInvocationRow | null> {
  const rows = await transaction.$queryRaw<ToolInvocationRow[]>(Prisma.sql`
    SELECT *
    FROM public."tool_invocations"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${invocationId}::uuid
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

async function loadInvocationContext(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  requesterUserId: string,
  toolVersionId: string,
  taskId: string,
): Promise<InvocationContext | null> {
  const tools = await transaction.$queryRaw<ToolContextRow[]>`
    SELECT version.*, definition."status" AS "definition_status"
    FROM public."tool_versions" version
    JOIN public."tool_definitions" definition
      ON definition."tenant_id" = version."tenant_id"
     AND definition."id" = version."tool_id"
    WHERE version."tenant_id" = ${tenantId}::uuid
      AND version."id" = ${toolVersionId}::uuid
      AND definition."status" = 'PUBLISHED'
      AND definition."current_version_id" = version."id"
      AND version."status" = 'PUBLISHED'
    LIMIT 1
    FOR SHARE OF version, definition
  `;
  const tool = tools[0];
  if (tool === undefined) return null;
  const tasks = await transaction.$queryRaw<TaskContextRow[]>`
    SELECT "id", "tenant_id", "status", "owner_role_assignment_id",
           "permission_labels"
    FROM public."tasks"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${taskId}::uuid
    LIMIT 1
    FOR SHARE
  `;
  const task = tasks[0];
  if (
    task === undefined ||
    task.owner_role_assignment_id === null ||
    !['READY', 'IN_PROGRESS'].includes(task.status)
  ) {
    return null;
  }
  const assignment = await loadAssignmentById(transaction, tenantId, task.owner_role_assignment_id);
  if (assignment === null || assignment.userId !== requesterUserId) return null;
  return { tool, task, assignment };
}

async function loadAssignmentById(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<TrustedToolAssignment | null> {
  const rows = await transaction.$queryRaw<AssignmentContextRow[]>`
    SELECT assignment."id", assignment."tenant_id", assignment."user_id",
           assignment."status", assignment."effective_from",
           assignment."effective_to", assignment."permission_scope",
           employment."status" AS "employment_status",
           unit."status" AS "org_unit_status",
           version."status" AS "role_version_status"
    FROM public."role_assignments" assignment
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
     AND employment."user_id" = assignment."user_id"
    JOIN public."org_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
    JOIN public."agent_versions" version
      ON version."tenant_id" = assignment."tenant_id"
     AND version."id" = assignment."role_version_id"
    WHERE assignment."tenant_id" = ${tenantId}::uuid
      AND assignment."id" = ${assignmentId}::uuid
    LIMIT 1
    FOR SHARE OF assignment, employment, unit, version
  `;
  return rows[0] === undefined ? null : mapAssignment(rows[0]);
}

async function loadReviewerAssignment(
  transaction: Prisma.TransactionClient,
  invocation: ToolInvocationRow,
  reviewerUserId: string,
): Promise<TrustedToolAssignment | null> {
  const rows = await transaction.$queryRaw<AssignmentContextRow[]>`
    SELECT assignment."id", assignment."tenant_id", assignment."user_id",
           assignment."status", assignment."effective_from",
           assignment."effective_to", assignment."permission_scope",
           employment."status" AS "employment_status",
           unit."status" AS "org_unit_status",
           version."status" AS "role_version_status"
    FROM public."role_assignments" assignment
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
     AND employment."user_id" = assignment."user_id"
    JOIN public."org_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
    JOIN public."agent_versions" version
      ON version."tenant_id" = assignment."tenant_id"
     AND version."id" = assignment."role_version_id"
    WHERE assignment."tenant_id" = ${invocation.tenant_id}::uuid
      AND assignment."user_id" = ${reviewerUserId}::uuid
      AND assignment."id" <> ${invocation.role_assignment_id}::uuid
      AND assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= CURRENT_TIMESTAMP
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > CURRENT_TIMESTAMP
      )
    ORDER BY assignment."effective_from" DESC, assignment."id" ASC
    FOR SHARE OF assignment, employment, unit, version
  `;
  const taskRows = await transaction.$queryRaw<
    Array<{ permission_labels: unknown; tool_key: string }>
  >`
    SELECT task."permission_labels", version."key" AS "tool_key"
    FROM public."tasks" task
    JOIN public."tool_versions" version
      ON version."tenant_id" = task."tenant_id"
     AND version."id" = ${invocation.tool_version_id}::uuid
    WHERE task."tenant_id" = ${invocation.tenant_id}::uuid
      AND task."id" = ${invocation.task_id}::uuid
    LIMIT 1
  `;
  const taskLabels = taskRows[0] === undefined ? [] : stringArray(taskRows[0].permission_labels);
  const toolKey = taskRows[0]?.tool_key;
  if (toolKey === undefined) return null;
  for (const row of rows) {
    const assignment = mapAssignment(row);
    if (
      assignment.userId !== invocation.requester_user_id &&
      assignment.taskIds.includes(invocation.task_id) &&
      hasToolAction(assignment.permissionActions, 'tool.approve', toolKey) &&
      classificationRank(assignment.maxDataClassification) >=
        classificationRank(invocation.data_classification) &&
      taskLabels.every((label) => assignment.dataLabels.includes(label))
    ) {
      return assignment;
    }
  }
  return null;
}

function policyInputFromContext(input: {
  readonly invocationId: string;
  readonly principal: CreateToolInvocationInput['principal'];
  readonly context: InvocationContext;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly dryRun: boolean;
  readonly now: Date;
}) {
  const task: TrustedToolTask = {
    id: input.context.task.id,
    tenantId: input.context.task.tenant_id,
    status: input.context.task.status,
    participantRoleAssignmentIds: [input.context.assignment.id],
    reviewerRoleAssignmentIds: [],
    dataLabels: stringArray(input.context.task.permission_labels),
  };
  return {
    invocationId: input.invocationId,
    tenantId: input.principal.tenantId,
    requesterUserId: input.principal.userId,
    tool: {
      id: input.context.tool.id,
      tenantId: input.context.tool.tenant_id,
      key: input.context.tool.key,
      status: input.context.tool.status,
      riskClass: input.context.tool.risk_class,
      dataClassification: input.context.tool.data_classification,
      dryRunMode: input.context.tool.dry_run_mode,
      effectiveFrom: input.context.tool.effective_from,
      effectiveTo: input.context.tool.effective_to,
    },
    task,
    assignment: input.context.assignment,
    inputHash: input.inputHash,
    policyDecisionId: input.policyDecisionId,
    dryRun: input.dryRun,
    now: input.now,
  } as const;
}

function mapAssignment(row: AssignmentContextRow): TrustedToolAssignment {
  const scope = jsonObject(row.permission_scope);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    employmentActive: row.employment_status === 'ACTIVE',
    orgUnitActive: row.org_unit_status === 'ACTIVE',
    roleVersionStatus: row.role_version_status,
    permissionActions: optionalStringArray(scope.actions),
    taskIds: optionalStringArray(scope.taskIds),
    dataLabels: optionalStringArray(scope.permissionLabels),
    maxDataClassification: classification(scope.maxDataClassification),
  };
}

function initialCommand(decision: ToolInvocationPolicyDecision): ToolInvocationCommand | null {
  if (decision.kind === 'deny') return 'DENY';
  if (decision.kind === 'allow') return 'START';
  if (decision.reasonCode === 'CONFIRMATION_REQUIRED') return 'REQUEST_CONFIRMATION';
  if (decision.reasonCode === 'APPROVAL_REQUIRED') return 'REQUEST_APPROVAL';
  return null;
}

function definitionRequestMatches(
  candidate: ToolDefinitionRow,
  request: CreateToolDefinitionInput['request'],
  ownerUserId: string,
): boolean {
  return (
    candidate.name === request.name &&
    candidate.description === request.description &&
    candidate.owner_user_id === ownerUserId &&
    runtimeHash(stringArray(candidate.permission_labels)) === runtimeHash(request.permissionLabels)
  );
}

function nextGeneratedDefinitionKey(baseKey: string, occupiedKeys: ReadonlySet<string>): string {
  if (!occupiedKeys.has(baseKey)) return baseKey;
  for (let suffixNumber = 2; suffixNumber <= 10_000; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const stem = baseKey.slice(0, 100 - suffix.length).replace(/[-.]+$/u, '');
    const candidate = `${stem}${suffix}`;
    if (!occupiedKeys.has(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a unique server-generated Tool Definition key.');
}

function policyProof(
  invocation: ToolInvocationRow,
  decision: ToolInvocationPolicyDecision,
  now: Date,
): PolicyProof {
  const proofDecision =
    decision.kind === 'deny'
      ? 'DENY'
      : decision.kind === 'allow'
        ? 'ALLOW'
        : decision.reasonCode === 'CONFIRMATION_REQUIRED'
          ? 'REQUIRE_CONFIRMATION'
          : 'REQUIRE_APPROVAL';
  return {
    tenantId: invocation.tenant_id,
    invocationId: invocation.id,
    toolVersionId: invocation.tool_version_id,
    taskId: invocation.task_id,
    inputHash: invocation.input_hash,
    policyDecisionId: invocation.policy_decision_id,
    riskClass: invocation.risk_class,
    dryRun: invocation.dry_run,
    decision: proofDecision,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROOF_TTL_MS).toISOString(),
  };
}

function systemActor(tenantId: string): TrustedToolTransitionActor {
  return {
    type: 'SYSTEM',
    tenantId,
    userId: null,
    servicePrincipalId: TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
    roleAssignment: null,
    capabilityActions: [
      'tool.policy.transition',
      'tool.provider.transition',
      'tool.cancel',
      'tool.compensate',
    ],
  };
}

function userActor(
  tenantId: string,
  assignment: TrustedToolAssignment,
): TrustedToolTransitionActor {
  return {
    type: 'USER',
    tenantId,
    userId: assignment.userId,
    servicePrincipalId: null,
    roleAssignment: {
      id: assignment.id,
      tenantId: assignment.tenantId,
      userId: assignment.userId,
      status: assignment.status,
      employmentActive: assignment.employmentActive,
      orgUnitActive: assignment.orgUnitActive,
      roleVersionStatus: assignment.roleVersionStatus,
      permissionActions: assignment.permissionActions,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo,
    },
    capabilityActions: [],
  };
}

function invalidAssignment(current: ToolInvocationRow): TrustedToolAssignment {
  return {
    id: current.role_assignment_id,
    tenantId: current.tenant_id,
    userId: current.requester_user_id,
    status: 'REVOKED',
    effectiveFrom: current.created_at,
    effectiveTo: current.created_at,
    employmentActive: false,
    orgUnitActive: false,
    roleVersionStatus: 'RETIRED',
    permissionActions: [],
    taskIds: [],
    dataLabels: [],
    maxDataClassification: 'PUBLIC',
  };
}

function redactInput(
  input: Readonly<Record<string, unknown>>,
  sensitivePaths: readonly string[],
): Record<string, unknown> {
  const clone = cloneJson(input);
  for (const rawPath of sensitivePaths) {
    const path = rawPath
      .replace(/^\$\./u, '')
      .split('.')
      .filter((segment) => segment.length > 0);
    let target: Record<string, unknown> = clone;
    for (let index = 0; index < path.length - 1; index += 1) {
      const next = target[path[index] ?? ''];
      if (!isRecord(next)) {
        target = {};
        break;
      }
      target = next;
    }
    const leaf = path.at(-1);
    if (leaf !== undefined && leaf in target) target[leaf] = '[REDACTED]';
  }
  return clone;
}

function cloneJson(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? [...new Set(value)]
    : [];
}

function classification(value: unknown): TrustedToolAssignment['maxDataClassification'] {
  return value === 'INTERNAL' || value === 'CONFIDENTIAL' || value === 'RESTRICTED'
    ? value
    : 'PUBLIC';
}

function classificationRank(value: TrustedToolAssignment['maxDataClassification']): number {
  return {
    PUBLIC: 0,
    INTERNAL: 1,
    CONFIDENTIAL: 2,
    RESTRICTED: 3,
  }[value];
}

function hasToolAction(actions: readonly string[], action: string, toolKey: string): boolean {
  return (
    actions.includes(action) ||
    actions.includes(`${action}:${toolKey}`) ||
    actions.includes('tool.*') ||
    actions.includes('*')
  );
}

function requestActionCommand(
  action: ToolInvocationDecisionRequest['action'],
): ToolInvocationCommand | null {
  if (action === 'CANCEL') return 'CANCEL_CONFIRMED';
  if (action === 'CONFIRM' || action === 'APPROVE' || action === 'REJECT') {
    return action;
  }
  return null;
}

function commandIdempotencyKey(
  invocationId: string,
  revision: number,
  command: ToolInvocationCommand,
  clientKey: string,
): string {
  return `tool-command:${runtimeHash({
    invocationId,
    revision,
    command,
    clientKey,
  })}`;
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function rejected<T>(detail: string): RuntimeMutationResult<T> {
  return {
    kind: 'REJECTED',
    reason: 'INVARIANT_VIOLATION',
    detail,
  };
}

function mapDatabaseError<T>(error: unknown): RuntimeMutationResult<T> {
  if (isDatabaseConflict(error)) return { kind: 'IDEMPOTENCY_CONFLICT' };
  if (isDatabaseRejection(error)) {
    return rejected(databaseErrorText(error).slice(0, 2_000));
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface InvocationContext {
  readonly tool: ToolContextRow;
  readonly task: TaskContextRow;
  readonly assignment: TrustedToolAssignment;
}

interface ToolContextRow extends ToolVersionRow {
  readonly definition_status: ToolDefinition['status'];
}

interface TaskContextRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly owner_role_assignment_id: string | null;
  readonly permission_labels: unknown;
}

interface AssignmentContextRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly status: TrustedToolAssignment['status'];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly permission_scope: unknown;
  readonly employment_status: string;
  readonly org_unit_status: string;
  readonly role_version_status: TrustedToolAssignment['roleVersionStatus'];
}

interface PolicyProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly toolVersionId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly riskClass: ToolInvocation['riskClass'];
  readonly dryRun: boolean;
  readonly decision: 'DENY' | 'REQUIRE_CONFIRMATION' | 'REQUIRE_APPROVAL' | 'ALLOW';
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ConfirmationProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly toolVersionId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly requesterUserId: string;
  readonly requesterRoleAssignmentId: string;
  readonly confirmed: boolean;
  readonly confirmedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ApprovalProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly toolVersionId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly approverUserId: string;
  readonly approverRoleAssignmentId: string;
  readonly actorType: 'USER';
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly approvedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ProviderProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly toolVersionId: string;
  readonly inputHash: string;
  readonly providerRequestId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
}

interface CommandInput {
  readonly command: ToolInvocationCommand;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly actor: TrustedToolTransitionActor;
  readonly policyProof: PolicyProof | null;
  readonly confirmationProof: ConfirmationProof | null;
  readonly approvalProof: ApprovalProof | null;
  readonly providerProof: ProviderProof | null;
  readonly now: Date;
}

interface TransitionInput extends CommandInput {
  readonly confirmation?: {
    readonly userId: string;
    readonly assignmentId: string;
    readonly reason: string;
    readonly proofHash: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  } | null;
  readonly approval?: {
    readonly userId: string;
    readonly assignmentId: string;
    readonly decision: 'APPROVED' | 'REJECTED';
    readonly reason: string;
    readonly proofHash: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  } | null;
  readonly completedAt?: Date | null;
}
