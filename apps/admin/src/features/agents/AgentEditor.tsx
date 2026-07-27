import type { AdminAgent, KnowledgeBase, UpdateAdminAgentRequest } from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';

import { reconcileUnknownAgentRun, updateAgent } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Notice, Spinner, StatusPill } from '@/components/ui';

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
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(agent.knowledgeBaseIds);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const request: UpdateAdminAgentRequest = {
      name,
      summary: summary.trim() ? summary : null,
      status,
      visibility,
      systemPrompt,
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

  return (
    <div className="knowledge-editor-stack">
      <article className="card agent-runtime-card">
        <div className="card-header">
          <span className="knowledge-glyph large">AI</span>
          <div>
            <span className="eyebrow">
              {agent.owner.displayName} · VERSION {agent.version}
            </span>
            <h2>{agent.name}</h2>
            <p>
              模型路由：{agent.modelRoute} · 配置版本：{agent.versionStatus}
            </p>
          </div>
          <StatusPill value={agent.status} />
        </div>
        {agent.lastRun ? (
          <Notice tone={runTone(agent.lastRun.status)}>
            最近运行：{runLabel(agent.lastRun.status)}
            {agent.lastRun.errorCode ? ` · ${agent.lastRun.errorCode}` : ''}
            {agent.lastRun.errorMessage ? ` · ${agent.lastRun.errorMessage}` : ''}
            {agent.lastRun.status === 'UNKNOWN' ? (
              <button
                className="button secondary compact"
                type="button"
                disabled={reconciling}
                onClick={() => void reconcile()}
              >
                {reconciling ? '正在对账…' : '向运行时重新对账'}
              </button>
            ) : null}
          </Notice>
        ) : (
          <Notice tone="info">该智能体还没有运行记录。首次对话后可在这里查看结果。</Notice>
        )}
      </article>

      <form className="card knowledge-settings form-stack" onSubmit={(event) => void submit(event)}>
        <div className="card-header">
          <div>
            <h2>智能体配置</h2>
            <p>提示词变更会生成新的已发布版本，不影响历史对话记录。</p>
          </div>
        </div>
        <div className="form-grid two">
          <label>
            <span>智能体名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>运行状态</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="ONLINE">上线</option>
              <option value="OFFLINE">停用</option>
              <option value="DISABLED">禁用</option>
            </select>
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>可见范围</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            >
              <option value="tenant">企业内成员可联系</option>
              <option value="owner">仅本人可联系</option>
            </select>
          </label>
          <label>
            <span>简介</span>
            <input value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
        </div>
        <label>
          <span>系统提示词</span>
          <textarea
            rows={9}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="定义该智能体的身份、职责、边界和回答风格"
          />
          <small className="form-hint">至少 20 个字符；新发起的消息会使用保存后的提示词。</small>
        </label>
        <fieldset className="agent-knowledge-options">
          <legend>绑定企业知识库</legend>
          {knowledgeBases
            .filter((item) => item.status === 'ACTIVE')
            .map((item) => (
              <label key={item.id} className="agent-knowledge-option">
                <input
                  type="checkbox"
                  checked={knowledgeBaseIds.includes(item.id)}
                  onChange={(event) =>
                    setKnowledgeBaseIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, item.id])]
                        : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>{item.name}</span>
                <small>{item.documentCount} 篇文档</small>
              </label>
            ))}
          {knowledgeBases.every((item) => item.status !== 'ACTIVE') ? (
            <small className="form-hint">请先在知识库管理中启用至少一个知识库。</small>
          ) : null}
          <small className="form-hint">运行时只会检索已就绪、且当前员工有权访问的文档。</small>
        </fieldset>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : '保存智能体配置'}
          </button>
        </div>
      </form>
    </div>
  );
}

function runTone(
  status: NonNullable<AdminAgent['lastRun']>['status'],
): 'success' | 'error' | 'info' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'UNKNOWN' || status === 'CANCELLED') return 'error';
  return 'info';
}

function runLabel(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: '等待执行',
    DISPATCHING: '正在分发',
    RUNNING: '运行中',
    SUCCEEDED: '成功',
    FAILED: '失败',
    UNKNOWN: '结果未知',
    CANCELLED: '已取消',
  };
  return labels[status] ?? status;
}
