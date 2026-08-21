import type {
  ProcessCommand,
  ProcessInstanceStatus,
  ProcessStepCommand,
  ProcessStepStatus,
} from '@enterprise/contracts';

export type ProcessNodeType =
  'START' | 'HUMAN_APPROVAL' | 'AGENT_EXECUTION' | 'CONDITION' | 'TIMER' | 'COMPENSATION' | 'END';

export interface ProcessNodeDefinition {
  readonly id: string;
  readonly code: string;
  readonly type: ProcessNodeType;
  readonly responsibleRoleBlueprintId: string | null;
  readonly slaMinutes: number | null;
  readonly compensationNodeId: string | null;
}

export interface ProcessEdgeDefinition {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly condition: string | null;
  readonly isDefault: boolean;
}

export interface ExecutableProcessDefinition {
  readonly id: string;
  readonly versionId: string;
  readonly version: number;
  readonly nodes: readonly ProcessNodeDefinition[];
  readonly edges: readonly ProcessEdgeDefinition[];
}

export interface ProcessDefinitionValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ProcessCompletionStep {
  readonly id: string;
  readonly nodeType: ProcessNodeType;
  readonly status: StepInstanceStatus;
  readonly requiredForCompletion: boolean;
}

export interface ProcessInstanceTransitionContext {
  readonly reachedEnd: boolean;
  readonly steps: readonly ProcessCompletionStep[];
}

export interface TrustedProcessStepRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly orgUnitStatus: 'ACTIVE' | 'ARCHIVED';
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedProcessStepActor {
  readonly type: 'USER' | 'AGENT' | 'SYSTEM';
  readonly tenantId: string;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly roleAssignment: TrustedProcessStepRoleAssignment | null;
}

export interface ProcessStepTransitionContext {
  readonly tenantId: string;
  readonly nodeType: ProcessNodeType;
  readonly resolvedRoleAssignmentId: string | null;
  readonly resolvedAgentId: string | null;
  readonly actor: TrustedProcessStepActor;
  readonly evidenceSealed: boolean;
  readonly skipAuthorized: boolean;
  readonly now: Date;
}

export type { ProcessInstanceStatus } from '@enterprise/contracts';
export type ProcessInstanceCommand = ProcessCommand['command'];
export type StepInstanceStatus = ProcessStepStatus;
export type StepInstanceCommand = ProcessStepCommand['command'];

const PROCESS_INSTANCE_TRANSITIONS: Readonly<
  Record<ProcessInstanceStatus, Partial<Record<ProcessInstanceCommand, ProcessInstanceStatus>>>
> = {
  PENDING: { START: 'RUNNING', CANCEL: 'CANCELLED' },
  RUNNING: {
    PAUSE: 'PAUSED',
    COMPLETE: 'COMPLETED',
    FAIL: 'FAILED',
    CANCEL: 'CANCELLED',
    BEGIN_COMPENSATION: 'COMPENSATING',
  },
  PAUSED: {
    RESUME: 'RUNNING',
    CANCEL: 'CANCELLED',
    BEGIN_COMPENSATION: 'COMPENSATING',
  },
  COMPLETED: { BEGIN_COMPENSATION: 'COMPENSATING' },
  FAILED: { BEGIN_COMPENSATION: 'COMPENSATING', CANCEL: 'CANCELLED' },
  CANCELLED: { BEGIN_COMPENSATION: 'COMPENSATING' },
  COMPENSATING: {
    COMPLETE_COMPENSATION: 'COMPENSATED',
    FAIL_COMPENSATION: 'COMPENSATION_FAILED',
  },
  COMPENSATED: {},
  COMPENSATION_FAILED: { BEGIN_COMPENSATION: 'COMPENSATING' },
};

const STEP_INSTANCE_TRANSITIONS: Readonly<
  Record<StepInstanceStatus, Partial<Record<StepInstanceCommand, StepInstanceStatus>>>
