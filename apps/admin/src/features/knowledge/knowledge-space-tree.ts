import type { KnowledgeBase, KnowledgeSpaceType } from '@enterprise/contracts';

export const KNOWLEDGE_SPACE_ROOTS = [
  {
    type: 'COMPANY',
    label: '公司知识',
    description: '公司战略、经营目标、制度与公共知识',
    glyph: '企',
  },
  {
    type: 'DEPARTMENT',
    label: '部门知识',
    description: '部门职责、目标、流程与专业知识',
    glyph: '部',
  },
  {
    type: 'PROJECT',
    label: '项目知识',
    description: '项目目标、方案、过程资料与交付经验',
    glyph: '项',
  },
  {
    type: 'MEMBER',
    label: '成员知识',
    description: '员工技能、岗位知识与个人经验',
    glyph: '人',
  },
] as const satisfies ReadonlyArray<{
  type: KnowledgeSpaceType;
  label: string;
  description: string;
  glyph: string;
}>;

export interface KnowledgeSpaceTreeGroup {
  readonly targetId: string;
  readonly targetName: string;
  readonly items: readonly KnowledgeBase[];
}

export interface KnowledgeSpaceTreeRoot {
  readonly type: KnowledgeSpaceType;
  readonly label: string;
  readonly description: string;
  readonly glyph: string;
  readonly itemCount: number;
  readonly groups: readonly KnowledgeSpaceTreeGroup[];
}

export function knowledgeSpaceRootLabel(type: KnowledgeSpaceType): string {
  return KNOWLEDGE_SPACE_ROOTS.find((root) => root.type === type)?.label ?? '知识空间';
}

export function visibleKnowledgeBases(items: readonly KnowledgeBase[]): KnowledgeBase[] {
  return items
    .filter((item) => item.status !== 'ARCHIVED')
    .map((item) => {
      const documents = item.documents.filter((document) => document.status !== 'ARCHIVED');
      return {
        ...item,
        documents,
        documentCount: documents.length,
      };
    });
}

export function buildKnowledgeSpaceTree(
  items: readonly KnowledgeBase[],
  query: string,
): readonly KnowledgeSpaceTreeRoot[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  return KNOWLEDGE_SPACE_ROOTS.map((root) => {
    const grouped = new Map<string, KnowledgeBase[]>();
    for (const item of items) {
      if (item.status === 'ARCHIVED' || item.space.type !== root.type || !matches(item, normalized))
        continue;
      const current = grouped.get(item.space.targetId) ?? [];
      current.push(item);
      grouped.set(item.space.targetId, current);
    }
    const groups = [...grouped.entries()]
      .map(([targetId, knowledgeBases]) => ({
        targetId,
        targetName: knowledgeBases[0]?.space.targetName ?? '未命名空间',
        items: knowledgeBases.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      }))
      .sort((left, right) => left.targetName.localeCompare(right.targetName, 'zh-CN'));
    return {
      ...root,
      itemCount: groups.reduce((total, group) => total + group.items.length, 0),
      groups,
    };
  });
}

function matches(item: KnowledgeBase, normalized: string): boolean {
  if (normalized.length === 0) return true;
  return [item.name, item.key, item.space.targetName].some((value) =>
    value.toLocaleLowerCase('zh-CN').includes(normalized),
  );
}
