import { describe, expect, it } from 'vitest';

import {
  acceptanceSchema,
  bscPerspectiveSchema,
  businessSemanticTraceResponseSchema,
  createEvidenceGuidedRequestSchema,
  createEvidenceRequestSchema,
  createObjectiveRelationRequestSchema,
  createTaskDependencyRequestSchema,
  createTaskRequestSchema,
  createValueVersionRequestSchema,
  deliverableSchema,
  indicatorTypeSchema,
  metricObservationSchema,
  transitionTaskRequestSchema,
  updateTaskRequestSchema,
  updateValueMetricRequestSchema,
  valueTypeSchema,
  type BusinessSemanticTraceResponse,
} from '../src/index.js';

const TENANT_ID = id(1);
const OWNER_ID = id(2);
const ROLE_ASSIGNMENT_ID = id(3);
const VALUE_DEFINITION_ID = id(10);
const VALUE_VERSION_ID = id(11);
const VALUE_METRIC_ID = id(12);
const VALUE_CONSTRAINT_ID = id(13);
const STRATEGY_ID = id(20);
const LEADING_OBJECTIVE_ID = id(21);
const LAGGING_OBJECTIVE_ID = id(22);
const OBJECTIVE_RELATION_ID = id(23);
const LEADING_METRIC_ID = id(30);
const LAGGING_METRIC_ID = id(31);
const OBSERVATION_ID = id(32);
const TASK_ID = id(40);
const DELIVERABLE_ID = id(50);
const ACCEPTANCE_ID = id(51);
const EVIDENCE_ID = id(60);
const EVIDENCE_LINK_ID = id(61);
const PROCESS_DEFINITION_ID = id(70);
const PROCESS_VERSION_ID = id(71);
const PROCESS_NODE_ID = id(72);
const PROCESS_START_NODE_ID = id(73);
const PROCESS_END_NODE_ID = id(74);
const NOW = '2026-07-28T05:00:00.000Z';
const START = '2026-07-01T00:00:00.000Z';
const END = '2026-12-31T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const owner = { type: 'ROLE_ASSIGNMENT' as const, id: ROLE_ASSIGNMENT_ID };

