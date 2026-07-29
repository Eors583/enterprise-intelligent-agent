import type { CompetencyCategory, PeopleOrganizationOverview } from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { ErrorState, LoadingPanel, Notice } from '@/components/ui';

import {
  createCompetencyDefinition,
  createTriangleTeam,
  getPeopleOrganizationOverview,
  proposeOrganizationChange,
} from './api';
import './people-organization.css';

const EMPTY_OVERVIEW: PeopleOrganizationOverview = {
  competencyDefinitions: 0,
  activeCompetencyVersions: 0,
  assessmentsAwaitingConfirmation: 0,
  openAppeals: 0,
  activeTriangleTeams: 0,
  organizationChangesAwaitingConfirmation: 0,
};

export function PeopleOrganizationPage(): ReactNode {
  const [overview, setOverview] = useState<PeopleOrganizationOverview | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [competency, setCompetency] = useState({
    code: '',
    name: '',
    category: 'SKILL' as CompetencyCategory,
    description: '',
  });
  const [change, setChange] = useState({
    type: 'ROLE_REASSIGNMENT' as const,
    subjectId: '',
    effectiveAt: '',
    reason: '',
    proposedChange: '{\n  "from": "",\n  "to": ""\n}',
  });
  const [team, setTeam] = useState({
    code: '',
    name: '',
    objectiveId: '',
    objectiveVersion: '1',
    customerRoleAssignmentId: '',
    solutionRoleAssignmentId: '',
    deliveryRoleAssignmentId: '',
    arbiterRoleAssignmentId: '',
    metricDefinitionIds: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void getPeopleOrganizationOverview(controller.signal)
      .then(setOverview)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [reloadKey]);

  const submitCompetency = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const created = await createCompetencyDefinition({
        ...competency,
        idempotencyKey: crypto.randomUUID(),
      });
      setCompetency({ code: '', name: '', category: 'SKILL', description: '' });
      setNotice(`能力项 ${created.code} 已创建。下一步请建立带行为锚点的版本并由独立审核人激活。`);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  };

  const submitChange = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const created = await proposeOrganizationChange({
        type: change.type,
        subjectId: change.subjectId,
        effectiveAt: new Date(change.effectiveAt).toISOString(),
        reason: change.reason,
        proposedChange: JSON.parse(change.proposedChange) as Record<string, unknown>,
        idempotencyKey: crypto.randomUUID(),
      });
      setNotice(
        `组织变更 ${created.id.slice(0, 8)} 已进入影响分析；在目标、流程、权限、任务和智能体任命全部分析并由独立人员确认前不会应用。`,
      );
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  };

  const submitTeam = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const created = await createTriangleTeam({
        code: team.code,
        name: team.name,
        objectiveId: team.objectiveId,
        objectiveVersion: Number(team.objectiveVersion),
        customerRoleAssignmentId: team.customerRoleAssignmentId,
        solutionRoleAssignmentId: team.solutionRoleAssignmentId,
        deliveryRoleAssignmentId: team.deliveryRoleAssignmentId,
        arbiterRoleAssignmentId: team.arbiterRoleAssignmentId,
        metricDefinitionIds: team.metricDefinitionIds
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        healthPolicy: {
          thresholds: {
            TASK_RESPONSE_LATENCY: 24,
            INPUT_OUTPUT_COMPLETENESS: 0.9,
            PROCESS_RETURN_RATE: 0.1,
            COMMITMENT_FULFILLMENT: 0.9,
            CUSTOMER_CLOSURE: 0.9,
            SHARED_OBJECTIVE_RESULT: 0.9,
          },
          weights: {
            TASK_RESPONSE_LATENCY: 0.15,
            INPUT_OUTPUT_COMPLETENESS: 0.2,
            PROCESS_RETURN_RATE: 0.15,
            COMMITMENT_FULFILLMENT: 0.2,
            CUSTOMER_CLOSURE: 0.15,
            SHARED_OBJECTIVE_RESULT: 0.15,
          },
        },
        idempotencyKey: crypto.randomUUID(),
      });
      setNotice(
        `铁三角 ${created.name} 已建立；健康度将按六项经营与协同结果计算，不采用消息次数。`,
      );
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  };

  const value = overview ?? EMPTY_OVERVIEW;

  return (
    <section className="page-section people-organization-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PEOPLE & ORGANIZATION GOVERNANCE</span>
          <h1>人才与组织治理</h1>
          <p>
            将角色能力、受控证据、人工复核、发展行动、铁三角共同目标和组织变更影响分析连接成可审计闭环。
          </p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          刷新状态
        </button>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : null}
      {overview === null && error === null ? (
        <LoadingPanel label="正在读取人才与组织治理状态…" />
      ) : null}

      <div className="people-overview-grid" aria-label="人才与组织治理概览">
        <Metric label="能力定义" value={value.competencyDefinitions} />
        <Metric label="已激活能力版本" value={value.activeCompetencyVersions} />
        <Metric
          label="待人工确认评价"
          value={value.assessmentsAwaitingConfirmation}
          tone="warning"
        />
        <Metric label="员工异议" value={value.openAppeals} tone="warning" />
        <Metric label="运行中铁三角" value={value.activeTriangleTeams} />
        <Metric
          label="待确认组织变更"
          value={value.organizationChangesAwaitingConfirmation}
          tone="warning"
        />
      </div>

      <div className="people-governance-grid">
        <form className="card people-form" onSubmit={(event) => void submitCompetency(event)}>
          <header>
            <div>
              <span className="eyebrow">HR-001</span>
              <h2>新建能力定义</h2>
            </div>
            <span className="governance-badge">人工激活</span>
          </header>
          <label>
            <span>能力编码</span>
            <input
              required
              pattern="[A-Z0-9][A-Z0-9._-]+"
              value={competency.code}
              placeholder="例如 SOLUTION.DESIGN"
              onChange={(event) =>
                setCompetency({ ...competency, code: event.target.value.toUpperCase() })
              }
            />
          </label>
          <label>
            <span>名称</span>
            <input
              required
              value={competency.name}
              onChange={(event) => setCompetency({ ...competency, name: event.target.value })}
            />
          </label>
          <label>
            <span>类别</span>
            <select
              value={competency.category}
              onChange={(event) =>
                setCompetency({
                  ...competency,
                  category: event.target.value as CompetencyCategory,
                })
              }
            >
              <option value="KNOWLEDGE">知识</option>
              <option value="SKILL">技能</option>
              <option value="EXPERIENCE">经验</option>
              <option value="BEHAVIOR">行为</option>
              <option value="TOOL">工具</option>
            </select>
          </label>
          <label>
            <span>定义</span>
            <textarea
              required
              value={competency.description}
              onChange={(event) =>
                setCompetency({ ...competency, description: event.target.value })
              }
            />
          </label>
          <button className="button primary" type="submit">
            创建能力定义
          </button>
          <p className="people-form-hint">
            能力版本必须包含等级、任务复杂度、证据要求和行为锚点，并明确绑定角色蓝图版本。
          </p>
        </form>

        <form className="card people-form" onSubmit={(event) => void submitTeam(event)}>
          <header>
            <div>
              <span className="eyebrow">ORG-001 · TRIANGLE</span>
              <h2>配置客户铁三角</h2>
            </div>
            <span className="governance-badge">三责互异</span>
          </header>
          <div className="people-form-row">
            <label>
              <span>团队编码</span>
              <input
                required
                value={team.code}
                onChange={(event) => setTeam({ ...team, code: event.target.value.toUpperCase() })}
              />
            </label>
            <label>
              <span>团队名称</span>
              <input
                required
                value={team.name}
                onChange={(event) => setTeam({ ...team, name: event.target.value })}
              />
            </label>
          </div>
          <div className="people-form-row">
            <label>
              <span>共同客户目标 ID</span>
              <input
                required
                value={team.objectiveId}
                onChange={(event) => setTeam({ ...team, objectiveId: event.target.value })}
              />
            </label>
            <label>
              <span>目标版本</span>
              <input
                required
                type="number"
                min="1"
                value={team.objectiveVersion}
                onChange={(event) => setTeam({ ...team, objectiveVersion: event.target.value })}
              />
            </label>
          </div>
          {(
            [
              ['customerRoleAssignmentId', '客户责任任命 ID'],
              ['solutionRoleAssignmentId', '解决方案责任任命 ID'],
              ['deliveryRoleAssignmentId', '交付责任任命 ID'],
              ['arbiterRoleAssignmentId', '冲突仲裁人任命 ID'],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              <span>{label}</span>
              <input
                required
                value={team[field]}
                onChange={(event) => setTeam({ ...team, [field]: event.target.value })}
              />
            </label>
          ))}
          <label>
            <span>共享指标 ID（逗号分隔）</span>
            <input
              required
              value={team.metricDefinitionIds}
              onChange={(event) => setTeam({ ...team, metricDefinitionIds: event.target.value })}
            />
          </label>
          <button className="button primary" type="submit">
            校验并建立铁三角
          </button>
        </form>

        <form className="card people-form" onSubmit={(event) => void submitChange(event)}>
          <header>
            <div>
              <span className="eyebrow">ORG-001</span>
              <h2>发起组织变更分析</h2>
            </div>
            <span className="governance-badge danger">禁止自动高风险变更</span>
          </header>
          <label>
            <span>目标对象 ID</span>
            <input
              required
              type="text"
              value={change.subjectId}
              placeholder="UUID"
              onChange={(event) => setChange({ ...change, subjectId: event.target.value })}
            />
          </label>
          <label>
            <span>生效时间</span>
            <input
              required
              type="datetime-local"
              value={change.effectiveAt}
              onChange={(event) => setChange({ ...change, effectiveAt: event.target.value })}
            />
          </label>
          <label>
            <span>变更原因</span>
            <textarea
              required
              value={change.reason}
              onChange={(event) => setChange({ ...change, reason: event.target.value })}
            />
          </label>
          <label>
            <span>变更内容（JSON）</span>
            <textarea
              required
              className="code-input"
              value={change.proposedChange}
              onChange={(event) => setChange({ ...change, proposedChange: event.target.value })}
            />
          </label>
          <button className="button primary" type="submit">
            创建影响分析单
          </button>
        </form>
      </div>

      <section className="card governance-boundaries" aria-labelledby="governance-boundaries-title">
        <header>
          <h2 id="governance-boundaries-title">不可绕过的治理边界</h2>
        </header>
        <ul>
          <li>AI 只生成能力归因候选；员工、有效直属管理者和 HR 按配置共同确认后才形成有效结论。</li>
          <li>能力评价不能单独触发晋升、调薪或淘汰；员工可查看证据、补证、提出异议并要求重评。</li>
          <li>铁三角必须有共同客户目标、三个互异责任任命、共享指标和明确仲裁人。</li>
          <li>
            健康度只采用任务响应、输入输出、流程退回、承诺兑现、客户闭环和共同目标结果，不使用消息数。
          </li>
          <li>
            组织变更必须覆盖目标、流程、权限、任务和智能体任命影响，关键风险进入专用审批执行流。
          </li>
        </ul>
      </section>
    </section>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warning';
}): ReactNode {
  return (
    <article className={`card people-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
