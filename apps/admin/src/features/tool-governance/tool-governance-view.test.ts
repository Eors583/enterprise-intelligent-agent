import { describe, expect, it } from 'vitest';

import { nextToolLifecycleAction, parseToolList, toolRiskLabel } from './tool-governance-view';

describe('tool governance view policy', () => {
  it('never skips the test lifecycle gate', () => {
    expect(nextToolLifecycleAction('DRAFT')).toBe('TEST');
    expect(nextToolLifecycleAction('TESTING')).toBe('PUBLISH');
    expect(nextToolLifecycleAction('PUBLISHED')).toBe('RETIRE');
    expect(nextToolLifecycleAction('RETIRED')).toBeNull();
  });

  it('explains all execution risk classes explicitly', () => {
    expect(toolRiskLabel('READ_ONLY')).toContain('只读');
    expect(toolRiskLabel('HIGH_RISK_APPROVAL')).toContain('独立审批');
    expect(toolRiskLabel('FORBIDDEN')).toContain('禁止');
  });

  it('deduplicates outbound allowlist values', () => {
    expect(parseToolList('api.example.com, api.example.com；files.example.com')).toEqual([
      'api.example.com',
      'files.example.com',
    ]);
  });
});
