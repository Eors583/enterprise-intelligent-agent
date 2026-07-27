export interface KnowledgeAccessScope {
  readonly orgUnitId: string;
  readonly includeChildren: boolean;
}

export interface ScopedKnowledgeBase {
  readonly id: string;
  readonly orgUnits: readonly KnowledgeAccessScope[];
}

export function accessibleKnowledgeBaseIds(input: {
  readonly userActive: boolean;
  readonly memberOrgUnitIds: ReadonlySet<string>;
  readonly parentByOrgUnitId: ReadonlyMap<string, string | null>;
  readonly knowledgeBases: readonly ScopedKnowledgeBase[];
}): string[] {
  // Enterprise knowledge is employment-bound. A still-active login must not
  // retain company-wide knowledge after every active employment has been
  // removed or its department has been archived.
  if (!input.userActive || input.memberOrgUnitIds.size === 0) return [];

  return input.knowledgeBases
    .filter((knowledgeBase) => {
      if (knowledgeBase.orgUnits.length === 0) return true;
      return knowledgeBase.orgUnits.some((scope) =>
        [...input.memberOrgUnitIds].some(
          (memberOrgUnitId) =>
            scope.orgUnitId === memberOrgUnitId ||
            (scope.includeChildren &&
              isOrgUnitAncestor(scope.orgUnitId, memberOrgUnitId, input.parentByOrgUnitId)),
        ),
      );
    })
    .map((knowledgeBase) => knowledgeBase.id);
}

export function isOrgUnitAncestor(
  ancestorId: string,
  descendantId: string,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  let current = parentById.get(descendantId) ?? null;
  while (current !== null && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}
