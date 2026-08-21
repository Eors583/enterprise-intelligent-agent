import type { KnowledgeGraphGovernanceOverview } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  createKnowledgeGraphCorrection: vi.fn(),
  createKnowledgeOntology: vi.fn(),
  getKnowledgeGraphGovernance: vi.fn(),
  transitionKnowledgeGraphCorrection: vi.fn(),
  transitionKnowledgeGraphRelationCorrectionBatch: vi.fn(),
  transitionKnowledgeOntologyVersion: vi.fn(),
}));

vi.mock('@/api/admin-api', () => api);

import { KnowledgeGraphGovernancePanel } from './KnowledgeGraphGovernancePanel';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';
const CONFLICT_ID = '00000000-0000-7000-8000-000000000002';
const RELATION_ID = '00000000-0000-7000-8000-000000000003';
const USER_ID = '00000000-0000-7000-8000-000000000004';

describe('KnowledgeGraphGovernancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getKnowledgeGraphGovernance.mockResolvedValue(overview());
    api.createKnowledgeGraphCorrection.mockResolvedValue({});
  });

  it('shows each blocked relation and creates only a reviewed resolution draft', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeGraphGovernancePanel, { knowledgeBaseId: KNOWLEDGE_BASE_ID }),
    );
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('关系冲突队列');
      expect(dom.container.textContent).toContain('ONTOLOGY.MAPPING.MISSING');
      expect(dom.container.textContent).toContain(CONFLICT_ID);

      const resolution = dom.container.querySelector('textarea');
      expect(resolution).not.toBeNull();
      if (resolution) {
        await dom.change(resolution, '已发布本体补齐谓词后，保留当前关系。');
      }
      const propose = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '创建裁决草稿',
      );
      expect(propose).not.toBeUndefined();
      if (propose) await dom.click(propose);

      expect(api.createKnowledgeGraphCorrection).toHaveBeenCalledWith(
        KNOWLEDGE_BASE_ID,
        expect.objectContaining({
          action: 'RESOLVE_CONFLICT',
          patch: {
            conflictId: CONFLICT_ID,
            resolution: '已发布本体补齐谓词后，保留当前关系。',
          },
          evidence: [
            expect.objectContaining({
              source: 'KNOWLEDGE_GRAPH_CONFLICT_REVIEW',
              conflictId: CONFLICT_ID,
            }),
          ],
        }),
      );
      expect(dom.container.textContent).toContain('必须经提交、独立复核和显式应用');
    } finally {
      await dom.cleanup();
    }
  });
});

function overview(): KnowledgeGraphGovernanceOverview {
  return {
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    suggestedOntology: {
      entityTypes: [
        {
          key: 'DOCUMENT',
          name: '文档',
          description: '由当前图谱归纳。',
          attributesSchema: {},
        },
      ],
      predicates: [],
      sourceEntityCount: 1,
      sourceRelationCount: 1,
      ungovernedRelationCount: 1,
    },
    ontologies: [],
    corrections: [],
    merges: [],
    aliases: [],
    conflicts: [
      {
        id: CONFLICT_ID,
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        projectionId: null,
        documentVersionId: null,
        projectionStatus: null,
        targetType: 'RELATION',
        targetId: RELATION_ID,
        conflictKey: `ONTOLOGY_MAPPING_MISSING:${RELATION_ID}`,
        conflictType: 'ONTOLOGY.MAPPING.MISSING',
        schemaPredicate: null,
        schemaSubjectType: null,
        schemaObjectType: null,
        occurrenceCount: 1,
        details: {
          predicate: 'APPLIES_TO',
          remediation: 'Publish and independently review an ontology mapping.',
        },
        evidence: [{ source: 'KNOWLEDGE_GRAPH_PROJECTION' }],
        status: 'OPEN',
        revision: 1,
        detectedByUserId: USER_ID,
        reviewedByUserId: null,
        resolutionCorrectionId: null,
        reviewComment: null,
        resolvedAt: null,
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
    ],
    retrieval: {
      eligibleRelationCount: 0,
      excludedConflictCount: 1,
      mergedEntityCount: 0,
      publishedOntologyVersionCount: 0,
      ungovernedRelationCount: 1,
      pendingReviewRelationCount: 0,
      approvedRelationCount: 0,
    },
  };
}
