import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  businessSemanticTraceResponseSchema,
  type BusinessSemanticTraceResponse,
  type WorkbenchObjectiveListResponse,
  type WorkbenchTaskListResponse,
} from '@enterprise/contracts';
import {
  Prisma,
  type Acceptance as DbAcceptance,
  type Deliverable as DbDeliverable,
  type Evidence as DbEvidence,
  type EvidenceLink as DbEvidenceLink,
  type MetricDefinition as DbMetricDefinition,
  type MetricObservation as DbMetricObservation,
  type Objective as DbObjective,
  type ObjectiveRelation as DbObjectiveRelation,
  type ProcessDefinition as DbProcessDefinition,
  type ProcessNode as DbProcessNode,
  type ProcessVersion as DbProcessVersion,
  type Strategy as DbStrategy,
  type Task as DbTask,
  type TaskDependency as DbTaskDependency,
  type ValueConstraint as DbValueConstraint,
  type ValueDefinition as DbValueDefinition,
  type ValueMetric as DbValueMetric,
  type ValueVersion as DbValueVersion,
} from '@prisma/client';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  isBusinessSemanticResourceVisible,
  type BusinessSemanticResource,
} from '../authorization/domain/business-semantics.authorization.js';
import {
  mapAcceptance,
  mapDeliverable,
  mapEvidence,
  mapEvidenceLink,
  mapMetricDefinition,
  mapMetricObservation,
  mapObjective,
  mapObjectiveRelation,
  mapProcessDefinition,
  mapProcessNode,
  mapProcessVersion,
  mapStrategy,
  mapTask,
  mapTaskDependency,
  mapValueDefinition,
  mapValueVersion,
} from './business-semantics.mapper.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
import { semanticNotFound } from './business-semantics.persistence.js';

@Injectable()
export class BusinessSemanticsWorkbenchService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listObjectives(): Promise<WorkbenchObjectiveListResponse> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const filter = await this.policy.requireReadFilter(
        transaction,
        principal,
        'business.objective.read',
      );
      const records = await transaction.objective.findMany({
        where: {
          tenantId: principal.tenantId,
          status: { in: ['ACTIVE', 'AT_RISK', 'ACHIEVED'] },
        },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
        take: 2_000,
      });
      const latestByCode = new Map<string, (typeof records)[number]>();
      for (const record of records) {
        if (!latestByCode.has(record.code)) latestByCode.set(record.code, record);
      }
      const objectives = [...latestByCode.values()];
      const links = await loadObjectiveLinks(transaction, principal.tenantId, objectives);
      const visible = objectives.filter((objective) =>
        isBusinessSemanticResourceVisible(
          semanticResource('OBJECTIVE', objective, {
            responsibleRoleAssignmentIds:
              links.byObjective.get(objective.id)?.responsibleRoleAssignmentIds ?? [],
          }),
          filter,
        ),
      );
      return {
        items: visible.map((objective) =>
          mapObjective(
            objective,
            links.byObjective.get(objective.id)?.valueVersionIds ?? [],
            links.byObjective.get(objective.id)?.metricDefinitionIds ?? [],
            links.byObjective.get(objective.id)?.responsibleRoleAssignmentIds ?? [],
          ),
        ),
      };
    });
  }

  async listTasks(): Promise<WorkbenchTaskListResponse> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const filter = await this.policy.requireReadFilter(
        transaction,
        principal,
        'business.task.read',
      );
      const records = await transaction.task.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { dueAt: 'asc' }],
        take: 5_000,
      });
      const latestByCode = new Map<string, (typeof records)[number]>();
      for (const record of records) {
        if (!latestByCode.has(record.code)) latestByCode.set(record.code, record);
      }
      const visible = [...latestByCode.values()]
        .filter((task) =>
          isBusinessSemanticResourceVisible(
            semanticResource('TASK', task, { taskId: task.id }),
            filter,
          ),
        )
        .sort(
          (left, right) =>
            left.dueAt.getTime() - right.dueAt.getTime() || left.code.localeCompare(right.code),
        );
      return { items: visible.map(mapTask) };
    });
  }

  async trace(taskId: string): Promise<BusinessSemanticTraceResponse> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const graph = await loadTraceGraph(transaction, principal, taskId);
      await this.policy.requireCompleteTrace(transaction, principal, graph.authorizationNodes);
      const parsed = businessSemanticTraceResponseSchema.safeParse(graph.response);
      if (!parsed.success) {
        throw new ConflictException('Business semantic trace is structurally incomplete.');
      }
      return parsed.data;
    });
  }
}

