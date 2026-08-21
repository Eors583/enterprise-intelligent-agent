import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

interface SnapshotAgentVersion {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly modelPolicy: Prisma.JsonValue;
  readonly toolPolicy: Prisma.JsonValue;
  readonly knowledgeScope: Prisma.JsonValue;
  readonly blueprintRevision?: number;
  readonly roleDefinitionSnapshot?: Prisma.JsonValue;
  readonly template?: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
  };
}

export interface AgentRunExecutionSnapshot {
  readonly agentVersionId: string;
  readonly agentVersion: number;
  readonly systemPrompt: string;
  readonly modelPolicy: Prisma.JsonValue;
  readonly knowledgeScope: Prisma.JsonValue;
}

interface SnapshotRoleAssignment {
  readonly id: string;
  readonly roleTemplateId: string;
  readonly roleVersionId: string;
}

export function buildAgentRunPolicySnapshot(input: {
  readonly agentVersion: SnapshotAgentVersion;
  readonly roleAssignment?: SnapshotRoleAssignment | null;
  readonly baseSnapshot?: Prisma.JsonValue;
  readonly knowledgeScopeOverride?: Prisma.JsonValue;
  readonly extra?: Prisma.InputJsonObject;
}): Prisma.InputJsonObject {
  const version = input.agentVersion;
  const assignment = input.roleAssignment;
  const base = inputJsonRecord(input.baseSnapshot);
  const roleDefinition =
    version.roleDefinitionSnapshot === undefined
      ? undefined
      : cloneJson(version.roleDefinitionSnapshot);
  return {
    ...base,
    snapshotSchemaVersion: 2,
    agentVersionId: version.id,
    agentVersion: version.version,
    version: version.version,
    systemPrompt: version.systemPrompt,
    systemPromptSha256: sha256(version.systemPrompt),
    prompt: {
      version: version.version,
      sha256: sha256(version.systemPrompt),
    },
    modelPolicy: cloneJson(version.modelPolicy),
    toolPolicy: cloneJson(version.toolPolicy),
    knowledgeScope: cloneJson(input.knowledgeScopeOverride ?? version.knowledgeScope),
    agentTemplate: {
      id: version.templateId,
      ...(version.template === undefined
        ? {}
        : {
            key: version.template.key,
            name: version.template.name,
          }),
    },
    ...(assignment === undefined || assignment === null
      ? {}
      : {
          roleAssignmentId: assignment.id,
          role: {
            templateId: assignment.roleTemplateId,
            versionId: assignment.roleVersionId,
            version: version.version,
            ...(version.template === undefined
              ? {}
              : {
                  key: version.template.key,
                  name: version.template.name,
                }),
            ...(version.blueprintRevision === undefined
              ? {}
              : { blueprintRevision: version.blueprintRevision }),
            ...(roleDefinition === undefined ? {} : { definition: roleDefinition }),
          },
        }),
    ...(input.extra ?? {}),
  };
}

export function buildAgentRunRetryPolicySnapshot(input: {
  readonly sourceSnapshot: Prisma.JsonValue;
  readonly sourceAgentVersion: SnapshotAgentVersion;
  readonly retryOfRunId: string;
}): Prisma.InputJsonObject | null {
  if (isAgentRunPolicySnapshotV2(input.sourceSnapshot)) {
    if (resolveAgentRunExecutionSnapshot(input.sourceSnapshot, input.sourceAgentVersion) === null) {
      return null;
    }
    return {
      ...inputJsonRecord(input.sourceSnapshot),
      retryOfRunId: input.retryOfRunId,
      retryPinnedToSourceVersion: true,
    };
  }
  return buildAgentRunPolicySnapshot({
    agentVersion: input.sourceAgentVersion,
    baseSnapshot: input.sourceSnapshot,
    extra: {
      retryOfRunId: input.retryOfRunId,
      retryPinnedToSourceVersion: true,
    },
  });
}

export function readPolicySnapshotAssignmentId(value: unknown): string | null {
  if (!isJsonRecord(value)) return null;
  return typeof value.roleAssignmentId === 'string' && value.roleAssignmentId.length > 0
    ? value.roleAssignmentId
    : null;
}

export function readControlledModelConnectivityProbeCatalogId(value: unknown): string | null {
  if (
    !isJsonRecord(value) ||
    value.controlledModelConnectivityProbe !== true ||
    typeof value.connectivityProbeCatalogVersionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.connectivityProbeCatalogVersionId,
    )
  ) {
    return null;
  }
  return value.connectivityProbeCatalogVersionId;
}

export function isAgentRunPolicySnapshotV2(value: unknown): boolean {
  return isJsonRecord(value) && value.snapshotSchemaVersion === 2;
}

export function resolveAgentRunExecutionSnapshot(
  value: unknown,
  fallback: SnapshotAgentVersion,
): AgentRunExecutionSnapshot | null {
  if (!isAgentRunPolicySnapshotV2(value) || !isJsonRecord(value)) {
    return {
      agentVersionId: fallback.id,
      agentVersion: fallback.version,
      systemPrompt: fallback.systemPrompt,
      modelPolicy: fallback.modelPolicy,
      knowledgeScope: fallback.knowledgeScope,
    };
  }
  if (
    value.agentVersionId !== fallback.id ||
    value.agentVersion !== fallback.version ||
    typeof value.systemPrompt !== 'string' ||
    typeof value.systemPromptSha256 !== 'string' ||
    value.systemPromptSha256 !== sha256(value.systemPrompt) ||
    value.modelPolicy === undefined ||
    value.toolPolicy === undefined ||
    value.knowledgeScope === undefined
  ) {
    return null;
  }
  return {
    agentVersionId: value.agentVersionId,
    agentVersion: value.agentVersion,
    systemPrompt: value.systemPrompt,
    modelPolicy: value.modelPolicy as Prisma.JsonValue,
    knowledgeScope: value.knowledgeScope as Prisma.JsonValue,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inputJsonRecord(value: Prisma.JsonValue | undefined): Prisma.InputJsonObject {
  if (!isJsonRecord(value)) return {};
  return cloneJson(value) as Prisma.InputJsonObject;
}

function cloneJson(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
