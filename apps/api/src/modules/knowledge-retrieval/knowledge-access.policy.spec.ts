import { describe, expect, it } from 'vitest';

import { accessibleKnowledgeBaseIds } from './knowledge-access.policy.js';

const parentByOrgUnitId = new Map<string, string | null>([
  ['company', null],
  ['product', 'company'],
  ['platform', 'product'],
  ['sales', 'company'],
]);

const knowledgeBases = [
  { id: 'company-wide', orgUnits: [] },
  {
    id: 'product-tree',
    orgUnits: [{ orgUnitId: 'product', includeChildren: true }],
  },
  {
    id: 'product-direct',
    orgUnits: [{ orgUnitId: 'product', includeChildren: false }],
  },
  {
    id: 'sales-only',
    orgUnits: [{ orgUnitId: 'sales', includeChildren: true }],
  },
] as const;

describe('knowledge access policy', () => {
  it('includes child departments only when the scope enables inheritance', () => {
    expect(
      accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds: new Set(['platform']),
        parentByOrgUnitId,
        knowledgeBases,
      }),
    ).toEqual(['company-wide', 'product-tree']);
  });

  it('uses every active employment for a multi-department member', () => {
    expect(
      accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds: new Set(['platform', 'sales']),
        parentByOrgUnitId,
        knowledgeBases,
      }),
    ).toEqual(['company-wide', 'product-tree', 'sales-only']);
  });

  it('allows a direct department even when child inheritance is disabled', () => {
    expect(
      accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds: new Set(['product']),
        parentByOrgUnitId,
        knowledgeBases,
      }),
    ).toEqual(['company-wide', 'product-tree', 'product-direct']);
  });

  it('denies every knowledge base to an inactive or locked member', () => {
    expect(
      accessibleKnowledgeBaseIds({
        userActive: false,
        memberOrgUnitIds: new Set(['product']),
        parentByOrgUnitId,
        knowledgeBases,
      }),
    ).toEqual([]);
  });

  it('denies company-wide knowledge when the member has no active employment', () => {
    expect(
      accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds: new Set(),
        parentByOrgUnitId,
        knowledgeBases,
      }),
    ).toEqual([]);
  });

  it('terminates safely when organization data contains a cycle', () => {
    const cyclicParents = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(
      accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds: new Set(['a']),
        parentByOrgUnitId: cyclicParents,
        knowledgeBases: [
          { id: 'unrelated', orgUnits: [{ orgUnitId: 'c', includeChildren: true }] },
        ],
      }),
    ).toEqual([]);
  });
});
