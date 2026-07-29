import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@/api/client', () => ({ request: requestMock }));

import {
  createDeliverableAcceptance,
  createEvidenceLink,
  createObjectiveRelation,
  createProcessDefinition,
  createProcessVersion,
  createTaskDeliverable,
  createTaskDependency,
  createValueDefinition,
  createValueVersion,
  listEvidence,
  listMetricDefinitions,
  listObjectives,
  listProcessDefinitions,
  listStrategies,
  listTasks,
  listValueDefinitions,
  transitionDeliverableAcceptance,
  transitionEvidence,
  transitionEvidenceLink,
  transitionMetricDefinition,
  transitionObjective,
  transitionObjectiveRelation,
  transitionProcessVersion,
  transitionStrategy,
  transitionTask,
  transitionTaskDeliverable,
  transitionTaskDependency,
  transitionValueVersion,
} from './api';

const id = (number: number): string =>
  `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`;
const now = '2026-07-28T00:00:00.000Z';
const owner = { type: 'USER' as const, id: id(1) };
const common = {
  owner,
  permissionLabels: ['business.read'],
  effectiveFrom: now,
  effectiveTo: null,
};

describe('business semantics admin API adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ items: [] });
  });

  it('uses the seven locked list envelopes without leaking path guesses into pages', async () => {
    const controller = new AbortController();
    await Promise.all([
      listValueDefinitions(controller.signal),
      listStrategies(controller.signal),
      listObjectives(controller.signal),
      listMetricDefinitions(controller.signal),
      listProcessDefinitions(controller.signal),
      listTasks(controller.signal),
      listEvidence(controller.signal),
    ]);

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/business-semantics/values',
      '/admin/business-semantics/strategies',
      '/admin/business-semantics/objectives',
      '/admin/business-semantics/metrics',
      '/admin/business-semantics/processes',
      '/admin/business-semantics/tasks',
      '/admin/business-semantics/evidence',
    ]);
    for (const [, options] of requestMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({ signal: controller.signal, schema: expect.anything() }),
      );
    }
  });

  it('creates Value and Process identities and publishes nested versions through exact routes', async () => {
    await createValueDefinition({
      ...common,
      code: 'VALUE.CUSTOMER.SUCCESS',
      type: 'CUSTOMER',
      name: '客户成功价值',
      description: null,
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe('/admin/business-semantics/values');

    await createValueVersion(id(10), {
      valueDefinitionId: id(10),
      expectedDefinitionRevision: 1,
      statement: '持续交付可验证的客户成果。',
      ...common,
      positiveBehaviors: ['主动识别风险'],
      negativeBehaviors: ['忽略客户反馈'],
      metrics: [
        {
          code: 'VALUE.METRIC.RETENTION',
          metricDefinitionId: id(20),
          name: '客户留存率',
          weight: 1,
          target: { kind: 'AT_LEAST', value: 90 },
          permissionLabels: [],
        },
      ],
      constraints: [],
      changeSummary: '首个价值版本',
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/business-semantics/values/${id(10)}/versions`,
    );
    await transitionValueVersion(id(10), id(11), {
      expectedRevision: 1,
      action: 'PUBLISH',
      reason: '完成治理校验',
      effectiveAt: now,
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/business-semantics/values/${id(10)}/versions/${id(11)}/transition`,
    );

    await createProcessDefinition({
      ...common,
      code: 'PROCESS.CUSTOMER.RETENTION',
      name: '客户留存流程',
      description: '识别并干预客户风险。',
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe('/admin/business-semantics/processes');
    await createProcessVersion(id(30), {
      processDefinitionId: id(30),
      expectedDefinitionRevision: 1,
      changeSummary: '首个流程版本',
      ...common,
      nodes: [
        { code: 'START.MAIN', name: '开始', type: 'START', ordinal: 0, configuration: {} },
        { code: 'END.MAIN', name: '结束', type: 'END', ordinal: 1, configuration: {} },
      ],
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/business-semantics/processes/${id(30)}/versions`,
    );
    await transitionProcessVersion(id(30), id(31), {
      expectedRevision: 1,
      action: 'PUBLISH',
      reason: '流程节点已复核',
      effectiveAt: now,
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/business-semantics/processes/${id(30)}/versions/${id(31)}/transition`,
    );
  });

  it('uses direct entity transition routes for Strategy, Objective, Metric, Task, and Evidence', async () => {
    await transitionStrategy(id(40), {
      expectedRevision: 1,
      action: 'ACTIVATE',
      reason: '战略已审批',
      effectiveAt: now,
    });
    await transitionObjective(id(41), {
      expectedRevision: 1,
      action: 'ACTIVATE',
      reason: '目标已拆解',
      effectiveAt: now,
    });
    await transitionMetricDefinition(id(42), {
      expectedRevision: 1,
      action: 'ACTIVATE',
      reason: '口径已确认',
      effectiveAt: now,
    });
    await transitionTask(id(43), {
      expectedRevision: 1,
      action: 'MAKE_READY',
      reason: '前置条件已满足',
      effectiveAt: now,
    });
    await transitionEvidence(id(44), {
      expectedRevision: 1,
      action: 'VERIFY',
      reason: '来源和哈希已核验',
      effectiveAt: now,
    });

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      `/admin/business-semantics/strategies/${id(40)}/transition`,
      `/admin/business-semantics/objectives/${id(41)}/transition`,
      `/admin/business-semantics/metrics/${id(42)}/transition`,
      `/admin/business-semantics/tasks/${id(43)}/transition`,
      `/admin/business-semantics/evidence/${id(44)}/transition`,
    ]);
  });

  it('keeps relation, dependency, delivery, acceptance, and evidence link nesting exact', async () => {
    await createObjectiveRelation({
      ...common,
      code: 'OBJECTIVE.RELATION.RETENTION',
      sourceObjectiveId: id(51),
      targetObjectiveId: id(52),
      type: 'SUPPORTS',
      weight: 1,
      lagDays: 0,
    });
    await transitionObjectiveRelation(id(53), {
      expectedRevision: 1,
      action: 'RETIRE',
      reason: '关系已替代',
      effectiveAt: now,
    });
    await createTaskDependency({
      ...common,
      code: 'TASK.DEPENDENCY.SCAN.REVIEW',
      predecessorTaskId: id(61),
      successorTaskId: id(62),
      type: 'FINISH_TO_START',
      lagMinutes: 0,
    });
    await transitionTaskDependency(id(63), {
      expectedRevision: 1,
      action: 'REMOVE',
      reason: '依赖已解除',
      effectiveAt: now,
    });
    await createTaskDeliverable(id(62), {
      ...common,
      code: 'DELIVERABLE.RISK.LIST',
      taskId: id(62),
      title: '客户风险清单',
      description: '可验收的客户风险清单。',
      dueAt: now,
    });
    await transitionTaskDeliverable(id(62), id(70), {
      expectedRevision: 1,
      action: 'SUBMIT',
      submittedAt: now,
      artifactUri: 'https://example.test/artifacts/risk-list',
      contentHash: 'a'.repeat(64),
      evidenceIds: [id(80)],
    });
    await createDeliverableAcceptance(id(62), id(70), {
      code: 'ACCEPTANCE.RISK.LIST',
      deliverableId: id(70),
      decision: 'ACCEPTED',
      decidedBy: owner,
      decidedAt: now,
      criteria: [
        {
          code: 'CRITERION.COMPLETE',
          description: '清单完整',
          mandatory: true,
          passed: true,
          weight: 1,
          comment: null,
        },
      ],
      evidenceIds: [id(80)],
      comment: '验收通过',
      owner,
      permissionLabels: [],
    });
    await transitionDeliverableAcceptance(id(62), id(70), id(71), {
      expectedRevision: 1,
      action: 'VOID',
      reason: '验收决定已被替代',
      effectiveAt: now,
    });
    await createEvidenceLink(id(80), {
      ...common,
      code: 'EVIDENCE.LINK.ACCEPTANCE',
      evidenceId: id(80),
      targetType: 'ACCEPTANCE',
      targetId: id(71),
      targetVersion: 1,
      type: 'SUPPORTS',
      relevance: 1,
      statement: '该证据支持验收决定。',
    });
    await transitionEvidenceLink(id(80), id(81), {
      expectedRevision: 1,
      action: 'REMOVE',
      reason: '链接已替代',
      effectiveAt: now,
    });

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/business-semantics/objectives/relations',
      `/admin/business-semantics/objectives/relations/${id(53)}/transition`,
      '/admin/business-semantics/tasks/dependencies',
      `/admin/business-semantics/tasks/dependencies/${id(63)}/transition`,
      `/admin/business-semantics/tasks/${id(62)}/deliverables`,
      `/admin/business-semantics/tasks/${id(62)}/deliverables/${id(70)}/transition`,
      `/admin/business-semantics/tasks/${id(62)}/deliverables/${id(70)}/acceptances`,
      `/admin/business-semantics/tasks/${id(62)}/deliverables/${id(70)}/acceptances/${id(71)}/transition`,
      `/admin/business-semantics/evidence/${id(80)}/links`,
      `/admin/business-semantics/evidence/${id(80)}/links/${id(81)}/transition`,
    ]);
  });
});