async function loadTraceGraph(
  transaction: Prisma.TransactionClient,
  principal: TenantPrincipal,
  rootTaskId: string,
): Promise<{
  readonly response: BusinessSemanticTraceResponse;
  readonly authorizationNodes: readonly BusinessSemanticResource[];
}> {
  const tenantId = principal.tenantId;
  const allTasks = await bounded(
    transaction.task.findMany({
      where: { tenantId },
      orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
      take: 5_001,
    }),
    5_000,
    'Task',
  );
  const rootTask = allTasks.find((task) => task.id === rootTaskId);
  if (rootTask === undefined) throw semanticNotFound('Task');
  const allDependencies = await bounded(
    transaction.taskDependency.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
      take: 10_001,
    }),
    10_000,
    'Task Dependency',
  );
  const taskIds = connectedIds(
    rootTaskId,
    allDependencies.map((dependency) => [dependency.predecessorTaskId, dependency.successorTaskId]),
    5_000,
  );
  const tasks = allTasks.filter((task) => taskIds.has(task.id));
  if (tasks.length !== taskIds.size) {
    throw new ConflictException('Task dependency graph contains a missing Task.');
  }
  const taskDependencies = allDependencies.filter(
    (dependency) =>
      taskIds.has(dependency.predecessorTaskId) && taskIds.has(dependency.successorTaskId),
  );

  const allObjectives = await bounded(
    transaction.objective.findMany({
      where: { tenantId },
      orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
      take: 2_001,
    }),
    2_000,
    'Objective',
  );
  const allObjectiveRelations = await bounded(
    transaction.objectiveRelation.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
      take: 5_001,
    }),
    5_000,
    'Objective Relation',
  );
  const objectiveIds = new Set(tasks.map((task) => task.objectiveId));
  let objectiveChanged = true;
  while (objectiveChanged) {
    objectiveChanged = false;
    for (const objective of allObjectives) {
      if (
        objectiveIds.has(objective.id) &&
        objective.parentObjectiveId !== null &&
        !objectiveIds.has(objective.parentObjectiveId)
      ) {
        objectiveIds.add(objective.parentObjectiveId);
        objectiveChanged = true;
      }
    }
    for (const relation of allObjectiveRelations) {
      if (
        objectiveIds.has(relation.sourceObjectiveId) &&
        !objectiveIds.has(relation.targetObjectiveId)
      ) {
        objectiveIds.add(relation.targetObjectiveId);
        objectiveChanged = true;
      } else if (
        objectiveIds.has(relation.targetObjectiveId) &&
        !objectiveIds.has(relation.sourceObjectiveId)
      ) {
        objectiveIds.add(relation.sourceObjectiveId);
        objectiveChanged = true;
      }
    }
    if (objectiveIds.size > 2_000) {
      throw new ConflictException('Objective trace exceeds the supported bound.');
    }
  }
  const objectives = allObjectives.filter((objective) => objectiveIds.has(objective.id));
  if (objectives.length !== objectiveIds.size) {
    throw new ConflictException('Objective trace contains a missing parent or endpoint.');
  }
  const objectiveRelations = allObjectiveRelations.filter(
    (relation) =>
      objectiveIds.has(relation.sourceObjectiveId) && objectiveIds.has(relation.targetObjectiveId),
  );
  const objectiveLinks = await loadObjectiveLinks(transaction, tenantId, objectives);

  const strategyIds = new Set(objectives.map((objective) => objective.strategyId));
  const strategies = await transaction.strategy.findMany({
    where: { tenantId, id: { in: [...strategyIds] } },
    orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
  });
  if (strategies.length !== strategyIds.size) {
    throw new ConflictException('Objective trace contains a missing Strategy.');
  }
  const strategyValueLinks = await transaction.strategyValueVersion.findMany({
    where: { tenantId, strategyId: { in: [...strategyIds] } },
    orderBy: [{ strategyId: 'asc' }, { valueVersionId: 'asc' }],
  });

  const valueVersionIds = new Set(tasks.map((task) => task.valueVersionId));
  for (const strategyLink of strategyValueLinks) {
    valueVersionIds.add(strategyLink.valueVersionId);
  }
  for (const links of objectiveLinks.byObjective.values()) {
    for (const id of links.valueVersionIds) valueVersionIds.add(id);
  }
  let valueVersions = await transaction.valueVersion.findMany({
    where: { tenantId, id: { in: [...valueVersionIds] } },
    orderBy: [{ valueDefinitionId: 'asc' }, { version: 'asc' }],
  });
  const valueDefinitionIds = new Set(valueVersions.map((version) => version.valueDefinitionId));
  const valueDefinitions = await transaction.valueDefinition.findMany({
    where: { tenantId, id: { in: [...valueDefinitionIds] } },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  });
  for (const definition of valueDefinitions) {
    if (definition.currentVersionId !== null) {
      valueVersionIds.add(definition.currentVersionId);
    }
  }
  valueVersions = await transaction.valueVersion.findMany({
    where: { tenantId, id: { in: [...valueVersionIds] } },
    orderBy: [{ valueDefinitionId: 'asc' }, { version: 'asc' }],
  });
  if (
    valueDefinitions.length !== valueDefinitionIds.size ||
    valueVersions.length !== valueVersionIds.size
  ) {
    throw new ConflictException('Value trace contains a missing definition or version.');
  }
  const [valueMetrics, valueConstraints] = await Promise.all([
    transaction.valueMetric.findMany({
      where: { tenantId, valueVersionId: { in: [...valueVersionIds] } },
      orderBy: [{ valueVersionId: 'asc' }, { code: 'asc' }],
    }),
    transaction.valueConstraint.findMany({
      where: { tenantId, valueVersionId: { in: [...valueVersionIds] } },
      orderBy: [{ valueVersionId: 'asc' }, { code: 'asc' }],
    }),
  ]);

  const metricDefinitionIds = new Set(valueMetrics.map((metric) => metric.metricDefinitionId));
  for (const links of objectiveLinks.byObjective.values()) {
    for (const id of links.metricDefinitionIds) metricDefinitionIds.add(id);
  }
  let metricDefinitions = await transaction.metricDefinition.findMany({
    where: { tenantId, id: { in: [...metricDefinitionIds] } },
    orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
  });
  if (metricDefinitions.length !== metricDefinitionIds.size) {
    throw new ConflictException('Metric trace contains a missing definition.');
  }

  const processDefinitionIds = new Set(tasks.map((task) => task.processDefinitionId));
  const processDefinitions = await transaction.processDefinition.findMany({
    where: { tenantId, id: { in: [...processDefinitionIds] } },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  });
  const processVersionIds = new Set(tasks.map((task) => task.processVersionId));
  for (const definition of processDefinitions) {
    if (definition.currentVersionId !== null) {
      processVersionIds.add(definition.currentVersionId);
    }
  }
  const processVersions = await transaction.processVersion.findMany({
    where: { tenantId, id: { in: [...processVersionIds] } },
    orderBy: [{ processDefinitionId: 'asc' }, { version: 'asc' }],
  });
  const processNodes = await transaction.processNode.findMany({
    where: { tenantId, processVersionId: { in: [...processVersionIds] } },
    orderBy: [{ processVersionId: 'asc' }, { ordinal: 'asc' }, { id: 'asc' }],
  });
  if (
    processDefinitions.length !== processDefinitionIds.size ||
    processVersions.length !== processVersionIds.size
  ) {
    throw new ConflictException('Process trace contains a missing exact version.');
  }

  const deliverables = await bounded(
    transaction.deliverable.findMany({
      where: { tenantId, taskId: { in: [...taskIds] } },
      orderBy: [{ taskId: 'asc' }, { code: 'asc' }, { version: 'asc' }],
      take: 10_001,
    }),
    10_000,
    'Deliverable',
  );
  const deliverableIds = new Set(deliverables.map((deliverable) => deliverable.id));
  const acceptances = await bounded(
    transaction.acceptance.findMany({
      where: { tenantId, deliverableId: { in: [...deliverableIds] } },
      orderBy: [{ deliverableId: 'asc' }, { code: 'asc' }, { version: 'asc' }],
      take: 10_001,
    }),
    10_000,
    'Acceptance',
  );

  const observationSubjectClauses: Prisma.MetricObservationWhereInput[] = [];
  if (valueVersionIds.size > 0) {
    observationSubjectClauses.push({
      subjectType: 'VALUE_VERSION',
      subjectValueVersionId: { in: [...valueVersionIds] },
    });
  }
  if (strategyIds.size > 0) {
    observationSubjectClauses.push({
      subjectType: 'STRATEGY',
      subjectStrategyId: { in: [...strategyIds] },
    });
  }
  if (objectiveIds.size > 0) {
    observationSubjectClauses.push({
      subjectType: 'OBJECTIVE',
      subjectObjectiveId: { in: [...objectiveIds] },
    });
  }
  if (taskIds.size > 0) {
    observationSubjectClauses.push({
      subjectType: 'TASK',
      subjectTaskId: { in: [...taskIds] },
    });
  }
  if (deliverableIds.size > 0) {
    observationSubjectClauses.push({
      subjectType: 'DELIVERABLE',
      subjectDeliverableId: { in: [...deliverableIds] },
    });
  }
  const metricObservations = await bounded(
    transaction.metricObservation.findMany({
      where: { tenantId, OR: observationSubjectClauses },
      orderBy: [{ observedAt: 'asc' }, { code: 'asc' }, { version: 'asc' }],
      take: 10_001,
    }),
    10_000,
    'Metric Observation',
  );
  for (const observation of metricObservations) {
    metricDefinitionIds.add(observation.metricDefinitionId);
  }
  metricDefinitions = await transaction.metricDefinition.findMany({
    where: { tenantId, id: { in: [...metricDefinitionIds] } },
    orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
  });
  if (metricDefinitions.length !== metricDefinitionIds.size) {
    throw new ConflictException('Metric trace contains a missing definition.');
  }
  const metricObservationIds = new Set(metricObservations.map((observation) => observation.id));

  const [metricObservationEvidence, deliverableEvidence, acceptanceEvidence] = await Promise.all([
    transaction.metricObservationEvidence.findMany({
      where: {
        tenantId,
        metricObservationId: { in: [...metricObservationIds] },
      },
      orderBy: [{ metricObservationId: 'asc' }, { evidenceId: 'asc' }],
    }),
    transaction.deliverableEvidence.findMany({
      where: { tenantId, deliverableId: { in: [...deliverableIds] } },
      orderBy: [{ deliverableId: 'asc' }, { evidenceId: 'asc' }],
    }),
    transaction.acceptanceEvidence.findMany({
      where: {
        tenantId,
        acceptanceId: { in: acceptances.map((acceptance) => acceptance.id) },
      },
      orderBy: [{ acceptanceId: 'asc' }, { evidenceId: 'asc' }],
    }),
  ]);
  const associatedEvidenceIds = new Set([
    ...metricObservationEvidence.map((link) => link.evidenceId),
    ...deliverableEvidence.map((link) => link.evidenceId),
    ...acceptanceEvidence.map((link) => link.evidenceId),
  ]);

  const evidenceTargetClauses: Prisma.EvidenceLinkWhereInput[] = [];
  if (valueVersionIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'VALUE_VERSION',
      targetValueVersionId: { in: [...valueVersionIds] },
    });
  }
  if (strategyIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'STRATEGY',
      targetStrategyId: { in: [...strategyIds] },
    });
  }
  if (objectiveIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'OBJECTIVE',
      targetObjectiveId: { in: [...objectiveIds] },
    });
  }
  if (metricObservationIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'METRIC_OBSERVATION',
      targetMetricObservationId: { in: [...metricObservationIds] },
    });
  }
  if (taskIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'TASK',
      targetTaskId: { in: [...taskIds] },
    });
  }
  if (deliverableIds.size > 0) {
    evidenceTargetClauses.push({
      targetType: 'DELIVERABLE',
      targetDeliverableId: { in: [...deliverableIds] },
    });
  }
  if (acceptances.length > 0) {
    evidenceTargetClauses.push({
      targetType: 'ACCEPTANCE',
      targetAcceptanceId: {
        in: acceptances.map((acceptance) => acceptance.id),
      },
    });
  }
  const evidenceLinks = await bounded(
    transaction.evidenceLink.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: evidenceTargetClauses,
      },
      orderBy: [{ evidenceId: 'asc' }, { code: 'asc' }, { version: 'asc' }],
      take: 50_001,
    }),
    50_000,
    'Evidence Link',
  );
  for (const link of evidenceLinks) associatedEvidenceIds.add(link.evidenceId);
  const evidence = await bounded(
    transaction.evidence.findMany({
      where: { tenantId, id: { in: [...associatedEvidenceIds] } },
      orderBy: [{ observedAt: 'asc' }, { code: 'asc' }, { version: 'asc' }],
      take: 20_001,
    }),
    20_000,
    'Evidence',
  );
  if (evidence.length !== associatedEvidenceIds.size) {
    throw new ConflictException('Evidence trace contains a missing version.');
  }

  const mappedValueVersions = valueVersions.map((version) =>
    mapValueVersion(
      version,
      valueMetrics.filter((metric) => metric.valueVersionId === version.id),
      valueConstraints.filter((constraint) => constraint.valueVersionId === version.id),
    ),
  );
  const mappedStrategies = strategies.map((strategy) =>
    mapStrategy(
      strategy,
      strategyValueLinks
        .filter(
          (link) => link.strategyId === strategy.id && link.strategyVersion === strategy.version,
        )
        .map((link) => link.valueVersionId),
    ),
  );
  const mappedObjectives = objectives.map((objective) => {
    const links = objectiveLinks.byObjective.get(objective.id);
    return mapObjective(
      objective,
      links?.valueVersionIds ?? [],
      links?.metricDefinitionIds ?? [],
      links?.responsibleRoleAssignmentIds ?? [],
    );
  });
  const mappedProcessVersions = processVersions.map((version) =>
    mapProcessVersion(
      version,
      processNodes.filter((node) => node.processVersionId === version.id),
    ),
  );
  const mappedMetricObservations = metricObservations.map((observation) =>
    mapMetricObservation(
      observation,
      metricObservationEvidence
        .filter(
          (link) =>
            link.metricObservationId === observation.id &&
            link.metricObservationVersion === observation.version,
        )
        .map((link) => link.evidenceId),
    ),
  );
  const mappedAcceptances = acceptances.map((acceptance) =>
    mapAcceptance(
      acceptance,
      acceptanceEvidence
        .filter(
          (link) =>
            link.acceptanceId === acceptance.id && link.acceptanceVersion === acceptance.version,
        )
        .map((link) => link.evidenceId),
    ),
  );

  const response = {
    traceId: randomUUID(),
    tenantId,
    rootTaskId,
    generatedAt: new Date().toISOString(),
    valueDefinitions: valueDefinitions.map(mapValueDefinition),
    valueVersions: mappedValueVersions,
    strategies: mappedStrategies,
    objectives: mappedObjectives,
    objectiveRelations: objectiveRelations.map(mapObjectiveRelation),
    metricDefinitions: metricDefinitions.map(mapMetricDefinition),
    metricObservations: mappedMetricObservations,
    processDefinitions: processDefinitions.map(mapProcessDefinition),
    processVersions: mappedProcessVersions,
    processNodes: processNodes.map(mapProcessNode),
    tasks: tasks.map(mapTask),
    taskDependencies: taskDependencies.map(mapTaskDependency),
    deliverables: deliverables.map(mapDeliverable),
    acceptances: mappedAcceptances,
    evidence: evidence.map(mapEvidence),
    evidenceLinks: evidenceLinks.map(mapEvidenceLink),
  } satisfies BusinessSemanticTraceResponse;

  const authorizationNodes = traceAuthorizationNodes({
    valueDefinitions,
    valueVersions,
    valueMetrics,
    valueConstraints,
    strategies,
    objectives,
    objectiveLinks,
    objectiveRelations,
    metricDefinitions,
    metricObservations,
    processDefinitions,
    processVersions,
    processNodes,
    tasks,
    taskDependencies,
    deliverables,
    acceptances,
    evidence,
    evidenceLinks,
  });
  return { response, authorizationNodes };
}

