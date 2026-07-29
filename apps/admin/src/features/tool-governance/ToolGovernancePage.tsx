import type {
  CreateToolDefinitionRequest,
  CreateToolVersionRequest,
  ToolDefinition,
  ToolDefinitionDetail,
  ToolVersion,
  ToolVersionLifecycleRequest,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  createToolDefinition,
  createToolVersion,
  getToolDefinition,
  listToolDefinitions,
  transitionToolVersion,
} from '@/api/admin-api';
import {
  EmptyState,
  ErrorState,
  FieldError,
  Modal,
  Notice,
  Spinner,
  StatusPill,
} from '@/components/ui';

import {
  formatToolDate,
  nextToolLifecycleAction,
  parseToolList,
  toolErrorMessage,
  toolLifecycleLabel,
  toolRiskLabel,
  toolStatusLabel,
} from './tool-governance-view';
import './tool-governance.css';

export function ToolGovernancePage(): ReactNode {
  const [definitions, setDefinitions] = useState<readonly ToolDefinition[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ToolDefinitionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createDefinitionOpen, setCreateDefinitionOpen] = useState(false);
  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [lifecycleVersion, setLifecycleVersion] = useState<ToolVersion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDefinitions(null);
    setError(null);
    void listToolDefinitions(controller.signal)
      .then((response) => {
        setDefinitions(response.items);
        setSelectedId((current) =>
          current && response.items.some((item) => item.id === current)
            ? current
            : (response.items[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    void getToolDefinition(selectedId, controller.signal)
      .then(setDetail)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setDetailError(caught);
      });
    return () => controller.abort();
  }, [selectedId, reloadKey]);

  const reload = (): void => setReloadKey((current) => current + 1);

  return (
    <section className="page-section tool-governance-page">
      <header className="page-header tool-governance-header">
        <div>
          <span className="eyebrow">TOOL GATEWAY</span>
          <h1>工具治理</h1>
          <p>
            工具必须经过封闭 JSON Schema、风险分级、测试和发布。高风险动作由独立审批人确认，
            禁止工具永远不会进入执行队列。
          </p>
        </div>
        <div className="tool-header-actions">
          <button className="button secondary" type="button" onClick={reload}>
            刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setCreateDefinitionOpen(true)}
          >
            注册工具
          </button>
        </div>
      </header>

      <div className="tool-gateway-boundary" role="note">
        <span>网关</span>
        <div>
          <strong>所有执行都经过唯一 Tool Gateway</strong>
          <small>
            身份、任命、任务、策略、确认/审批、参数摘要、DNS/IP Pin、回执和成本均可追溯。
          </small>
        </div>
      </div>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      {definitions === null ? (
        error ? (
          <ErrorState message={toolErrorMessage(error)} onRetry={reload} />
        ) : (
          <div className="card tool-loading">
            <Spinner label="正在读取工具注册表…" />
          </div>
        )
      ) : (
        <div className="tool-governance-layout">
          <aside className="card tool-definition-list">
            <header>
              <div>
                <span className="eyebrow">REGISTRY</span>
                <h2>工具定义</h2>
              </div>
              <strong>{definitions.length}</strong>
            </header>
            {definitions.length === 0 ? (
              <EmptyState
                title="尚未注册工具"
                description="注册定义后还需创建、测试和发布不可变版本。"
              />
            ) : (
              <div>
                {definitions.map((definition) => (
                  <button
                    key={definition.id}
                    type="button"
                    className={definition.id === selectedId ? 'selected' : ''}
                    onClick={() => setSelectedId(definition.id)}
                  >
                    <span
                      className={`tool-definition-mark status-${definition.status.toLowerCase()}`}
                    >
                      T
                    </span>
                    <span>
                      <strong>{definition.name}</strong>
                      <code>{definition.key}</code>
                      <small>
                        {toolStatusLabel(definition.status)} · r{definition.revision}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          {detailError ? (
            <article className="card tool-detail-error">
              <ErrorState message={toolErrorMessage(detailError)} onRetry={reload} />
            </article>
          ) : detail === null && selectedId ? (
            <article className="card tool-loading">
              <Spinner label="正在读取工具版本…" />
            </article>
          ) : detail ? (
            <ToolDefinitionDetailPanel
              detail={detail}
              onCreateVersion={() => setCreateVersionOpen(true)}
              onLifecycle={setLifecycleVersion}
            />
          ) : (
            <article className="card tool-detail-error">
              <EmptyState title="选择一个工具" description="查看版本、风险、出站边界和生命周期。" />
            </article>
          )}
        </div>
      )}

      {createDefinitionOpen ? (
        <CreateToolDefinitionDialog
          onClose={() => setCreateDefinitionOpen(false)}
          onSaved={(definition) => {
            setCreateDefinitionOpen(false);
            setSelectedId(definition.id);
            setNotice('工具定义已登记；尚未创建并发布可执行版本。');
            reload();
          }}
        />
      ) : null}

      {detail && createVersionOpen ? (
        <CreateToolVersionDialog
          definition={detail.definition}
          onClose={() => setCreateVersionOpen(false)}
          onSaved={() => {
            setCreateVersionOpen(false);
            setNotice('不可变工具版本已创建，下一步必须进入测试。');
            reload();
          }}
        />
      ) : null}

      {detail && lifecycleVersion ? (
        <ToolLifecycleDialog
          definition={detail.definition}
          version={lifecycleVersion}
          onClose={() => setLifecycleVersion(null)}
          onSaved={() => {
            setLifecycleVersion(null);
            setNotice('工具版本生命周期已由服务端确认并记录审计。');
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

function ToolDefinitionDetailPanel({
  detail,
  onCreateVersion,
  onLifecycle,
}: {
  detail: ToolDefinitionDetail;
  onCreateVersion: () => void;
  onLifecycle: (version: ToolVersion) => void;
}): ReactNode {
  return (
    <div className="tool-detail-stack">
      <article className="card tool-definition-detail">
        <header>
          <div>
            <span className="eyebrow">TOOL DEFINITION · r{detail.definition.revision}</span>
            <h2>{detail.definition.name}</h2>
            <p>{detail.definition.description}</p>
          </div>
          <div>
            <StatusPill
              value={detail.definition.status}
              label={toolStatusLabel(detail.definition.status)}
            />
            <button className="button primary compact" type="button" onClick={onCreateVersion}>
              新建版本
            </button>
          </div>
        </header>
        <dl className="tool-definition-metadata">
          <div>
            <dt>Key</dt>
            <dd>{detail.definition.key}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{detail.definition.ownerUserId}</dd>
          </div>
          <div>
            <dt>当前版本</dt>
            <dd>{detail.definition.currentVersion ?? '未发布'}</dd>
          </div>
          <div>
            <dt>权限标签</dt>
            <dd>{detail.definition.permissionLabels.join('、') || '无'}</dd>
          </div>
        </dl>
      </article>

      <section className="card tool-versions">
        <header>
          <div>
            <span className="eyebrow">IMMUTABLE VERSIONS</span>
            <h2>版本与风险</h2>
          </div>
          <small>{detail.versions.length} 个版本</small>
        </header>
        {detail.versions.length === 0 ? (
          <EmptyState
            title="还没有版本"
            description="定义本身不可执行；请创建包含 Schema、风险和出站边界的版本。"
          />
        ) : (
          <div className="tool-version-list">
            {detail.versions.map((version) => {
              const lifecycle = nextToolLifecycleAction(version.status);
              return (
                <article key={version.id}>
                  <header>
                    <div>
                      <span className={`tool-risk risk-${version.riskClass.toLowerCase()}`}>
                        {toolRiskLabel(version.riskClass)}
                      </span>
                      <h3>
                        v{version.version} · {version.name}
                      </h3>
                    </div>
                    <StatusPill value={version.status} label={toolStatusLabel(version.status)} />
                  </header>
                  <p>{version.description}</p>
                  <dl>
                    <div>
                      <dt>Adapter</dt>
                      <dd>{version.adapter}</dd>
                    </div>
                    <div>
                      <dt>Endpoint Ref</dt>
                      <dd>{version.endpointRef}</dd>
                    </div>
                    <div>
                      <dt>Dry Run</dt>
                      <dd>{version.dryRunMode}</dd>
                    </div>
                    <div>
                      <dt>超时 / 重试</dt>
                      <dd>
                        {version.timeoutMs}ms / {version.maxAttempts}
                      </dd>
                    </div>
                    <div>
                      <dt>HTTP 方法</dt>
                      <dd>{version.allowedHttpMethods.join(', ') || '不适用'}</dd>
                    </div>
                    <div>
                      <dt>Host Allowlist</dt>
                      <dd>{version.allowedHostPatterns.join(', ') || '不适用'}</dd>
                    </div>
                    <div>
                      <dt>补偿工具版本</dt>
                      <dd>{version.compensationToolVersionId ?? '未配置'}</dd>
                    </div>
                  </dl>
                  <footer>
                    <small>
                      生效 {formatToolDate(version.effectiveFrom)} · 配置{' '}
                      {version.configurationHash.slice(0, 12)}…
                    </small>
                    {lifecycle ? (
                      <button
                        className={
                          lifecycle === 'RETIRE'
                            ? 'button danger compact'
                            : 'button primary compact'
                        }
                        type="button"
                        onClick={() => onLifecycle(version)}
                      >
                        {toolLifecycleLabel(lifecycle)}
                      </button>
                    ) : (
                      <span>生命周期终态</span>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function CreateToolDefinitionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (definition: ToolDefinition) => void;
}): ReactNode {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: CreateToolDefinitionRequest = {
        key,
        name,
        description,
        permissionLabels: parseToolList(labels),
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await createToolDefinition(input));
    } catch (caught: unknown) {
      setError(toolErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="注册工具定义"
      description="这里只登记治理身份；没有已发布版本时工具不可调用。"
      onClose={onClose}
      dismissible={!saving}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>唯一 Key</span>
          <input
            required
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="crm.customer.read"
          />
        </label>
        <label>
          <span>名称</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>用途说明</span>
          <textarea
            required
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>权限标签</span>
          <input value={labels} onChange={(event) => setLabels(event.target.value)} />
        </label>
        <FieldError message={error} />
        <DialogActions saving={saving} onClose={onClose} label="注册定义" />
      </form>
    </Modal>
  );
}

function CreateToolVersionDialog({
  definition,
  onClose,
  onSaved,
}: {
  definition: ToolDefinition;
  onClose: () => void;
  onSaved: (version: ToolVersion) => void;
}): ReactNode {
  const objectSchema = JSON.stringify(
    { type: 'object', additionalProperties: false, properties: {}, required: [] },
    null,
    2,
  );
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [adapter, setAdapter] = useState<CreateToolVersionRequest['adapter']>('HTTP');
  const [endpointRef, setEndpointRef] = useState('');
  const [riskClass, setRiskClass] = useState<CreateToolVersionRequest['riskClass']>('READ_ONLY');
  const [classification, setClassification] =
    useState<CreateToolVersionRequest['dataClassification']>('INTERNAL');
  const [dryRunMode, setDryRunMode] =
    useState<CreateToolVersionRequest['dryRunMode']>('VALIDATE_ONLY');
  const [idempotencyMode, setIdempotencyMode] =
    useState<CreateToolVersionRequest['idempotencyMode']>('PROVIDER_SUPPORTED');
  const [inputSchema, setInputSchema] = useState(objectSchema);
  const [outputSchema, setOutputSchema] = useState(objectSchema);
  const [methods, setMethods] = useState('GET');
  const [hosts, setHosts] = useState('');
  const [sensitivePaths, setSensitivePaths] = useState('');
  const [compensationToolVersionId, setCompensationToolVersionId] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: CreateToolVersionRequest = {
        name,
        description,
        adapter,
        endpointRef,
        inputSchema: JSON.parse(inputSchema) as Record<string, unknown>,
        outputSchema: JSON.parse(outputSchema) as Record<string, unknown>,
        riskClass,
        dataClassification: classification,
        timeoutMs,
        maxAttempts,
        idempotencyMode,
        dryRunMode,
        allowedHttpMethods:
          adapter === 'HTTP'
            ? (parseToolList(methods) as CreateToolVersionRequest['allowedHttpMethods'])
            : [],
        allowedHostPatterns: adapter === 'HTTP' ? parseToolList(hosts) : [],
        sensitiveInputPaths: parseToolList(sensitivePaths),
        ...(compensationToolVersionId.trim()
          ? { compensationToolVersionId: compensationToolVersionId.trim() }
          : {}),
        effectiveFrom: new Date().toISOString(),
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await createToolVersion(definition.id, input));
    } catch (caught: unknown) {
      setError(toolErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="创建不可变工具版本"
      description="Schema 必须为封闭子集；HTTP 工具必须声明方法和 Host 白名单。"
      onClose={onClose}
      size="wide"
      dismissible={!saving}
    >
      <form className="form-stack tool-version-form" onSubmit={(event) => void submit(event)}>
        <div className="tool-form-grid">
          <label>
            <span>版本名称</span>
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>执行适配器</span>
            <select
              value={adapter}
              onChange={(event) => setAdapter(event.target.value as typeof adapter)}
            >
              <option value="HTTP">HTTP</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="DATABASE">DATABASE</option>
              <option value="QUEUE">QUEUE</option>
            </select>
          </label>
        </div>
        <label>
          <span>版本说明</span>
          <textarea
            required
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>Endpoint Ref（服务端凭据引用，不填写密钥）</span>
          <input
            required
            value={endpointRef}
            onChange={(event) => setEndpointRef(event.target.value)}
            placeholder="secret://crm/customer-read"
          />
        </label>
        <div className="tool-form-grid three">
          <label>
            <span>风险级别</span>
            <select
              value={riskClass}
              onChange={(event) => setRiskClass(event.target.value as typeof riskClass)}
            >
              <option value="READ_ONLY">READ_ONLY</option>
              <option value="DRAFT_ONLY">DRAFT_ONLY</option>
              <option value="CONFIRM_REQUIRED">CONFIRM_REQUIRED</option>
              <option value="HIGH_RISK_APPROVAL">HIGH_RISK_APPROVAL</option>
              <option value="FORBIDDEN">FORBIDDEN</option>
            </select>
          </label>
          <label>
            <span>数据密级</span>
            <select
              value={classification}
              onChange={(event) => setClassification(event.target.value as typeof classification)}
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="CONFIDENTIAL">CONFIDENTIAL</option>
              <option value="RESTRICTED">RESTRICTED</option>
            </select>
          </label>
          <label>
            <span>Dry Run</span>
            <select
              value={dryRunMode}
              onChange={(event) => setDryRunMode(event.target.value as typeof dryRunMode)}
            >
              <option value="NATIVE">NATIVE</option>
              <option value="VALIDATE_ONLY">VALIDATE_ONLY</option>
              <option value="UNSUPPORTED">UNSUPPORTED</option>
            </select>
          </label>
        </div>
        {adapter === 'HTTP' ? (
          <div className="tool-form-grid">
            <label>
              <span>允许的 HTTP 方法</span>
              <input
                required
                value={methods}
                onChange={(event) => setMethods(event.target.value)}
              />
            </label>
            <label>
              <span>Host 白名单</span>
              <input
                required
                value={hosts}
                onChange={(event) => setHosts(event.target.value)}
                placeholder="api.example.com"
              />
            </label>
          </div>
        ) : null}
        <div className="tool-form-grid">
          <label>
            <span>幂等保障</span>
            <select
              value={idempotencyMode}
              onChange={(event) =>
                setIdempotencyMode(
                  event.target.value as CreateToolVersionRequest['idempotencyMode'],
                )
              }
            >
              <option value="PROVIDER_SUPPORTED">外部系统支持幂等</option>
              <option value="REQUIRED">强制幂等键</option>
              <option value="SYSTEM_LEDGER">仅本地账本（只读工具）</option>
            </select>
          </label>
          <label>
            <span>超时（ms）</span>
            <input
              type="number"
              min={100}
              max={120000}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(Number(event.target.value))}
            />
          </label>
          <label>
            <span>最大尝试</span>
            <input
              type="number"
              min={1}
              max={5}
              value={maxAttempts}
              onChange={(event) => setMaxAttempts(Number(event.target.value))}
            />
          </label>
        </div>
        <label>
          <span>敏感输入 JSON Path</span>
          <input
            value={sensitivePaths}
            onChange={(event) => setSensitivePaths(event.target.value)}
            placeholder="$.token, $.customer.phone"
          />
        </label>
        <label>
          <span>补偿工具版本 ID（可选）</span>
          <input
            value={compensationToolVersionId}
            onChange={(event) => setCompensationToolVersionId(event.target.value)}
            placeholder="已发布补偿 Tool Version UUID"
          />
          <small>原调用成功后才可创建独立补偿调用；补偿仍按其风险级别完成确认或审批。</small>
        </label>
        <div className="tool-schema-grid">
          <label>
            <span>Input JSON Schema</span>
            <textarea
              required
              rows={12}
              value={inputSchema}
              onChange={(event) => setInputSchema(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Output JSON Schema</span>
            <textarea
              required
              rows={12}
              value={outputSchema}
              onChange={(event) => setOutputSchema(event.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        <FieldError message={error} />
        <DialogActions saving={saving} onClose={onClose} label="创建版本" />
      </form>
    </Modal>
  );
}

function ToolLifecycleDialog({
  definition,
  version,
  onClose,
  onSaved,
}: {
  definition: ToolDefinition;
  version: ToolVersion;
  onClose: () => void;
  onSaved: (detail: ToolDefinitionDetail) => void;
}): ReactNode {
  const action = nextToolLifecycleAction(version.status);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (action === null) return null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: ToolVersionLifecycleRequest = {
        action,
        expectedDefinitionRevision: definition.revision,
        reason,
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await transitionToolVersion(definition.id, version.id, input));
    } catch (caught: unknown) {
      setError(toolErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={toolLifecycleLabel(action)}
      description={`v${version.version} · ${toolRiskLabel(version.riskClass)}。服务端将校验定义 r${definition.revision}。`}
      onClose={onClose}
      dismissible={!saving}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {action === 'PUBLISH' ? (
          <Notice tone="info">
            发布后员工才能通过组合身份发起调用；高风险版本仍必须由另一审批人批准。
          </Notice>
        ) : null}
        <label>
          <span>操作理由</span>
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <FieldError message={error} />
        <DialogActions
          saving={saving}
          onClose={onClose}
          label={toolLifecycleLabel(action)}
          danger={action === 'RETIRE'}
        />
      </form>
    </Modal>
  );
}

function DialogActions({
  saving,
  onClose,
  label,
  danger = false,
}: {
  saving: boolean;
  onClose: () => void;
  label: string;
  danger?: boolean;
}): ReactNode {
  return (
    <div className="modal-actions">
      <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
        取消
      </button>
      <button
        className={danger ? 'button danger' : 'button primary'}
        type="submit"
        disabled={saving}
      >
        {saving ? <Spinner label="正在提交…" /> : label}
      </button>
    </div>
  );
}
