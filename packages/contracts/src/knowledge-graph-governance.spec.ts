import { describe, expect, it } from 'vitest';

import {
  createKnowledgeGraphCorrectionRequestSchema,
  createKnowledgeOntologyRequestSchema,
  knowledgeOntologyVersionSchema,
} from './knowledge-graph-governance.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const checkerId = '22222222-2222-4222-8222-222222222222';

describe('knowledge graph governance contracts', () => {
  it('accepts reciprocal inverse predicates with swapped domain and range', () => {
    const result = createKnowledgeOntologyRequestSchema.safeParse({
      code: 'ENTERPRISE',
      name: 'Enterprise ontology',
      description: null,
      changeSummary: 'Initial governed ontology',
      entityTypes: [
        { key: 'EMPLOYEE', name: 'Employee' },
        { key: 'DEPARTMENT', name: 'Department' },
      ],
      predicates: [
        {
          key: 'BELONGS_TO',
          predicate: 'BELONGS_TO',
          label: 'belongs to',
          domainTypeKey: 'EMPLOYEE',
          rangeTypeKey: 'DEPARTMENT',
          inversePredicateKey: 'HAS_MEMBER',
        },
        {
          key: 'HAS_MEMBER',
          predicate: 'HAS_MEMBER',
          label: 'has member',
          domainTypeKey: 'DEPARTMENT',
          rangeTypeKey: 'EMPLOYEE',
          inversePredicateKey: 'BELONGS_TO',
        },
      ],
      idempotencyKey: 'ontology-create-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects dangling and non-reciprocal inverse predicate definitions', () => {
    const result = createKnowledgeOntologyRequestSchema.safeParse({
      code: 'ENTERPRISE',
      name: 'Enterprise ontology',
      description: null,
      changeSummary: 'Invalid inverse relation',
      entityTypes: [
        { key: 'EMPLOYEE', name: 'Employee' },
        { key: 'DEPARTMENT', name: 'Department' },
      ],
      predicates: [
        {
          key: 'BELONGS_TO',
          predicate: 'BELONGS_TO',
          label: 'belongs to',
          domainTypeKey: 'EMPLOYEE',
          rangeTypeKey: 'DEPARTMENT',
          inversePredicateKey: 'HAS_MEMBER',
        },
      ],
      idempotencyKey: 'ontology-create-2',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['predicates', 0, 'inversePredicateKey'],
        }),
      ]),
    );
  });

  it('rejects entity self-merges and invalid relation validity windows', () => {
    const selfMerge = createKnowledgeGraphCorrectionRequestSchema.safeParse({
      action: 'MERGE_ENTITY',
      patch: {
        sourceEntityId: actorId,
        targetEntityId: actorId,
        reason: 'duplicate',
      },
      evidence: [{ source: 'human-review' }],
      idempotencyKey: 'correction-merge-1',
    });
    const invalidWindow = createKnowledgeGraphCorrectionRequestSchema.safeParse({
      action: 'UPSERT_RELATION_VALIDITY',
      patch: {
        relationId: actorId,
        ontologyVersionId: checkerId,
        predicateDefinitionId: '33333333-3333-4333-8333-333333333333',
        validFrom: '2026-07-28T08:00:00.000Z',
        validTo: '2026-07-28T07:59:59.000Z',
      },
      evidence: [{ source: 'human-review' }],
      idempotencyKey: 'correction-relation-1',
    });

    expect(selfMerge.success).toBe(false);
    expect(invalidWindow.success).toBe(false);
  });

  it('requires an independent checker for a non-bootstrap published version', () => {
    const version = {
      id: '33333333-3333-4333-8333-333333333333',
      ontologyId: '44444444-4444-4444-8444-444444444444',
      versionNumber: 1,
      revision: 3,
      status: 'PUBLISHED',
      changeSummary: 'Approved ontology',
      schemaHash: 'a'.repeat(64),
      createdByUserId: actorId,
      submittedByUserId: actorId,
      reviewedByUserId: actorId,
      reviewComment: 'self approval',
      submittedAt: '2026-07-28T08:00:00.000Z',
      reviewedAt: '2026-07-28T08:01:00.000Z',
      publishedAt: '2026-07-28T08:01:00.000Z',
      retiredAt: null,
      systemBootstrap: false,
      createdAt: '2026-07-28T08:00:00.000Z',
      updatedAt: '2026-07-28T08:01:00.000Z',
      entityTypes: [],
      predicates: [],
    };

    expect(knowledgeOntologyVersionSchema.safeParse(version).success).toBe(false);
    expect(
      knowledgeOntologyVersionSchema.safeParse({
        ...version,
        reviewedByUserId: checkerId,
      }).success,
    ).toBe(true);
  });
});
