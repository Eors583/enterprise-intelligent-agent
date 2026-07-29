import {
  businessPermissionLabelsSchema,
  metricTargetSchema,
  type Acceptance,
  type BusinessOwner,
  type Deliverable,
  type Evidence,
  type EvidenceLink,
  type MetricDefinition,
  type MetricObservation,
  type Objective,
  type ObjectiveRelation,
  type ProcessDefinition,
  type ProcessNode,
  type ProcessVersion,
  type Strategy,
  type Task,
  type TaskDependency,
  type ValueConstraint,
  type ValueDefinition,
  type ValueMetric,
  type ValueVersion,
} from '@enterprise/contracts';
import type {
  Acceptance as DbAcceptance,
  Deliverable as DbDeliverable,
  Evidence as DbEvidence,
  EvidenceLink as DbEvidenceLink,
  MetricDefinition as DbMetricDefinition,
  MetricObservation as DbMetricObservation,
  Objective as DbObjective,
  ObjectiveRelation as DbObjectiveRelation,
  ProcessDefinition as DbProcessDefinition,
  ProcessNode as DbProcessNode,
  ProcessVersion as DbProcessVersion,
  Strategy as DbStrategy,
  Task as DbTask,
  TaskDependency as DbTaskDependency,
  ValueConstraint as DbValueConstraint,
  ValueDefinition as DbValueDefinition,
  ValueMetric as DbValueMetric,
  ValueVersion as DbValueVersion,
} from '@prisma/client';

interface OwnerColumns {
  readonly ownerUserId: string | null;
  readonly ownerRoleAssignmentId: string | null;
  readonly ownerRoleTemplateId: string | null;
  readonly ownerOrgUnitId: string | null;
}

interface DeciderColumns {
  readonly decidedByUserId: string | null;
  readonly decidedByRoleAssignmentId: string | null;
  readonly decidedByRoleTemplateId: string | null;
  readonly decidedByOrgUnitId: string | null;
}

interface VerifierColumns {
  readonly verifiedByUserId: string | null;
  readonly verifiedByRoleAssignmentId: string | null;
  readonly verifiedByRoleTemplateId: string | null;
  readonly verifiedByOrgUnitId: string | null;
}

export function ownerColumns(owner: BusinessOwner): OwnerColumns {
  return {
    ownerUserId: owner.type === 'USER' ? owner.id : null,
    ownerRoleAssignmentId: owner.type === 'ROLE_ASSIGNMENT' ? owner.id : null,
    ownerRoleTemplateId: owner.type === 'ROLE_BLUEPRINT' ? owner.id : null,
    ownerOrgUnitId: owner.type === 'ORG_UNIT' ? owner.id : null,
  };
}

export function ownerFrom(record: OwnerColumns): BusinessOwner {
  if (record.ownerUserId !== null) return { type: 'USER', id: record.ownerUserId };
  if (record.ownerRoleAssignmentId !== null) {
    return { type: 'ROLE_ASSIGNMENT', id: record.ownerRoleAssignmentId };
  }
  if (record.ownerRoleTemplateId !== null) {
    return { type: 'ROLE_BLUEPRINT', id: record.ownerRoleTemplateId };
  }
  if (record.ownerOrgUnitId !== null) return { type: 'ORG_UNIT', id: record.ownerOrgUnitId };
  throw new Error('Business entity has no verified owner.');
}

export function deciderColumns(owner: BusinessOwner): DeciderColumns {
  return {
    decidedByUserId: owner.type === 'USER' ? owner.id : null,
    decidedByRoleAssignmentId: owner.type === 'ROLE_ASSIGNMENT' ? owner.id : null,
    decidedByRoleTemplateId: owner.type === 'ROLE_BLUEPRINT' ? owner.id : null,
    decidedByOrgUnitId: owner.type === 'ORG_UNIT' ? owner.id : null,
  };
}

