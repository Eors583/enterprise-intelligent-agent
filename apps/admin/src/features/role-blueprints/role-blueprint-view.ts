import type { RoleBlueprint, RoleVersion } from '@enterprise/contracts';

import { ApiError, messageFromError } from '@/api/client';

export interface RoleVersionActions {
  canEdit: boolean;
  canSubmit: boolean;
  canReview: boolean;
  reviewBlockedForAuthor: boolean;
  canPublish: boolean;
  canRetire: boolean;
  canRollback: boolean;
}

export type RoleVersionDiffKind = 'added' | 'removed' | 'changed';

export interface RoleVersionDiffEntry {
  id: string;
  path: readonly string[];
  label: string;
  section: 'roleDefinition' | 'systemPrompt' | 'modelPolicy' | 'toolPolicy' | 'knowledgeScope';
  kind: RoleVersionDiffKind;
  before: string | null;
  after: string | null;
}

export function roleVersionActions(
  version: RoleVersion,
  currentUserId: string,
  currentPublishedVersionId: string | null,
): RoleVersionActions {
  const inReview = version.status === 'TESTING' && version.reviewStatus === 'IN_REVIEW';
  return {
    canEdit: version.status === 'DRAFT',
    canSubmit: version.status === 'DRAFT',
    canReview: inReview && version.createdById !== currentUserId,
    reviewBlockedForAuthor: inReview && version.createdById === currentUserId,
    canPublish: version.status === 'DRAFT' || version.status === 'TESTING',
    canRetire: version.status === 'PUBLISHED',
    canRollback:
      (version.status === 'PUBLISHED' || version.status === 'RETIRED') &&
      version.id !== currentPublishedVersionId,
  };
}

export function currentPublishedVersionId(blueprint: RoleBlueprint): string | null {
  return (
    blueprint.versions
      .filter((version) => version.status === 'PUBLISHED')
      .toSorted(
        (left, right) =>
          Date.parse(right.publishedAt ?? right.createdAt) -
            Date.parse(left.publishedAt ?? left.createdAt) || right.version - left.version,
      )[0]?.id ?? null
  );
}

export function roleVersionStatusLabel(status: RoleVersion['status']): string {
  return {
    DRAFT: '草稿',
    TESTING: '审核中',
    PUBLISHED: '已发布',
    RETIRED: '已停用',
  }[status];
}

export function roleVersionReviewLabel(status: RoleVersion['reviewStatus']): string {
  return {
    NOT_SUBMITTED: '未提交',
    IN_REVIEW: '待审核',
    APPROVED: '已批准',
    CHANGES_REQUESTED: '已退回',
  }[status];
}

export function roleVersionStageDescription(version: RoleVersion): string {
  if (version.status === 'DRAFT' && version.reviewStatus === 'CHANGES_REQUESTED') {
    return '审核人已要求修改；编辑草稿后可重新提交。';
  }
  if (version.status === 'DRAFT') return '可继续编辑，也可直接发布用于初版验证。';
  if (version.status === 'TESTING' && version.reviewStatus === 'IN_REVIEW') {
    return '审核可继续进行，也可直接发布用于初版验证。';
  }
  if (version.status === 'TESTING' && version.reviewStatus === 'APPROVED') {
    return '独立审核已通过，可以发布。';
  }
  if (version.status === 'PUBLISHED') return '该版本当前可用于角色任命。';
  return '该版本已停用，仅可作为历史回滚来源。';
}

