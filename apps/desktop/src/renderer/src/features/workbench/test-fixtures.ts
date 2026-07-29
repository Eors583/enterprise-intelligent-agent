import {
  businessSemanticTraceResponseSchema,
  type BusinessSemanticTraceResponse,
  type Objective,
  type Task,
} from '@enterprise/contracts';

const tenantId = '10000000-0000-7000-8000-000000000001';
const owner = {
  type: 'USER' as const,
  id: '20000000-0000-7000-8000-000000000001',
};
const createdAt = '2026-01-01T00:00:00.000Z';
const updatedAt = '2026-07-01T00:00:00.000Z';
const effectiveFrom = '2026-01-01T00:00:00.000Z';
const effectiveTo = null;
const stored = (number: number, code: string) => ({
  id: id(number),
  tenantId,
  code,
  owner,
  version: 1,
  revision: 1,
  permissionLabels: ['business.read'],
  createdAt,
  updatedAt,
});

export function objectiveFixture(overrides: Partial<Objective> = {}): Objective {
  return {
    ...stored(30, 'OBJECTIVE.RETENTION'),
    strategyId: id(20),
    parentObjectiveId: null,
    name: '提升客户留存',
    description: '通过主动服务降低客户流失。',
    status: 'ACTIVE',
    bscPerspective: 'CUSTOMER',
    indicatorType: 'LEADING',
    weight: 1,
    valueVersionIds: [id(11)],
    metricDefinitionIds: [id(40)],
    responsibleRoleAssignmentIds: [id(90)],
    effectiveFrom,
    effectiveTo,
    ...overrides,
  };
}

export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    ...stored(60, 'TASK.RETENTION.REVIEW'),
    objectiveId: id(30),
    valueDefinitionId: id(10),
    valueVersionId: id(11),
    processRef: {
      definitionId: id(50),
      definitionCode: 'PROCESS.CUSTOMER.RETENTION',
      versionId: id(51),
      version: 1,
      nodeId: id(53),
      nodeCode: 'ACTIVITY.REVIEW',
      instanceId: null,
    },
    title: '复盘高风险客户',
    description: '分析高风险客户并形成可验收的干预清单。',
    status: 'ACCEPTED',
    priority: 'HIGH',
    dueAt: '2026-08-01T00:00:00.000Z',
    effectiveFrom,
    effectiveTo,
    ...overrides,
  };
}

