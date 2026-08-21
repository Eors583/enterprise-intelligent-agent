import { describe, expect, it } from 'vitest';

import {
  isExternalKnowledgeAiApproved,
  knowledgeClassificationToAi,
  maximumAiDataClassification,
} from './ai-data-classification.js';

describe('AI data classification', () => {
  it('uses one monotonic order for the maximum effective classification', () => {
    expect(maximumAiDataClassification('PUBLIC', 'CONFIDENTIAL', 'INTERNAL')).toBe('CONFIDENTIAL');
    expect(maximumAiDataClassification('RESTRICTED', 'PUBLIC')).toBe('RESTRICTED');
  });

  it('maps knowledge governance classifications conservatively', () => {
    expect(knowledgeClassificationToAi('PUBLIC')).toBe('PUBLIC');
    expect(knowledgeClassificationToAi('INTERNAL')).toBe('INTERNAL');
    expect(knowledgeClassificationToAi('SENSITIVE')).toBe('CONFIDENTIAL');
    expect(knowledgeClassificationToAi('CONFIDENTIAL')).toBe('RESTRICTED');
    expect(knowledgeClassificationToAi(undefined)).toBe('RESTRICTED');
  });

  it('fails closed for knowledge-provider egress above INTERNAL', () => {
    expect(isExternalKnowledgeAiApproved('PUBLIC')).toBe(true);
    expect(isExternalKnowledgeAiApproved('INTERNAL')).toBe(true);
    expect(isExternalKnowledgeAiApproved('CONFIDENTIAL')).toBe(false);
    expect(isExternalKnowledgeAiApproved('RESTRICTED')).toBe(false);
  });
});
