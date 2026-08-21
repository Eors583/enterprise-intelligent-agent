import { Prisma } from '@prisma/client';

import type {
  AuthorizationDecision,
  AuthorizationObligationType,
} from '../authorization/authorization.types.js';

const REQUIRED_KNOWLEDGE_FILTER_OBLIGATIONS = new Set<AuthorizationObligationType>([
  'FILTER_ORGANIZATION_SCOPE',
  'FILTER_PROJECT_SCOPE',
  'FILTER_TASK_SCOPE',
  'ENFORCE_DATA_LABEL_SCOPE',
]);

const ALLOWED_CLASSIFICATIONS = new Set(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'CONFIDENTIAL']);
const ALLOWED_REVIEW_STATUSES = new Set(['PENDING', 'APPROVED', 'MIGRATED']);
const SENSITIVE_CLEARANCE = 'CLASSIFICATION:SENSITIVE';
const CONFIDENTIAL_CLEARANCE = 'CLASSIFICATION:CONFIDENTIAL';

export interface KnowledgeResourceAuthorizationFilters {
  readonly assignmentOrganizationScoped: boolean;
  readonly organizationIds: readonly string[];
  readonly includeOrganizationDescendants: boolean;
  readonly projectIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly roleTemplateIds: readonly string[];
  readonly principalDataLabels: readonly string[];
}

export interface KnowledgeVersionResourcePolicy {
  readonly ownerUserId: string;
  readonly classification: 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'CONFIDENTIAL';
  readonly scopeMode: 'TENANT' | 'RESTRICTED';
  readonly organizationScopeIds: readonly string[];
  readonly projectScopeIds: readonly string[];
  readonly taskScopeIds: readonly string[];
  readonly roleTemplateScopeIds: readonly string[];
  readonly dataLabels: readonly string[];
  readonly effectiveFrom: string;
  readonly expiresAt: string | null;
  readonly retentionUntil: string | null;
  readonly retentionAction: 'ARCHIVE' | 'REVIEW_DELETE' | 'LEGAL_HOLD';
  readonly supersedesVersionId: string | null;
  readonly reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MIGRATED';
  readonly policyHash: string;
}

export function knowledgeFiltersFromDecision(
  decision: AuthorizationDecision,
  roleTemplateIds: readonly string[] = [],
  principalUserId?: string,
): KnowledgeResourceAuthorizationFilters {
  const obligations = new Map(
    decision.obligations.map((obligation) => [obligation.type, obligation.parameters]),
  );
  for (const required of REQUIRED_KNOWLEDGE_FILTER_OBLIGATIONS) {
    if (!obligations.has(required)) {
      throw new Error(`Authorization decision omitted required knowledge filter ${required}.`);
    }
  }

  const organization = readRecord(obligations.get('FILTER_ORGANIZATION_SCOPE'));
  const project = readRecord(obligations.get('FILTER_PROJECT_SCOPE'));
  const task = readRecord(obligations.get('FILTER_TASK_SCOPE'));
  const dataLabels = readRecord(obligations.get('ENFORCE_DATA_LABEL_SCOPE'));
  return {
    assignmentOrganizationScoped: organization.assignmentScoped === true,
    organizationIds: readStringArray(organization.organizationIds),
    includeOrganizationDescendants: organization.includeDescendants === true,
    projectIds: readStringArray(project.projectIds),
    taskIds: readStringArray(task.taskIds),
    roleTemplateIds: uniqueStrings(roleTemplateIds),
    principalDataLabels: uniqueStrings([
      ...readStringArray(dataLabels.principalLabels),
      ...(principalUserId === undefined ? [] : [`USER:${principalUserId}`]),
    ]),
  };
}

export function withResolvedOrganizationIds(
  filters: KnowledgeResourceAuthorizationFilters,
  organizationIds: readonly string[],
): KnowledgeResourceAuthorizationFilters {
  return {
    ...filters,
    organizationIds: uniqueStrings(organizationIds),
  };
}

/**
 * Final in-process policy check for candidates returned by SQL.
 *
 * A missing or malformed version policy always denies access. Tenant-wide
 * access must be explicit; it is never inferred from missing scope metadata.
 */