export function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const normalized = value.trim();
  if (!normalized) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`${label}必须是有效的 JSON 对象。`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象，不能是数组或基础值。`);
  }
  return parsed as Record<string, unknown>;
}

export function formatJsonObject(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value, null, 2);
}

export function generatedRoleIdentifier(name: string, prefix = 'role'): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  const encoded =
    normalized ||
    [...name.trim()]
      .map((character) => character.codePointAt(0)?.toString(36) ?? '')
      .filter(Boolean)
      .join('-');
  const candidate = (encoded ? `${prefix}-${encoded}` : `${prefix}-new`)
    .slice(0, 100)
    .replace(/[-._:]+$/u, '');
  return candidate.length >= 3 ? candidate : `${prefix}-new`;
}

export function identifierForRenamedRoleField(
  currentKey: string,
  currentName: string,
  nextName: string,
  prefix = 'role',
): string {
  return !currentKey || currentKey === generatedRoleIdentifier(currentName, prefix)
    ? generatedRoleIdentifier(nextName, prefix)
    : currentKey;
}

export function withGeneratedRoleKeys<T extends { readonly key: string; readonly name: string }>(
  items: ReadonlyArray<T>,
  prefix: string,
): T[] {
  const used = new Set<string>();
  return items.map((item) => {
    const base = item.key.trim().toLowerCase() || generatedRoleIdentifier(item.name, prefix);
    let candidate = base;
    let ordinal = 2;
    while (used.has(candidate)) {
      const suffix = `-${ordinal}`;
      candidate = `${base.slice(0, 100 - suffix.length).replace(/[-._:]+$/u, '')}${suffix}`;
      ordinal += 1;
    }
    used.add(candidate);
    return { ...item, key: candidate };
  });
}

export function diffRoleVersions(
  baseline: RoleVersion,
  target: RoleVersion,
): ReadonlyArray<RoleVersionDiffEntry> {
  const before = flattenRoleVersion(baseline);
  const after = flattenRoleVersion(target);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes: RoleVersionDiffEntry[] = [];

  for (const key of keys) {
    const previous = before.get(key);
    const next = after.get(key);
    if (previous?.value === next?.value) continue;
    const field = next ?? previous;
    if (!field) continue;
    const kind: RoleVersionDiffKind =
      previous === undefined ? 'added' : next === undefined ? 'removed' : 'changed';
    changes.push({
      id: `${kind}:${key}`,
      path: field.path,
      label: formatRoleVersionDiffPath(field.path),
      section: roleVersionDiffSection(field.path[0] ?? ''),
      kind,
      before: previous?.value ?? null,
      after: next?.value ?? null,
    });
  }

  const sectionOrder: ReadonlyArray<RoleVersionDiffEntry['section']> = [
    'roleDefinition',
    'systemPrompt',
    'modelPolicy',
    'toolPolicy',
    'knowledgeScope',
  ];
  return changes.toSorted(
    (left, right) =>
      sectionOrder.indexOf(left.section) - sectionOrder.indexOf(right.section) ||
      left.label.localeCompare(right.label, 'zh-CN'),
  );
}

export function roleVersionDiffKindLabel(kind: RoleVersionDiffKind): string {
  return {
    added: '新增',
    removed: '删除',
    changed: '变更',
  }[kind];
}

export function roleVersionDiffSectionLabel(section: RoleVersionDiffEntry['section']): string {
  return {
    roleDefinition: '结构化角色定义',
    systemPrompt: '系统提示词',
    modelPolicy: '模型策略',
    toolPolicy: '工具策略',
    knowledgeScope: '知识范围',
  }[section];
}

export function formatRoleBlueprintDate(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function roleBlueprintErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return messageFromError(error);
  const translations: ReadonlyArray<[string, string]> = [
    [
      'A Role Version author cannot approve their own version.',
      '双人审批要求：版本作者不能审核自己的版本。请由另一位企业所有者或管理员完成审批或退回。',
    ],
    ['Only a draft Role Version can be edited.', '只有草稿版本可以编辑。请刷新后重试。'],
    [
      'Only a draft Role Version can be submitted for review.',
      '只有草稿版本可以提交审核。请刷新后重试。',
    ],
    [
      'Only an in-review Role Version can be reviewed.',
      '只有处于待审核状态的版本可以审批或退回。请刷新后重试。',
    ],
    [
      'Only a draft or testing Role Version can be published.',
      '只有草稿或测试中的版本可以发布，请刷新后重试。',
    ],
    ['Only a published Role Version can be retired.', '只有已发布版本可以停用。'],
    [
      'A draft or testing Role Version cannot be a rollback source.',
      '草稿或审核中版本不能作为回滚来源。',
    ],
    [
      'The published Role Version changed. Refresh and try again.',
      '当前已发布版本已发生变化，请刷新后重新确认回滚。',
    ],
    [
      'The Role Blueprint changed. Refresh and try again.',
      '角色蓝图已被其他管理员更新，请刷新后再保存。',
    ],
    [
      'The Role Version changed. Refresh and try again.',
      '角色版本已被其他管理员更新，请刷新后再操作。',
    ],
  ];
  const translated =
    translations.find(([source]) => error.message.includes(source))?.[1] ?? error.message;
  return error.requestId ? `${translated}（请求 ID：${error.requestId}）` : translated;
}

interface FlattenedRoleVersionField {
  path: readonly string[];
  value: string;
}

function flattenRoleVersion(version: RoleVersion): Map<string, FlattenedRoleVersionField> {
  const fields = new Map<string, FlattenedRoleVersionField>();
  addFlattenedField(
    fields,
    ['roleDefinitionSnapshot', 'blueprintRevision'],
    `r${version.blueprintRevision}`,
  );
  if (version.roleDefinitionSnapshot !== null) {
    flattenRoleVersionValue(version.roleDefinitionSnapshot, ['roleDefinitionSnapshot'], fields);
  }
  addFlattenedField(fields, ['systemPrompt'], version.systemPrompt);
  flattenRoleVersionValue(version.modelPolicy, ['modelPolicy'], fields);
  flattenRoleVersionValue(version.toolPolicy, ['toolPolicy'], fields);
  flattenRoleVersionValue(version.knowledgeScope, ['knowledgeScope'], fields);
  return fields;
}

function flattenRoleVersionValue(
  value: unknown,
  path: readonly string[],
  fields: Map<string, FlattenedRoleVersionField>,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      addFlattenedField(fields, path, '[]');
      return;
    }
    if (value.every((item) => isRecord(item) && typeof item.key === 'string')) {
      for (const item of value.toSorted((left, right) =>
        String(left.key).localeCompare(String(right.key)),
      )) {
        const keyedPath = [...path, `@${String(item.key)}`];
        const entries = Object.entries(item).filter(([key]) => key !== 'key');
        if (entries.length === 0) addFlattenedField(fields, keyedPath, '{}');
        for (const [key, nested] of entries) {
          flattenRoleVersionValue(nested, [...keyedPath, key], fields);
        }
      }
      return;
    }
    value.forEach((item, index) =>
      flattenRoleVersionValue(item, [...path, `#${index + 1}`], fields),
    );
    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) addFlattenedField(fields, path, '{}');
    for (const [key, nested] of entries) {
      flattenRoleVersionValue(nested, [...path, key], fields);
    }
    return;
  }

  addFlattenedField(fields, path, serializeDiffValue(value));
}

