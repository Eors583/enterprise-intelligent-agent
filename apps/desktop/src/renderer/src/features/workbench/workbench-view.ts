import type {
  Acceptance,
  BusinessSemanticTraceResponse,
  Deliverable,
  Evidence,
  EvidenceLink,
  Objective,
  Task,
  TaskDependency,
} from '@enterprise/contracts';

export interface ObjectiveTreeNode {
  objective: Objective;
  children: ObjectiveTreeNode[];
  cycle: boolean;
  orphan: boolean;
}

export function buildObjectiveForest(objectives: readonly Objective[]): ObjectiveTreeNode[] {
  const byId = new Map(objectives.map((objective) => [objective.id, objective]));
  const childrenByParent = new Map<string, Objective[]>();
  for (const objective of objectives) {
    if (objective.parentObjectiveId === null || !byId.has(objective.parentObjectiveId)) continue;
    const children = childrenByParent.get(objective.parentObjectiveId) ?? [];
    children.push(objective);
    childrenByParent.set(objective.parentObjectiveId, children);
  }
  const included = new Set<string>();
  const build = (
    objective: Objective,
    path: ReadonlySet<string>,
    orphan: boolean,
  ): ObjectiveTreeNode => {
    if (path.has(objective.id)) {
      included.add(objective.id);
      return { objective, children: [], cycle: true, orphan };
    }
    included.add(objective.id);
    const nextPath = new Set(path);
    nextPath.add(objective.id);
    return {
      objective,
      children: [...(childrenByParent.get(objective.id) ?? [])]
        .sort(compareObjectives)
        .map((child) => build(child, nextPath, false)),
      cycle: false,
      orphan,
    };
  };

  const naturalRoots = objectives
    .filter((objective) => objective.parentObjectiveId === null)
    .sort(compareObjectives)
    .map((objective) => build(objective, new Set(), false));
  const orphanRoots = objectives
    .filter(
      (objective) => objective.parentObjectiveId !== null && !byId.has(objective.parentObjectiveId),
    )
    .sort(compareObjectives)
    .map((objective) => build(objective, new Set(), true));
  const roots = [...naturalRoots, ...orphanRoots];
  for (const objective of [...objectives].sort(compareObjectives)) {
    if (!included.has(objective.id)) roots.push(build(objective, new Set(), true));
  }
  return roots;
}

function compareObjectives(left: Objective, right: Objective): number {
  return left.name.localeCompare(right.name, 'zh-CN') || left.code.localeCompare(right.code);
}

export function objectiveStatusLabel(status: Objective['status']): string {
  return (
    {
      DRAFT: '草稿',
      ACTIVE: '进行中',
      AT_RISK: '有风险',
      ACHIEVED: '已达成',
      CANCELLED: '已取消',
    }[status] ?? status
  );
}

export function taskStatusLabel(status: Task['status']): string {
  return (
    {
      PLANNED: '已规划',
      READY: '可开始',
      IN_PROGRESS: '进行中',
      BLOCKED: '受阻',
      DELIVERED: '已交付',
      ACCEPTED: '已验收',
      REJECTED: '已拒绝',
      CANCELLED: '已取消',
    }[status] ?? status
  );
}

export function taskPriorityLabel(priority: Task['priority']): string {
  return (
    {
      LOW: '低',
      MEDIUM: '中',
      HIGH: '高',
      CRITICAL: '紧急',
    }[priority] ?? priority
  );
}

