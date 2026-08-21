import { describe, expect, it } from 'vitest';

import {
  associationChecks,
  entityStatus,
  formatEffectivePeriod,
  semanticStatusLabel,
} from './business-semantics-view';
import { valueDefinitionFixture } from './test-fixtures';

describe('business semantics admin view model', () => {
  it('shows governed version, effective period, and association state from server data', () => {
    const value = valueDefinitionFixture();

    expect(entityStatus('values', value)).toBe('VERSIONED');
    expect(semanticStatusLabel(entityStatus('values', value))).toBe('已有发布版本');
    expect(formatEffectivePeriod(value)).toContain('长期有效');
    expect(associationChecks('values', value)).toEqual([
      expect.objectContaining({ label: '发布版本', valid: true }),
    ]);
  });

  it('does not claim a Value is published when currentVersionId is absent', () => {
    const draftOnly = { ...valueDefinitionFixture(), currentVersionId: null };

    expect(entityStatus('values', draftOnly)).toBe('NO_PUBLISHED_VERSION');
    expect(associationChecks('values', draftOnly)).toEqual([
      expect.objectContaining({
        detail: '尚未绑定已发布版本',
        valid: false,
      }),
    ]);
  });
});