function addFlattenedField(
  fields: Map<string, FlattenedRoleVersionField>,
  path: readonly string[],
  value: string,
): void {
  fields.set(JSON.stringify(path), { path, value });
}

function serializeDiffValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roleVersionDiffSection(root: string): RoleVersionDiffEntry['section'] {
  if (root === 'systemPrompt') return 'systemPrompt';
  if (root === 'modelPolicy') return 'modelPolicy';
  if (root === 'toolPolicy') return 'toolPolicy';
  if (root === 'knowledgeScope') return 'knowledgeScope';
  return 'roleDefinition';
}

function formatRoleVersionDiffPath(path: readonly string[]): string {
  const labels: Readonly<Record<string, string>> = {
    roleDefinitionSnapshot: '结构化角色定义',
    blueprintRevision: '蓝图修订',
    mission: '使命',
    responsibilities: '职责',
    valueDefinition: '价值定义',
    statement: '价值主张',
    stakeholderOutcomes: '利益相关方成果',
    measures: '衡量指标',
    capabilities: '能力',
    processes: '流程',
    tools: '工具',
    knowledgeDomains: '知识域',
    systemPrompt: '系统提示词',
    modelPolicy: '模型策略',
    toolPolicy: '工具策略',
    knowledgeScope: '知识范围',
    name: '名称',
    description: '说明',
    outcomes: '成果',
    level: '能力级别',
    responsibility: '流程责任',
    access: '工具权限',
    sensitivity: '敏感级别',
  };
  const structuredDefinition = path[0] === 'roleDefinitionSnapshot';
  const visiblePath = structuredDefinition && path.length > 1 ? path.slice(1) : path;
  return visiblePath
    .map((segment, index) => {
      if (segment.startsWith('@')) return segment.slice(1);
      if (segment.startsWith('#')) return `第 ${segment.slice(1)} 项`;
      return structuredDefinition || index === 0 ? (labels[segment] ?? segment) : segment;
    })
    .join(' / ');
}