export function knowledgeVersionResourcePolicyAllowed(
  value: Prisma.JsonValue,
  filters: KnowledgeResourceAuthorizationFilters,
  now = new Date(),
): boolean {
  const policy = parsePolicy(value);
  if (policy === null) return false;
  if (!ALLOWED_REVIEW_STATUSES.has(policy.reviewStatus)) return false;
  const nowMs = now.getTime();
  const effectiveFrom = Date.parse(policy.effectiveFrom);
  const expiresAt = policy.expiresAt === null ? null : Date.parse(policy.expiresAt);
  if (
    !Number.isFinite(effectiveFrom) ||
    effectiveFrom > nowMs ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= nowMs))
  ) {
    return false;
  }
  if (!classificationAllowed(policy.classification, filters.principalDataLabels)) return false;
  if (policy.scopeMode === 'TENANT') {
    return (
      (policy.classification === 'PUBLIC' || policy.classification === 'INTERNAL') &&
      noResourceRestrictions(policy)
    );
  }
  if (!hasResourceRestriction(policy)) return false;
  return (
    peopleScopeAllowed(
      policy.organizationScopeIds,
      filters.organizationIds,
      policy.dataLabels,
      filters.principalDataLabels,
    ) &&
    arrayScopeAllowed(policy.projectScopeIds, filters.projectIds) &&
    arrayScopeAllowed(policy.taskScopeIds, filters.taskIds) &&
    arrayScopeAllowed(policy.roleTemplateScopeIds, filters.roleTemplateIds) &&
    labelsAllowed(policy.dataLabels, filters.principalDataLabels)
  );
}

/** SQL predicate applied before lexical, vector, graph, or citation content is read. */
export function knowledgeVersionResourcePolicySql(
  version: Prisma.Sql,
  filters: KnowledgeResourceAuthorizationFilters,
): Prisma.Sql {
  const project = arrayOverlapSql(
    Prisma.sql`${version}."project_scope_ids"`,
    filters.projectIds,
    'uuid',
  );
  const task = arrayOverlapSql(Prisma.sql`${version}."task_scope_ids"`, filters.taskIds, 'uuid');
  const role = arrayOverlapSql(
    Prisma.sql`${version}."role_template_scope_ids"`,
    filters.roleTemplateIds,
    'uuid',
  );
  const labels = labelsSubsetSql(Prisma.sql`${version}."data_labels"`, filters.principalDataLabels);
  const classification = classificationSql(
    Prisma.sql`${version}."classification"`,
    filters.principalDataLabels,
  );
  const people = peopleScopeSql(
    Prisma.sql`${version}."organization_scope_ids"`,
    filters.organizationIds,
    Prisma.sql`${version}."data_labels"`,
    filters.principalDataLabels,
  );
  return Prisma.sql`
    ${version}."governance_review_status" IN ('PENDING', 'APPROVED', 'MIGRATED')
    AND ${version}."governance_hash" ~ '^[a-f0-9]{64}$'
    AND ${version}."effective_from" <= statement_timestamp()
    AND (
      ${version}."expires_at" IS NULL
      OR ${version}."expires_at" > statement_timestamp()
    )
    AND ${classification}
    AND (
      (
        ${version}."scope_mode" = 'TENANT'
        AND ${version}."classification" IN ('PUBLIC', 'INTERNAL')
        AND cardinality(${version}."organization_scope_ids") = 0
        AND cardinality(${version}."project_scope_ids") = 0
        AND cardinality(${version}."task_scope_ids") = 0
        AND cardinality(${version}."role_template_scope_ids") = 0
        AND cardinality(${version}."data_labels") = 0
      )
      OR
      (
        ${version}."scope_mode" = 'RESTRICTED'
        AND (
          cardinality(${version}."organization_scope_ids") > 0
          OR cardinality(${version}."project_scope_ids") > 0
          OR cardinality(${version}."task_scope_ids") > 0
          OR cardinality(${version}."role_template_scope_ids") > 0
          OR cardinality(${version}."data_labels") > 0
        )
        AND ${people}
        AND ${project}
        AND ${task}
        AND ${role}
        AND ${labels}
      )
    )
  `;
}

