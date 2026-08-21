import {
  createMetricDefinitionRequestSchema,
  createObjectiveRequestSchema,
  createProcessDefinitionRequestSchema,
  createProcessVersionRequestSchema,
  createStrategyRequestSchema,
  createTaskRequestSchema,
  createValueDefinitionRequestSchema,
  createValueVersionRequestSchema,
  transitionEvidenceRequestSchema,
  transitionMetricDefinitionRequestSchema,
  transitionObjectiveRequestSchema,
  transitionProcessVersionRequestSchema,
  transitionStrategyRequestSchema,
  transitionTaskRequestSchema,
  transitionValueVersionRequestSchema,
  updateEvidenceRequestSchema,
  updateMetricDefinitionRequestSchema,
  updateObjectiveRequestSchema,
  updateProcessDefinitionRequestSchema,
  updateProcessVersionRequestSchema,
  updateStrategyRequestSchema,
  updateTaskRequestSchema,
  updateValueDefinitionRequestSchema,
  updateValueVersionRequestSchema,
  type CreateMetricDefinitionRequest,
  type CreateObjectiveRequest,
  type CreateProcessDefinitionRequest,
  type CreateProcessVersionRequest,
  type CreateStrategyRequest,
  type CreateTaskRequest,
  type CreateValueDefinitionRequest,
  type CreateValueVersionRequest,
  type Evidence,
  type MetricDefinition,
  type Objective,
  type ProcessDefinition,
  type ProcessVersion,
  type Strategy,
  type Task,
  type TransitionEvidenceRequest,
  type TransitionMetricDefinitionRequest,
  type TransitionObjectiveRequest,
  type TransitionProcessVersionRequest,
  type TransitionStrategyRequest,
  type TransitionTaskRequest,
  type TransitionValueVersionRequest,
  type UpdateEvidenceRequest,
  type UpdateMetricDefinitionRequest,
  type UpdateObjectiveRequest,
  type UpdateProcessDefinitionRequest,
  type UpdateProcessVersionRequest,
  type UpdateStrategyRequest,
  type UpdateTaskRequest,
  type UpdateValueDefinitionRequest,
  type UpdateValueVersionRequest,
  type ValueDefinition,
  type ValueVersion,
} from '@enterprise/contracts';
import type { ZodType } from 'zod';

import {
  createMetricDefinition,
  createObjective,
  createProcessDefinition,
  createProcessVersion,
  createStrategy,
  createTask,
  createValueDefinition,
  createValueVersion,
  transitionEvidence,
  transitionMetricDefinition,
  transitionObjective,
  transitionProcessVersion,
  transitionStrategy,
  transitionTask,
  transitionValueVersion,
  updateEvidence,
  updateMetricDefinition,
  updateObjective,
  updateProcessDefinition,
  updateProcessVersion,
  updateStrategy,
  updateTask,
  updateValueDefinition,
  updateValueVersion,
} from './api';
import type { ContractJsonEditorConfig } from './ContractJsonEditor';
import type { BusinessResourceKey, BusinessSemanticEntity } from './business-semantics-view';

interface TransitionEditorConfig {
  label: string;
  editor: ContractJsonEditorConfig;
}

