import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ZodError } from 'zod';

import { listRoleAssignments } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { EntityMultiPicker, EntitySelect, type EntityOption } from '@/components/EntityPicker';
import { FieldError, Modal, Notice, Spinner } from '@/components/ui';

import {
  listEvidence,
  listMetricDefinitions,
  listObjectives,
  listProcessDefinitions,
  listProcessVersions,
  listStrategies,
  listTaskDeliverables,
  listTasks,
  listValueDefinitions,
  listValueVersions,
} from './api';

export interface ContractJsonEditorConfig {
  title: string;
  description: string;
  initialValue: unknown;
  submitLabel: string;
  parse: (value: unknown) => unknown;
  submit: (value: unknown) => Promise<unknown>;
}

type FieldPath = readonly (string | number)[];

interface ProcessChoice extends EntityOption {
  reference: ProcessReference;
}

interface ProcessReference {
  definitionId: string;
  definitionCode: string;
  versionId: string;
  version: number;
  nodeId: string;
  nodeCode: string;
  instanceId: string | null;
}

interface BusinessCatalog {
  byField: Readonly<Record<string, readonly EntityOption[]>>;
  processChoices: readonly ProcessChoice[];
}

const EMPTY_CATALOG: BusinessCatalog = { byField: {}, processChoices: [] };

const SYSTEM_FIELDS = new Set([
  'code',
  'expectedRevision',
  'expectedDefinitionRevision',
  'idempotencyKey',
  'owner',
  'permissionLabels',
  'effectiveFrom',
  'effectiveTo',
  'observedAt',
  'verifiedBy',
  'verifiedAt',
  'submittedAt',
  'decidedBy',
  'decidedAt',
  'contentHash',
  'contentHashAlgorithm',
  'sourceSystem',
  'sourceRecordId',
  'sourceVersion',
  'configuration',
  'ordinal',
  'targetVersion',
  'externalRunId',
]);

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '名称',
  title: '标题',
  description: '说明',
  statement: '说明内容',
  summary: '摘要',
  comment: '备注',
  reason: '原因',
  changeSummary: '本次变更说明',
  type: '类型',
  priority: '优先级',
  dueAt: '截止时间',
  bscPerspective: '平衡计分卡视角',
  indicatorType: '指标属性',
  weight: '权重',
  valueType: '数值类型',
  unit: '单位',
  aggregation: '汇总方式',
  direction: '目标方向',
  confidence: '可信度',
  trustLevel: '验证状态',
  lagDays: '滞后天数',
  lagMinutes: '滞后分钟',
  relevance: '相关程度',
  decision: '验收决定',
  mandatory: '是否必选',
  passed: '是否通过',
  score: '分数',
  positiveBehaviors: '鼓励行为',
  negativeBehaviors: '不鼓励行为',
  requiredEvidenceTypes: '所需证据类型',
  metrics: '指标',
  constraints: '约束',
  nodes: '流程步骤',
  criteria: '验收项',
  target: '目标值',
  kind: '比较方式',
  value: '目标值',
  min: '最小值',
  max: '最大值',
  currency: '币种',
  amount: '金额',
  severity: '严重程度',
  artifactUri: '交付物链接',
  sourceUri: '来源链接',
};

const ASSOCIATION_LABELS: Readonly<Record<string, string>> = {
  valueVersionIds: '价值版本',
  strategyId: '所属战略',
  parentObjectiveId: '上级目标',
  objectiveId: '所属目标',
  sourceObjectiveId: '起点目标',
  targetObjectiveId: '关联目标',
  metricDefinitionIds: '指标口径',
  metricDefinitionId: '指标口径',
  responsibleRoleAssignmentIds: '责任角色',
  valueDefinitionId: '价值定义',
  predecessorTaskId: '前置任务',
  successorTaskId: '后继任务',
  taskId: '任务',
  evidenceIds: '证据',
  evidenceId: '证据',
  deliverableId: '交付物',
  targetId: '关联业务对象',
};

