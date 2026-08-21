import type {
  CreateRoleBlueprintRequest,
  RoleBlueprint,
  RoleCapability,
  RoleKnowledgeDomain,
  RoleProcess,
  RoleResponsibility,
  RoleTool,
  UpdateRoleBlueprintRequest,
} from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ZodError } from 'zod';

import { createRoleBlueprint, updateRoleBlueprint } from '@/api/admin-api';
import { FieldError, Modal, Spinner } from '@/components/ui';

import {
  generatedRoleIdentifier,
  identifierForRenamedRoleField,
  roleBlueprintErrorMessage,
  withGeneratedRoleKeys,
} from './role-blueprint-view';

interface BlueprintFormState {
  key: string;
  name: string;
  description: string;
  mission: string;
  responsibilities: RoleResponsibility[];
  valueStatement: string;
  stakeholderOutcomes: string[];
  measures: string[];
  capabilities: RoleCapability[];
  processes: RoleProcess[];
  tools: RoleTool[];
  knowledgeDomains: RoleKnowledgeDomain[];
}

export function RoleBlueprintEditor({
  blueprint,
  onClose,
  onSaved,
}: {
  blueprint: RoleBlueprint | null;
  onClose: () => void;
  onSaved: (blueprint: RoleBlueprint, created: boolean) => void;
}): ReactNode {
  const editing = blueprint !== null;
  const [form, setForm] = useState<BlueprintFormState>(() => blueprintForm(blueprint));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const structured = structuredInput(form);
      const saved =
        blueprint === null
          ? await createRoleBlueprint({
              key: form.key.trim() || generatedRoleIdentifier(form.name),
              name: form.name,
              description: form.description.trim() ? form.description : null,
              ...structured,
            })
          : await updateRoleBlueprint(blueprint.id, {
              expectedRevision: blueprint.revision,
              name: form.name,
              description: form.description.trim() ? form.description : null,
              ...structured,
            } satisfies UpdateRoleBlueprintRequest);
      onSaved(saved, blueprint === null);
    } catch (caught) {
      setError(roleBlueprintFormError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑角色蓝图' : '新建角色蓝图'}
      description="结构化定义会成为版本设计与后续角色任命的治理依据。"
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack role-blueprint-editor" onSubmit={(event) => void submit(event)}>
        <section className="role-editor-section">
          <header>
            <div>
              <span>01</span>
              <h3>身份与使命</h3>
            </div>
            <p>蓝图标识创建后不可修改；使命应说明该角色为何存在。</p>
          </header>
          <label>
            <span>角色名称</span>
            <input
              autoFocus
              required
              value={form.name}
              maxLength={200}
              onChange={(event) => {
                const name = event.target.value;
                setForm({
                  ...form,
                  name,
                  key: identifierForRenamedRoleField(form.key, form.name, name),
                });
              }}
              placeholder="例如 销售负责人"
            />
          </label>
          <label>
            <span>角色说明</span>
            <textarea
              value={form.description}
              maxLength={5_000}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="说明角色边界、适用场景与协作关系"
            />
          </label>
          <label>
            <span>使命</span>
            <textarea
              required
              className="role-mission-input"
              value={form.mission}
              maxLength={20_000}
              onChange={(event) => setForm({ ...form, mission: event.target.value })}
              placeholder="描述该角色需要持续实现的核心使命"
            />
          </label>
        </section>

        <section className="role-editor-section">
          <header>
            <div>
              <span>02</span>
              <h3>价值定义</h3>
            </div>
            <p>明确价值主张、利益相关方结果和可观察衡量指标。</p>
          </header>
          <label>
            <span>价值主张</span>
            <textarea
              required
              value={form.valueStatement}
              maxLength={2_000}
              onChange={(event) => setForm({ ...form, valueStatement: event.target.value })}
              placeholder="该角色如何为企业和利益相关方创造价值"
            />
          </label>
          <div className="form-grid two">
            <RepeatableTextField
              label="利益相关方结果"
              required
              value={form.stakeholderOutcomes}
              onChange={(stakeholderOutcomes) => setForm({ ...form, stakeholderOutcomes })}
              placeholder="例如：客户获得匹配需求的解决方案"
            />
            <RepeatableTextField
              label="衡量指标"
              value={form.measures}
              onChange={(measures) => setForm({ ...form, measures })}
              placeholder="例如：续约率"
            />
          </div>
        </section>

        <StructuredCollection
          title="职责"
          identifierPrefix="responsibility"
          sequence="03"
          description="至少定义一项职责；预期结果可逐项添加。"
          items={form.responsibilities}
          minimum={1}
          createItem={blankResponsibility}
          onChange={(responsibilities) => setForm({ ...form, responsibilities })}
          renderExtra={(item, replace) => (
            <RepeatableTextField
              label="预期结果"
              value={item.outcomes}
              onChange={(outcomes) => replace({ ...item, outcomes })}
              placeholder="添加一项预期结果"
            />
          )}
        />

        <StructuredCollection
          title="能力"
          identifierPrefix="capability"
          sequence="04"
          description="定义完成职责所需的能力与熟练度。"
          items={form.capabilities}
          createItem={blankCapability}
          onChange={(capabilities) => setForm({ ...form, capabilities })}
          renderExtra={(item, replace) => (
            <label>
              <span>能力级别（可选）</span>
              <select
                value={item.level ?? ''}
                onChange={(event) => {
                  const level = event.target.value;
                  if (level) {
                    replace({
                      ...item,
                      level: level as NonNullable<RoleCapability['level']>,
                    });
                    return;
                  }
                  const { level: _level, ...withoutLevel } = item;
                  replace(withoutLevel);
                }}
              >
                <option value="">未指定</option>
                <option value="FOUNDATIONAL">基础</option>
                <option value="PRACTITIONER">熟练</option>
                <option value="ADVANCED">高级</option>
                <option value="EXPERT">专家</option>
              </select>
            </label>
          )}
        />

        <StructuredCollection
          title="流程"
          identifierPrefix="process"
          sequence="05"
          description="定义角色在企业流程中的责任类型。"
          items={form.processes}
          createItem={blankProcess}
          onChange={(processes) => setForm({ ...form, processes })}
          renderExtra={(item, replace) => (
            <label>
              <span>流程责任</span>
              <select
                value={item.responsibility}
                onChange={(event) =>
                  replace({
                    ...item,
                    responsibility: event.target.value as RoleProcess['responsibility'],
                  })
                }
              >
                <option value="OWNER">负责</option>
                <option value="APPROVER">审批</option>
                <option value="CONTRIBUTOR">参与</option>
                <option value="OBSERVER">观察</option>
              </select>
            </label>
          )}
        />

        <StructuredCollection
          title="工具"
          identifierPrefix="tool"
          sequence="06"
          description="仅声明角色所需访问级别；实际授权仍由发布版本和服务端策略执行。"
          items={form.tools}
          createItem={blankTool}
          onChange={(tools) => setForm({ ...form, tools })}
          renderExtra={(item, replace) => (
            <label>
              <span>访问级别</span>
              <select
                value={item.access}
                onChange={(event) =>
                  replace({ ...item, access: event.target.value as RoleTool['access'] })
                }
              >
                <option value="READ">只读</option>
                <option value="DRAFT">草拟</option>
                <option value="EXECUTE">执行</option>
                <option value="APPROVAL_REQUIRED">需审批</option>
              </select>
            </label>
          )}
        />

        <StructuredCollection
          title="知识域"
          identifierPrefix="knowledge"
          sequence="07"
          description="描述角色依赖的知识边界与敏感级别。"
          items={form.knowledgeDomains}
          createItem={blankKnowledgeDomain}
          onChange={(knowledgeDomains) => setForm({ ...form, knowledgeDomains })}
          renderExtra={(item, replace) => (
            <label>
              <span>敏感级别</span>
              <select
                value={item.sensitivity}
                onChange={(event) =>
                  replace({
                    ...item,
                    sensitivity: event.target.value as RoleKnowledgeDomain['sensitivity'],
                  })
                }
              >
                <option value="PUBLIC">公开</option>
                <option value="INTERNAL">内部</option>
                <option value="CONFIDENTIAL">机密</option>
                <option value="RESTRICTED">严格限制</option>
              </select>
            </label>
          )}
        />

        <FieldError message={error} />
        <div className="modal-actions role-editor-actions">
          <span>保存时会使用修订号进行并发校验。</span>
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : editing ? '保存蓝图' : '创建蓝图'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface NamedRoleElement {
  key: string;
  name: string;
  description: string;
}

function StructuredCollection<T extends NamedRoleElement>({
  title,
  identifierPrefix,
  sequence,
  description,
  items,
  minimum = 0,
  createItem,
  onChange,
  renderExtra,
}: {
  title: string;
  identifierPrefix: string;
  sequence: string;
  description: string;
  items: T[];
  minimum?: number;
  createItem: () => T;
  onChange: (items: T[]) => void;
  renderExtra: (item: T, replace: (item: T) => void) => ReactNode;
}): ReactNode {
  const replaceAt = (index: number, item: T): void => {
    onChange(items.map((current, itemIndex) => (itemIndex === index ? item : current)));
  };
  return (
    <section className="role-editor-section structured-role-section">
      <header>
        <div>
          <span>{sequence}</span>
          <h3>{title}</h3>
        </div>
        <p>{description}</p>
      </header>
      {items.length === 0 ? <p className="structured-empty">尚未添加{title}。</p> : null}
      <div className="structured-role-list">
        {items.map((item, index) => (
          <article className="structured-role-item" key={`${title}-${index}`}>
            <header>
              <strong>
                {title} {index + 1}
              </strong>
              <button
                className="button compact danger-ghost"
                type="button"
                disabled={items.length <= minimum}
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                移除
              </button>
            </header>
            <label>
              <span>名称</span>
              <input
                required
                value={item.name}
                maxLength={200}
                onChange={(event) => {
                  const name = event.target.value;
                  replaceAt(index, {
                    ...item,
                    name,
                    key: identifierForRenamedRoleField(item.key, item.name, name, identifierPrefix),
                  });
                }}
              />
            </label>
            <label>
              <span>说明</span>
              <textarea
                required
                value={item.description}
                maxLength={2_000}
                onChange={(event) => replaceAt(index, { ...item, description: event.target.value })}
              />
            </label>
            {renderExtra(item, (replacement) => replaceAt(index, replacement))}
          </article>
        ))}
      </div>
      <button
        className="button secondary structured-add"
        type="button"
        disabled={items.length >= 100}
        onClick={() => onChange([...items, createItem()])}
      >
        + 添加{title}
      </button>
    </section>
  );
}

function RepeatableTextField({
  label,
  value,
  onChange,
  placeholder,
  required = false,
}: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  required?: boolean;
}): ReactNode {
  return (
    <fieldset className="role-repeatable-text">
      <legend>{label}</legend>
      {value.map((item, index) => (
        <label key={index}>
          <span>
            {label} {index + 1}
          </span>
          <input
            required={required}
            value={item}
            onChange={(event) =>
              onChange(
                value.map((candidate, itemIndex) =>
                  itemIndex === index ? event.target.value : candidate,
                ),
              )
            }
            placeholder={placeholder}
          />
          <button
            type="button"
            className="button compact secondary"
            onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
          >
            移除
          </button>
        </label>
      ))}
      <button
        type="button"
        className="button compact secondary"
        onClick={() => onChange([...value, ''])}
      >
        添加{label}
      </button>
    </fieldset>
  );
}

function blueprintForm(blueprint: RoleBlueprint | null): BlueprintFormState {
  if (blueprint === null) {
    return {
      key: '',
      name: '',
      description: '',
      mission: '',
      responsibilities: [blankResponsibility()],
      valueStatement: '',
      stakeholderOutcomes: [''],
      measures: [],
      capabilities: [],
      processes: [],
      tools: [],
      knowledgeDomains: [],
    };
  }
  return {
    key: blueprint.key,
    name: blueprint.name,
    description: blueprint.description ?? '',
    mission: blueprint.mission,
    responsibilities: blueprint.responsibilities.map((item) => ({
      ...item,
      outcomes: [...item.outcomes],
    })),
    valueStatement: blueprint.valueDefinition.statement,
    stakeholderOutcomes: [...blueprint.valueDefinition.stakeholderOutcomes],
    measures: [...blueprint.valueDefinition.measures],
    capabilities: blueprint.capabilities.map((item) => ({ ...item })),
    processes: blueprint.processes.map((item) => ({ ...item })),
    tools: blueprint.tools.map((item) => ({ ...item })),
    knowledgeDomains: blueprint.knowledgeDomains.map((item) => ({ ...item })),
  };
}

function structuredInput(
  form: BlueprintFormState,
): Pick<
  CreateRoleBlueprintRequest,
  | 'mission'
  | 'responsibilities'
  | 'valueDefinition'
  | 'capabilities'
  | 'processes'
  | 'tools'
  | 'knowledgeDomains'
> {
  return {
    mission: form.mission,
    responsibilities: withGeneratedRoleKeys(form.responsibilities, 'responsibility'),
    valueDefinition: {
      statement: form.valueStatement,
      stakeholderOutcomes: form.stakeholderOutcomes.map((item) => item.trim()).filter(Boolean),
      measures: form.measures.map((item) => item.trim()).filter(Boolean),
    },
    capabilities: withGeneratedRoleKeys(form.capabilities, 'capability'),
    processes: withGeneratedRoleKeys(form.processes, 'process'),
    tools: withGeneratedRoleKeys(form.tools, 'tool'),
    knowledgeDomains: withGeneratedRoleKeys(form.knowledgeDomains, 'knowledge'),
  };
}

function blankResponsibility(): RoleResponsibility {
  return { key: '', name: '', description: '', outcomes: [] };
}

function blankCapability(): RoleCapability {
  return { key: '', name: '', description: '' };
}

function blankProcess(): RoleProcess {
  return { key: '', name: '', description: '', responsibility: 'CONTRIBUTOR' };
}

function blankTool(): RoleTool {
  return { key: '', name: '', description: '', access: 'READ' };
}

function blankKnowledgeDomain(): RoleKnowledgeDomain {
  return { key: '', name: '', description: '', sensitivity: 'INTERNAL' };
}

function roleBlueprintFormError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const field = issue?.path.length ? `${issue.path.join('.')}：` : '';
    return `请检查结构化定义。${field}${issue?.message ?? '字段不符合契约。'}`;
  }
  return roleBlueprintErrorMessage(error);
}
