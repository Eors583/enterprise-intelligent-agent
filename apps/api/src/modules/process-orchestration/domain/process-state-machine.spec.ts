import { describe, expect, it } from 'vitest';

import {
  InvalidProcessTransitionError,
  nextProcessStepAttempt,
  resolveConditionEdge,
  transitionProcessInstance,
  transitionStepInstance,
  validateExecutableProcessDefinition,
  type ExecutableProcessDefinition,
} from './process-state-machine.js';

describe('process instance state machine', () => {
  it('supports start, pause, resume, completion, and compensation', () => {
    expect(transitionProcessInstance('PENDING', 'START')).toBe('RUNNING');
    expect(transitionProcessInstance('RUNNING', 'PAUSE')).toBe('PAUSED');
    expect(transitionProcessInstance('PAUSED', 'RESUME')).toBe('RUNNING');
    expect(
      transitionProcessInstance('RUNNING', 'COMPLETE', {
        reachedEnd: true,
        steps: [
          {
            id: 'approval-step',
            nodeType: 'HUMAN_APPROVAL',
            status: 'COMPLETED',
            requiredForCompletion: true,
          },
        ],
      }),
    ).toBe('COMPLETED');
    expect(transitionProcessInstance('COMPLETED', 'BEGIN_COMPENSATION')).toBe('COMPENSATING');
    expect(transitionProcessInstance('COMPENSATING', 'COMPLETE_COMPENSATION')).toBe('COMPENSATED');
  });

  it('rejects an illegal or repeated terminal transition', () => {
    expect(() => transitionProcessInstance('PENDING', 'COMPLETE')).toThrow(
      InvalidProcessTransitionError,
    );
    expect(() => transitionProcessInstance('COMPLETED', 'COMPLETE')).toThrow(
      InvalidProcessTransitionError,
    );
  });

  it('cannot complete while a required approval is missing or END was not reached', () => {
    expect(() =>
      transitionProcessInstance('RUNNING', 'COMPLETE', {
        reachedEnd: true,
        steps: [
          {
            id: 'approval-step',
            nodeType: 'HUMAN_APPROVAL',
            status: 'READY',
            requiredForCompletion: true,
          },
        ],
      }),
    ).toThrow(InvalidProcessTransitionError);
    expect(() =>
      transitionProcessInstance('RUNNING', 'COMPLETE', {
        reachedEnd: false,
        steps: [
          {
            id: 'approval-step',
            nodeType: 'HUMAN_APPROVAL',
            status: 'COMPLETED',
            requiredForCompletion: true,
          },
        ],
      }),
    ).toThrow(InvalidProcessTransitionError);
  });
});

describe('step instance state machine', () => {
  it('supports activation, execution, rejection, retry, timeout, and compensation', () => {
    expect(transitionStepInstance('WAITING', 'ACTIVATE', systemStepContext())).toBe('READY');
    expect(transitionStepInstance('READY', 'CLAIM', humanStepContext())).toBe('RUNNING');
    expect(transitionStepInstance('RUNNING', 'REJECT', humanStepContext())).toBe('REJECTED');
    expect(transitionStepInstance('REJECTED', 'RETRY', systemStepContext())).toBe('READY');
    expect(transitionStepInstance('READY', 'TIMEOUT', systemStepContext())).toBe('TIMED_OUT');
    expect(transitionStepInstance('TIMED_OUT', 'BEGIN_COMPENSATION', systemStepContext())).toBe(
      'COMPENSATING',
    );
    expect(transitionStepInstance('COMPENSATING', 'FAIL_COMPENSATION', systemStepContext())).toBe(
      'COMPENSATION_FAILED',
    );
  });

  it('increments attempt identity only for a bounded RETRY', () => {
    expect(nextProcessStepAttempt(1, 'RETRY')).toBe(2);
    expect(nextProcessStepAttempt(99, 'RETRY')).toBe(100);
    expect(nextProcessStepAttempt(7, 'CLAIM')).toBe(7);
    expect(() => nextProcessStepAttempt(100, 'RETRY')).toThrow(RangeError);
    expect(() => nextProcessStepAttempt(0, 'ACTIVATE')).toThrow(RangeError);
  });

  it('does not let a completed compensation execute twice', () => {
    expect(() =>
      transitionStepInstance('COMPENSATED', 'COMPLETE_COMPENSATION', systemStepContext()),
    ).toThrow(InvalidProcessTransitionError);
  });

  it('does not let an Agent, an expired assignment, or SKIP bypass human approval', () => {
    expect(() =>
      transitionStepInstance('READY', 'CLAIM', {
        ...humanStepContext(),
        actor: {
          ...humanStepContext().actor,
          type: 'AGENT',
          userId: null,
          agentId: 'agent-reviewer',
        },
      }),
    ).toThrow(InvalidProcessTransitionError);
    expect(() =>
      transitionStepInstance('RUNNING', 'COMPLETE', {
        ...humanStepContext(),
        actor: {
          ...humanStepContext().actor,
          roleAssignment: {
            ...humanStepContext().actor.roleAssignment!,
            status: 'EXPIRED',
          },
        },
      }),
    ).toThrow(InvalidProcessTransitionError);
    expect(() =>
      transitionStepInstance('READY', 'SKIP', {
        ...systemStepContext(),
        skipAuthorized: true,
      }),
    ).toThrow(InvalidProcessTransitionError);
    expect(() =>
      transitionStepInstance('RUNNING', 'COMPLETE', {
        ...humanStepContext(),
        evidenceSealed: false,
      }),
    ).toThrow(InvalidProcessTransitionError);
  });
});