export function workbenchTraceFixture(): BusinessSemanticTraceResponse {
  const metric = {
    ...stored(40, 'METRIC.CUSTOMER.RETENTION'),
    name: '客户留存率',
    description: '统计周期内留存客户占比。',
    status: 'ACTIVE' as const,
    valueType: 'PERCENTAGE' as const,
    unit: '%',
    aggregation: 'LATEST' as const,
    direction: 'INCREASE' as const,
    bscPerspective: 'CUSTOMER' as const,
    indicatorType: 'LEADING' as const,
    validRange: { minimum: 0, maximum: 100 },
    effectiveFrom,
    effectiveTo,
  };
  const valueMetric = {
    ...stored(12, 'VALUE.METRIC.RETENTION'),
    valueVersionId: id(11),
    metricDefinitionId: metric.id,
    name: '客户留存率',
    weight: 1,
    target: { kind: 'AT_LEAST' as const, value: 90 },
  };
  const valueVersion = {
    id: id(11),
    tenantId,
    valueDefinitionId: id(10),
    version: 1,
    revision: 1,
    status: 'PUBLISHED' as const,
    statement: '通过持续可靠的客户结果创造长期价值。',
    effectiveFrom,
    effectiveTo,
    owner,
    permissionLabels: ['business.read'],
    positiveBehaviors: ['主动识别客户风险'],
    negativeBehaviors: ['忽略客户反馈'],
    metrics: [valueMetric],
    constraints: [],
    changeSummary: '首个已发布价值版本',
    createdAt,
    updatedAt,
  };
  const valueDefinition = {
    ...stored(10, 'VALUE.CUSTOMER.SUCCESS'),
    type: 'CUSTOMER' as const,
    name: '客户成功价值',
    description: '以客户持续成功作为价值判断。',
    currentVersionId: valueVersion.id,
    effectiveFrom,
    effectiveTo,
  };
  const strategy = {
    ...stored(20, 'STRATEGY.RETENTION'),
    name: '客户留存战略',
    description: '通过主动风险干预提升客户留存。',
    status: 'ACTIVE' as const,
    valueVersionIds: [valueVersion.id],
    budget: null,
    effectiveFrom,
    effectiveTo,
  };
  const objective = objectiveFixture();
  const processStart = {
    id: id(52),
    tenantId,
    processDefinitionId: id(50),
    processVersionId: id(51),
    processVersion: 1,
    code: 'START.MAIN',
    name: '开始',
    type: 'START' as const,
    ordinal: 0,
    configuration: {},
    createdAt,
    updatedAt,
  };
  const processActivity = {
    id: id(53),
    tenantId,
    processDefinitionId: id(50),
    processVersionId: id(51),
    processVersion: 1,
    code: 'ACTIVITY.REVIEW',
    name: '风险复盘',
    type: 'ACTIVITY' as const,
    ordinal: 1,
    configuration: {},
    createdAt,
    updatedAt,
  };
  const processEnd = {
    id: id(54),
    tenantId,
    processDefinitionId: id(50),
    processVersionId: id(51),
    processVersion: 1,
    code: 'END.MAIN',
    name: '结束',
    type: 'END' as const,
    ordinal: 2,
    configuration: {},
    createdAt,
    updatedAt,
  };
  const processVersion = {
    id: id(51),
    tenantId,
    processDefinitionId: id(50),
    version: 1,
    revision: 1,
    status: 'PUBLISHED' as const,
    changeSummary: '首个客户留存流程版本',
    owner,
    permissionLabels: ['business.read'],
    effectiveFrom,
    effectiveTo,
    nodes: [processStart, processActivity, processEnd],
    createdAt,
    updatedAt,
  };
  const processDefinition = {
    ...stored(50, 'PROCESS.CUSTOMER.RETENTION'),
    name: '客户留存流程',
    description: '识别、复盘并处置客户留存风险。',
    status: 'ACTIVE' as const,
    currentVersionId: processVersion.id,
    effectiveFrom,
    effectiveTo,
  };
  const predecessor = taskFixture({
    ...stored(61, 'TASK.RETENTION.SCAN'),
    title: '扫描客户风险',
    description: '从业务系统提取高风险客户。',
    status: 'ACCEPTED',
    processRef: {
      definitionId: processDefinition.id,
      definitionCode: processDefinition.code,
      versionId: processVersion.id,
      version: processVersion.version,
      nodeId: processActivity.id,
      nodeCode: processActivity.code,
      instanceId: null,
    },
  });
  const rootTask = taskFixture();
  const dependency = {
    ...stored(62, 'TASK.DEPENDENCY.SCAN.REVIEW'),
    predecessorTaskId: predecessor.id,
    successorTaskId: rootTask.id,
    type: 'FINISH_TO_START' as const,
    status: 'ACTIVE' as const,
    lagMinutes: 0,
    effectiveFrom,
    effectiveTo,
  };
  const deliverable = {
    ...stored(70, 'DELIVERABLE.RISK.LIST'),
    taskId: rootTask.id,
    title: '高风险客户干预清单',
    description: '包含风险原因、Owner 与干预截止日。',
    status: 'ACCEPTED' as const,
    dueAt: '2026-08-01T00:00:00.000Z',
    submittedAt: '2026-07-20T00:00:00.000Z',
    artifactUri: 'https://example.test/artifacts/risk-list',
    contentHash: 'a'.repeat(64),
    effectiveFrom,
    effectiveTo,
  };
  const evidence = {
    ...stored(80, 'EVIDENCE.RISK.LIST'),
    status: 'ACTIVE' as const,
    sourceType: 'DOCUMENT' as const,
    sourceSystem: 'SYSTEM.DOCUMENT',
    sourceRecordId: 'risk-list-2026-07',
    sourceVersion: '1',
    sourceUri: 'https://example.test/artifacts/risk-list',
    observedAt: '2026-07-20T00:00:00.000Z',
    contentHashAlgorithm: 'SHA256' as const,
    contentHash: 'a'.repeat(64),
    trustLevel: 'HIGH' as const,
    confidence: 0.9,
    summary: '高风险客户干预清单证据',
    verifiedBy: null,
    verifiedAt: null,
    effectiveFrom,
    effectiveTo,
  };
  const acceptance = {
    ...stored(71, 'ACCEPTANCE.RISK.LIST'),
    deliverableId: deliverable.id,
    status: 'ACTIVE' as const,
    decision: 'ACCEPTED' as const,
    decidedBy: owner,
    decidedAt: '2026-07-21T00:00:00.000Z',
    criteria: [
      {
        code: 'CRITERION.COMPLETE',
        description: '清单覆盖全部高风险客户',
        mandatory: true,
        passed: true,
        weight: 1,
        comment: null,
      },
    ],
    evidenceIds: [evidence.id],
    comment: '验收通过，进入客户干预阶段。',
  };
  const evidenceLink = {
    ...stored(81, 'EVIDENCE.LINK.ACCEPTANCE'),
    evidenceId: evidence.id,
    targetType: 'ACCEPTANCE' as const,
    targetId: acceptance.id,
    targetVersion: acceptance.version,
    status: 'ACTIVE' as const,
    type: 'SUPPORTS' as const,
    relevance: 1,
    statement: '该清单直接支持验收决定。',
    effectiveFrom,
    effectiveTo,
  };

  return businessSemanticTraceResponseSchema.parse({
    traceId: id(1),
    tenantId,
    rootTaskId: rootTask.id,
    generatedAt: '2026-07-22T00:00:00.000Z',
    valueDefinitions: [valueDefinition],
    valueVersions: [valueVersion],
    strategies: [strategy],
    objectives: [objective],
    objectiveRelations: [],
    metricDefinitions: [metric],
    metricObservations: [],
    processDefinitions: [processDefinition],
    processVersions: [processVersion],
    processNodes: [processStart, processActivity, processEnd],
    tasks: [predecessor, rootTask],
    taskDependencies: [dependency],
    deliverables: [deliverable],
    acceptances: [acceptance],
    evidence: [evidence],
    evidenceLinks: [evidenceLink],
  });
}

function id(number: number): string {
  return `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`;
}
