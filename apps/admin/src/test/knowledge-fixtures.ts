import type { KnowledgeDocumentGovernance } from '@enterprise/contracts';

export function testKnowledgeGovernance(
  overrides: Partial<KnowledgeDocumentGovernance> = {},
): KnowledgeDocumentGovernance {
  return {
    ownerUserId: '00000000-0000-7000-8000-000000000901',
    classification: 'INTERNAL',
    scopeMode: 'TENANT',
    organizationScopeIds: [],
    projectScopeIds: [],
    taskScopeIds: [],
    roleTemplateScopeIds: [],
    dataLabels: [],
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: null,
    retentionUntil: null,
    retentionAction: 'ARCHIVE',
    supersedesVersionId: null,
    revision: 2,
    reviewStatus: 'APPROVED',
    reviewedById: '00000000-0000-7000-8000-000000000902',
    reviewedAt: '2026-07-01T01:00:00.000Z',
    reviewNote: null,
    policyHash: 'd'.repeat(64),
    ...overrides,
  };
}