export function formatWorkbenchDate(value: string): string {
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

export function shortBusinessId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export interface RootTaskTrace {
  rootTask: Task;
  dependencies: TaskDependency[];
  deliverables: Deliverable[];
  acceptances: Acceptance[];
  evidence: Evidence[];
  evidenceLinks: EvidenceLink[];
}

export function rootTaskTrace(trace: BusinessSemanticTraceResponse): RootTaskTrace {
  const rootTask = trace.tasks.find((task) => task.id === trace.rootTaskId);
  if (!rootTask) {
    throw new Error('Trace root task is missing.');
  }
  const dependencies = trace.taskDependencies.filter(
    (dependency) =>
      dependency.predecessorTaskId === rootTask.id || dependency.successorTaskId === rootTask.id,
  );
  const deliverables = trace.deliverables.filter(
    (deliverable) => deliverable.taskId === rootTask.id,
  );
  const deliverableIds = new Set(deliverables.map((deliverable) => deliverable.id));
  const acceptances = trace.acceptances.filter((acceptance) =>
    deliverableIds.has(acceptance.deliverableId),
  );
  const acceptanceIds = new Set(acceptances.map((acceptance) => acceptance.id));
  const evidenceLinks = trace.evidenceLinks.filter(
    (link) =>
      (link.targetType === 'TASK' && link.targetId === rootTask.id) ||
      (link.targetType === 'DELIVERABLE' && deliverableIds.has(link.targetId)) ||
      (link.targetType === 'ACCEPTANCE' && acceptanceIds.has(link.targetId)),
  );
  const evidenceIds = new Set([
    ...acceptances.flatMap((acceptance) => acceptance.evidenceIds),
    ...evidenceLinks.map((link) => link.evidenceId),
  ]);
  const evidence = trace.evidence.filter((item) => evidenceIds.has(item.id));
  return { rootTask, dependencies, deliverables, acceptances, evidence, evidenceLinks };
}

export interface TraceStep {
  key: string;
  label: string;
  title: string;
  code: string;
  meta: string;
}

export function businessTraceSteps(trace: BusinessSemanticTraceResponse): TraceStep[] {
  const root = rootTaskTrace(trace);
  const objective = trace.objectives.find((item) => item.id === root.rootTask.objectiveId);
  const strategy = objective
    ? trace.strategies.find((item) => item.id === objective.strategyId)
    : undefined;
  const valueDefinition = trace.valueDefinitions.find(
    (item) => item.id === root.rootTask.valueDefinitionId,
  );
  const valueVersion = trace.valueVersions.find((item) => item.id === root.rootTask.valueVersionId);
  const metrics = objective
    ? trace.metricDefinitions.filter((item) => objective.metricDefinitionIds.includes(item.id))
    : [];
  const processDefinition = trace.processDefinitions.find(
    (item) => item.id === root.rootTask.processRef.definitionId,
  );
  const processVersion = trace.processVersions.find(
    (item) => item.id === root.rootTask.processRef.versionId,
  );
  return [
    {
      key: 'value',
      label: 'Value',
      title: valueDefinition?.name ?? '价值定义缺失',
      code: valueDefinition?.code ?? shortBusinessId(root.rootTask.valueDefinitionId),
      meta: valueVersion ? `v${valueVersion.version} · ${valueVersion.status}` : '版本缺失',
    },
    {
      key: 'strategy',
      label: 'Strategy',
      title: strategy?.name ?? '战略缺失',
      code: strategy?.code ?? '—',
      meta: strategy?.status ?? 'MISSING',
    },
    {
      key: 'objective',
      label: 'Objective',
      title: objective?.name ?? '目标缺失',
      code: objective?.code ?? shortBusinessId(root.rootTask.objectiveId),
      meta: objective
        ? `${objective.bscPerspective} · ${objectiveStatusLabel(objective.status)}`
        : 'MISSING',
    },
    {
      key: 'metric',
      label: 'Metric',
      title: metrics.length > 0 ? metrics.map((metric) => metric.name).join('、') : '未返回指标',
      code: metrics.length > 0 ? metrics.map((metric) => metric.code).join(' / ') : '—',
      meta: `${metrics.length} 个口径`,
    },
    {
      key: 'process',
      label: 'Process',
      title: processDefinition?.name ?? root.rootTask.processRef.definitionCode,
      code: root.rootTask.processRef.nodeCode,
      meta: processVersion
        ? `v${processVersion.version} · ${processVersion.status}`
        : `v${root.rootTask.processRef.version}`,
    },
    {
      key: 'task',
      label: 'Task',
      title: root.rootTask.title,
      code: root.rootTask.code,
      meta: taskStatusLabel(root.rootTask.status),
    },
    {
      key: 'evidence',
      label: 'Evidence',
      title: `${root.deliverables.length} 交付物 · ${root.acceptances.length} 验收`,
      code: `${root.evidence.length} 条证据`,
      meta: `${root.evidenceLinks.length} 个链接`,
    },
  ];
}
