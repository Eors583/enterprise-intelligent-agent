import { describe, expect, it } from 'vitest';

import { updateKnowledgeDocumentAccessRequestSchema } from './admin.js';

describe('knowledge document access contract', () => {
  it('accepts an inherited scope without explicit targets', () => {
    expect(
      updateKnowledgeDocumentAccessRequestSchema.parse({
        mode: 'INHERIT',
        orgUnitIds: [],
        memberUserIds: [],
        expectedGovernanceRevision: 2,
      }),
    ).toMatchObject({ mode: 'INHERIT' });
  });

  it('requires at least one target for a restricted scope', () => {
    expect(() =>
      updateKnowledgeDocumentAccessRequestSchema.parse({
        mode: 'RESTRICTED',
        orgUnitIds: [],
        memberUserIds: [],
        expectedGovernanceRevision: 2,
      }),
    ).toThrow('Restricted document access requires at least one department or member.');
  });
});
