import type { AdminAgent, KnowledgeBase, UpdateAdminAgentRequest } from '@enterprise/contracts';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { reconcileUnknownAgentRun, updateAgent } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Notice, Spinner, StatusPill } from '@/components/ui';
import { agentConfigurationStatusLabel } from './agent-status-view';

export function AgentEditor({
  agent,
  knowledgeBases,
  onSaved,
  onReconciled,
}: {
  agent: AdminAgent;
  knowledgeBases: KnowledgeBase[];
  onSaved: (agent: AdminAgent) => void;
  onReconciled: () => void;
}): ReactNode {
  const [name, setName] = useState(agent.name);
  const [summary, setSummary] = useState(agent.summary ?? '');
  const [status, setStatus] = useState(agent.status);
  const [visibility, setVisibility] = useState(agent.visibility);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(agent.knowledgeBaseIds);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectableKnowledgeBases = useMemo(
    () =>
      knowledgeBases.filter(
        (item) => item.status === 'ACTIVE' || knowledgeBaseIds.includes(item.id),
      ),
    [knowledgeBaseIds, knowledgeBases],
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const request: UpdateAdminAgentRequest = {
      name,
      summary: summary.trim() ? summary.trim() : null,
      status,
      visibility: agent.kind === 'DEPARTMENT' ? 'department' : visibility,
      knowledgeBaseIds,
      expectedVersionId: agent.versionId,
    };
    try {
      onSaved(await updateAgent(agent.id, request));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (agent.lastRun?.status !== 'UNKNOWN') return;
    setReconciling(true);
    setError(null);
    try {
      await reconcileUnknownAgentRun(agent.lastRun.id);
      onReconciled();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setReconciling(false);
    }
  };

  const subjectName =
    agent.kind === 'DEPARTMENT'
      ? (agent.department?.name ?? '部门')
      : (agent.owner?.displayName ?? '员工');

  return (
    <div className="knowledge-editor-stack">
      <article className="card agent-runtime-card">
        <div className="card-header">
          <span className="knowledge-glyph large">AI</span>
          <div>
            <span className="eyebrow">
              {agent.kind === 'DEPARTMENT' ? '部门智能体' : '员工智能体'} · {subjectName}
            </span>
            <h2>{agent.name}</h2>
            <p>
              已绑定 {agent.knowledgeBaseIds.length} 个知识库
              {agent.lastRun ? ` · 最近运行：${runLabel(agent.lastRun.status)}` : ' · 暂无运行记录'}
            </p>
          </div>
          <StatusPill value={agent.status} label={agentConfigurationStatusLabel(agent.status)} />
        </div>
        {agent.lastRun?.status === 'UNKNOWN' ? (
          <Notice tone="error">
            最近一次回答状态未知。
            <button
              className="button secondary compact"
              type="button"
              disabled={reconciling}
              onClick={() => void reconcile()}
            >
              {reconciling ? '正在确认…' : '重新确认运行结果'}
            </button>
          </Notice>
        ) : null}
      </article>

      <form className="card knowledge-settings form-stack" onSubmit={(event) => void submit(event)}>
        <div className="card-header">
          <div>
            <h2>基础配置</h2>
            <p>为智能体选择知识库后，新问题会立即按最新绑定范围检索和召回。</p>
          </div>
        </div>

        <div className="form-grid two">
          <label>
            <span>智能体名称</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>启用状态</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="ONLINE">启用</option>
              <option value="OFFLINE">暂时停用</option>
              <option value="DISABLED">禁用</option>
            </select>
          </label>
        </div>

        <div className="form-grid two">
          {agent.kind === 'MEMBER' ? (
            <label>
              <span>谁可以联系</span>
              <select
                value={visibility === 'department' ? 'tenant' : visibility}
                onChange={(event) => setVisibility(event.target.value as 'tenant' | 'owner')}
              >
                <option value="tenant">企业内员工</option>
                <option value="owner">仅智能体所属员工</option>
              </select>
            </label>
          ) : (
            <label>
              <span>服务范围</span>
              <input value={agent.department?.name ?? '部门'} disabled />
            </label>
          )}
          <label>
            <span>简介</span>
            <input
              value={summary}
              maxLength={2_000}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="agent-knowledge-options">
          <legend>这个智能体可以使用的知识库</legend>
          {selectableKnowledgeBases.map((item) => (
            <label key={item.id} className="agent-knowledge-option">
              <input
                type="checkbox"
                checked={knowledgeBaseIds.includes(item.id)}
                disabled={item.status !== 'ACTIVE'}
                onChange={(event) =>
                  setKnowledgeBaseIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, item.id])]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              <span>{item.name}</span>
              <small>
                {item.documentCount} 份文档 · {item.status === 'ACTIVE' ? '可用' : '已停用'}
              </small>
            </label>
          ))}
          {selectableKnowledgeBases.length === 0 ? (
            <Notice tone="info">还没有可用知识库，请先到“知识中心”上传并启用文档。</Notice>
          ) : null}
          {knowledgeBaseIds.length === 0 ? (
            <small className="form-hint">未选择知识库时，智能体只能使用模型通用能力回答。</small>
          ) : (
            <small className="form-hint">
              回答时会同时校验提问员工的部门权限，只召回该员工有权查看的文档。
            </small>
          )}
        </fieldset>

        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button primary"
            type="submit"
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? <Spinner label="正在保存…" /> : '保存并应用'}
          </button>
        </div>
      </form>
    </div>
  );
}

function runLabel(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: '等待执行',
    DISPATCHING: '正在分发',
    RUNNING: '正在回答',
    SUCCEEDED: '成功',
    FAILED: '失败',
    UNKNOWN: '结果未知',
    CANCELLED: '已取消',
  };
  return labels[status] ?? status;
}