export function verifierColumns(owner: BusinessOwner | null): VerifierColumns {
  return {
    verifiedByUserId: owner?.type === 'USER' ? owner.id : null,
    verifiedByRoleAssignmentId: owner?.type === 'ROLE_ASSIGNMENT' ? owner.id : null,
    verifiedByRoleTemplateId: owner?.type === 'ROLE_BLUEPRINT' ? owner.id : null,
    verifiedByOrgUnitId: owner?.type === 'ORG_UNIT' ? owner.id : null,
  };
}

export function mapValueDefinition(record: DbValueDefinition): ValueDefinition {
  return {
    ...storedEntity(record),
    type: record.type,
    name: record.name,
    description: record.description,
    currentVersionId: record.currentVersionId,
    ...effectivePeriod(record),
  };
}

export function mapValueMetric(record: DbValueMetric): ValueMetric {
  return {
    ...storedEntity(record),
    valueVersionId: record.valueVersionId,
    metricDefinitionId: record.metricDefinitionId,
    name: record.name,
    weight: Number(record.weight),
    target: metricTargetSchema.parse(record.target),
  };
}

export function mapValueConstraint(record: DbValueConstraint): ValueConstraint {
  return {
    ...storedEntity(record),
    valueVersionId: record.valueVersionId,
    type: record.type,
    severity: record.severity,
    statement: record.statement,
    requiredEvidenceTypes: stringArray(record.requiredEvidenceTypes),
  };
}

export function mapValueVersion(
  record: DbValueVersion,
  metrics: readonly DbValueMetric[],
  constraints: readonly DbValueConstraint[],
): ValueVersion {
  return {
    id: record.id,
    tenantId: record.tenantId,
    valueDefinitionId: record.valueDefinitionId,
    version: record.version,
    revision: record.revision,
    status: record.status,
    statement: record.statement,
    ...effectivePeriod(record),
    owner: ownerFrom(record),
    permissionLabels: permissionLabels(record.permissionLabels),
    positiveBehaviors: stringArray(record.positiveBehaviors),
    negativeBehaviors: stringArray(record.negativeBehaviors),
    metrics: metrics.map(mapValueMetric),
    constraints: constraints.map(mapValueConstraint),
    changeSummary: record.changeSummary,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function mapStrategy(record: DbStrategy, valueVersionIds: readonly string[]): Strategy {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    name: record.name,
    description: record.description,
    status: record.status,
    valueVersionIds: [...valueVersionIds],
    budget:
      record.budgetAmount === null || record.budgetCurrency === null
        ? null
        : { amount: Number(record.budgetAmount), currency: record.budgetCurrency },
  };
}

export function mapObjective(
  record: DbObjective,
  valueVersionIds: readonly string[],
  metricDefinitionIds: readonly string[],
  responsibleRoleAssignmentIds: readonly string[],
): Objective {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    strategyId: record.strategyId,
    parentObjectiveId: record.parentObjectiveId,
    name: record.name,
    description: record.description,
    status: record.status,
    bscPerspective: record.bscPerspective,
    indicatorType: record.indicatorType,
    weight: Number(record.weight),
    valueVersionIds: [...valueVersionIds],
    metricDefinitionIds: [...metricDefinitionIds],
    responsibleRoleAssignmentIds: [...responsibleRoleAssignmentIds],
  };
}

export function mapObjectiveRelation(record: DbObjectiveRelation): ObjectiveRelation {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    sourceObjectiveId: record.sourceObjectiveId,
    targetObjectiveId: record.targetObjectiveId,
    type: record.type,
    status: record.status,
    weight: Number(record.weight),
    lagDays: record.lagDays,
  };
}

