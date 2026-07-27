import { describe, expect, it } from 'vitest';

import { shouldPromoteKnowledgeVersion } from './knowledge-version-publication.policy.js';

describe('knowledge version publication policy', () => {
  it('publishes the first successfully indexed version', () => {
    expect(
      shouldPromoteKnowledgeVersion({
        currentVersionId: null,
        currentVersionNumber: 1,
        candidateVersionNumber: 1,
      }),
    ).toBe(true);
  });

  it('promotes a newer version', () => {
    expect(
      shouldPromoteKnowledgeVersion({
        currentVersionId: 'version-1',
        currentVersionNumber: 1,
        candidateVersionNumber: 2,
      }),
    ).toBe(true);
  });

  it('does not let a slower old job roll the current version backward', () => {
    expect(
      shouldPromoteKnowledgeVersion({
        currentVersionId: 'version-3',
        currentVersionNumber: 3,
        candidateVersionNumber: 2,
      }),
    ).toBe(false);
  });

  it('does not republish the same version', () => {
    expect(
      shouldPromoteKnowledgeVersion({
        currentVersionId: 'version-2',
        currentVersionNumber: 2,
        candidateVersionNumber: 2,
      }),
    ).toBe(false);
  });
});
