import { describe, expect, it } from 'vitest';

import { buildObjectiveForest, businessTraceSteps, rootTaskTrace } from './workbench-view';
import { objectiveFixture, workbenchTraceFixture } from './test-fixtures';

describe('objective and task workbench view model', () => {
  it('reconstructs objective hierarchy and keeps orphaned nodes visible', () => {
    const root = objectiveFixture();
    const child = objectiveFixture({
      id: '00000000-0000-7000-8000-000000000031',
      code: 'OBJECTIVE.CHILD',
      name: '子目标',
      parentObjectiveId: root.id,
    });
    const orphan = objectiveFixture({
      id: '00000000-0000-7000-8000-000000000032',
      code: 'OBJECTIVE.ORPHAN',
      name: '待校验目标',
      parentObjectiveId: '00000000-0000-7000-8000-000000000099',
    });

    const forest = buildObjectiveForest([child, orphan, root]);

    expect(forest.map((node) => node.objective.id)).toEqual([root.id, orphan.id]);
    expect(forest[0]?.children[0]?.objective.id).toBe(child.id);
    expect(forest[1]?.orphan).toBe(true);
  });

  it('selects root-task delivery records and constructs the complete semantic chain', () => {
    const trace = workbenchTraceFixture();

    const root = rootTaskTrace(trace);
    const steps = businessTraceSteps(trace);

    expect(root.rootTask.id).toBe(trace.rootTaskId);
    expect(root.dependencies).toHaveLength(1);
    expect(root.deliverables[0]?.title).toBe('高风险客户干预清单');
    expect(root.acceptances[0]?.decision).toBe('ACCEPTED');
    expect(root.evidence[0]?.code).toBe('EVIDENCE.RISK.LIST');
    expect(steps.map((step) => step.label)).toEqual([
      'Value',
      'Strategy',
      'Objective',
      'Metric',
      'Process',
      'Task',
      'Evidence',
    ]);
    expect(steps.find((step) => step.label === 'Process')?.title).toBe('客户留存流程');
  });
});