const ENUM_OPTIONS: Readonly<Record<string, readonly { value: string; label: string }[]>> = {
  bscPerspective: [
    { value: 'FINANCIAL', label: '财务' },
    { value: 'CUSTOMER', label: '客户' },
    { value: 'INTERNAL_PROCESS', label: '内部流程' },
    { value: 'LEARNING_GROWTH', label: '学习与成长' },
  ],
  indicatorType: [
    { value: 'LEADING', label: '前置指标' },
    { value: 'LAGGING', label: '结果指标' },
  ],
  priority: [
    { value: 'LOW', label: '低' },
    { value: 'MEDIUM', label: '中' },
    { value: 'HIGH', label: '高' },
    { value: 'CRITICAL', label: '紧急' },
  ],
  valueType: [
    { value: 'NUMBER', label: '数值' },
    { value: 'PERCENTAGE', label: '百分比' },
    { value: 'CURRENCY', label: '金额' },
    { value: 'DURATION', label: '时长' },
    { value: 'BOOLEAN', label: '是/否' },
  ],
  aggregation: [
    { value: 'LATEST', label: '取最新值' },
    { value: 'SUM', label: '求和' },
    { value: 'AVERAGE', label: '取平均值' },
    { value: 'MIN', label: '取最小值' },
    { value: 'MAX', label: '取最大值' },
  ],
  direction: [
    { value: 'INCREASE', label: '越高越好' },
    { value: 'DECREASE', label: '越低越好' },
    { value: 'RANGE', label: '保持区间' },
  ],
  trustLevel: [
    { value: 'UNVERIFIED', label: '待验证' },
    { value: 'VERIFIED', label: '已验证' },
    { value: 'REJECTED', label: '已拒绝' },
  ],
  severity: [
    { value: 'INFO', label: '提示' },
    { value: 'WARNING', label: '警告' },
    { value: 'BLOCKING', label: '阻断' },
  ],
  decision: [
    { value: 'ACCEPTED', label: '通过' },
    { value: 'REJECTED', label: '不通过' },
    { value: 'CONDITIONAL', label: '有条件通过' },
  ],
  kind: [
    { value: 'AT_LEAST', label: '至少达到' },
    { value: 'AT_MOST', label: '不超过' },
    { value: 'EXACT', label: '等于' },
    { value: 'RANGE', label: '位于区间' },
  ],
};