describe('business semantics contracts', () => {
  it('parses a complete Value → Objective → Task → Acceptance → Evidence trace', () => {
    const parsed = businessSemanticTraceResponseSchema.parse(fullTrace());

    expect(parsed.rootTaskId).toBe(TASK_ID);
    expect(parsed.tasks[0]).toMatchObject({
      code: 'TASK.CUSTOMER.RETENTION',
      objectiveId: LAGGING_OBJECTIVE_ID,
      valueDefinitionId: VALUE_DEFINITION_ID,
      valueVersionId: VALUE_VERSION_ID,
      processRef: {
        definitionId: PROCESS_DEFINITION_ID,
        versionId: PROCESS_VERSION_ID,
        nodeId: PROCESS_NODE_ID,
      },
    });
    expect(parsed.evidence[0]).toMatchObject({
      contentHashAlgorithm: 'SHA256',
      contentHash: HASH,
      trustLevel: 'VERIFIED',
      permissionLabels: ['internal.strategy'],
    });
    expect(parsed.objectiveRelations[0]).toMatchObject({
      type: 'CAUSES',
      sourceObjectiveId: LEADING_OBJECTIVE_ID,
      targetObjectiveId: LAGGING_OBJECTIVE_ID,
    });
  });

  it('supports all documented value kinds and BSC perspectives with explicit indicator roles', () => {
    for (const valueType of ['CUSTOMER', 'ENTERPRISE', 'ROLE']) {
      expect(valueTypeSchema.parse(valueType)).toBe(valueType);
    }
    for (const perspective of ['FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH']) {
      expect(bscPerspectiveSchema.parse(perspective)).toBe(perspective);
    }
    expect(indicatorTypeSchema.parse('LEADING')).toBe('LEADING');
    expect(indicatorTypeSchema.parse('LAGGING')).toBe('LAGGING');
  });

  it('rejects invalid value periods, non-unit weights, duplicate codes, and conflicting behaviors', () => {
    const request = valueVersionRequest();

    expect(() =>
      createValueVersionRequestSchema.parse({
        ...request,
        effectiveTo: request.effectiveFrom,
      }),
    ).toThrow();
    expect(() =>
      createValueVersionRequestSchema.parse({
        ...request,
        metrics: [
          { ...request.metrics[0], weight: 0.6 },
          {
            ...request.metrics[0],
            metricDefinitionId: LEADING_METRIC_ID,
            weight: 0.3,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createValueVersionRequestSchema.parse({
        ...request,
        metrics: [
          { ...request.metrics[0], weight: 0.5 },
          {
            ...request.metrics[0],
            metricDefinitionId: LEADING_METRIC_ID,
            weight: 0.5,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createValueVersionRequestSchema.parse({
        ...request,
        negativeBehaviors: ['Resolve customer issues at the source'],
      }),
    ).toThrow();
  });

  it('requires every new Task to link Objective, Value, and a versioned Process node', () => {
    const request = taskRequest();

    expect(createTaskRequestSchema.parse(request)).toMatchObject({
      code: 'TASK.CUSTOMER.RETENTION',
      objectiveId: LAGGING_OBJECTIVE_ID,
      valueDefinitionId: VALUE_DEFINITION_ID,
      valueVersionId: VALUE_VERSION_ID,
    });
    const { processRef: _processRef, ...withoutProcess } = request;
    expect(() => createTaskRequestSchema.parse(withoutProcess)).toThrow();
    const { objectiveId: _objectiveId, ...withoutObjective } = request;
    expect(() => createTaskRequestSchema.parse(withoutObjective)).toThrow();
    const { valueVersionId: _valueVersionId, ...withoutValueVersion } = request;
    expect(() => createTaskRequestSchema.parse(withoutValueVersion)).toThrow();
    expect(() =>
      createTaskRequestSchema.parse({
        ...request,
        dueAt: '2027-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('keeps create, update, and transition requests strict and concurrency-aware', () => {
    expect(() =>
      createTaskRequestSchema.parse({ ...taskRequest(), tenantId: TENANT_ID }),
    ).toThrow();
    expect(() => updateTaskRequestSchema.parse({ expectedRevision: 1 })).toThrow();
    expect(() =>
      updateValueMetricRequestSchema.parse({
        expectedRevision: 1,
        expectedValueVersionRevision: 1,
      }),
    ).toThrow();
    expect(() =>
      updateTaskRequestSchema.parse({
        expectedRevision: 1,
        title: 'Updated governed task',
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      transitionTaskRequestSchema.parse({
        expectedRevision: 1,
        action: 'START',
        reason: 'Dependencies and authorization were verified.',
        effectiveAt: NOW,
        force: true,
      }),
    ).toThrow();
  });

  it('rejects self-relations, parent lags, and self-dependencies', () => {
    const relation = {
      code: 'RELATION.SPEED.CAUSES.RETENTION',
      sourceObjectiveId: LEADING_OBJECTIVE_ID,
      targetObjectiveId: LAGGING_OBJECTIVE_ID,
      type: 'CAUSES' as const,
      weight: 0.8,
      lagDays: 30,
      owner,
      effectiveFrom: START,
      effectiveTo: END,
      permissionLabels: ['internal.strategy'],
    };
    expect(createObjectiveRelationRequestSchema.parse(relation)).toMatchObject({
      type: 'CAUSES',
      lagDays: 30,
    });
    expect(() =>
      createObjectiveRelationRequestSchema.parse({
        ...relation,
        targetObjectiveId: LEADING_OBJECTIVE_ID,
      }),
    ).toThrow();
    expect(() =>
      createObjectiveRelationRequestSchema.parse({
        ...relation,
        type: 'PARENT_CHILD',
      }),
    ).toThrow();

    expect(() =>
      createTaskDependencyRequestSchema.parse({
        code: 'DEPENDENCY.SELF',
        predecessorTaskId: TASK_ID,
        successorTaskId: TASK_ID,
        type: 'FINISH_TO_START',
        lagMinutes: 0,
        owner,
        effectiveFrom: START,
        effectiveTo: END,
        permissionLabels: ['internal.strategy'],
      }),
    ).toThrow();
  });

  it('rejects malformed or unverifiable Evidence', () => {
    const request = evidenceRequest();

    expect(createEvidenceRequestSchema.parse(request)).toMatchObject({
      contentHashAlgorithm: 'SHA256',
      contentHash: HASH,
      trustLevel: 'VERIFIED',
    });
    expect(() =>
      createEvidenceRequestSchema.parse({
        ...request,
        contentHash: 'not-a-sha256',
      }),
    ).toThrow();
    expect(() =>
      createEvidenceRequestSchema.parse({
        ...request,
        verifiedBy: null,
        verifiedAt: null,
      }),
    ).toThrow();
    expect(() =>
      createEvidenceRequestSchema.parse({
        ...request,
        permissionLabels: ['internal.strategy', 'INTERNAL.STRATEGY'],
      }),
    ).toThrow();
  });

  it('accepts a business-facing Evidence command without technical identity or hash fields', () => {
    const parsed = createEvidenceGuidedRequestSchema.parse({
      sourceType: 'DOCUMENT',
      sourceName: '2026 年客户服务复盘',
      sourceUri: 'https://knowledge.example.local/reviews/2026-customer-service',
      observedAt: NOW,
      summary: '复盘确认客户响应时间缩短并给出可追溯的原始记录。',
      trustLevel: 'MEDIUM',
      retentionDays: 365,
    });

    expect(parsed).toEqual({
      sourceType: 'DOCUMENT',
      sourceName: '2026 年客户服务复盘',
      sourceUri: 'https://knowledge.example.local/reviews/2026-customer-service',
      observedAt: NOW,
      summary: '复盘确认客户响应时间缩短并给出可追溯的原始记录。',
      trustLevel: 'MEDIUM',
      retentionDays: 365,
    });
    expect(
      createEvidenceGuidedRequestSchema.safeParse({ ...parsed, trustLevel: 'VERIFIED' }).success,
    ).toBe(false);
    expect(
      createEvidenceGuidedRequestSchema.safeParse({
        ...parsed,
        contentHash: HASH,
        owner,
      }).success,
    ).toBe(false);
  });

  it('rejects metric observations with reversed periods, premature observation times, or no evidence', () => {
    const observation = fullTrace().metricObservations[0];

    expect(() =>
      metricObservationSchema.parse({
        ...observation,
        periodEnd: observation.periodStart,
      }),
    ).toThrow();
    expect(() =>
      metricObservationSchema.parse({
        ...observation,
        observedAt: '2026-07-15T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      metricObservationSchema.parse({
        ...observation,
        evidenceIds: [],
      }),
    ).toThrow();
  });

  it('rejects Acceptance decisions that conflict with weighted criteria', () => {
    const acceptance = fullTrace().acceptances[0];

    expect(acceptanceSchema.parse(acceptance).decision).toBe('ACCEPTED');
    expect(() =>
      acceptanceSchema.parse({
        ...acceptance,
        criteria: [
          {
            ...acceptance.criteria[0],
            mandatory: true,
            passed: false,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      acceptanceSchema.parse({
        ...acceptance,
        criteria: [
          { ...acceptance.criteria[0], weight: 0.8 },
          {
            ...acceptance.criteria[0],
            code: 'CRITERION.SECURITY',
            weight: 0.3,
          },
        ],
      }),
    ).toThrow();
  });

  it('allows both pre-submission and post-submission Deliverable withdrawal states', () => {
    const deliverable = fullTrace().deliverables[0];
    expect(
      deliverableSchema.parse({
        ...deliverable,
        status: 'WITHDRAWN',
        submittedAt: null,
        artifactUri: null,
        contentHash: null,
      }).status,
    ).toBe('WITHDRAWN');
    expect(
      deliverableSchema.parse({
        ...deliverable,
        status: 'WITHDRAWN',
      }).status,
    ).toBe('WITHDRAWN');
  });

  it('fails a trace closed on causal-role inversion, dangling links, duplicate codes, or cross-tenant data', () => {
    const invertedCause = fullTrace();
    invertedCause.objectives[0].indicatorType = 'LAGGING';
    expect(() => businessSemanticTraceResponseSchema.parse(invertedCause)).toThrow();

    const danglingTask = fullTrace();
    danglingTask.tasks[0].objectiveId = id(999);
    expect(() => businessSemanticTraceResponseSchema.parse(danglingTask)).toThrow();

    const danglingEvidence = fullTrace();
    danglingEvidence.evidenceLinks[0].targetId = id(998);
    expect(() => businessSemanticTraceResponseSchema.parse(danglingEvidence)).toThrow();

    const duplicateCode = fullTrace();
    duplicateCode.tasks.push({
      ...duplicateCode.tasks[0],
      id: id(997),
      code: 'task.customer.retention',
    });
    expect(() => businessSemanticTraceResponseSchema.parse(duplicateCode)).toThrow();

    const crossTenant = fullTrace();
    crossTenant.evidence[0].tenantId = id(996);
    expect(() => businessSemanticTraceResponseSchema.parse(crossTenant)).toThrow();

    const objectiveCycle = fullTrace();
    objectiveCycle.objectives[0].parentObjectiveId = LAGGING_OBJECTIVE_ID;
    objectiveCycle.objectives[1].parentObjectiveId = LEADING_OBJECTIVE_ID;
    expect(() => businessSemanticTraceResponseSchema.parse(objectiveCycle)).toThrow();

    const crossStrategyParent = fullTrace();
    const otherStrategyId = id(992);
    crossStrategyParent.strategies.push({
      ...crossStrategyParent.strategies[0],
      id: otherStrategyId,
      code: 'STRATEGY.OTHER.VALUE',
    });
    crossStrategyParent.objectiveRelations = [];
    crossStrategyParent.objectives[0].strategyId = otherStrategyId;
    crossStrategyParent.objectives[1].parentObjectiveId = LEADING_OBJECTIVE_ID;
    expect(() => businessSemanticTraceResponseSchema.parse(crossStrategyParent)).toThrow();

    const taskCycle = fullTrace();
    const otherTaskId = id(995);
    taskCycle.tasks.push({
      ...taskCycle.tasks[0],
      id: otherTaskId,
      code: 'TASK.CUSTOMER.RETENTION.FOLLOWUP',
      status: 'READY',
    });
    taskCycle.taskDependencies.push(
      {
        ...entity(id(994), 'DEPENDENCY.ROOT.FOLLOWUP'),
        effectiveFrom: START,
        effectiveTo: END,
        predecessorTaskId: TASK_ID,
        successorTaskId: otherTaskId,
        type: 'FINISH_TO_START',
        status: 'ACTIVE',
        lagMinutes: 0,
      },
      {
        ...entity(id(993), 'DEPENDENCY.FOLLOWUP.ROOT'),
        effectiveFrom: START,
        effectiveTo: END,
        predecessorTaskId: otherTaskId,
        successorTaskId: TASK_ID,
        type: 'FINISH_TO_START',
        status: 'ACTIVE',
        lagMinutes: 0,
      },
    );
    expect(() => businessSemanticTraceResponseSchema.parse(taskCycle)).toThrow();
  });

  it('fails a trace closed when Process identity is missing, mis-versioned, or has the wrong code', () => {
    const missingDefinition = fullTrace();
    missingDefinition.processDefinitions = [];
    expect(() => businessSemanticTraceResponseSchema.parse(missingDefinition)).toThrow();

    const wrongVersion = fullTrace();
    wrongVersion.tasks[0].processRef.version = 4;
    expect(() => businessSemanticTraceResponseSchema.parse(wrongVersion)).toThrow();

    const wrongDefinitionCode = fullTrace();
    wrongDefinitionCode.tasks[0].processRef.definitionCode = 'PROCESS.WRONG.CODE';
    expect(() => businessSemanticTraceResponseSchema.parse(wrongDefinitionCode)).toThrow();

    const wrongNodeCode = fullTrace();
    wrongNodeCode.tasks[0].processRef.nodeCode = 'NODE.WRONG.CODE';
    expect(() => businessSemanticTraceResponseSchema.parse(wrongNodeCode)).toThrow();

    const crossTenantNode = fullTrace();
    crossTenantNode.processNodes[0].tenantId = id(998);
    expect(() => businessSemanticTraceResponseSchema.parse(crossTenantNode)).toThrow();
  });
});

function fullTrace(): BusinessSemanticTraceResponse {
  const valueDefinition = {
    ...entity(VALUE_DEFINITION_ID, 'value.customer.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    type: 'CUSTOMER' as const,
    name: 'Customer retention value',
    description: 'Retain customers by resolving root causes and improving outcomes.',
    currentVersionId: VALUE_VERSION_ID,
  };
  const valueMetric = {
    ...entity(VALUE_METRIC_ID, 'value.metric.retention'),
    valueVersionId: VALUE_VERSION_ID,
    metricDefinitionId: LAGGING_METRIC_ID,
    name: 'Retention contribution',
    weight: 1,
    target: { kind: 'AT_LEAST' as const, value: 0.9 },
  };
  const valueConstraint = {
    ...entity(VALUE_CONSTRAINT_ID, 'value.constraint.privacy'),
    valueVersionId: VALUE_VERSION_ID,
    type: 'POLICY' as const,
    severity: 'HARD' as const,
    statement: 'Customer privacy and least privilege must be preserved.',
    requiredEvidenceTypes: ['AUDIT.EVENT'],
  };
  const valueVersion = {
    id: VALUE_VERSION_ID,
    tenantId: TENANT_ID,
    valueDefinitionId: VALUE_DEFINITION_ID,
    version: 1,
    revision: 1,
    status: 'PUBLISHED' as const,
    statement: 'Resolve customer needs while preserving trust and policy compliance.',
    effectiveFrom: START,
    effectiveTo: END,
    owner,
    permissionLabels: ['INTERNAL.STRATEGY'],
    positiveBehaviors: ['Resolve customer issues at the source'],
    negativeBehaviors: ['Hide recurring customer complaints'],
    metrics: [valueMetric],
    constraints: [valueConstraint],
    changeSummary: 'Initial governed customer value version.',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const strategy = {
    ...entity(STRATEGY_ID, 'strategy.customer.trust'),
    effectiveFrom: START,
    effectiveTo: END,
    name: 'Customer trust strategy',
    description: 'Improve leading service behavior to produce durable retention.',
    status: 'ACTIVE' as const,
    valueVersionIds: [VALUE_VERSION_ID],
    budget: { amount: 1_000_000, currency: 'CNY' },
  };
  const leadingMetric = {
    ...entity(LEADING_METRIC_ID, 'metric.resolution.speed'),
    effectiveFrom: START,
    effectiveTo: END,
    name: 'Resolution speed',
    description: 'Measures the speed of root-cause customer issue resolution.',
    status: 'ACTIVE' as const,
    valueType: 'DURATION' as const,
    unit: 'hours',
    aggregation: 'AVERAGE' as const,
    direction: 'DECREASE' as const,
    bscPerspective: 'INTERNAL_PROCESS' as const,
    indicatorType: 'LEADING' as const,
    validRange: { minimum: 0, maximum: 720 },
  };
  const laggingMetric = {
    ...entity(LAGGING_METRIC_ID, 'metric.customer.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    name: 'Customer retention',
    description: 'Measures retained customers in the governed reporting period.',
    status: 'ACTIVE' as const,
    valueType: 'PERCENTAGE' as const,
    unit: 'ratio',
    aggregation: 'LATEST' as const,
    direction: 'INCREASE' as const,
    bscPerspective: 'CUSTOMER' as const,
    indicatorType: 'LAGGING' as const,
    validRange: { minimum: 0, maximum: 1 },
  };
  const leadingObjective = {
    ...entity(LEADING_OBJECTIVE_ID, 'objective.resolution.speed'),
    effectiveFrom: START,
    effectiveTo: END,
    strategyId: STRATEGY_ID,
    parentObjectiveId: null,
    name: 'Resolve issues faster',
    description: 'Improve the leading service process before retention is measured.',
    status: 'ACTIVE' as const,
    bscPerspective: 'INTERNAL_PROCESS' as const,
    indicatorType: 'LEADING' as const,
    weight: 0.4,
    valueVersionIds: [VALUE_VERSION_ID],
    metricDefinitionIds: [LEADING_METRIC_ID],
    responsibleRoleAssignmentIds: [ROLE_ASSIGNMENT_ID],
  };
  const laggingObjective = {
    ...entity(LAGGING_OBJECTIVE_ID, 'objective.customer.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    strategyId: STRATEGY_ID,
    parentObjectiveId: null,
    name: 'Retain customers',
    description: 'Increase retained customers after service improvements.',
    status: 'ACTIVE' as const,
    bscPerspective: 'CUSTOMER' as const,
    indicatorType: 'LAGGING' as const,
    weight: 0.6,
    valueVersionIds: [VALUE_VERSION_ID],
    metricDefinitionIds: [LAGGING_METRIC_ID],
    responsibleRoleAssignmentIds: [ROLE_ASSIGNMENT_ID],
  };
  const objectiveRelation = {
    ...entity(OBJECTIVE_RELATION_ID, 'relation.speed.causes.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    sourceObjectiveId: LEADING_OBJECTIVE_ID,
    targetObjectiveId: LAGGING_OBJECTIVE_ID,
    type: 'CAUSES' as const,
    status: 'ACTIVE' as const,
    weight: 0.8,
    lagDays: 30,
  };
  const evidence = {
    ...entity(EVIDENCE_ID, 'evidence.retention.observation'),
    effectiveFrom: START,
    effectiveTo: END,
    status: 'ACTIVE' as const,
    sourceType: 'BUSINESS_SYSTEM' as const,
    sourceSystem: 'CRM.PRODUCTION',
    sourceRecordId: 'retention-report-2026-07',
    sourceVersion: '2026.07.1',
    sourceUri: 'https://evidence.example.test/reports/retention-2026-07',
    observedAt: NOW,
    contentHashAlgorithm: 'SHA256' as const,
    contentHash: HASH,
    trustLevel: 'VERIFIED' as const,
    confidence: 0.99,
    summary: 'CRM retention report signed by the governed reporting pipeline.',
    verifiedBy: { type: 'USER' as const, id: OWNER_ID },
    verifiedAt: NOW,
  };
  const observation = {
    ...entity(OBSERVATION_ID, 'observation.retention.2026-07'),
    metricDefinitionId: LAGGING_METRIC_ID,
    subject: {
      type: 'OBJECTIVE' as const,
      id: LAGGING_OBJECTIVE_ID,
      version: 1,
    },
    value: 0.92,
    periodStart: START,
    periodEnd: '2026-07-31T00:00:00.000Z',
    observedAt: '2026-08-01T00:00:00.000Z',
    evidenceIds: [EVIDENCE_ID],
    supersedesObservationId: null,
  };
  const processStartNode = {
    id: PROCESS_START_NODE_ID,
    tenantId: TENANT_ID,
    processDefinitionId: PROCESS_DEFINITION_ID,
    processVersionId: PROCESS_VERSION_ID,
    processVersion: 3,
    code: 'NODE.PROCESS.START',
    name: 'Start retention process',
    type: 'START' as const,
    ordinal: 0,
    configuration: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  const processNode = {
    id: PROCESS_NODE_ID,
    tenantId: TENANT_ID,
    processDefinitionId: PROCESS_DEFINITION_ID,
    processVersionId: PROCESS_VERSION_ID,
    processVersion: 3,
    code: 'NODE.RESOLVE.ROOT.CAUSE',
    name: 'Resolve root cause',
    type: 'ACTIVITY' as const,
    ordinal: 1,
    configuration: { requiredEvidence: true },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const processEndNode = {
    id: PROCESS_END_NODE_ID,
    tenantId: TENANT_ID,
    processDefinitionId: PROCESS_DEFINITION_ID,
    processVersionId: PROCESS_VERSION_ID,
    processVersion: 3,
    code: 'NODE.PROCESS.END',
    name: 'Complete retention process',
    type: 'END' as const,
    ordinal: 2,
    configuration: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  const processDefinition = {
    ...entity(PROCESS_DEFINITION_ID, 'process.customer.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    name: 'Customer retention process',
    description: 'Governed process for resolving customer retention root causes.',
    status: 'ACTIVE' as const,
    currentVersionId: PROCESS_VERSION_ID,
  };
  const processVersion = {
    id: PROCESS_VERSION_ID,
    tenantId: TENANT_ID,
    processDefinitionId: PROCESS_DEFINITION_ID,
    version: 3,
    revision: 1,
    status: 'PUBLISHED' as const,
    changeSummary: 'Published governed retention workflow.',
    owner,
    permissionLabels: ['INTERNAL.STRATEGY'],
    effectiveFrom: START,
    effectiveTo: END,
    nodes: [processStartNode, processNode, processEndNode],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const task = {
    ...entity(TASK_ID, 'task.customer.retention'),
    effectiveFrom: START,
    effectiveTo: END,
    objectiveId: LAGGING_OBJECTIVE_ID,
    valueDefinitionId: VALUE_DEFINITION_ID,
    valueVersionId: VALUE_VERSION_ID,
    processRef: {
      definitionId: PROCESS_DEFINITION_ID,
      definitionCode: 'PROCESS.CUSTOMER.RETENTION',
      versionId: PROCESS_VERSION_ID,
      version: 3,
      nodeId: PROCESS_NODE_ID,
      nodeCode: 'NODE.RESOLVE.ROOT.CAUSE',
      instanceId: null,
    },
    title: 'Resolve retention root causes',
    description: 'Execute the governed customer retention process and produce evidence.',
    status: 'ACCEPTED' as const,
    priority: 'HIGH' as const,
    dueAt: '2026-09-30T00:00:00.000Z',
  };
  const deliverable = {
    ...entity(DELIVERABLE_ID, 'deliverable.retention.plan'),
    effectiveFrom: START,
    effectiveTo: END,
    taskId: TASK_ID,
    title: 'Retention root-cause plan',
    description: 'A versioned action plan addressing verified retention causes.',
    status: 'ACCEPTED' as const,
    dueAt: '2026-09-30T00:00:00.000Z',
    submittedAt: '2026-09-20T00:00:00.000Z',
    artifactUri: 'https://evidence.example.test/artifacts/retention-plan-v1',
    contentHash: HASH,
  };
  const acceptance = {
    ...entity(ACCEPTANCE_ID, 'acceptance.retention.plan'),
    deliverableId: DELIVERABLE_ID,
    status: 'ACTIVE' as const,
    decision: 'ACCEPTED' as const,
    decidedBy: { type: 'USER' as const, id: OWNER_ID },
    decidedAt: '2026-09-21T00:00:00.000Z',
    criteria: [
      {
        code: 'CRITERION.ROOT.CAUSE',
        description: 'All material root causes are supported by governed evidence.',
        mandatory: true,
        passed: true,
        weight: 1,
        comment: 'Verified against the CRM report.',
      },
    ],
    evidenceIds: [EVIDENCE_ID],
    comment: 'The deliverable satisfies the governed acceptance criteria.',
  };
  const evidenceLink = {
    ...entity(EVIDENCE_LINK_ID, 'evidence.link.retention.acceptance'),
    effectiveFrom: START,
    effectiveTo: END,
    evidenceId: EVIDENCE_ID,
    targetType: 'ACCEPTANCE' as const,
    targetId: ACCEPTANCE_ID,
    targetVersion: 1,
    status: 'ACTIVE' as const,
    type: 'SUPPORTS' as const,
    relevance: 1,
    statement: 'The verified CRM report supports this acceptance decision.',
  };

  return {
    traceId: id(100),
    tenantId: TENANT_ID,
    rootTaskId: TASK_ID,
    generatedAt: NOW,
    valueDefinitions: [valueDefinition],
    valueVersions: [valueVersion],
    strategies: [strategy],
    objectives: [leadingObjective, laggingObjective],
    objectiveRelations: [objectiveRelation],
    metricDefinitions: [leadingMetric, laggingMetric],
    metricObservations: [observation],
    processDefinitions: [processDefinition],
    processVersions: [processVersion],
    processNodes: [processStartNode, processNode, processEndNode],
    tasks: [task],
    taskDependencies: [],
    deliverables: [deliverable],
    acceptances: [acceptance],
    evidence: [evidence],
    evidenceLinks: [evidenceLink],
  };
}

function valueVersionRequest() {
  return {
    valueDefinitionId: VALUE_DEFINITION_ID,
    expectedDefinitionRevision: 1,
    statement: 'Resolve customer needs while preserving trust and policy compliance.',
    effectiveFrom: START,
    effectiveTo: END,
    owner,
    permissionLabels: ['internal.strategy'],
    positiveBehaviors: ['Resolve customer issues at the source'],
    negativeBehaviors: ['Hide recurring customer complaints'],
    metrics: [
      {
        code: 'VALUE.METRIC.RETENTION',
        metricDefinitionId: LAGGING_METRIC_ID,
        name: 'Retention contribution',
        weight: 1,
        target: { kind: 'AT_LEAST' as const, value: 0.9 },
        permissionLabels: ['internal.strategy'],
      },
    ],
    constraints: [
      {
        code: 'VALUE.CONSTRAINT.PRIVACY',
        type: 'POLICY' as const,
        severity: 'HARD' as const,
        statement: 'Customer privacy and least privilege must be preserved.',
        requiredEvidenceTypes: ['AUDIT.EVENT'],
        permissionLabels: ['internal.strategy'],
      },
    ],
    changeSummary: 'Initial governed customer value version.',
  };
}

function taskRequest() {
  return {
    code: 'TASK.CUSTOMER.RETENTION',
    objectiveId: LAGGING_OBJECTIVE_ID,
    valueDefinitionId: VALUE_DEFINITION_ID,
    valueVersionId: VALUE_VERSION_ID,
    processRef: {
      definitionId: PROCESS_DEFINITION_ID,
      definitionCode: 'PROCESS.CUSTOMER.RETENTION',
      versionId: PROCESS_VERSION_ID,
      version: 3,
      nodeId: PROCESS_NODE_ID,
      nodeCode: 'NODE.RESOLVE.ROOT.CAUSE',
      instanceId: null,
    },
    title: 'Resolve retention root causes',
    description: 'Execute the governed customer retention process and produce evidence.',
    owner,
    priority: 'HIGH' as const,
    effectiveFrom: START,
    effectiveTo: END,
    dueAt: '2026-09-30T00:00:00.000Z',
    permissionLabels: ['internal.strategy'],
  };
}

function evidenceRequest() {
  return {
    code: 'EVIDENCE.RETENTION.OBSERVATION',
    sourceType: 'BUSINESS_SYSTEM' as const,
    sourceSystem: 'CRM.PRODUCTION',
    sourceRecordId: 'retention-report-2026-07',
    sourceVersion: '2026.07.1',
    sourceUri: 'https://evidence.example.test/reports/retention-2026-07',
    observedAt: NOW,
    contentHashAlgorithm: 'SHA256' as const,
    contentHash: HASH,
    trustLevel: 'VERIFIED' as const,
    confidence: 0.99,
    summary: 'CRM retention report signed by the governed reporting pipeline.',
    verifiedBy: { type: 'USER' as const, id: OWNER_ID },
    verifiedAt: NOW,
    owner,
    effectiveFrom: START,
    effectiveTo: END,
    permissionLabels: ['internal.strategy'],
  };
}

function entity(entityId: string, code: string) {
  return {
    id: entityId,
    tenantId: TENANT_ID,
    code,
    owner,
    version: 1,
    revision: 1,
    permissionLabels: ['INTERNAL.STRATEGY'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function id(value: number): string {
  return `00000000-0000-7000-8000-${value.toString().padStart(12, '0')}`;
}
