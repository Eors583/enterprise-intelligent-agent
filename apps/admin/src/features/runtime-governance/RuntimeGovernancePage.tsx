import type {
  BusinessEventDelivery,
  BusinessEventEnvelope,
  ProcessCommand,
  ProcessInstance,
  ProcessStepCommand,
  ProcessStepInstance,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { Modal, Notice, StatusPill } from '@/components/ui';

import {
  getBusinessEventDetail,
  getProcessInstanceDetail,
  listBusinessEvents,
  listProcessInstances,
  replayEventDelivery,
  sendProcessCommand,
  sendProcessStepCommand,
} from './api';
import {
  availableProcessStepCommands,
  commandLabel,
  deliveryStatusLabel,
  formatRuntimeDate,
  isCapabilityUnavailable,
  processCommandsFor,
  processStatusLabel,
  processStepStatusLabel,
  runtimeErrorMessage,
  shortRuntimeId,
  type ProcessCommandName,
  type ProcessStepCommandName,
} from './runtime-view';
import './runtime-governance.css';

type GovernanceSection = 'processes' | 'events' | 'dlq';

const SECTIONS: ReadonlyArray<{
  id: GovernanceSection;
  label: string;
  description: string;
}> = [
  { id: 'processes', label: '流程运行', description: '实例、步骤、补偿与修订' },
  { id: 'events', label: '业务事件', description: 'Envelope、因果与关联追踪' },
  { id: 'dlq', label: 'DLQ', description: '投递异常与人工重放' },
];

export function RuntimeGovernancePage(): ReactNode {
  const [section, setSection] = useState<GovernanceSection>('processes');

  return (
    <section className="page-section runtime-governance-page">
      <header className="page-header runtime-governance-header">
        <div>
          <span className="eyebrow">PROCESS & EVENT GOVERNANCE</span>
          <h1>运行治理</h1>
          <p>查看流程实例、结构化业务事件和死信投递；所有状态均来自服务端契约响应。</p>
        </div>
      </header>

      <div className="runtime-governance-tabs" role="tablist" aria-label="运行治理模块">
        {SECTIONS.map((candidate) => (
          <button
            key={candidate.id}
            id={`runtime-tab-${candidate.id}`}
            type="button"
            role="tab"
            aria-selected={section === candidate.id}
            aria-controls="runtime-governance-panel"
            tabIndex={section === candidate.id ? 0 : -1}
            className={section === candidate.id ? 'active' : ''}
            onClick={() => setSection(candidate.id)}
          >
            <strong>{candidate.label}</strong>
            <small>{candidate.description}</small>
          </button>
        ))}
      </div>

      <div id="runtime-governance-panel" role="tabpanel" aria-labelledby={`runtime-tab-${section}`}>
        {section === 'processes' ? <ProcessRuntimePanel /> : null}
        {section === 'events' ? <BusinessEventsPanel /> : null}
        {section === 'dlq' ? <DeliveryPanel /> : null}
      </div>
    </section>
  );
}

function ProcessRuntimePanel(): ReactNode {
  const [instances, setInstances] = useState<ProcessInstance[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [instanceCommandOpen, setInstanceCommandOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setInstances(null);
    setError(null);
    void listProcessInstances(controller.signal)
      .then((response) => {
        const { items } = response;
        setInstances(items);
        setSelectedId((current) =>
          current && items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const selected = instances?.find((instance) => instance.id === selectedId) ?? null;
  const commands = selected ? processCommandsFor(selected.status) : [];
  const reload = (): void => setReloadKey((current) => current + 1);

  if (instances === null) {
    return (
      <RuntimeLoadState
        label="流程运行"
        error={error}
        loadingMessage="正在读取流程实例…"
        onRetry={reload}
      />
    );
  }

  return (
    <div className="runtime-governance-layout">
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      <aside className="card runtime-record-list" aria-label="流程实例列表">
        <RuntimeListHeader
          title="流程实例"
          count={instances.length}
          refreshing={false}
          onRefresh={reload}
        />
        {instances.length === 0 ? (
          <RuntimeEmpty
            title="暂无流程实例"
            description="服务端已成功响应，但当前租户没有可治理的流程实例。"
          />
        ) : (
          <div>
            {instances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                className={instance.id === selectedId ? 'selected' : ''}
                aria-current={instance.id === selectedId ? 'true' : undefined}
                onClick={() => setSelectedId(instance.id)}
              >
                <span className={`runtime-mark ${instance.status.toLowerCase()}`}>流</span>
                <span>
                  <strong>{shortRuntimeId(instance.id)}</strong>
                  <small>
                    {processStatusLabel(instance.status)} · r{instance.revision}
                  </small>
                  <code>{shortRuntimeId(instance.correlationId)}</code>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {selected ? (
        <div className="runtime-detail-stack">
          <article className="card runtime-detail-card">
            <header>
              <div>
                <span className="eyebrow">PROCESS INSTANCE</span>
                <h2>{shortRuntimeId(selected.id)}</h2>
                <p>版本 v{selected.processVersion} 的不可变运行引用</p>
              </div>
              <div className="runtime-detail-actions">
                <StatusPill value={selected.status} label={processStatusLabel(selected.status)} />
                <button
                  className="button primary compact"
                  type="button"
                  disabled={commands.length === 0}
                  onClick={() => setInstanceCommandOpen(true)}
                >
                  {commands.length === 0 ? '终态不可操作' : '执行命令'}
                </button>
              </div>
            </header>
            <RuntimeIdentityGrid
              entries={[
                ['Correlation ID', selected.correlationId],
                ['Trigger Event', selected.triggerEventId],
                ['Objective', selected.objectiveId],
                ['Task', selected.taskId],
                ['Process Definition', selected.processDefinitionId],
                ['Process Version ID', selected.processVersionId],
              ]}
            />
            <dl className="runtime-time-grid">
              <div>
                <dt>创建</dt>
                <dd>{formatRuntimeDate(selected.createdAt)}</dd>
              </div>
              <div>
                <dt>启动</dt>
                <dd>{formatRuntimeDate(selected.startedAt)}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>{formatRuntimeDate(selected.updatedAt)}</dd>
              </div>
              <div>
                <dt>修订</dt>
                <dd>r{selected.revision}</dd>
              </div>
            </dl>
            {selected.failureCode ? (
              <div className="runtime-failure" role="alert">
                <strong>{selected.failureCode}</strong>
                <span>{selected.failureDetail}</span>
              </div>
            ) : null}
            <JsonSnapshot title="输入快照" value={selected.input} />
            {selected.output ? <JsonSnapshot title="输出快照" value={selected.output} /> : null}
          </article>

          <ProcessStepsPanel instance={selected} parentReload={reload} onNotice={setNotice} />
        </div>
      ) : null}

      {selected && instanceCommandOpen ? (
        <RuntimeCommandDialog
          kind="instance"
          instance={selected}
          commands={commands}
          onClose={() => setInstanceCommandOpen(false)}
          onSaved={() => {
            setInstanceCommandOpen(false);
            setNotice('流程命令已由服务端确认，实例列表已刷新。');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ProcessStepsPanel({
  instance,
  parentReload,
  onNotice,
}: {
  instance: ProcessInstance;
  parentReload: () => void;
  onNotice: (message: string) => void;
}): ReactNode {
  const [steps, setSteps] = useState<ProcessStepInstance[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [commandStep, setCommandStep] = useState<ProcessStepInstance | null>(null);
  const reload = (): void => setReloadKey((current) => current + 1);

  useEffect(() => {
    const controller = new AbortController();
    setSteps(null);
    setError(null);
    void getProcessInstanceDetail(instance.id, controller.signal)
      .then((response) => setSteps(response.steps))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [instance.id, reloadKey]);

  return (
    <section className="card runtime-steps-card" aria-labelledby="runtime-steps-title">
      <RuntimeListHeader
        title="步骤实例"
        titleId="runtime-steps-title"
        count={steps?.length ?? 0}
        refreshing={steps === null}
        onRefresh={reload}
      />
      {steps === null ? (
        <RuntimeLoadState
          label="流程步骤"
          error={error}
          loadingMessage="正在读取步骤实例…"
          onRetry={reload}
          compact
        />
      ) : steps.length === 0 ? (
        <RuntimeEmpty title="暂无步骤实例" description="该流程尚未产生可见步骤。" />
      ) : (
        <div className="runtime-step-list">
          {steps.map((step) => {
            const commands = availableProcessStepCommands(step);
            return (
              <article key={step.id}>
                <span className={`runtime-step-state ${step.status.toLowerCase()}`}>步</span>
                <div>
                  <strong>{step.processNodeCode}</strong>
                  <small>
                    {processStepStatusLabel(step.status)} · 第 {step.attempt} 次 · r{step.revision}
                  </small>
                  <code>{shortRuntimeId(step.id)}</code>
                </div>
                <div>
                  <small>截止 {formatRuntimeDate(step.dueAt)}</small>
                  <button
                    className="button secondary compact"
                    type="button"
                    disabled={commands.length === 0}
                    onClick={() => setCommandStep(step)}
                  >
                    {commands.length === 0 ? '终态' : '步骤命令'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {commandStep ? (
        <RuntimeCommandDialog
          kind="step"
          instance={instance}
          step={commandStep}
          commands={availableProcessStepCommands(commandStep)}
          onClose={() => setCommandStep(null)}
          onSaved={() => {
            setCommandStep(null);
            onNotice('步骤命令已由服务端确认，运行状态已刷新。');
            reload();
            parentReload();
          }}
        />
      ) : null}
    </section>
  );
}

function BusinessEventsPanel(): ReactNode {
  const [events, setEvents] = useState<BusinessEventEnvelope[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = (): void => setReloadKey((current) => current + 1);

  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    setError(null);
    void listBusinessEvents(controller.signal)
      .then((response) => {
        const { items } = response;
        setEvents(items);
        setSelectedId((current) =>
          current && items.some((item) => item.eventId === current)
            ? current
            : (items[0]?.eventId ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reloadKey]);

  if (events === null) {
    return (
      <RuntimeLoadState
        label="业务事件"
        error={error}
        loadingMessage="正在读取业务事件…"
        onRetry={reload}
      />
    );
  }
  const selected = events.find((event) => event.eventId === selectedId) ?? null;

  return (
    <div className="runtime-governance-layout">
      <aside className="card runtime-record-list" aria-label="业务事件列表">
        <RuntimeListHeader
          title="业务事件"
          count={events.length}
          refreshing={false}
          onRefresh={reload}
        />
        {events.length === 0 ? (
          <RuntimeEmpty title="暂无业务事件" description="服务端已成功响应，当前查询结果为空。" />
        ) : (
          <div>
            {events.map((event) => (
              <button
                key={event.eventId}
                type="button"
                className={event.eventId === selectedId ? 'selected' : ''}
                aria-current={event.eventId === selectedId ? 'true' : undefined}
                onClick={() => setSelectedId(event.eventId)}
              >
                <span className="runtime-mark event">事</span>
                <span>
                  <strong>{event.eventType}</strong>
                  <small>
                    {event.subject.type} · schema v{event.schemaVersion}
                  </small>
                  <code>{shortRuntimeId(event.correlationId)}</code>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {selected ? (
        <article className="card runtime-detail-card">
          <header>
            <div>
              <span className="eyebrow">BUSINESS EVENT ENVELOPE</span>
              <h2>{selected.eventType}</h2>
              <p>
                {selected.source.system} / {selected.source.recordId} / {selected.source.version}
              </p>
            </div>
            <StatusPill value={selected.sensitivity} label={selected.sensitivity} />
          </header>
          <RuntimeIdentityGrid
            entries={[
              ['Event ID', selected.eventId],
              ['Correlation ID', selected.correlationId],
              ['Causation ID', selected.causationId],
              ['Aggregate', `${selected.aggregate.type} · ${selected.aggregate.id}`],
              ['Subject', `${selected.subject.type} · ${selected.subject.id}`],
              ['Producer', selected.source.producer],
            ]}
          />
          <dl className="runtime-time-grid">
            <div>
              <dt>发生</dt>
              <dd>{formatRuntimeDate(selected.occurredAt)}</dd>
            </div>
            <div>
              <dt>生产</dt>
              <dd>{formatRuntimeDate(selected.producedAt)}</dd>
            </div>
            <div>
              <dt>保留至</dt>
              <dd>{formatRuntimeDate(selected.retention.retainUntil)}</dd>
            </div>
            <div>
              <dt>保留动作</dt>
              <dd>
                {selected.retention.action}
                {selected.retention.legalHold ? ' · Legal hold' : ''}
              </dd>
            </div>
          </dl>
          <JsonSnapshot title="事件 Payload" value={selected.payload} />
          <section className="runtime-reference-list">
            <header>
              <strong>证据引用</strong>
              <span>{selected.evidenceRefs.length}</span>
            </header>
            {selected.evidenceRefs.length > 0 ? (
              selected.evidenceRefs.map((reference) => (
                <code key={`${reference.evidenceId}:${reference.version}`}>
                  {shortRuntimeId(reference.evidenceId)} · v{reference.version} ·{' '}
                  {reference.contentHash ? `${reference.contentHash.slice(0, 12)}…` : '无哈希'}
                </code>
              ))
            ) : (
              <p>该事件未携带证据引用。</p>
            )}
          </section>
        </article>
      ) : null}
    </div>
  );
}

function DeliveryPanel(): ReactNode {
  const [events, setEvents] = useState<BusinessEventEnvelope[] | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<BusinessEventDelivery[] | null>(null);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [replayOpen, setReplayOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = (): void => setReloadKey((current) => current + 1);

  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    setError(null);
    void listBusinessEvents(controller.signal)
      .then((response) => {
        setEvents(response.items);
        setSelectedEventId((current) =>
          current && response.items.some((item) => item.eventId === current)
            ? current
            : (response.items[0]?.eventId ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedEventId) {
      setDeliveries([]);
      setSelectedDeliveryId(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDeliveries(null);
    setDetailError(null);
    void getBusinessEventDetail(selectedEventId, controller.signal)
      .then((response) => {
        setDeliveries(response.deliveries);
        setSelectedDeliveryId((current) =>
          current && response.deliveries.some((item) => item.id === current)
            ? current
            : (response.deliveries[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setDetailError(caught);
      });
    return () => controller.abort();
  }, [reloadKey, selectedEventId]);

  if (events === null) {
    return (
      <RuntimeLoadState
        label="事件投递与 DLQ"
        error={error}
        loadingMessage="正在读取事件投递…"
        onRetry={reload}
      />
    );
  }
  const selected = deliveries?.find((delivery) => delivery.id === selectedDeliveryId) ?? null;

  return (
    <div className="runtime-governance-layout">
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      <aside className="card runtime-record-list" aria-label="事件投递列表">
        <RuntimeListHeader
          title="事件投递与 DLQ"
          count={deliveries?.length ?? 0}
          refreshing={false}
          onRefresh={reload}
        />
        {events.length === 0 ? (
          <RuntimeEmpty
            title="暂无业务事件"
            description="服务端已成功响应，当前没有可查看投递的业务事件。"
          />
        ) : (
          <>
            <label className="runtime-event-picker">
              <span>业务事件</span>
              <select
                aria-label="选择业务事件"
                value={selectedEventId ?? ''}
                onChange={(event) => setSelectedEventId(event.target.value)}
              >
                {events.map((event) => (
                  <option key={event.eventId} value={event.eventId}>
                    {event.eventType} · {shortRuntimeId(event.eventId)}
                  </option>
                ))}
              </select>
            </label>
            {deliveries === null ? (
              <RuntimeLoadState
                label="事件投递详情"
                error={detailError}
                loadingMessage="正在读取事件投递…"
                onRetry={reload}
                compact
              />
            ) : deliveries.length === 0 ? (
              <RuntimeEmpty
                title="该事件暂无投递"
                description="事件详情已通过共享契约校验，投递列表为空。"
              />
            ) : (
              <div>
                {deliveries.map((delivery) => (
                  <button
                    key={delivery.id}
                    type="button"
                    className={delivery.id === selectedDeliveryId ? 'selected' : ''}
                    aria-current={delivery.id === selectedDeliveryId ? 'true' : undefined}
                    onClick={() => setSelectedDeliveryId(delivery.id)}
                  >
                    <span className={`runtime-mark ${delivery.status.toLowerCase()}`}>投</span>
                    <span>
                      <strong>{delivery.consumerName}</strong>
                      <small>
                        {deliveryStatusLabel(delivery.status)} · {delivery.attempts} 次
                      </small>
                      <code>{shortRuntimeId(delivery.businessEventId)}</code>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </aside>

      {selected ? (
        <article className="card runtime-detail-card">
          <header>
            <div>
              <span className="eyebrow">EVENT DELIVERY</span>
              <h2>{selected.consumerName}</h2>
              <p>事件 {shortRuntimeId(selected.businessEventId)}</p>
            </div>
            <div className="runtime-detail-actions">
              <StatusPill value={selected.status} label={deliveryStatusLabel(selected.status)} />
              <button
                className="button primary compact"
                type="button"
                disabled={selected.status !== 'DEAD_LETTERED'}
                onClick={() => setReplayOpen(true)}
              >
                {selected.status === 'DEAD_LETTERED' ? '人工重放' : '仅死信可重放'}
              </button>
            </div>
          </header>
          <RuntimeIdentityGrid
            entries={[
              ['Delivery ID', selected.id],
              ['Business Event ID', selected.businessEventId],
              ['Consumer', selected.consumerName],
              ['Revision', String(selected.revision)],
              ['Replay count', String(selected.replayCount)],
              ['Lease holder', selected.lockedBy],
            ]}
          />
          <dl className="runtime-time-grid">
            <div>
              <dt>可用时间</dt>
              <dd>{formatRuntimeDate(selected.availableAt)}</dd>
            </div>
            <div>
              <dt>锁定至</dt>
              <dd>{formatRuntimeDate(selected.lockedUntil)}</dd>
            </div>
            <div>
              <dt>处理时间</dt>
              <dd>{formatRuntimeDate(selected.processedAt)}</dd>
            </div>
            <div>
              <dt>死信时间</dt>
              <dd>{formatRuntimeDate(selected.deadLetteredAt)}</dd>
            </div>
            <div>
              <dt>最近重放</dt>
              <dd>{formatRuntimeDate(selected.replayedAt)}</dd>
            </div>
          </dl>
          {selected.replayCount > 0 ? (
            <p className="runtime-muted">
              最近由 {selected.replayedByUserId ?? '未知管理员'} 重放：{selected.replayReason}
            </p>
          ) : null}
          {selected.lastErrorCode ? (
            <div className="runtime-failure" role="alert">
              <strong>{selected.lastErrorCode}</strong>
              <span>{selected.lastErrorDetail}</span>
            </div>
          ) : (
            <p className="runtime-muted">服务端未返回投递错误。</p>
          )}
        </article>
      ) : null}

      {selected && replayOpen ? (
        <ReplayDialog
          delivery={selected}
          onClose={() => setReplayOpen(false)}
          onSaved={() => {
            setReplayOpen(false);
            setNotice('重放请求已由服务端确认，投递状态已刷新。');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

type RuntimeCommandDialogProps =
  | {
      kind: 'instance';
      instance: ProcessInstance;
      commands: readonly ProcessCommandName[];
      onClose: () => void;
      onSaved: () => void;
    }
  | {
      kind: 'step';
      instance: ProcessInstance;
      step: ProcessStepInstance;
      commands: readonly ProcessStepCommandName[];
      onClose: () => void;
      onSaved: () => void;
    };

function RuntimeCommandDialog(props: RuntimeCommandDialogProps): ReactNode {
  const [command, setCommand] = useState<string>(props.commands[0] ?? '');
  const [reason, setReason] = useState('');
  const [failureCode, setFailureCode] = useState('');
  const [failureDetail, setFailureDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `admin-runtime:${crypto.randomUUID()}`);
  const failureCommand = command === 'FAIL' || command === 'FAIL_COMPENSATION';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (props.kind === 'instance') {
        const input: ProcessCommand = {
          processInstanceId: props.instance.id,
          expectedRevision: props.instance.revision,
          command: command as ProcessCommandName,
          reason,
          effectiveAt: new Date().toISOString(),
          idempotencyKey,
          ...(failureCommand ? { failureCode, failureDetail } : {}),
        };
        await sendProcessCommand(props.instance.id, input);
      } else {
        const input: ProcessStepCommand = {
          stepInstanceId: props.step.id,
          expectedRevision: props.step.revision,
          command: command as ProcessStepCommandName,
          actorRoleAssignmentId: props.step.resolvedRoleAssignmentId,
          reason,
          effectiveAt: new Date().toISOString(),
          idempotencyKey,
          ...(failureCommand ? { failureCode, failureDetail } : {}),
        };
        await sendProcessStepCommand(props.instance.id, props.step.id, input);
      }
      props.onSaved();
    } catch (caught) {
      setError(runtimeErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={props.kind === 'instance' ? '执行流程命令' : '执行步骤命令'}
      description="expectedRevision 与幂等键会随请求提交；仅服务端确认后才显示成功。"
      onClose={props.onClose}
      dismissible={!submitting}
    >
      <form className="form-stack runtime-command-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>命令</span>
          <select
            aria-label="运行命令"
            value={command}
            disabled={submitting}
            onChange={(event) => setCommand(event.target.value)}
          >
            {props.commands.map((candidate) => (
              <option key={candidate} value={candidate}>
                {commandLabel(candidate)} ({candidate})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>原因</span>
          <textarea
            value={reason}
            disabled={submitting}
            rows={3}
            required
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {failureCommand ? (
          <>
            <label>
              <span>失败代码</span>
              <input
                value={failureCode}
                disabled={submitting}
                required
                onChange={(event) => setFailureCode(event.target.value)}
              />
            </label>
            <label>
              <span>失败详情</span>
              <textarea
                value={failureDetail}
                disabled={submitting}
                rows={4}
                required
                onChange={(event) => setFailureDetail(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <code>
          expectedRevision:{' '}
          {props.kind === 'instance' ? props.instance.revision : props.step.revision}
        </code>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-actions">
          <button
            className="button secondary"
            type="button"
            disabled={submitting}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || command.length === 0 || reason.trim().length === 0}
          >
            {submitting ? '等待服务端确认…' : '提交命令'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ReplayDialog({
  delivery,
  onClose,
  onSaved,
}: {
  delivery: BusinessEventDelivery;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `admin-dlq:${crypto.randomUUID()}`);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await replayEventDelivery(delivery.id, {
        expectedStatus: 'DEAD_LETTERED',
        reason,
        idempotencyKey,
      });
      onSaved();
    } catch (caught) {
      setError(runtimeErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="人工重放死信"
      description="仅 DEAD_LETTERED 状态允许重放；服务端会再次校验当前状态和幂等键。"
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack runtime-command-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>重放原因</span>
          <textarea
            value={reason}
            disabled={submitting}
            rows={4}
            required
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="modal-actions">
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
            disabled={submitting || reason.trim().length === 0}
          >
            {submitting ? '等待服务端确认…' : '确认重放'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function RuntimeLoadState({
  label,
  error,
  loadingMessage,
  onRetry,
  compact = false,
}: {
  label: string;
  error: unknown;
  loadingMessage: string;
  onRetry: () => void;
  compact?: boolean;
}): ReactNode {
  if (error) {
    const unavailable = isCapabilityUnavailable(error);
    return (
      <div
        className={`runtime-load-state error ${compact ? 'compact' : ''}`}
        role="alert"
        data-capability-state={unavailable ? 'unavailable' : 'error'}
      >
        <strong>{unavailable ? `${label}能力未接通` : `${label}加载失败`}</strong>
        <p>{runtimeErrorMessage(error)}</p>
        <button className="button secondary compact" type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  return (
    <div className={`runtime-load-state ${compact ? 'compact' : ''}`} role="status">
      <span className="spinner" aria-hidden="true" />
      <strong>{loadingMessage}</strong>
    </div>
  );
}

function RuntimeListHeader({
  title,
  titleId,
  count,
  refreshing,
  onRefresh,
}: {
  title: string;
  titleId?: string;
  count: number;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactNode {
  return (
    <header>
      <div>
        <strong id={titleId}>{title}</strong>
        <small>{count} 条服务端记录</small>
      </div>
      <button
        className="button secondary compact"
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing ? '刷新中…' : '刷新'}
      </button>
    </header>
  );
}

function RuntimeEmpty({ title, description }: { title: string; description: string }): ReactNode {
  return (
    <div className="runtime-empty">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function RuntimeIdentityGrid({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string | null]>;
}): ReactNode {
  return (
    <dl className="runtime-identity-grid">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value ?? undefined}>{value === null ? '—' : shortRuntimeId(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function JsonSnapshot({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown>;
}): ReactNode {
  return (
    <section className="runtime-json-snapshot">
      <strong>{title}</strong>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