describe('validateExecutableProcessDefinition', () => {
  it('accepts a deterministic role-routed serial and conditional process', () => {
    expect(validateExecutableProcessDefinition(validDefinition())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects employee-less executable nodes, invalid compensation, and malformed conditions', () => {
    const base = validDefinition();
    const invalid: ExecutableProcessDefinition = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.code === 'REVIEW'
          ? { ...node, responsibleRoleBlueprintId: null, compensationNodeId: 'missing' }
          : node,
      ),
      edges: base.edges.filter((edge) => !edge.isDefault),
    };

    const result = validateExecutableProcessDefinition(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must bind a responsible Role Blueprint'),
        expect.stringContaining('invalid compensation node'),
        expect.stringContaining('exactly one default edge'),
      ]),
    );
  });

  it('rejects cycles, unreachable nodes, incoming START edges, and outgoing END edges', () => {
    const base = validDefinition();
    const invalid: ExecutableProcessDefinition = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'orphan',
          code: 'ORPHAN',
          type: 'END',
          responsibleRoleBlueprintId: null,
          slaMinutes: null,
          compensationNodeId: null,
        },
      ],
      edges: [
        ...base.edges,
        {
          id: 'loop',
          sourceNodeId: 'end-approved',
          targetNodeId: 'start',
          condition: null,
          isDefault: false,
        },
      ],
    };

    const result = validateExecutableProcessDefinition(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'The START node cannot have incoming edges.',
        expect.stringContaining('cannot have outgoing edges'),
        'The first process version cannot contain cycles.',
        expect.stringContaining('orphan is unreachable'),
      ]),
    );
  });
});

describe('resolveConditionEdge', () => {
  it('selects an exact branch or the single explicit default without model interpretation', () => {
    const definition = validDefinition();
    expect(resolveConditionEdge(definition, 'decision', 'approved').targetNodeId).toBe(
      'end-approved',
    );
    expect(resolveConditionEdge(definition, 'decision', null).targetNodeId).toBe('end-rejected');
    expect(() => resolveConditionEdge(definition, 'decision', 'unknown')).toThrow(
      'No deterministic process edge',
    );
  });
});

function validDefinition(): ExecutableProcessDefinition {
  return {
    id: 'process',
    versionId: 'process-version',
    version: 1,
    nodes: [
      {
        id: 'start',
        code: 'START',
        type: 'START',
        responsibleRoleBlueprintId: null,
        slaMinutes: null,
        compensationNodeId: null,
      },
      {
        id: 'review',
        code: 'REVIEW',
        type: 'HUMAN_APPROVAL',
        responsibleRoleBlueprintId: 'reviewer-role',
        slaMinutes: 1_440,
        compensationNodeId: null,
      },
      {
        id: 'decision',
        code: 'DECISION',
        type: 'CONDITION',
        responsibleRoleBlueprintId: null,
        slaMinutes: null,
        compensationNodeId: null,
      },
      {
        id: 'end-approved',
        code: 'END_APPROVED',
        type: 'END',
        responsibleRoleBlueprintId: null,
        slaMinutes: null,
        compensationNodeId: null,
      },
      {
        id: 'end-rejected',
        code: 'END_REJECTED',
        type: 'END',
        responsibleRoleBlueprintId: null,
        slaMinutes: null,
        compensationNodeId: null,
      },
    ],
    edges: [
      {
        id: 'start-review',
        sourceNodeId: 'start',
        targetNodeId: 'review',
        condition: null,
        isDefault: false,
      },
      {
        id: 'review-decision',
        sourceNodeId: 'review',
        targetNodeId: 'decision',
        condition: null,
        isDefault: false,
      },
      {
        id: 'approved',
        sourceNodeId: 'decision',
        targetNodeId: 'end-approved',
        condition: 'approved',
        isDefault: false,
      },
      {
        id: 'default-rejected',
        sourceNodeId: 'decision',
        targetNodeId: 'end-rejected',
        condition: null,
        isDefault: true,
      },
    ],
  };
}

function systemStepContext() {
  return {
    tenantId: 'tenant-a',
    nodeType: 'HUMAN_APPROVAL' as const,
    resolvedRoleAssignmentId: 'assignment-reviewer',
    resolvedAgentId: null,
    actor: {
      type: 'SYSTEM' as const,
      tenantId: 'tenant-a',
      userId: null,
      agentId: null,
      roleAssignment: null,
    },
    evidenceSealed: false,
    skipAuthorized: false,
    now: new Date('2026-07-28T08:00:00.000Z'),
  };
}

function humanStepContext() {
  return {
    ...systemStepContext(),
    actor: {
      type: 'USER' as const,
      tenantId: 'tenant-a',
      userId: 'user-reviewer',
      agentId: null,
      roleAssignment: {
        id: 'assignment-reviewer',
        tenantId: 'tenant-a',
        userId: 'user-reviewer',
        agentId: 'agent-reviewer',
        status: 'ACTIVE' as const,
        employmentStatus: 'ACTIVE' as const,
        orgUnitStatus: 'ACTIVE' as const,
        roleVersionStatus: 'PUBLISHED' as const,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    },
    evidenceSealed: true,
  };
}