export function createEntityEditorConfig(
  resource: BusinessResourceKey,
  currentUserId: string,
): ContractJsonEditorConfig {
  const common = createCommon(currentUserId);
  switch (resource) {
    case 'values':
      return editor<CreateValueDefinitionRequest>({
        title: '新建价值定义',
        description: '先创建稳定身份；行为、约束和指标在价值版本中维护。',
        initialValue: {
          ...common,
          code: 'VALUE.NEW',
          type: 'ENTERPRISE',
          name: '',
          description: null,
        },
        schema: createValueDefinitionRequestSchema,
        submitLabel: '创建 Value',
        submit: createValueDefinition,
      });
    case 'strategies':
      return editor<CreateStrategyRequest>({
        title: '新建战略',
        description: 'valueVersionIds 必须指向已发布且当前有效的价值版本。',
        initialValue: {
          ...common,
          code: 'STRATEGY.NEW',
          name: '',
          description: '',
          valueVersionIds: ['<published-value-version-id>'],
          budget: null,
        },
        schema: createStrategyRequestSchema,
        submitLabel: '创建 Strategy',
        submit: createStrategy,
      });
    case 'objectives':
      return editor<CreateObjectiveRequest>({
        title: '新建目标',
        description: '目标必须同时绑定战略、价值版本、指标口径和责任角色任命。',
        initialValue: {
          ...common,
          code: 'OBJECTIVE.NEW',
          strategyId: '<strategy-id>',
          parentObjectiveId: null,
          name: '',
          description: '',
          bscPerspective: 'CUSTOMER',
          indicatorType: 'LEADING',
          weight: 1,
          valueVersionIds: ['<published-value-version-id>'],
          metricDefinitionIds: ['<active-metric-definition-id>'],
          responsibleRoleAssignmentIds: ['<role-assignment-id>'],
        },
        schema: createObjectiveRequestSchema,
        submitLabel: '创建 Objective',
        submit: createObjective,
      });
    case 'metrics':
      return editor<CreateMetricDefinitionRequest>({
        title: '新建指标口径',
        description: '创建后仍为草稿；生效前可继续校对单位、方向和范围。',
        initialValue: {
          ...common,
          code: 'METRIC.NEW',
          name: '',
          description: '',
          valueType: 'NUMBER',
          unit: 'count',
          aggregation: 'LATEST',
          direction: 'INCREASE',
          bscPerspective: 'CUSTOMER',
          indicatorType: 'LEADING',
          validRange: null,
        },
        schema: createMetricDefinitionRequestSchema,
        submitLabel: '创建 Metric',
        submit: createMetricDefinition,
      });
    case 'processes':
      return editor<CreateProcessDefinitionRequest>({
        title: '新建流程身份',
        description: '流程身份使用稳定 code；可执行节点保存在独立流程版本中。',
        initialValue: {
          ...common,
          code: 'PROCESS.NEW',
          name: '',
          description: '',
        },
        schema: createProcessDefinitionRequestSchema,
        submitLabel: '创建 Process identity',
        submit: createProcessDefinition,
      });
    case 'tasks': {
      const dueAt = new Date(Date.parse(common.effectiveFrom) + 7 * 86_400_000).toISOString();
      return editor<CreateTaskRequest>({
        title: '新建任务',
        description: '任务必须落在目标、价值版本和流程节点的有效期内。',
        initialValue: {
          ...common,
          code: 'TASK.NEW',
          objectiveId: '<objective-id>',
          valueDefinitionId: '<value-definition-id>',
          valueVersionId: '<published-value-version-id>',
          processRef: {
            definitionId: '<process-definition-id>',
            definitionCode: 'PROCESS.NEW',
            versionId: '<published-process-version-id>',
            version: 1,
            nodeId: '<process-node-id>',
            nodeCode: 'ACTIVITY.NEW',
            instanceId: null,
          },
          title: '',
          description: '',
          priority: 'MEDIUM',
          dueAt,
        },
        schema: createTaskRequestSchema,
        submitLabel: '创建 Task',
        submit: createTask,
      });
    }
    case 'evidence':
      throw new Error('Evidence creation must use the guided business dialog.');
  }
}

