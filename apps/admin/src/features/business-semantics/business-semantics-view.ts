import type {
  Evidence,
  MetricDefinition,
  Objective,
  ProcessDefinition,
  Strategy,
  Task,
  ValueDefinition,
} from '@enterprise/contracts';

export type BusinessResourceKey =
  'values' | 'strategies' | 'objectives' | 'metrics' | 'processes' | 'tasks' | 'evidence';

export type BusinessSemanticEntity =
  ValueDefinition | Strategy | Objective | MetricDefinition | ProcessDefinition | Task | Evidence;

export interface BusinessResourceDefinition {
  key: BusinessResourceKey;
  label: string;
  singular: string;
  description: string;
  mark: string;
}

export const BUSINESS_RESOURCES: readonly BusinessResourceDefinition[] = [
  {
    key: 'values',
    label: '价值',
    singular: 'Value',
    description: '定义价值、行为、约束及可发布版本',
    mark: '值',
  },
  {
    key: 'strategies',
    label: '战略',
    singular: 'Strategy',
    description: '把已发布价值版本落实为战略选择',
    mark: '略',
  },
  {
    key: 'objectives',
    label: '目标',
    singular: 'Objective',
    description: '建立 BSC 目标树和因果关系',
    mark: '目',
  },
  {
    key: 'metrics',
    label: '指标',
    singular: 'Metric',
    description: '治理口径、方向、聚合和有效范围',
    mark: '标',
  },
  {
    key: 'processes',
    label: '流程身份',
    singular: 'Process identity',
    description: '维护稳定流程身份及节点版本',
    mark: '流',
  },
  {
    key: 'tasks',
    label: '任务',
    singular: 'Task',
    description: '关联目标、价值版本、流程节点与依赖',
    mark: '任',
  },
  {
    key: 'evidence',
    label: '证据',
    singular: 'Evidence',
    description: '登记来源、可信度、验真及语义链接',
    mark: '证',
  },
] as const;

export function resourceDefinition(key: BusinessResourceKey): BusinessResourceDefinition {
  return BUSINESS_RESOURCES.find((resource) => resource.key === key)!;
}

export function entityTitle(entity: BusinessSemanticEntity): string {
  const record = entity as BusinessSemanticEntity & {
    title?: string;
    name?: string;
    summary?: string;
  };
  return record.title ?? record.name ?? record.summary ?? record.code;
}

export function entityDescription(entity: BusinessSemanticEntity): string {
  if ('description' in entity) return entity.description ?? '未填写说明。';
  if ('summary' in entity) return entity.summary;
  return '未填写说明。';
}

export function entityStatus(
  resource: BusinessResourceKey,
  entity: BusinessSemanticEntity,
): string {
  if ('status' in entity) return entity.status;
  return resource === 'values' && 'currentVersionId' in entity
    ? entity.currentVersionId === null
      ? 'NO_PUBLISHED_VERSION'
      : 'VERSIONED'
    : 'UNKNOWN';
}

export function semanticStatusLabel(status: string): string {
  return (
    {
      DRAFT: '草稿',
      PUBLISHED: '已发布',
      ACTIVE: '生效中',
      RETIRED: '已停用',
      CLOSED: '已关闭',
      CANCELLED: '已取消',
      AT_RISK: '有风险',
      ACHIEVED: '已达成',
      PLANNED: '已规划',
      READY: '可开始',
      IN_PROGRESS: '进行中',
      BLOCKED: '受阻',
      DELIVERED: '已交付',
      ACCEPTED: '已验收',
      REJECTED: '已拒绝',
      REVOKED: '已撤销',
      VERIFIED: '已验证',
      UNVERIFIED: '未验证',
      VERSIONED: '已有发布版本',
      NO_PUBLISHED_VERSION: '尚未发布',
    }[status] ?? status
  );
}

export function ownerLabel(entity: BusinessSemanticEntity): string {
  return `${ownerTypeLabel(entity.owner.type)} · ${shortId(entity.owner.id)}`;
}