> = {
  WAITING: { ACTIVATE: 'READY', SKIP: 'SKIPPED', CANCEL: 'CANCELLED' },
  READY: { CLAIM: 'RUNNING', TIMEOUT: 'TIMED_OUT', CANCEL: 'CANCELLED', SKIP: 'SKIPPED' },
  RUNNING: {
    COMPLETE: 'COMPLETED',
    REJECT: 'REJECTED',
    TIMEOUT: 'TIMED_OUT',
    FAIL: 'FAILED',
    CANCEL: 'CANCELLED',
  },
  COMPLETED: { BEGIN_COMPENSATION: 'COMPENSATING' },
  REJECTED: { RETRY: 'READY', CANCEL: 'CANCELLED' },
  TIMED_OUT: {
    RETRY: 'READY',
    CANCEL: 'CANCELLED',
    BEGIN_COMPENSATION: 'COMPENSATING',
  },
  FAILED: {
    RETRY: 'READY',
    CANCEL: 'CANCELLED',
    BEGIN_COMPENSATION: 'COMPENSATING',
  },
  CANCELLED: { BEGIN_COMPENSATION: 'COMPENSATING' },
  COMPENSATING: {
    COMPLETE_COMPENSATION: 'COMPENSATED',
    FAIL_COMPENSATION: 'COMPENSATION_FAILED',
  },
  COMPENSATED: {},
  COMPENSATION_FAILED: { BEGIN_COMPENSATION: 'COMPENSATING' },
  SKIPPED: {},
};

export class InvalidProcessTransitionError extends Error {
  constructor(
    readonly currentStatus: ProcessInstanceStatus | StepInstanceStatus,
    readonly command: ProcessInstanceCommand | StepInstanceCommand,
  ) {
    super(`Command ${command} is not valid from ${currentStatus}.`);
    this.name = 'InvalidProcessTransitionError';
  }
}

export function transitionProcessInstance(
  currentStatus: ProcessInstanceStatus,
  command: ProcessInstanceCommand,
  context?: ProcessInstanceTransitionContext,
): ProcessInstanceStatus {
  if (command === 'COMPLETE' && !processCompletionReady(context)) {
    throw new InvalidProcessTransitionError(currentStatus, command);
  }
  const next = PROCESS_INSTANCE_TRANSITIONS[currentStatus][command];
  if (next === undefined) throw new InvalidProcessTransitionError(currentStatus, command);
  return next;
}

export function transitionStepInstance(
  currentStatus: StepInstanceStatus,
  command: StepInstanceCommand,
  context: ProcessStepTransitionContext,
): StepInstanceStatus {
  if (!stepCommandAuthorized(command, context)) {
    throw new InvalidProcessTransitionError(currentStatus, command);
  }
  const next = STEP_INSTANCE_TRANSITIONS[currentStatus][command];
  if (next === undefined) throw new InvalidProcessTransitionError(currentStatus, command);
  return next;
}

export function nextProcessStepAttempt(
  currentAttempt: number,
  command: StepInstanceCommand,
): number {
  if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 1 || currentAttempt > 100) {
    throw new RangeError('A Process Step attempt must be an integer from 1 through 100.');
  }
  if (command !== 'RETRY') return currentAttempt;
  if (currentAttempt === 100) {
    throw new RangeError('A Process Step cannot exceed 100 attempts.');
  }
  return currentAttempt + 1;
}

function processCompletionReady(context: ProcessInstanceTransitionContext | undefined): boolean {
  return (
    context !== undefined &&
    context.reachedEnd &&
    context.steps.length > 0 &&
    context.steps.every(
      (step) =>
        !step.requiredForCompletion ||
        step.status === 'COMPLETED' ||
        (step.nodeType !== 'HUMAN_APPROVAL' &&
          step.nodeType !== 'AGENT_EXECUTION' &&
          step.status === 'SKIPPED'),
    )
  );
}

function stepCommandAuthorized(
  command: StepInstanceCommand,
  context: ProcessStepTransitionContext,
): boolean {
  if (!Number.isFinite(context.now.getTime()) || context.actor.tenantId !== context.tenantId) {
    return false;
  }
  if (command === 'SKIP') {
    return (
      context.actor.type === 'SYSTEM' &&
      context.skipAuthorized &&
      context.nodeType !== 'HUMAN_APPROVAL' &&
      context.nodeType !== 'AGENT_EXECUTION'
    );
  }
  if (
    [
      'ACTIVATE',
      'TIMEOUT',
      'RETRY',
      'CANCEL',
      'BEGIN_COMPENSATION',
      'COMPLETE_COMPENSATION',
      'FAIL_COMPENSATION',
    ].includes(command)
  ) {
    return context.actor.type === 'SYSTEM';
  }
  if (
    context.nodeType !== 'HUMAN_APPROVAL' &&
    context.nodeType !== 'AGENT_EXECUTION' &&
    ['CLAIM', 'COMPLETE', 'FAIL'].includes(command)
  ) {
    return context.actor.type === 'SYSTEM';
  }

  if (!actorMatchesResolvedIdentity(context)) return false;
  if (context.nodeType === 'HUMAN_APPROVAL') {
    return (
      context.actor.type === 'USER' &&
      (command === 'CLAIM' ||
        ((command === 'COMPLETE' || command === 'REJECT') && context.evidenceSealed))
    );
  }
  if (context.nodeType === 'AGENT_EXECUTION') {
    return (
      context.actor.type === 'AGENT' &&
      (command === 'CLAIM' || command === 'COMPLETE' || command === 'FAIL')
    );
  }
  return false;
}