export function mapMetricDefinition(record: DbMetricDefinition): MetricDefinition {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    name: record.name,
    description: record.description,
    status: record.status,
    valueType: record.valueType,
    unit: record.unit,
    aggregation: record.aggregation,
    direction: record.direction,
    bscPerspective: record.bscPerspective,
    indicatorType: record.indicatorType,
    validRange:
      record.validRangeMinimum === null || record.validRangeMaximum === null
        ? null
        : {
            minimum: Number(record.validRangeMinimum),
            maximum: Number(record.validRangeMaximum),
          },
  };
}

export function mapMetricObservation(
  record: DbMetricObservation,
  evidenceIds: readonly string[],
): MetricObservation {
  return {
    ...storedEntity(record),
    metricDefinitionId: record.metricDefinitionId,
    subject: metricSubject(record),
    value: Number(record.value),
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    observedAt: record.observedAt.toISOString(),
    evidenceIds: [...evidenceIds],
    supersedesObservationId: record.supersedesObservationId,
  };
}

export function mapProcessDefinition(record: DbProcessDefinition): ProcessDefinition {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    name: record.name,
    description: record.description,
    status: record.status,
    currentVersionId: record.currentVersionId,
  };
}

export function mapProcessNode(record: DbProcessNode): ProcessNode {
  return {
    id: record.id,
    tenantId: record.tenantId,
    processDefinitionId: record.processDefinitionId,
    processVersionId: record.processVersionId,
    processVersion: record.processVersion,
    code: record.code,
    name: record.name,
    type: record.type,
    ordinal: record.ordinal,
    configuration: jsonRecord(record.configuration),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function mapProcessVersion(
  record: DbProcessVersion,
  nodes: readonly DbProcessNode[],
): ProcessVersion {
  return {
    id: record.id,
    tenantId: record.tenantId,
    processDefinitionId: record.processDefinitionId,
    version: record.version,
    revision: record.revision,
    status: record.status,
    changeSummary: record.changeSummary,
    owner: ownerFrom(record),
    permissionLabels: permissionLabels(record.permissionLabels),
    ...effectivePeriod(record),
    nodes: nodes.map(mapProcessNode),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function mapTask(record: DbTask): Task {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    objectiveId: record.objectiveId,
    valueDefinitionId: record.valueDefinitionId,
    valueVersionId: record.valueVersionId,
    processRef: {
      definitionId: record.processDefinitionId,
      definitionCode: record.processDefinitionCode,
      versionId: record.processVersionId,
      version: record.processVersion,
      nodeId: record.processNodeId,
      nodeCode: record.processNodeCode,
      instanceId: record.processInstanceId,
    },
    title: record.title,
    description: record.description,
    status: record.status,
    priority: record.priority,
    dueAt: record.dueAt.toISOString(),
  };
}

export function mapTaskDependency(record: DbTaskDependency): TaskDependency {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    predecessorTaskId: record.predecessorTaskId,
    successorTaskId: record.successorTaskId,
    type: record.type,
    status: record.status,
    lagMinutes: record.lagMinutes,
  };
}

export function mapDeliverable(record: DbDeliverable): Deliverable {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    taskId: record.taskId,
    title: record.title,
    description: record.description,
    status: record.status,
    dueAt: record.dueAt.toISOString(),
    submittedAt: record.submittedAt?.toISOString() ?? null,
    artifactUri: record.artifactUri,
    contentHash: record.contentHash,
  };
}

export function mapAcceptance(record: DbAcceptance, evidenceIds: readonly string[]): Acceptance {
  return {
    ...storedEntity(record),
    deliverableId: record.deliverableId,
    status: record.status,
    decision: record.decision,
    decidedBy: deciderFrom(record),
    decidedAt: record.decidedAt.toISOString(),
    criteria: acceptanceCriteria(record.criteria),
    evidenceIds: [...evidenceIds],
    comment: record.comment,
  };
}

export function mapEvidence(record: DbEvidence): Evidence {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    status: record.status,
    sourceType: record.sourceType,
    sourceSystem: record.sourceSystem,
    sourceRecordId: record.sourceRecordId,
    sourceVersion: record.sourceVersion,
    sourceUri: record.sourceUri,
    observedAt: record.observedAt.toISOString(),
    contentHashAlgorithm: 'SHA256',
    contentHash: record.contentHash,
    trustLevel: record.trustLevel,
    confidence: Number(record.confidence),
    summary: record.summary,
    verifiedBy: verifierFrom(record),
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
  };
}

