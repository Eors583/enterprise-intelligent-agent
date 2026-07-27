import { BadRequestException, NotFoundException } from '@nestjs/common';

export interface OrgUnitTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export function assertOrgUnitParent(
  nodes: readonly OrgUnitTreeNode[],
  unitId: string | undefined,
  parentId: string | null,
): void {
  if (parentId === null) return;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = byId.get(parentId);
  if (parent === undefined || parent.status !== 'ACTIVE') {
    throw new NotFoundException('The parent organization unit was not found.');
  }

  const visited = new Set<string>();
  let cursor: OrgUnitTreeNode | undefined = parent;
  while (cursor !== undefined) {
    if (cursor.id === unitId) {
      throw new BadRequestException('Moving this organization unit would create a cycle.');
    }
    if (visited.has(cursor.id)) {
      throw new BadRequestException('The existing organization tree contains a cycle.');
    }
    visited.add(cursor.id);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
}