function traceAuthorizationNodes(input: {
  readonly valueDefinitions: readonly DbValueDefinition[];
  readonly valueVersions: readonly DbValueVersion[];
  readonly valueMetrics: readonly DbValueMetric[];
  readonly valueConstraints: readonly DbValueConstraint[];
  readonly strategies: readonly DbStrategy[];
  readonly objectives: readonly DbObjective[];
  readonly objectiveLinks: Awaited<ReturnType<typeof loadObjectiveLinks>>;
  readonly objectiveRelations: readonly DbObjectiveRelation[];
  readonly metricDefinitions: readonly DbMetricDefinition[];
  readonly metricObservations: readonly DbMetricObservation[];
  readonly processDefinitions: readonly DbProcessDefinition[];
  readonly processVersions: readonly DbProcessVersion[];
  readonly processNodes: readonly DbProcessNode[];
  readonly tasks: readonly DbTask[];
  readonly taskDependencies: readonly DbTaskDependency[];
  readonly deliverables: readonly DbDeliverable[];
  readonly acceptances: readonly DbAcceptance[];
  readonly evidence: readonly DbEvidence[];
  readonly evidenceLinks: readonly DbEvidenceLink[];
}): BusinessSemanticResource[] {
  const nodes: BusinessSemanticResource[] = [];
  for (const record of input.valueDefinitions) {
    nodes.push(semanticResource('VALUE', record));
  }
  for (const record of input.valueVersions) {
    nodes.push(semanticResource('VALUE', record));
  }
  for (const record of input.valueMetrics) {
    nodes.push(semanticResource('VALUE', record));
  }
  for (const record of input.valueConstraints) {
    nodes.push(semanticResource('VALUE', record));
  }
  for (const record of input.strategies) {
    nodes.push(semanticResource('STRATEGY', record));
  }
  for (const record of input.objectives) {
    nodes.push(
      semanticResource('OBJECTIVE', record, {
        responsibleRoleAssignmentIds:
          input.objectiveLinks.byObjective.get(record.id)?.responsibleRoleAssignmentIds ?? [],
      }),
    );
  }
  for (const record of input.objectiveRelations) {
    nodes.push(semanticResource('OBJECTIVE', record));
  }
  for (const record of input.metricDefinitions) {
    nodes.push(semanticResource('METRIC', record));
  }
  for (const record of input.metricObservations) {
    const taskId =
      record.subjectTaskId ??
      (record.subjectDeliverableId === null
        ? null
        : (input.deliverables.find((deliverable) => deliverable.id === record.subjectDeliverableId)
            ?.taskId ?? null));
    nodes.push(semanticResource('METRIC', record, { taskId }));
  }
  for (const record of input.processDefinitions) {
    nodes.push(semanticResource('PROCESS', record));
  }
  for (const record of input.processVersions) {
    nodes.push(semanticResource('PROCESS', record));
  }
  for (const record of input.processNodes) {
    const version = input.processVersions.find(
      (candidate) => candidate.id === record.processVersionId,
    );
    if (version === undefined) {
      throw new ConflictException('Process Node has no trace-visible Process Version.');
    }
    nodes.push({
      ...semanticResource('PROCESS', version),
      id: record.id,
    });
  }
  for (const record of input.tasks) {
    nodes.push(semanticResource('TASK', record, { taskId: record.id }));
  }
  for (const record of input.taskDependencies) {
    nodes.push(semanticResource('TASK', record, { taskId: record.successorTaskId }));
  }
  for (const record of input.deliverables) {
    nodes.push(semanticResource('DELIVERABLE', record, { taskId: record.taskId }));
  }
  for (const record of input.acceptances) {
    const taskId =
      input.deliverables.find((deliverable) => deliverable.id === record.deliverableId)?.taskId ??
      null;
    nodes.push(semanticResource('ACCEPTANCE', record, { taskId }));
  }
  for (const record of input.evidence) {
    nodes.push(semanticResource('EVIDENCE', record));
  }
  for (const record of input.evidenceLinks) {
    const taskId =
      record.targetTaskId ??
      (record.targetDeliverableId === null
        ? null
        : (input.deliverables.find((deliverable) => deliverable.id === record.targetDeliverableId)
            ?.taskId ?? null)) ??
      (record.targetAcceptanceId === null
        ? null
        : (input.deliverables.find(
            (deliverable) =>
              deliverable.id ===
              input.acceptances.find((acceptance) => acceptance.id === record.targetAcceptanceId)
                ?.deliverableId,
          )?.taskId ?? null));
    nodes.push(semanticResource('EVIDENCE', record, { taskId }));
  }
  return nodes;
}

