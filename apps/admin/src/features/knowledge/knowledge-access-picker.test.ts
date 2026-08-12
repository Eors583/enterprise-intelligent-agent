import { describe, expect, it } from 'vitest';

import {
  knowledgeAccessError,
  knowledgeAccessMode,
  knowledgeAccessSummary,
} from './KnowledgeAccessPicker';

const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000001';
const MEMBER_USER_ID = '00000000-0000-7000-8000-000000000002';

describe('knowledge access picker view model', () => {
  it('treats an empty audience as enterprise-wide for backward compatibility', () => {
    expect(knowledgeAccessMode([], [])).toBe('ENTERPRISE');
    expect(knowledgeAccessSummary([], [])).toBe('全公司成员可访问');
  });

  it('supports the union of departments and named members', () => {
    const departments = [{ orgUnitId: ORG_UNIT_ID, includeChildren: true }];
    expect(knowledgeAccessMode(departments, [MEMBER_USER_ID])).toBe('RESTRICTED');
    expect(knowledgeAccessSummary(departments, [MEMBER_USER_ID])).toBe(
      '1 个部门 + 1 名指定成员可访问',
    );
    expect(knowledgeAccessError('RESTRICTED', departments, [MEMBER_USER_ID])).toBeNull();
  });

  it('rejects a restricted mode with no selected audience', () => {
    expect(knowledgeAccessError('RESTRICTED', [], [])).toContain('至少一个可访问部门或成员');
  });
});