/** Canonical JSON snapshot used by the post-query recheck and tests. */
export function knowledgeVersionResourcePolicySnapshotSql(version: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    jsonb_build_object(
      'ownerUserId', ${version}."governance_owner_user_id"::text,
      'classification', ${version}."classification",
      'scopeMode', ${version}."scope_mode",
      'organizationScopeIds', to_jsonb(${version}."organization_scope_ids"),
      'projectScopeIds', to_jsonb(${version}."project_scope_ids"),
      'taskScopeIds', to_jsonb(${version}."task_scope_ids"),
      'roleTemplateScopeIds', to_jsonb(${version}."role_template_scope_ids"),
      'dataLabels', to_jsonb(${version}."data_labels"),
      'effectiveFrom', to_jsonb(${version}."effective_from"),
      'expiresAt', to_jsonb(${version}."expires_at"),
      'retentionUntil', to_jsonb(${version}."retention_until"),
      'retentionAction', ${version}."retention_action",
      'supersedesVersionId', to_jsonb(${version}."supersedes_version_id"::text),
      'reviewStatus', ${version}."governance_review_status",
      'policyHash', btrim(${version}."governance_hash")
    )
  `;
}

function arrayOverlapSql(
  column: Prisma.Sql,
  allowedValues: readonly string[],
  cast: 'uuid' | 'text',
): Prisma.Sql {
  if (allowedValues.length === 0) return Prisma.sql`cardinality(${column}) = 0`;
  const allowed = Prisma.join(
    uniqueStrings(allowedValues).map((value) =>
      cast === 'uuid' ? Prisma.sql`${value}::uuid` : Prisma.sql`${value}::text`,
    ),
  );
  return Prisma.sql`(
    cardinality(${column}) = 0
    OR ${column} && ARRAY[${allowed}]::${Prisma.raw(`${cast}[]`)}
  )`;
}

function labelsSubsetSql(column: Prisma.Sql, allowedLabels: readonly string[]): Prisma.Sql {
  const allowedGovernanceLabels = uniqueStrings(
    allowedLabels.filter((label) => !isMemberAccessLabel(label)),
  );
  const allowedGovernanceSql =
    allowedGovernanceLabels.length === 0
      ? Prisma.sql`ARRAY[]::text[]`
      : Prisma.sql`ARRAY[${Prisma.join(allowedGovernanceLabels.map((label) => Prisma.sql`${label}::text`))}]::text[]`;
  return Prisma.sql`(
    ARRAY(
      SELECT label
      FROM unnest(${column}) AS label
      WHERE label NOT LIKE 'USER:%'
    ) <@ ${allowedGovernanceSql}
  )`;
}

function peopleScopeSql(
  organizationColumn: Prisma.Sql,
  allowedOrganizationIds: readonly string[],
  labelColumn: Prisma.Sql,
  allowedLabels: readonly string[],
): Prisma.Sql {
  const allowedOrganizationsSql =
    allowedOrganizationIds.length === 0
      ? Prisma.sql`ARRAY[]::uuid[]`
      : Prisma.sql`ARRAY[${Prisma.join(uniqueStrings(allowedOrganizationIds).map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`;
  const allowedMemberLabels = uniqueStrings(allowedLabels.filter(isMemberAccessLabel));
  const allowedMembersSql =
    allowedMemberLabels.length === 0
      ? Prisma.sql`ARRAY[]::text[]`
      : Prisma.sql`ARRAY[${Prisma.join(allowedMemberLabels.map((label) => Prisma.sql`${label}::text`))}]::text[]`;
  return Prisma.sql`(
    (
      cardinality(${organizationColumn}) = 0
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${labelColumn}) AS label WHERE label LIKE 'USER:%'
      )
    )
    OR ${organizationColumn} && ${allowedOrganizationsSql}
    OR ${labelColumn} && ${allowedMembersSql}
  )`;
}

function classificationSql(column: Prisma.Sql, principalDataLabels: readonly string[]): Prisma.Sql {
  const labels = new Set(principalDataLabels);
  const mayReadSensitive = labels.has(SENSITIVE_CLEARANCE) || labels.has(CONFIDENTIAL_CLEARANCE);
  const mayReadConfidential = labels.has(CONFIDENTIAL_CLEARANCE);
  return Prisma.sql`(
    ${column} IN ('PUBLIC', 'INTERNAL')
    ${mayReadSensitive ? Prisma.sql`OR ${column} = 'SENSITIVE'` : Prisma.empty}
    ${mayReadConfidential ? Prisma.sql`OR ${column} = 'CONFIDENTIAL'` : Prisma.empty}
  )`;
}

function classificationAllowed(
  classification: KnowledgeVersionResourcePolicy['classification'],
  labels: readonly string[],
): boolean {
  const principal = new Set(labels);
  if (classification === 'SENSITIVE') {
    return principal.has(SENSITIVE_CLEARANCE) || principal.has(CONFIDENTIAL_CLEARANCE);
  }
  if (classification === 'CONFIDENTIAL') return principal.has(CONFIDENTIAL_CLEARANCE);
  return true;
}

function arrayScopeAllowed(required: readonly string[], allowed: readonly string[]): boolean {
  if (required.length === 0) return true;
  const allowedSet = new Set(allowed);
  return required.some((value) => allowedSet.has(value));
}

function labelsAllowed(required: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return required
    .filter((value) => !isMemberAccessLabel(value))
    .every((value) => allowedSet.has(value));
}

function peopleScopeAllowed(
  requiredOrganizations: readonly string[],
  allowedOrganizations: readonly string[],
  requiredLabels: readonly string[],
  allowedLabels: readonly string[],
): boolean {
  const requiredMembers = requiredLabels.filter(isMemberAccessLabel);
  if (requiredOrganizations.length === 0 && requiredMembers.length === 0) return true;
  const allowedOrganizationSet = new Set(allowedOrganizations);
  const allowedLabelSet = new Set(allowedLabels);
  return (
    requiredOrganizations.some((value) => allowedOrganizationSet.has(value)) ||
    requiredMembers.some((value) => allowedLabelSet.has(value))
  );
}

function isMemberAccessLabel(value: string): boolean {
  return value.startsWith('USER:');
}

function noResourceRestrictions(policy: KnowledgeVersionResourcePolicy): boolean {
  return (
    policy.organizationScopeIds.length === 0 &&
    policy.projectScopeIds.length === 0 &&
    policy.taskScopeIds.length === 0 &&
    policy.roleTemplateScopeIds.length === 0 &&
    policy.dataLabels.length === 0
  );
}

function hasResourceRestriction(policy: KnowledgeVersionResourcePolicy): boolean {
  return !noResourceRestrictions(policy);
}

function parsePolicy(value: Prisma.JsonValue): KnowledgeVersionResourcePolicy | null {
  if (!isRecord(value)) return null;
  const ownerUserId = readNonEmptyString(value.ownerUserId);
  const classification = readNonEmptyString(value.classification);
  const scopeMode = readNonEmptyString(value.scopeMode);
  const effectiveFrom = readNonEmptyString(value.effectiveFrom);
  const retentionAction = readNonEmptyString(value.retentionAction);
  const reviewStatus = readNonEmptyString(value.reviewStatus);
  const policyHash = readNonEmptyString(value.policyHash);
  const expiresAt = readNullableString(value.expiresAt);
  const retentionUntil = readNullableString(value.retentionUntil);
  const supersedesVersionId = readNullableString(value.supersedesVersionId);
  const organizationScopeIds = readStrictStringArray(value.organizationScopeIds);
  const projectScopeIds = readStrictStringArray(value.projectScopeIds);
  const taskScopeIds = readStrictStringArray(value.taskScopeIds);
  const roleTemplateScopeIds = readStrictStringArray(value.roleTemplateScopeIds);
  const dataLabels = readStrictStringArray(value.dataLabels);
  if (
    ownerUserId === null ||
    classification === null ||
    !ALLOWED_CLASSIFICATIONS.has(classification) ||
    scopeMode === null ||
    (scopeMode !== 'TENANT' && scopeMode !== 'RESTRICTED') ||
    effectiveFrom === null ||
    retentionAction === null ||
    !['ARCHIVE', 'REVIEW_DELETE', 'LEGAL_HOLD'].includes(retentionAction) ||
    reviewStatus === null ||
    !['PENDING', 'APPROVED', 'REJECTED', 'MIGRATED'].includes(reviewStatus) ||
    policyHash === null ||
    !/^[a-f0-9]{64}$/u.test(policyHash) ||
    expiresAt === undefined ||
    retentionUntil === undefined ||
    supersedesVersionId === undefined ||
    organizationScopeIds === null ||
    projectScopeIds === null ||
    taskScopeIds === null ||
    roleTemplateScopeIds === null ||
    dataLabels === null
  ) {
    return null;
  }
  return {
    ownerUserId,
    classification: classification as KnowledgeVersionResourcePolicy['classification'],
    scopeMode,
    organizationScopeIds,
    projectScopeIds,
    taskScopeIds,
    roleTemplateScopeIds,
    dataLabels,
    effectiveFrom,
    expiresAt,
    retentionUntil,
    retentionAction: retentionAction as KnowledgeVersionResourcePolicy['retentionAction'],
    supersedesVersionId,
    reviewStatus: reviewStatus as KnowledgeVersionResourcePolicy['reviewStatus'],
    policyHash,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(
        value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
      )
    : [];
}

function readStrictStringArray(value: Prisma.JsonValue | undefined): string[] | null {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    return null;
  }
  const values = value as string[];
  return new Set(values).size === values.length ? values : null;
}

function readNonEmptyString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNullableString(value: Prisma.JsonValue | undefined): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