export function mapEvidenceLink(record: DbEvidenceLink): EvidenceLink {
  return {
    ...storedEntity(record),
    ...effectivePeriod(record),
    evidenceId: record.evidenceId,
    targetType: record.targetType,
    targetId: evidenceTargetId(record),
    targetVersion: record.targetVersion,
    status: record.status,
    type: record.type,
    relevance: Number(record.relevance),
    statement: record.statement,
  };
}

function storedEntity(record: {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly version: number;
  readonly revision: number;
  readonly permissionLabels: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly ownerUserId: string | null;
  readonly ownerRoleAssignmentId: string | null;
  readonly ownerRoleTemplateId: string | null;
  readonly ownerOrgUnitId: string | null;
}) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    code: record.code,
    owner: ownerFrom(record),
    version: record.version,
    revision: record.revision,
    permissionLabels: permissionLabels(record.permissionLabels),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function effectivePeriod(record: {
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}) {
  return {
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo?.toISOString() ?? null,
  };
}

function permissionLabels(value: unknown): string[] {
  return businessPermissionLabelsSchema.parse(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Expected a JSON string array.');
  }
  return [...value];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return { ...value };
}

function deciderFrom(record: DeciderColumns): BusinessOwner {
  return ownerFrom({
    ownerUserId: record.decidedByUserId,
    ownerRoleAssignmentId: record.decidedByRoleAssignmentId,
    ownerRoleTemplateId: record.decidedByRoleTemplateId,
    ownerOrgUnitId: record.decidedByOrgUnitId,
  });
}

function verifierFrom(record: VerifierColumns): BusinessOwner | null {
  const values = [
    record.verifiedByUserId,
    record.verifiedByRoleAssignmentId,
    record.verifiedByRoleTemplateId,
    record.verifiedByOrgUnitId,
  ];
  if (values.every((value) => value === null)) return null;
  return ownerFrom({
    ownerUserId: record.verifiedByUserId,
    ownerRoleAssignmentId: record.verifiedByRoleAssignmentId,
    ownerRoleTemplateId: record.verifiedByRoleTemplateId,
    ownerOrgUnitId: record.verifiedByOrgUnitId,
  });
}

function metricSubject(record: DbMetricObservation): MetricObservation['subject'] {
  const subjects = {
    VALUE_VERSION: record.subjectValueVersionId,
    STRATEGY: record.subjectStrategyId,
    OBJECTIVE: record.subjectObjectiveId,
    TASK: record.subjectTaskId,
    DELIVERABLE: record.subjectDeliverableId,
  } as const;
  const id = subjects[record.subjectType];
  if (id === null) throw new Error('Metric Observation has no verified subject.');
  return { type: record.subjectType, id, version: record.subjectVersion };
}

function evidenceTargetId(record: DbEvidenceLink): string {
  const targets = {
    VALUE_VERSION: record.targetValueVersionId,
    STRATEGY: record.targetStrategyId,
    OBJECTIVE: record.targetObjectiveId,
    METRIC_OBSERVATION: record.targetMetricObservationId,
    TASK: record.targetTaskId,
    DELIVERABLE: record.targetDeliverableId,
    ACCEPTANCE: record.targetAcceptanceId,
  } as const;
  const id = targets[record.targetType];
  if (id === null) throw new Error('Evidence Link has no verified target.');
  return id;
}

function acceptanceCriteria(value: unknown): Acceptance['criteria'] {
  if (!Array.isArray(value)) throw new Error('Acceptance criteria must be an array.');
  return value as Acceptance['criteria'];
}
