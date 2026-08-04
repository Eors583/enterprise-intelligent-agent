import type {
  AdminAgent,
  AdminOrgUnit,
  CreateDepartmentAgentRequest,
  KnowledgeBase,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  createDepartmentAgent,
  getOrganization,
  listAgents,
  listKnowledgeBases,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import {
  EmptyState,
  ErrorState,
  FieldError,
  LoadingPanel,
  Modal,
  Notice,
  Spinner,
  StatusPill,
} from '@/components/ui';
import { AgentEditor } from './AgentEditor';
import { agentConfigurationStatusLabel } from './agent-status-view';

export function AgentsPage(): ReactNode {
  const [items, setItems] = useState<AdminAgent[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [orgUnits, setOrgUnits] = useState<AdminOrgUnit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'ALL' | AdminAgent['kind']>('ALL');
  const [showCreateDepartment, setShowCreateDepartment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      listAgents(controller.signal),
      listKnowledgeBases(controller.signal),
      getOrganization(controller.signal),
    ])
      .then(([{ items: loaded }, { items: loadedKnowledgeBases }, organization]) => {
        setItems(loaded);
        setKnowledgeBases(loadedKnowledgeBases);
        setOrgUnits(organization.orgUnits);
        setSelectedId((current) =>
          current !== null && loaded.some((item) => item.id === current)
            ? current
            : (loaded[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => {
      if (kind !== 'ALL' && item.kind !== kind) return false;
      return (
        !normalized ||
        [item.name, item.owner?.displayName, item.department?.name].some((value) =>
          value?.toLocaleLowerCase('zh-CN').includes(normalized),
        )
      );
    });
  }, [items, kind, query]);

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">AGENT CENTER</span>
          <h1>智能体中心</h1>
          <p>管理员工智能体和部门智能体，并为它们选择真正可检索的企业知识库。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setShowCreateDepartment(true)}
          >
            <Icon name="plus" size={17} /> 新建部门智能体
          </button>
        </div>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      <Notice tone="info">
        员工智能体服务于具体员工；部门智能体供该部门成员共同使用。两者都只能召回提问人有权访问的已启用知识。
      </Notice>
      {loading && items.length === 0 ? <LoadingPanel label="正在读取智能体…" /> : null}
      {error && items.length === 0 ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="还没有智能体"
          description="同步或创建员工后会生成员工智能体，也可以直接创建部门智能体。"
        />
      ) : null}

      {items.length > 0 ? (
        <div className="knowledge-layout agent-admin-layout">
          <aside className="card knowledge-list-card">
            <div className="knowledge-list-header">
              <div className="search-input">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索员工、部门或智能体"
                  aria-label="搜索智能体"
                />
              </div>
              <div className="segmented-control" aria-label="智能体类型">
                {(['ALL', 'MEMBER', 'DEPARTMENT'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={kind === value ? 'active' : ''}
                    onClick={() => setKind(value)}
                  >
                    {value === 'ALL' ? '全部' : value === 'MEMBER' ? '员工' : '部门'}
                  </button>
                ))}
              </div>
            </div>
            <div className="knowledge-list">
              {filtered.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={selectedId === item.id ? 'selected' : ''}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="knowledge-glyph">AI</span>
                  <span className="knowledge-list-copy">
                    <strong>
                      {item.kind === 'DEPARTMENT'
                        ? (item.department?.name ?? '部门')
                        : (item.owner?.displayName ?? '员工')}
                    </strong>
                    <small>
                      {item.name} · {item.knowledgeBaseIds.length} 个知识库
                    </small>
                  </span>
                  <StatusPill
                    value={item.status}
                    label={agentConfigurationStatusLabel(item.status)}
                  />
                </button>
              ))}
              {filtered.length === 0 ? <p className="inline-empty">没有匹配的智能体</p> : null}
            </div>
          </aside>

          <section className="knowledge-detail">
            {selected ? (
              <AgentEditor
                key={`${selected.id}-${selected.versionId}`}
                agent={selected}
                knowledgeBases={knowledgeBases}
                onSaved={(updated) => {
                  setItems((current) =>
                    current.map((item) => (item.id === updated.id ? updated : item)),
                  );
                  setNotice('智能体配置已保存，新问题会使用最新知识库范围。');
                }}
                onReconciled={() => {
                  setNotice('已重新确认智能体运行结果。');
                  reload();
                }}
              />
            ) : (
              <EmptyState title="请选择智能体" description="从左侧选择需要配置的智能体。" />
            )}
          </section>
        </div>
      ) : null}

      {showCreateDepartment ? (
        <CreateDepartmentAgentModal
          orgUnits={orgUnits}
          knowledgeBases={knowledgeBases}
          onClose={() => setShowCreateDepartment(false)}
          onCreated={(created) => {
            setItems((current) => [...current, created]);
            setSelectedId(created.id);
            setShowCreateDepartment(false);
            setNotice('部门智能体已创建，可以在消息中发起对话或加入头脑风暴。');
          }}
        />
      ) : null}
    </section>
  );
}