export function updateEntityEditorConfig(
  resource: BusinessResourceKey,
  entity: BusinessSemanticEntity,
): ContractJsonEditorConfig {
  switch (resource) {
    case 'values': {
      const value = entity as ValueDefinition;
      return editor<UpdateValueDefinitionRequest>({
        title: `编辑 ${value.code}`,
        description: 'expectedRevision 用于阻止覆盖其他管理员的并发修改。',
        initialValue: {
          expectedRevision: value.revision,
          code: value.code,
          type: value.type,
          name: value.name,
          description: value.description,
          owner: value.owner,
          effectiveFrom: value.effectiveFrom,
          effectiveTo: value.effectiveTo,
          permissionLabels: value.permissionLabels,
        },
        schema: updateValueDefinitionRequestSchema,
        submitLabel: '保存 Value',
        submit: (input) => updateValueDefinition(value.id, input),
      });
    }
    case 'strategies': {
      const strategy = entity as Strategy;
      return editor<UpdateStrategyRequest>({
        title: `编辑 ${strategy.code}`,
        description: '状态迁移不在此请求中执行。',
        initialValue: {
          expectedRevision: strategy.revision,
          code: strategy.code,
          name: strategy.name,
          description: strategy.description,
          owner: strategy.owner,
          effectiveFrom: strategy.effectiveFrom,
          effectiveTo: strategy.effectiveTo,
          permissionLabels: strategy.permissionLabels,
          valueVersionIds: strategy.valueVersionIds,
          budget: strategy.budget,
        },
        schema: updateStrategyRequestSchema,
        submitLabel: '保存 Strategy',
        submit: (input) => updateStrategy(strategy.id, input),
      });
    }
    case 'objectives': {
      const objective = entity as Objective;
      return editor<UpdateObjectiveRequest>({
        title: `编辑 ${objective.code}`,
        description: '父目标不能指向自身；目标层级和关联周期由服务端校验。',
        initialValue: {
          expectedRevision: objective.revision,
          code: objective.code,
          strategyId: objective.strategyId,
          parentObjectiveId: objective.parentObjectiveId,
          name: objective.name,
          description: objective.description,
          owner: objective.owner,
          bscPerspective: objective.bscPerspective,
          indicatorType: objective.indicatorType,
          weight: objective.weight,
          effectiveFrom: objective.effectiveFrom,
          effectiveTo: objective.effectiveTo,
          permissionLabels: objective.permissionLabels,
          valueVersionIds: objective.valueVersionIds,
          metricDefinitionIds: objective.metricDefinitionIds,
          responsibleRoleAssignmentIds: objective.responsibleRoleAssignmentIds,
        },
        schema: updateObjectiveRequestSchema,
        submitLabel: '保存 Objective',
        submit: (input) => updateObjective(objective.id, input),
      });
    }
    case 'metrics': {
      const metric = entity as MetricDefinition;
      return editor<UpdateMetricDefinitionRequest>({
        title: `编辑 ${metric.code}`,
        description: 'RANGE 方向必须保留 validRange。',
        initialValue: {
          expectedRevision: metric.revision,
          code: metric.code,
          name: metric.name,
          description: metric.description,
          owner: metric.owner,
          valueType: metric.valueType,
          unit: metric.unit,
          aggregation: metric.aggregation,
          direction: metric.direction,
          bscPerspective: metric.bscPerspective,
          indicatorType: metric.indicatorType,
          validRange: metric.validRange,
          effectiveFrom: metric.effectiveFrom,
          effectiveTo: metric.effectiveTo,
          permissionLabels: metric.permissionLabels,
        },
        schema: updateMetricDefinitionRequestSchema,
        submitLabel: '保存 Metric',
        submit: (input) => updateMetricDefinition(metric.id, input),
      });
    }
    case 'processes': {
      const process = entity as ProcessDefinition;
      return editor<UpdateProcessDefinitionRequest>({
        title: `编辑 ${process.code}`,
        description: '此 DTO 暂时隔离在客户端，待共享 Process contract 收敛后替换。',
        initialValue: {
          expectedRevision: process.revision,
          code: process.code,
          name: process.name,
          description: process.description,
          owner: process.owner,
          permissionLabels: process.permissionLabels,
          effectiveFrom: process.effectiveFrom,
          effectiveTo: process.effectiveTo,
        },
        schema: updateProcessDefinitionRequestSchema,
        submitLabel: '保存 Process identity',
        submit: (input) => updateProcessDefinition(process.id, input),
      });
    }
    case 'tasks': {
      const task = entity as Task;
      return editor<UpdateTaskRequest>({
        title: `编辑 ${task.code}`,
        description: '状态变化须使用独立迁移命令；这里仅更新任务定义。',
        initialValue: {
          expectedRevision: task.revision,
          code: task.code,
          objectiveId: task.objectiveId,
          valueDefinitionId: task.valueDefinitionId,
          valueVersionId: task.valueVersionId,
          processRef: task.processRef,
          title: task.title,
          description: task.description,
          owner: task.owner,
          priority: task.priority,
          effectiveFrom: task.effectiveFrom,
          effectiveTo: task.effectiveTo,
          dueAt: task.dueAt,
          permissionLabels: task.permissionLabels,
        },
        schema: updateTaskRequestSchema,
        submitLabel: '保存 Task',
        submit: (input) => updateTask(task.id, input),
      });
    }
    case 'evidence': {
      const evidence = entity as Evidence;
      return editor<UpdateEvidenceRequest>({
        title: `编辑 ${evidence.code}`,
        description: '来源身份与内容哈希是不可变字段，因此不出现在更新请求中。',
        initialValue: {
          expectedRevision: evidence.revision,
          trustLevel: evidence.trustLevel,
          confidence: evidence.confidence,
          summary: evidence.summary,
          verifiedBy: evidence.verifiedBy,
          verifiedAt: evidence.verifiedAt,
          owner: evidence.owner,
          effectiveFrom: evidence.effectiveFrom,
          effectiveTo: evidence.effectiveTo,
          permissionLabels: evidence.permissionLabels,
        },
        schema: updateEvidenceRequestSchema,
        submitLabel: '保存 Evidence',
        submit: (input) => updateEvidence(evidence.id, input),
      });
    }
  }
}