async function loadObjectiveLinks(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  objectives: readonly DbObjective[],
) {
  const ids = objectives.map((objective) => objective.id);
  const [values, metrics, assignments] = await Promise.all([
    transaction.objectiveValueVersion.findMany({
      where: { tenantId, objectiveId: { in: ids } },
      orderBy: [{ objectiveId: 'asc' }, { valueVersionId: 'asc' }],
    }),
    transaction.objectiveMetricDefinition.findMany({
      where: { tenantId, objectiveId: { in: ids } },
      orderBy: [{ objectiveId: 'asc' }, { metricDefinitionId: 'asc' }],
    }),
    transaction.objectiveRoleAssignment.findMany({
      where: { tenantId, objectiveId: { in: ids } },
      orderBy: [{ objectiveId: 'asc' }, { roleAssignmentId: 'asc' }],
    }),
  ]);
  const byObjective = new Map<
    string,
    {
      readonly valueVersionIds: string[];
      readonly metricDefinitionIds: string[];
      readonly responsibleRoleAssignmentIds: string[];
    }
  >();
  for (const objective of objectives) {
    byObjective.set(objective.id, {
      valueVersionIds: values
        .filter(
          (link) =>
            link.objectiveId === objective.id && link.objectiveVersion === objective.version,
        )
        .map((link) => link.valueVersionId),
      metricDefinitionIds: metrics
        .filter(
          (link) =>
            link.objectiveId === objective.id && link.objectiveVersion === objective.version,
        )
        .map((link) => link.metricDefinitionId),
      responsibleRoleAssignmentIds: assignments
        .filter(
          (link) =>
            link.objectiveId === objective.id && link.objectiveVersion === objective.version,
        )
        .map((link) => link.roleAssignmentId),
    });
  }
  return { byObjective };
}

function connectedIds(
  rootId: string,
  edges: readonly (readonly [string, string])[],
  limit: number,
): Set<string> {
  const result = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of edges) {
      if (result.has(left) && !result.has(right)) {
        result.add(right);
        changed = true;
      } else if (result.has(right) && !result.has(left)) {
        result.add(left);
        changed = true;
      }
    }
    if (result.size > limit) {
      throw new ConflictException('Task dependency trace exceeds the supported bound.');
    }
  }
  return result;
}

async function bounded<T>(promise: Promise<T[]>, limit: number, resource: string): Promise<T[]> {
  const records = await promise;
  if (records.length > limit) {
    throw new ConflictException(`${resource} trace exceeds the supported bound.`);
  }
  return records;
}
