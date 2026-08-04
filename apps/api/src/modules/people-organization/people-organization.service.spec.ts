import { describe, expect, it } from 'vitest';

import { generatedPeopleCode } from './people-organization.service.js';

describe('generatedPeopleCode', () => {
  it('derives a stable readable code without inventing transliterations', () => {
    expect(generatedPeopleCode('COMPETENCY', 'Solution Design')).toBe('COMPETENCY.SOLUTION.DESIGN');
    expect(generatedPeopleCode('TEAM', '客户成功')).toMatch(/^TEAM\.[A-Z0-9.]+$/u);
  });
});