export function transitionEntityEditorConfig(
  resource: BusinessResourceKey,
  entity: BusinessSemanticEntity,
): TransitionEditorConfig | null {
  const effectiveAt = new Date().toISOString();
  if (resource === 'strategies') {
    const strategy = entity as Strategy;
    const next =
      strategy.status === 'DRAFT'
        ? { action: 'ACTIVATE' as const, label: '生效战略' }
        : strategy.status === 'ACTIVE'
          ? { action: 'CLOSE' as const, label: '关闭战略' }
          : null;
    if (!next) return null;
    return {
      label: next.label,
      editor: editor<TransitionStrategyRequest>({
        title: next.label,
        description: '状态迁移会保留原因和生效时间，成功后以服务端返回状态为准。',
        initialValue: {
          expectedRevision: strategy.revision,
          action: next.action,
          reason: '',
          effectiveAt,
        },
        schema: transitionStrategyRequestSchema,
        submitLabel: next.label,
        submit: (input) => transitionStrategy(strategy.id, input),
      }),
    };
  }
  if (resource === 'objectives') {
    const objective = entity as Objective;
    const next =
      objective.status === 'DRAFT'
        ? { action: 'ACTIVATE' as const, label: '生效目标' }
        : objective.status === 'ACTIVE'
          ? { action: 'ACHIEVE' as const, label: '标记达成' }
          : objective.status === 'AT_RISK'
            ? { action: 'RESTORE' as const, label: '恢复目标' }
            : null;
    if (!next) return null;
    return {
      label: next.label,
      editor: editor<TransitionObjectiveRequest>({
        title: next.label,
        description: '目标状态迁移由服务端校验前置条件。',
        initialValue: {
          expectedRevision: objective.revision,
          action: next.action,
          reason: '',
          effectiveAt,
        },
        schema: transitionObjectiveRequestSchema,
        submitLabel: next.label,
        submit: (input) => transitionObjective(objective.id, input),
      }),
    };
  }
  if (resource === 'metrics') {
    const metric = entity as MetricDefinition;
    const next =
      metric.status === 'DRAFT'
        ? { action: 'ACTIVATE' as const, label: '生效指标' }
        : metric.status === 'ACTIVE'
          ? { action: 'RETIRE' as const, label: '停用指标' }
          : null;
    if (!next) return null;
    return {
      label: next.label,
      editor: editor<TransitionMetricDefinitionRequest>({
        title: next.label,
        description: '指标状态迁移成功后才会更新页面状态。',
        initialValue: {
          expectedRevision: metric.revision,
          action: next.action,
          reason: '',
          effectiveAt,
        },
        schema: transitionMetricDefinitionRequestSchema,
        submitLabel: next.label,
        submit: (input) => transitionMetricDefinition(metric.id, input),
      }),
    };
  }
  if (resource === 'tasks') {
    const task = entity as Task;
    const transitions = {
      PLANNED: { action: 'MAKE_READY' as const, label: '设为可开始' },
      READY: { action: 'START' as const, label: '开始任务' },
      IN_PROGRESS: { action: 'DELIVER' as const, label: '标记已交付' },
      BLOCKED: { action: 'UNBLOCK' as const, label: '解除阻塞' },
      DELIVERED: { action: 'ACCEPT' as const, label: '接受任务' },
    };
    const next = transitions[task.status as keyof typeof transitions];
    if (!next) return null;
    return {
      label: next.label,
      editor: editor<TransitionTaskRequest>({
        title: next.label,
        description: '交付和验收状态可能要求已存在对应 Deliverable / Acceptance。',
        initialValue: {
          expectedRevision: task.revision,
          action: next.action,
          reason: '',
          effectiveAt,
        },
        schema: transitionTaskRequestSchema,
        submitLabel: next.label,
        submit: (input) => transitionTask(task.id, input),
      }),
    };
  }
  if (resource === 'evidence') {
    const evidence = entity as Evidence;
    const next =
      evidence.status === 'DRAFT'
        ? { action: 'VERIFY' as const, label: '验证并生效' }
        : evidence.status === 'ACTIVE'
          ? { action: 'REVOKE' as const, label: '撤销证据' }
          : null;
    if (!next) return null;
    return {
      label: next.label,
      editor: editor<TransitionEvidenceRequest>({
        title: next.label,
        description: '验证者身份由服务端根据当前管理员上下文记录。',
        initialValue: {
          expectedRevision: evidence.revision,
          action: next.action,
          reason: '',
          effectiveAt,
        },
        schema: transitionEvidenceRequestSchema,
        submitLabel: next.label,
        submit: (input) => transitionEvidence(evidence.id, input),
      }),
    };
  }
  return null;
}