function actorMatchesResolvedIdentity(context: ProcessStepTransitionContext): boolean {
  const actor = context.actor;
  const assignment = actor.roleAssignment;
  if (
    assignment === null ||
    assignment.tenantId !== context.tenantId ||
    assignment.id !== context.resolvedRoleAssignmentId ||
    !usableProcessAssignment(assignment, context.now)
  ) {
    return false;
  }
  if (actor.type === 'USER') {
    return actor.userId !== null && actor.userId === assignment.userId;
  }
  if (actor.type === 'AGENT') {
    return (
      actor.agentId !== null &&
      actor.agentId === assignment.agentId &&
      actor.agentId === context.resolvedAgentId
    );
  }
  return false;
}

function usableProcessAssignment(assignment: TrustedProcessStepRoleAssignment, now: Date): boolean {
  const start = processTime(assignment.effectiveFrom);
  const end = processTime(assignment.effectiveTo);
  return (
    assignment.status === 'ACTIVE' &&
    assignment.employmentStatus === 'ACTIVE' &&
    assignment.orgUnitStatus === 'ACTIVE' &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    start !== null &&
    start <= now.getTime() &&
    (assignment.effectiveTo === null || (end !== null && end > now.getTime()))
  );
}

function processTime(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateExecutableProcessDefinition(
  definition: ExecutableProcessDefinition,
): ProcessDefinitionValidation {
  const errors: string[] = [];
  if (!Number.isInteger(definition.version) || definition.version <= 0) {
    errors.push('Process version must be a positive integer.');
  }
  if (definition.nodes.length === 0) errors.push('A process must contain nodes.');

  const nodeIds = definition.nodes.map((node) => node.id);
  const nodeCodes = definition.nodes.map((node) => node.code);
  const edgeIds = definition.edges.map((edge) => edge.id);
  if (!allUnique(nodeIds)) errors.push('Process node IDs must be unique.');
  if (!allUnique(nodeCodes)) errors.push('Process node codes must be unique.');
  if (!allUnique(edgeIds)) errors.push('Process edge IDs must be unique.');

  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const starts = definition.nodes.filter((node) => node.type === 'START');
  const ends = definition.nodes.filter((node) => node.type === 'END');
  if (starts.length !== 1) errors.push('A process must contain exactly one START node.');
  if (ends.length === 0) errors.push('A process must contain at least one END node.');

  for (const node of definition.nodes) {
    if (!/^[A-Z0-9]+(?:[._:-][A-Z0-9]+)*$/.test(node.code)) {
      errors.push(`Process node ${node.id} has an invalid code.`);
    }
    if (
      (node.type === 'HUMAN_APPROVAL' || node.type === 'AGENT_EXECUTION') &&
      node.responsibleRoleBlueprintId === null
    ) {
      errors.push(`Executable node ${node.id} must bind a responsible Role Blueprint.`);
    }
    if (
      node.type !== 'HUMAN_APPROVAL' &&
      node.type !== 'AGENT_EXECUTION' &&
      node.responsibleRoleBlueprintId !== null
    ) {
      errors.push(`Non-executable node ${node.id} cannot bind a responsible Role Blueprint.`);
    }
    if (node.slaMinutes !== null && (!Number.isInteger(node.slaMinutes) || node.slaMinutes <= 0)) {
      errors.push(`Process node ${node.id} has an invalid SLA.`);
    }
    if (node.compensationNodeId !== null) {
      const compensation = nodeById.get(node.compensationNodeId);
      if (compensation === undefined || compensation.type !== 'COMPENSATION') {
        errors.push(`Process node ${node.id} references an invalid compensation node.`);
      }
    }
  }

  for (const edge of definition.edges) {
    if (!nodeById.has(edge.sourceNodeId) || !nodeById.has(edge.targetNodeId)) {
      errors.push(`Process edge ${edge.id} references a missing node.`);
    }
    if (edge.sourceNodeId === edge.targetNodeId) {
      errors.push(`Process edge ${edge.id} cannot point to the same node.`);
    }
    if (edge.isDefault && edge.condition !== null) {
      errors.push(`Default process edge ${edge.id} cannot also declare a condition.`);
    }
    if (!edge.isDefault && edge.condition !== null && edge.condition.trim().length === 0) {
      errors.push(`Conditional process edge ${edge.id} has an empty condition.`);
    }
  }

  if (starts.length === 1) {
    const incomingToStart = definition.edges.some((edge) => edge.targetNodeId === starts[0]?.id);
    if (incomingToStart) errors.push('The START node cannot have incoming edges.');
  }
  for (const end of ends) {
    if (definition.edges.some((edge) => edge.sourceNodeId === end.id)) {
      errors.push(`END node ${end.id} cannot have outgoing edges.`);
    }
  }

  for (const node of definition.nodes) {
    if (node.type === 'END' || node.type === 'COMPENSATION') continue;
    const outgoing = definition.edges.filter((edge) => edge.sourceNodeId === node.id);
    if (node.type === 'CONDITION') {
      const defaults = outgoing.filter((edge) => edge.isDefault);
      const conditional = outgoing.filter((edge) => !edge.isDefault && edge.condition !== null);
      if (outgoing.length < 2 || defaults.length !== 1 || conditional.length < 1) {
        errors.push(
          `CONDITION node ${node.id} needs conditional branches and exactly one default edge.`,
        );
      }
      if (!allUnique(conditional.map((edge) => edge.condition!))) {
        errors.push(`CONDITION node ${node.id} has duplicate conditions.`);
      }
    } else if (outgoing.length !== 1) {
      errors.push(`Process node ${node.id} must have exactly one outgoing edge.`);
    }
  }

  const normalEdges = definition.edges.filter(
    (edge) =>
      nodeById.get(edge.sourceNodeId)?.type !== 'COMPENSATION' &&
      nodeById.get(edge.targetNodeId)?.type !== 'COMPENSATION',
  );
  if (hasDirectedCycle(normalEdges))
    errors.push('The first process version cannot contain cycles.');
  if (starts.length === 1) {
    const reachable = reachableNodeIds(starts[0]!.id, normalEdges);
    for (const node of definition.nodes) {
      if (node.type !== 'COMPENSATION' && !reachable.has(node.id)) {
        errors.push(`Process node ${node.id} is unreachable from START.`);
      }
    }
  }
  const endIds = new Set(ends.map((node) => node.id));
  for (const node of definition.nodes) {
    if (node.type === 'COMPENSATION') continue;
    const reachable = reachableNodeIds(node.id, normalEdges);
    if (![...endIds].some((endId) => reachable.has(endId))) {
      errors.push(`Process node ${node.id} cannot reach an END node.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function resolveConditionEdge(
  definition: ExecutableProcessDefinition,
  nodeId: string,
  matchedCondition: string | null,
): ProcessEdgeDefinition {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== 'CONDITION') {
    throw new Error('Condition routing requires a CONDITION node.');
  }
  const outgoing = definition.edges.filter((edge) => edge.sourceNodeId === nodeId);
  const selected =
    matchedCondition === null
      ? outgoing.find((edge) => edge.isDefault)
      : outgoing.find((edge) => !edge.isDefault && edge.condition === matchedCondition);
  if (selected === undefined) {
    throw new Error('No deterministic process edge matches the condition result.');
  }
  return selected;
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function reachableNodeIds(
  startNodeId: string,
  edges: readonly ProcessEdgeDefinition[],
): ReadonlySet<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const reached = new Set<string>();
  const pending = [startNodeId];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || reached.has(node)) continue;
    reached.add(node);
    pending.push(...(outgoing.get(node) ?? []));
  }
  return reached;
}

function hasDirectedCycle(edges: readonly ProcessEdgeDefinition[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      if (visit(targetId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return [...outgoing.keys()].some(visit);
}