export function ContractJsonEditor({
  config,
  onClose,
  onSaved,
}: {
  config: ContractJsonEditorConfig;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [value, setValue] = useState<unknown>(() => sanitizeInitialValue(config.initialValue));
  const [catalog, setCatalog] = useState<BusinessCatalog>(EMPTY_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadBusinessCatalog(controller.signal)
      .then(setCatalog)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setCatalogError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const parsed = config.parse(prepareBusinessPayload(value, config.title));
      await config.submit(parsed);
      onSaved();
    } catch (caught) {
      setError(contractEditorError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const update = (path: FieldPath, next: unknown): void => {
    setValue((current: unknown) => setValueAtPath(current, path, next));
  };

  return (
    <Modal
      title={config.title}
      description={businessDescription(config.description)}
      onClose={onClose}
      dismissible={!submitting}
      size="wide"
    >
      <form
        className="form-stack semantic-business-editor"
        onSubmit={(event) => void submit(event)}
      >
        <Notice tone="info">
          只需填写业务内容。记录编号、权限范围、版本信息和校验信息由系统自动生成或继承。
        </Notice>
        {catalogLoading ? <Spinner label="正在加载可选择的业务对象…" /> : null}
        {catalogError ? (
          <Notice tone="info">关联目录暂时加载失败：{catalogError}。请刷新后重试。</Notice>
        ) : null}
        <BusinessFields value={value} path={[]} catalog={catalog} update={update} />
        <FieldError message={error} />
        <footer className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting || catalogLoading}>
            {submitting ? '正在保存…' : config.submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function BusinessFields({
  value,
  path,
  catalog,
  update,
}: {
  value: unknown;
  path: FieldPath;
  catalog: BusinessCatalog;
  update: (path: FieldPath, next: unknown) => void;
}): ReactNode {
  if (!isRecord(value)) return null;
  const visibleEntries = Object.entries(value).filter(([key]) => !shouldHideField(key));
  return (
    <div className="semantic-business-fields">
      {visibleEntries.map(([key, fieldValue]) => (
        <BusinessField
          key={[...path, key].join('.')}
          name={key}
          value={fieldValue}
          parent={value}
          path={[...path, key]}
          catalog={catalog}
          update={update}
        />
      ))}
    </div>
  );
}

function BusinessField({
  name,
  value,
  parent,
  path,
  catalog,
  update,
}: {
  name: string;
  value: unknown;
  parent: Record<string, unknown>;
  path: FieldPath;
  catalog: BusinessCatalog;
  update: (path: FieldPath, next: unknown) => void;
}): ReactNode {
  const label = ASSOCIATION_LABELS[name] ?? FIELD_LABELS[name] ?? humanizeFieldName(name);
  const associationOptions = associationChoices(name, parent, catalog);
  if (associationOptions) {
    if (Array.isArray(value)) {
      return (
        <fieldset className="semantic-business-group">
          <legend>{label}</legend>
          <EntityMultiPicker
            value={value.filter((item): item is string => typeof item === 'string')}
            options={associationOptions}
            onChange={(next) => update(path, next)}
            ariaLabel={label}
          />
        </fieldset>
      );
    }
    return (
      <label>
        <span>{label}</span>
        <EntitySelect
          value={typeof value === 'string' ? value : ''}
          options={associationOptions}
          onChange={(next) => update(path, next || (value === null ? null : ''))}
          placeholder={`请选择${label}`}
          required={value !== null}
          ariaLabel={label}
        />
      </label>
    );
  }

  if (name === 'processRef' && isRecord(value)) {
    const selected = catalog.processChoices.find(
      (choice) =>
        choice.reference.versionId === value.versionId && choice.reference.nodeId === value.nodeId,
    );
    return (
      <label>
        <span>执行流程步骤</span>
        <select
          value={selected?.id ?? ''}
          required
          onChange={(event) => {
            const choice = catalog.processChoices.find(({ id }) => id === event.target.value);
            if (choice) update(path, choice.reference);
          }}
        >
          <option value="">请选择已发布流程中的步骤</option>
          {catalog.processChoices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (Array.isArray(value)) {
    return (
      <BusinessArrayField name={name} value={value} path={path} catalog={catalog} update={update} />
    );
  }

  if (isRecord(value)) {
    return (
      <fieldset className="semantic-business-group">
        <legend>{label}</legend>
        <BusinessFields value={value} path={path} catalog={catalog} update={update} />
      </fieldset>
    );
  }

  const enumOptions = enumChoices(name, value);
  if (enumOptions) {
    return (
      <label>
        <span>{label}</span>
        <select value={String(value ?? '')} onChange={(event) => update(path, event.target.value)}>
          {enumOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <label className="semantic-business-check">
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => update(path, event.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }
  if (typeof value === 'number') {
    return (
      <label>
        <span>{label}</span>
        <input
          type="number"
          step="any"
          value={value}
          onChange={(event) => update(path, Number(event.target.value))}
        />
      </label>
    );
  }
  if (name === 'dueAt') {
    return (
      <label>
        <span>{label}</span>
        <input
          type="datetime-local"
          value={toLocalDateTime(typeof value === 'string' ? value : '')}
          onChange={(event) => update(path, new Date(event.target.value).toISOString())}
        />
      </label>
    );
  }
  const textValue = typeof value === 'string' ? value : '';
  const multiline = /description|statement|summary|comment|reason|changeSummary/u.test(name);
  return (
    <label>
      <span>{label}</span>
      {multiline ? (
        <textarea
          rows={3}
          value={textValue}
          onChange={(event) => update(path, event.target.value)}
        />
      ) : (
        <input
          type={name.endsWith('Uri') ? 'url' : 'text'}
          value={textValue}
          onChange={(event) => update(path, event.target.value)}
        />
      )}
    </label>
  );
}

function BusinessArrayField({
  name,
  value,
  path,
  catalog,
  update,
}: {
  name: string;
  value: readonly unknown[];
  path: FieldPath;
  catalog: BusinessCatalog;
  update: (path: FieldPath, next: unknown) => void;
}): ReactNode {
  const label = FIELD_LABELS[name] ?? humanizeFieldName(name);
  const objectItems = value.some(isRecord);
  const template = objectArrayTemplate(name, value);
  return (
    <fieldset className="semantic-business-group">
      <legend>{label}</legend>
      {value.length === 0 ? <p className="form-hint">当前没有{label}。</p> : null}
      <div className="semantic-repeatable-list">
        {value.map((item, index) => (
          <article key={index} className="semantic-repeatable-item">
            {isRecord(item) ? (
              <BusinessFields
                value={item}
                path={[...path, index]}
                catalog={catalog}
                update={update}
              />
            ) : (
              <label>
                <span>
                  {label} {index + 1}
                </span>
                <input
                  value={typeof item === 'string' ? item : String(item ?? '')}
                  onChange={(event) => update([...path, index], event.target.value)}
                />
              </label>
            )}
            <button
              className="button compact secondary"
              type="button"
              onClick={() =>
                update(
                  path,
                  value.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              移除
            </button>
          </article>
        ))}
      </div>
      {template !== null || !objectItems ? (
        <button
          className="button compact secondary"
          type="button"
          onClick={() => update(path, [...value, template ?? ''])}
        >
          添加{label}
        </button>
      ) : null}
    </fieldset>
  );
}

async function loadBusinessCatalog(signal: AbortSignal): Promise<BusinessCatalog> {
  const [values, strategies, objectives, metrics, processes, tasks, evidence, assignments] =
    await Promise.all([
      listValueDefinitions(signal),
      listStrategies(signal),
      listObjectives(signal),
      listMetricDefinitions(signal),
      listProcessDefinitions(signal),
      listTasks(signal),
      listEvidence(signal),
      listRoleAssignments(signal),
    ]);
  const [valueVersionGroups, processVersionGroups, deliverableGroups] = await Promise.all([
    Promise.all(
      values.map(async (item) => ({ item, versions: await listValueVersions(item.id, signal) })),
    ),
    Promise.all(
      processes.map(async (item) => ({
        item,
        versions: await listProcessVersions(item.id, signal),
      })),
    ),
    Promise.all(
      tasks.map(async (item) => ({
        item,
        deliverables: await listTaskDeliverables(item.id, signal),
      })),
    ),
  ]);
  const options = <T extends { id: string }>(
    items: readonly T[],
    label: (item: T) => string,
  ): EntityOption[] => items.map((item) => ({ id: item.id, label: label(item) }));
  const valueVersions = valueVersionGroups.flatMap(({ item, versions }) =>
    versions.map((version) => ({
      id: version.id,
      label: `${item.name} · 第 ${version.version} 版`,
    })),
  );
  const deliverables = deliverableGroups.flatMap(({ item, deliverables: items }) =>
    items.map((deliverable) => ({
      id: deliverable.id,
      label: `${item.title} / ${deliverable.title}`,
    })),
  );
  const processChoices = processVersionGroups.flatMap(({ item, versions }) =>
    versions
      .filter((version) => version.status === 'PUBLISHED')
      .flatMap((version) =>
        version.nodes.map((node) => ({
          id: `${version.id}:${node.id}`,
          label: `${item.name} · 第 ${version.version} 版 · ${node.name}`,
          reference: {
            definitionId: item.id,
            definitionCode: item.code,
            versionId: version.id,
            version: version.version,
            nodeId: node.id,
            nodeCode: node.code,
            instanceId: null,
          },
        })),
      ),
  );
  const objectiveOptions = options(objectives, (item) => item.name);
  const taskOptions = options(tasks, (item) => item.title);
  const evidenceOptions = options(evidence, (item) => item.summary || item.code);
  return {
    processChoices,
    byField: {
      valueVersionIds: valueVersions,
      strategyId: options(strategies, (item) => item.name),
      parentObjectiveId: objectiveOptions,
      objectiveId: objectiveOptions,
      sourceObjectiveId: objectiveOptions,
      targetObjectiveId: objectiveOptions,
      metricDefinitionIds: options(metrics, (item) => item.name),
      metricDefinitionId: options(metrics, (item) => item.name),
      responsibleRoleAssignmentIds: assignments.items.map((item) => ({
        id: item.id,
        label: item.agent.name,
      })),
      valueDefinitionId: options(values, (item) => item.name),
      predecessorTaskId: taskOptions,
      successorTaskId: taskOptions,
      taskId: taskOptions,
      evidenceIds: evidenceOptions,
      evidenceId: evidenceOptions,
      deliverableId: deliverables,
      targetId: [...objectiveOptions, ...taskOptions, ...deliverables],
    },
  };
}

function associationChoices(
  name: string,
  _parent: Record<string, unknown>,
  catalog: BusinessCatalog,
): readonly EntityOption[] | null {
  return catalog.byField[name] ?? null;
}

function shouldHideField(name: string): boolean {
  return SYSTEM_FIELDS.has(name) || /(?:Hash|Fingerprint|Revision)$/u.test(name);
}

function enumChoices(
  name: string,
  value: unknown,
): readonly { value: string; label: string }[] | null {
  const configured = ENUM_OPTIONS[name];
  if (configured) return configured;
  if (name !== 'type' || typeof value !== 'string') return null;
  if (['ENTERPRISE', 'DIVISION', 'TEAM', 'PERSONAL'].includes(value)) {
    return [
      { value: 'ENTERPRISE', label: '企业' },
      { value: 'DIVISION', label: '事业部' },
      { value: 'TEAM', label: '团队' },
      { value: 'PERSONAL', label: '个人' },
    ];
  }
  if (['START', 'ACTIVITY', 'GATEWAY', 'END'].includes(value)) {
    return [
      { value: 'START', label: '开始' },
      { value: 'ACTIVITY', label: '办理步骤' },
      { value: 'GATEWAY', label: '判断分支' },
      { value: 'END', label: '结束' },
    ];
  }
  if (['FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH'].includes(value)) {
    return [
      { value: 'FINISH_TO_START', label: '前置完成后开始' },
      { value: 'START_TO_START', label: '前置开始后开始' },
      { value: 'FINISH_TO_FINISH', label: '前置完成后完成' },
    ];
  }
  if (['SUPPORTS', 'CAUSES', 'PARENT_CHILD', 'CONTRADICTS', 'DERIVED_FROM'].includes(value)) {
    return [
      { value: 'SUPPORTS', label: '支持' },
      { value: 'CAUSES', label: '促进' },
      { value: 'PARENT_CHILD', label: '上下级' },
      { value: 'CONTRADICTS', label: '存在冲突' },
      { value: 'DERIVED_FROM', label: '来源于' },
    ];
  }
  return null;
}

function objectArrayTemplate(
  name: string,
  value: readonly unknown[],
): Record<string, unknown> | null {
  const first = value.find(isRecord);
  if (first) return clearBusinessTemplate(first);
  if (name === 'constraints') {
    return {
      code: 'CONSTRAINT.NEW',
      type: 'POLICY',
      severity: 'WARNING',
      statement: '',
      requiredEvidenceTypes: [],
      permissionLabels: [],
    };
  }
  return null;
}

function clearBusinessTemplate(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === 'code')
        return [key, `${String(item).split('.').slice(0, -1).join('.') || 'ITEM'}.NEW`];
      if (SYSTEM_FIELDS.has(key)) return [key, item];
      if (typeof item === 'string') return [key, enumChoices(key, item) ? item : ''];
      if (typeof item === 'number') return [key, key === 'weight' ? 1 : 0];
      if (typeof item === 'boolean') return [key, item];
      if (Array.isArray(item)) return [key, []];
      if (isRecord(item)) return [key, clearBusinessTemplate(item)];
      return [key, item];
    }),
  );
}

function sanitizeInitialValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sanitizeInitialValue).filter((item) => !isPlaceholder(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeInitialValue(item)]),
    );
  }
  return isPlaceholder(value) ? '' : value;
}

function prepareBusinessPayload(value: unknown, title: string): unknown {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const visit = (item: unknown, parent: Record<string, unknown> | null): unknown => {
    if (Array.isArray(item))
      return item.map((entry) => visit(entry, isRecord(entry) ? entry : parent));
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => {
        if (
          key === 'code' &&
          (entry === '' || (typeof entry === 'string' && entry.endsWith('.NEW')))
        ) {
          const prefix =
            typeof entry === 'string' && entry.includes('.') ? entry.split('.')[0] : 'ITEM';
          const source = String(item.name ?? item.title ?? item.description ?? title);
          return [key, `${prefix}.${businessSlug(source)}.${suffix}`];
        }
        return [key, visit(entry, item)];
      }),
    );
  };
  return visit(value, null);
}

function businessSlug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '.')
    .replace(/^\.|\.$/gu, '');
  return normalized || 'RECORD';
}

function setValueAtPath(root: unknown, path: FieldPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...tail] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(head)] = setValueAtPath(copy[Number(head)], tail, next);
    return copy;
  }
  const record = isRecord(root) ? root : {};
  return { ...record, [String(head)]: setValueAtPath(record[String(head)], tail, next) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && /^<[^>]+>$/u.test(value);
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function businessDescription(description: string): string {
  return /(?:JSON|SHA|UUID|ID|DTO|contract|revision|code|artifact)/iu.test(description)
    ? '填写业务信息并选择已存在的关联记录，系统会自动处理编号、权限、版本和一致性校验。'
    : description;
}

function humanizeFieldName(name: string): string {
  return (
    name
      .replace(/([a-z])([A-Z])/gu, '$1 $2')
      .replace(/Ids?$/u, '')
      .trim() || '业务信息'
  );
}

function contractEditorError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const rawField = String(issue?.path.at(-1) ?? '表单');
    const field =
      ASSOCIATION_LABELS[rawField] ?? FIELD_LABELS[rawField] ?? humanizeFieldName(rawField);
    return `${field}：${issue?.message ?? '请检查填写内容。'}`;
  }
  return messageFromError(error);
}
