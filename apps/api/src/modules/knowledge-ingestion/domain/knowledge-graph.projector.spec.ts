import { describe, expect, it } from 'vitest';

import { projectKnowledgeGraph } from './knowledge-graph.projector.js';

describe('knowledge graph projector', () => {
  it('projects declarations, identifiers and evidence-backed document relations', () => {
    const projection = projectKnowledgeGraph({
      documentId: '00000000-0000-7000-8000-000000000001',
      documentTitle: '客户数据管理制度',
      chunks: [
        {
          id: '00000000-0000-7000-8000-000000000101',
          chunkIndex: 0,
          headingPath: ['总则'],
          content:
            '制度编号：DATA-2026-01\n负责人：安全平台主管\n适用范围：全体员工\n本制度依赖权限管理系统。',
        },
      ],
    });

    expect(
      projection.entities.some(
        (entity) => entity.entityType === 'IDENTIFIER' && entity.canonicalName === 'DATA-2026-01',
      ),
    ).toBe(true);
    expect(
      projection.relations.some(
        (relation) =>
          relation.normalizedPredicate === 'IDENTIFIED_BY' && relation.evidence.length === 1,
      ),
    ).toBe(true);
    expect(
      projection.relations.some(
        (relation) =>
          relation.normalizedPredicate === 'APPLIES_TO' &&
          relation.evidence[0]?.chunkId === '00000000-0000-7000-8000-000000000101',
      ),
    ).toBe(true);
    expect(projection.mentions.every((mention) => mention.endOffset >= mention.startOffset)).toBe(
      true,
    );
  });

  it('builds a navigable document and section hierarchy', () => {
    const projection = projectKnowledgeGraph({
      documentId: '00000000-0000-7000-8000-000000000002',
      documentTitle: '采购流程',
      chunks: [
        {
          id: '00000000-0000-7000-8000-000000000201',
          chunkIndex: 0,
          headingPath: ['审批', '金额门槛'],
          content: '超过十万元的采购适用于集团审批范围。',
        },
      ],
    });

    expect(
      projection.relations.filter((relation) =>
        ['CONTAINS_SECTION', 'PARENT_OF'].includes(relation.normalizedPredicate),
      ),
    ).toHaveLength(2);
    expect(
      projection.relations.some((relation) => relation.normalizedPredicate === 'APPLIES_TO'),
    ).toBe(true);
  });

  it('deduplicates repeated entities and relation evidence', () => {
    const projection = projectKnowledgeGraph({
      documentId: '00000000-0000-7000-8000-000000000003',
      documentTitle: '值班制度',
      chunks: [
        {
          id: '00000000-0000-7000-8000-000000000301',
          chunkIndex: 0,
          headingPath: [],
          content: '负责人：平台组\n负责人：平台组',
        },
      ],
    });

    expect(projection.entities.filter((entity) => entity.canonicalName === '平台组')).toHaveLength(
      1,
    );
    const relation = projection.relations.find((item) => item.normalizedPredicate === 'OWNED_BY');
    expect(relation?.evidence).toHaveLength(2);
  });

  it('aggregates bounded surface aliases for one semantic identity', () => {
    const base = 'aliasvariant';
    const variants = Array.from({ length: 40 }, (_, mask) =>
      Array.from(base, (character, index) =>
        (mask & (1 << index)) === 0 ? character : character.toUpperCase(),
      ).join(''),
    );
    const projection = projectKnowledgeGraph({
      documentId: '00000000-0000-7000-8000-000000000004',
      documentTitle: '别名聚合',
      chunks: [
        {
          id: '00000000-0000-7000-8000-000000000401',
          chunkIndex: 0,
          headingPath: [],
          content: variants.map((variant) => `“${variant}”`).join(' '),
        },
      ],
    });

    const entity = projection.entities.find(
      (candidate) => candidate.entityType === 'TERM' && candidate.normalizedName === base,
    );
    expect(entity).toBeDefined();
    expect(entity?.aliases).toHaveLength(32);
    expect(new Set(entity?.aliases).size).toBe(entity?.aliases.length);
    expect(entity?.aliases).not.toContain(entity?.canonicalName);
    expect(entity?.aliases.every((alias) => alias.length <= 160)).toBe(true);
  });

  it('isolates source-scoped document and section identities while sharing semantic entities', () => {
    const project = (documentId: string, chunkId: string) =>
      projectKnowledgeGraph({
        documentId,
        documentTitle: '同名管理制度',
        chunks: [
          {
            id: chunkId,
            chunkIndex: 0,
            headingPath: ['总则'],
            content: '负责人：平台组\n“共享术语”适用于全体员工。',
          },
        ],
      });
    const first = project(
      '00000000-0000-7000-8000-000000000011',
      '00000000-0000-7000-8000-000000000111',
    );
    const second = project(
      '00000000-0000-7000-8000-000000000012',
      '00000000-0000-7000-8000-000000000112',
    );

    const firstDocument = first.entities.find((entity) => entity.entityType === 'DOCUMENT');
    const secondDocument = second.entities.find((entity) => entity.entityType === 'DOCUMENT');
    expect(firstDocument?.externalKey).toBe('document:00000000-0000-7000-8000-000000000011');
    expect(secondDocument?.externalKey).toBe('document:00000000-0000-7000-8000-000000000012');
    expect(firstDocument?.key).not.toBe(secondDocument?.key);

    const firstSection = first.entities.find((entity) => entity.entityType === 'SECTION');
    const secondSection = second.entities.find((entity) => entity.entityType === 'SECTION');
    expect(firstSection?.externalKey).toMatch(
      /^document:00000000-0000-7000-8000-000000000011:section:[a-f0-9]{64}$/u,
    );
    expect(secondSection?.externalKey).toMatch(
      /^document:00000000-0000-7000-8000-000000000012:section:[a-f0-9]{64}$/u,
    );
    expect(firstSection?.key).not.toBe(secondSection?.key);

    const firstSemantic = first.entities.find((entity) => entity.canonicalName === '共享术语');
    const secondSemantic = second.entities.find((entity) => entity.canonicalName === '共享术语');
    expect(firstSemantic).toMatchObject({ entityType: 'TERM', externalKey: null });
    expect(secondSemantic).toMatchObject({ entityType: 'TERM', externalKey: null });
    expect(firstSemantic?.key).toBe(secondSemantic?.key);
  });
});