export function createValueVersionEditorConfig(
  definition: ValueDefinition,
): ContractJsonEditorConfig {
  return editor<CreateValueVersionRequest>({
    title: `创建 ${definition.code} 价值版本`,
    description: '指标权重必须合计为 1，正向与负向行为不能重复。',
    initialValue: {
      valueDefinitionId: definition.id,
      expectedDefinitionRevision: definition.revision,
      statement: '',
      effectiveFrom: definition.effectiveFrom,
      effectiveTo: definition.effectiveTo,
      owner: definition.owner,
      permissionLabels: definition.permissionLabels,
      positiveBehaviors: [''],
      negativeBehaviors: [''],
      metrics: [
        {
          code: 'VALUE.METRIC.NEW',
          metricDefinitionId: '<active-metric-definition-id>',
          name: '',
          weight: 1,
          target: { kind: 'AT_LEAST', value: 0 },
          permissionLabels: [],
        },
      ],
      constraints: [],
      changeSummary: '',
    },
    schema: createValueVersionRequestSchema,
    submitLabel: '创建价值版本草稿',
    submit: (input) => createValueVersion(definition.id, input),
  });
}

export function updateValueVersionEditorConfig(
  definition: ValueDefinition,
  version: ValueVersion,
): ContractJsonEditorConfig {
  return editor<UpdateValueVersionRequest>({
    title: `编辑 ${definition.code} v${version.version}`,
    description: '只有服务端允许修改的版本状态才会接受此请求。',
    initialValue: {
      expectedRevision: version.revision,
      statement: version.statement,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      owner: version.owner,
      permissionLabels: version.permissionLabels,
      positiveBehaviors: version.positiveBehaviors,
      negativeBehaviors: version.negativeBehaviors,
      metrics: version.metrics.map((metric) => ({
        code: metric.code,
        metricDefinitionId: metric.metricDefinitionId,
        name: metric.name,
        weight: metric.weight,
        target: metric.target,
        permissionLabels: metric.permissionLabels,
      })),
      constraints: version.constraints.map((constraint) => ({
        code: constraint.code,
        type: constraint.type,
        severity: constraint.severity,
        statement: constraint.statement,
        requiredEvidenceTypes: constraint.requiredEvidenceTypes,
        permissionLabels: constraint.permissionLabels,
      })),
      changeSummary: version.changeSummary,
    },
    schema: updateValueVersionRequestSchema,
    submitLabel: '保存价值版本',
    submit: (input) => updateValueVersion(definition.id, version.id, input),
  });
}

