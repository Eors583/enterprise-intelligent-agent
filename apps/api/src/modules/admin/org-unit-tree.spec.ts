import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { assertOrgUnitParent, type OrgUnitTreeNode } from './org-unit-tree.js';

const nodes: readonly OrgUnitTreeNode[] = [
  { id: 'root', parentId: null, status: 'ACTIVE' },
  { id: 'product', parentId: 'root', status: 'ACTIVE' },
  { id: 'design', parentId: 'product', status: 'ACTIVE' },
  { id: 'old', parentId: 'root', status: 'ARCHIVED' },
];

describe('assertOrgUnitParent', () => {
  it('accepts a root placement and a move beneath an unrelated active node', () => {
    expect(() => assertOrgUnitParent(nodes, 'design', null)).not.toThrow();
    expect(() => assertOrgUnitParent(nodes, 'design', 'root')).not.toThrow();
  });

  it('rejects moving a node beneath itself or one of its descendants', () => {
    expect(() => assertOrgUnitParent(nodes, 'product', 'product')).toThrow(BadRequestException);
    expect(() => assertOrgUnitParent(nodes, 'product', 'design')).toThrow(BadRequestException);
  });

  it('hides missing and archived parents behind the same not-found response', () => {
    expect(() => assertOrgUnitParent(nodes, 'product', 'missing')).toThrow(NotFoundException);
    expect(() => assertOrgUnitParent(nodes, 'product', 'old')).toThrow(NotFoundException);
  });

  it('detects corruption in an existing ancestor chain', () => {
    const corrupt: readonly OrgUnitTreeNode[] = [
      { id: 'a', parentId: 'b', status: 'ACTIVE' },
      { id: 'b', parentId: 'a', status: 'ACTIVE' },
      { id: 'c', parentId: null, status: 'ACTIVE' },
    ];

    expect(() => assertOrgUnitParent(corrupt, 'c', 'a')).toThrow(BadRequestException);
  });
});