export function ownerTypeLabel(type: string): string {
  return (
    {
      USER: '成员',
      ROLE_ASSIGNMENT: '角色任命',
      ROLE_BLUEPRINT: '角色蓝图',
      ORG_UNIT: '组织单元',
    }[type] ?? type
  );
}

export function formatEffectivePeriod(entity: {
  effectiveFrom: string;
  effectiveTo: string | null;
}): string {
  return `${formatDate(entity.effectiveFrom)} → ${
    entity.effectiveTo === null ? '长期有效' : formatDate(entity.effectiveTo)
  }`;
}

export function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export interface AssociationCheck {
  label: string;
  detail: string;
  valid: boolean;
}

export function associationChecks(
  resource: BusinessResourceKey,
  entity: BusinessSemanticEntity,
): AssociationCheck[] {
  switch (resource) {
    case 'values':
      return [
        {
          label: '发布版本',
          detail:
            'currentVersionId' in entity && entity.currentVersionId
              ? shortId(entity.currentVersionId)
              : '尚未绑定已发布版本',
          valid: 'currentVersionId' in entity && entity.currentVersionId !== null,
        },
      ];
    case 'strategies': {
      const strategy = entity as Strategy;
      return [
        {
          label: '价值版本',
          detail: `${strategy.valueVersionIds.length} 个引用`,
          valid: strategy.valueVersionIds.length > 0,
        },
      ];
    }
    case 'objectives': {
      const objective = entity as Objective;
      return [
        { label: '所属战略', detail: shortId(objective.strategyId), valid: true },
        {
          label: '价值版本',
          detail: `${objective.valueVersionIds.length} 个引用`,
          valid: objective.valueVersionIds.length > 0,
        },
        {
          label: '指标口径',
          detail: `${objective.metricDefinitionIds.length} 个引用`,
          valid: objective.metricDefinitionIds.length > 0,
        },
        {
          label: '责任角色',
          detail: `${objective.responsibleRoleAssignmentIds.length} 个引用`,
          valid: objective.responsibleRoleAssignmentIds.length > 0,
        },
      ];
    }
    case 'metrics': {
      const metric = entity as MetricDefinition;
      return [
        {
          label: '范围约束',
          detail: metric.validRange
            ? `${metric.validRange.minimum} – ${metric.validRange.maximum}`
            : '未设置数值范围',
          valid: metric.direction !== 'RANGE' || metric.validRange !== null,
        },
      ];
    }
    case 'processes': {
      const process = entity as ProcessDefinition;
      return [
        {
          label: '发布版本',
          detail: process.currentVersionId ? shortId(process.currentVersionId) : '尚未发布流程版本',
          valid: process.currentVersionId !== null,
        },
      ];
    }
    case 'tasks': {
      const task = entity as Task;
      return [
        { label: '所属目标', detail: shortId(task.objectiveId), valid: true },
        { label: '价值定义', detail: shortId(task.valueDefinitionId), valid: true },
        { label: '价值版本', detail: shortId(task.valueVersionId), valid: true },
        {
          label: '流程节点',
          detail: `${task.processRef.definitionCode} / ${task.processRef.nodeCode} · v${task.processRef.version}`,
          valid: true,
        },
      ];
    }
    case 'evidence': {
      const evidence = entity as Evidence;
      return [
        {
          label: '来源身份',
          detail: `${evidence.sourceSystem} / ${evidence.sourceRecordId}`,
          valid: true,
        },
        {
          label: '内容完整性',
          detail: `${evidence.contentHashAlgorithm} · ${shortId(evidence.contentHash)}`,
          valid: evidence.contentHash.length === 64,
        },
        {
          label: '验证身份',
          detail: evidence.verifiedBy ? ownerTypeLabel(evidence.verifiedBy.type) : '尚未验证',
          valid: evidence.trustLevel !== 'VERIFIED' || evidence.verifiedBy !== null,
        },
      ];
    }
  }
}