function CreateDepartmentAgentModal({
  orgUnits,
  knowledgeBases,
  onClose,
  onCreated,
}: {
  orgUnits: AdminOrgUnit[];
  knowledgeBases: KnowledgeBase[];
  onClose: () => void;
  onCreated: (agent: AdminAgent) => void;
}): ReactNode {
  const activeOrgUnits = orgUnits.filter((item) => item.status === 'ACTIVE');
  const [orgUnitId, setOrgUnitId] = useState(activeOrgUnits[0]?.id ?? '');
  const [name, setName] = useState(
    activeOrgUnits[0] === undefined ? '' : `${activeOrgUnits[0].name}智能体`,
  );
  const [summary, setSummary] = useState('');
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligibleKnowledgeBases = knowledgeBases.filter(
    (item) =>
      item.status === 'ACTIVE' && knowledgeBaseVisibleToDepartment(item, orgUnitId, orgUnits),
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const request: CreateDepartmentAgentRequest = {
      name: name.trim(),
      summary: summary.trim() || null,
      orgUnitId,
      knowledgeBaseIds,
      status: 'ONLINE',
    };
    try {
      onCreated(await createDepartmentAgent(request));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建部门智能体"
      description="选择服务部门和知识库，系统会自动创建可对话的共享智能体。"
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>服务部门</span>
          <select
            value={orgUnitId}
            onChange={(event) => {
              const nextId = event.target.value;
              const department = activeOrgUnits.find((item) => item.id === nextId);
              setOrgUnitId(nextId);
              setName(department === undefined ? '' : `${department.name}智能体`);
              setKnowledgeBaseIds([]);
            }}
          >
            {activeOrgUnits.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>智能体名称</span>
          <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>简介（可选）</span>
          <input
            value={summary}
            maxLength={2_000}
            placeholder="例如：解答研发制度、交付规范和技术流程问题"
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <fieldset className="agent-knowledge-options">
          <legend>选择知识库</legend>
          {eligibleKnowledgeBases.map((item) => (
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
              <small>{item.documentCount} 份文档</small>
            </label>
          ))}
          {eligibleKnowledgeBases.length === 0 ? (
            <Notice tone="info">该部门当前没有可用知识库，请先在知识中心配置部门范围。</Notice>
          ) : null}
        </fieldset>
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              submitting ||
              orgUnitId.length === 0 ||
              name.trim().length === 0 ||
              knowledgeBaseIds.length === 0
            }
          >
            {submitting ? <Spinner label="正在创建…" /> : '创建部门智能体'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function knowledgeBaseVisibleToDepartment(
  knowledgeBase: KnowledgeBase,
  orgUnitId: string,
  orgUnits: readonly AdminOrgUnit[],
): boolean {
  if (knowledgeBase.orgUnitScopes.length === 0) return true;
  const parentById = new Map(orgUnits.map((item) => [item.id, item.parentId]));
  return knowledgeBase.orgUnitScopes.some(
    (scope) =>
      scope.orgUnitId === orgUnitId ||
      (scope.includeChildren && isAncestor(scope.orgUnitId, orgUnitId, parentById)),
  );
}

function isAncestor(
  ancestorId: string,
  descendantId: string,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  let current = parentById.get(descendantId) ?? null;
  while (current !== null && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}
