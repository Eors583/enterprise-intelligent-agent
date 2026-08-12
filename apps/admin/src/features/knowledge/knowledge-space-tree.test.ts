import { describe, expect, it } from 'vitest';

import { buildKnowledgeSpaceTree, visibleKnowledgeBases } from './knowledge-space-tree';

function knowledgeBase(input: {
  id: string;
  name: string;
  type: 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'MEMBER';
  targetId: string;
  targetName: string;
  status?: 'ACTIVE' | 'ARCHIVED';
  documents?: Array<{ status: 'READY' | 'ARCHIVED' }>;
}) {
  const documents = input.documents ?? [];
  return {
    id: input.id,
    key: input.id,
    name: input.name,
    status: input.status ?? 'ACTIVE',
    documents,
    documentCount: documents.length,
    space: {
      type: input.type,
      targetId: input.targetId,
      targetName: input.targetName,
    },
  } as never;
}

describe('knowledge space tree', () => {
  it('removes deleted knowledge bases and documents from the ordinary user projection', () => {
    const visible = visibleKnowledgeBases([
      knowledgeBase({
        id: 'active',
        name: '有效知识库',
        type: 'COMPANY',
        targetId: 'tenant',
        targetName: '示例企业',
        documents: [{ status: 'READY' }, { status: 'ARCHIVED' }],
      }),
      knowledgeBase({
        id: 'deleted',
        name: '已删除知识库',
        type: 'COMPANY',
        targetId: 'tenant',
        targetName: '示例企业',
        status: 'ARCHIVED',
      }),
    ]);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe('active');
    expect(visible[0]?.documents).toHaveLength(1);
    expect(visible[0]?.documentCount).toBe(1);
    expect(buildKnowledgeSpaceTree(visible, '')[0]?.itemCount).toBe(1);
  });

  it('keeps company, department, project and member as four sibling roots', () => {
    const tree = buildKnowledgeSpaceTree(
      [
        knowledgeBase({
          id: 'company',
          name: '公司战略',
          type: 'COMPANY',
          targetId: 'tenant',
          targetName: '示例企业',
        }),
        knowledgeBase({
          id: 'department',
          name: '产品目标',
          type: 'DEPARTMENT',
          targetId: 'product',
          targetName: '产品部',
        }),
        knowledgeBase({
          id: 'project',
          name: '上线方案',
          type: 'PROJECT',
          targetId: 'launch',
          targetName: '新品上线',
        }),
        knowledgeBase({
          id: 'member',
          name: '交互设计技能',
          type: 'MEMBER',
          targetId: 'designer',
          targetName: '林晓',
        }),
      ],
      '',
    );

    expect(tree.map((root) => root.type)).toEqual(['COMPANY', 'DEPARTMENT', 'PROJECT', 'MEMBER']);
    expect(tree.map((root) => root.itemCount)).toEqual([1, 1, 1, 1]);
    expect(tree[2]?.groups[0]?.targetName).toBe('新品上线');
  });

  it('searches both knowledge base names and their owning space names', () => {
    const tree = buildKnowledgeSpaceTree(
      [
        knowledgeBase({
          id: 'one',
          name: '年度目标',
          type: 'DEPARTMENT',
          targetId: 'sales',
          targetName: '销售部',
        }),
        knowledgeBase({
          id: 'two',
          name: '年度目标',
          type: 'DEPARTMENT',
          targetId: 'product',
          targetName: '产品部',
        }),
      ],
      '销售',
    );

    expect(tree[1]?.groups).toHaveLength(1);
    expect(tree[1]?.groups[0]?.targetName).toBe('销售部');
  });
});