export function transitionValueVersionEditorConfig(
  definition: ValueDefinition,
  version: ValueVersion,
): TransitionEditorConfig | null {
  const next =
    version.status === 'DRAFT'
      ? { action: 'PUBLISH' as const, label: '发布价值版本' }
      : version.status === 'PUBLISHED'
        ? { action: 'RETIRE' as const, label: '停用价值版本' }
        : null;
  if (!next) return null;
  return {
    label: next.label,
    editor: editor<TransitionValueVersionRequest>({
      title: `${next.label} v${version.version}`,
      description: '服务端会验证指标、约束、有效期和唯一当前发布版本。',
      initialValue: {
        expectedRevision: version.revision,
        action: next.action,
        reason: '',
        effectiveAt: new Date().toISOString(),
      },
      schema: transitionValueVersionRequestSchema,
      submitLabel: next.label,
      submit: (input) => transitionValueVersion(definition.id, version.id, input),
    }),
  };
}

export function createProcessVersionEditorConfig(
  definition: ProcessDefinition,
): ContractJsonEditorConfig {
  return editor<CreateProcessVersionRequest>({
    title: `创建 ${definition.code} 流程版本`,
    description: '每个版本必须至少包含一个 START 和一个 END 节点。',
    initialValue: {
      processDefinitionId: definition.id,
      expectedDefinitionRevision: definition.revision,
      changeSummary: '',
      owner: definition.owner,
      permissionLabels: definition.permissionLabels,
      effectiveFrom: definition.effectiveFrom,
      effectiveTo: definition.effectiveTo,
      nodes: [
        {
          code: 'START.MAIN',
          name: '开始',
          type: 'START',
          ordinal: 0,
          configuration: {},
        },
        {
          code: 'END.MAIN',
          name: '结束',
          type: 'END',
          ordinal: 1,
          configuration: {},
        },
      ],
    },
    schema: createProcessVersionRequestSchema,
    submitLabel: '创建流程版本草稿',
    submit: (input) => createProcessVersion(definition.id, input),
  });
}

export function updateProcessVersionEditorConfig(
  definition: ProcessDefinition,
  version: ProcessVersion,
): ContractJsonEditorConfig {
  return editor<UpdateProcessVersionRequest>({
    title: `编辑 ${definition.code} v${version.version}`,
    description: '已发布版本是否允许修改由服务端状态机决定。',
    initialValue: {
      expectedRevision: version.revision,
      changeSummary: version.changeSummary,
      owner: version.owner,
      permissionLabels: version.permissionLabels,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      nodes: version.nodes.map((node) => ({
        code: node.code,
        name: node.name,
        type: node.type,
        ordinal: node.ordinal,
        configuration: node.configuration,
      })),
    },
    schema: updateProcessVersionRequestSchema,
    submitLabel: '保存流程版本',
    submit: (input) => updateProcessVersion(definition.id, version.id, input),
  });
}

export function transitionProcessVersionEditorConfig(
  definition: ProcessDefinition,
  version: ProcessVersion,
): TransitionEditorConfig | null {
  const next =
    version.status === 'DRAFT'
      ? { action: 'PUBLISH' as const, label: '发布流程版本' }
      : version.status === 'PUBLISHED'
        ? { action: 'RETIRE' as const, label: '停用流程版本' }
        : null;
  if (!next) return null;
  return {
    label: next.label,
    editor: editor<TransitionProcessVersionRequest>({
      title: `${next.label} v${version.version}`,
      description: '发布成功后，任务才可引用该流程版本和节点身份。',
      initialValue: {
        expectedRevision: version.revision,
        action: next.action,
        reason: '',
        effectiveAt: new Date().toISOString(),
      },
      schema: transitionProcessVersionRequestSchema,
      submitLabel: next.label,
      submit: (input) => transitionProcessVersion(definition.id, version.id, input),
    }),
  };
}

function editor<T>(input: {
  title: string;
  description: string;
  initialValue: unknown;
  schema: ZodType<T>;
  submitLabel: string;
  submit: (value: T) => Promise<unknown>;
}): ContractJsonEditorConfig {
  return {
    title: input.title,
    description: input.description,
    initialValue: input.initialValue,
    submitLabel: input.submitLabel,
    parse: (value) => input.schema.parse(value),
    submit: (value) => input.submit(value as T),
  };
}

function createCommon(currentUserId: string): {
  owner: { type: 'USER'; id: string };
  permissionLabels: never[];
  effectiveFrom: string;
  effectiveTo: null;
} {
  return {
    owner: { type: 'USER', id: currentUserId },
    permissionLabels: [],
    effectiveFrom: new Date().toISOString(),
    effectiveTo: null,
  };
}
