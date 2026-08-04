import type { AdminMember } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  assignmentEffectiveFrom,
  controlledMemoryPolicy,
  controlledOrganizationScope,
  eligibleAssignmentMembers,
  parseScopeJson,
  roleAssignmentSourceLabel,
  roleAssignmentStatusLabel,
} from './role-assignment-view';

const baseMember: AdminMember = {
  id: '00000000-0000-7000-8000-000000000201',
  email: 'lin@example.com',
  displayName: '林晓',
  status: 'ACTIVE',
  role: 'MEMBER',
  source: 'LOCAL',
  employment: {
    id: '00000000-0000-7000-8000-000000000203',
    organizationId: '00000000-0000-7000-8000-000000000204',
    orgUnitId: '00000000-0000-7000-8000-000000000205',
    title: '产品经理',
    status: 'ACTIVE',
  },
};

describe('role assignment view model', () => {
  it('only exposes active members with an ACTIVE employment', () => {
    expect(
      eligibleAssignmentMembers([
        { ...baseMember, id: '00000000-0000-7000-8000-000000000202', status: 'LOCKED' },
        {
          ...baseMember,
          id: '00000000-0000-7000-8000-000000000206',
          employment: { ...baseMember.employment!, status: 'SUSPENDED' },
        },
        {
          ...baseMember,
          id: '00000000-0000-7000-8000-000000000207',
          employment: null,
        },
        baseMember,
      ]),
    ).toEqual([baseMember]);
  });

  it('maps governance states and sources to clear labels', () => {
    expect(roleAssignmentStatusLabel('ACTIVE')).toBe('生效中');
    expect(roleAssignmentStatusLabel('REVOKED')).toBe('已撤销');
    expect(roleAssignmentSourceLabel('TEMPORARY')).toBe('临时任命');
    expect(roleAssignmentSourceLabel('HANDOVER')).toBe('交接');
  });

  it('accepts object scopes and rejects malformed or non-object JSON', () => {
    expect(parseScopeJson(' {"orgUnitIds":["product"]} ', '组织范围')).toEqual({
      orgUnitIds: ['product'],
    });
    expect(parseScopeJson('', '组织范围')).toEqual({});
    expect(() => parseScopeJson('[1,2]', '组织范围')).toThrow(
      '组织范围必须是 JSON 对象，不能是数组或基础值。',
    );
    expect(() => parseScopeJson('{', '权限范围')).toThrow('权限范围必须是有效的 JSON 对象。');
  });

  it('converts controlled organization and memory choices into compatible policy objects', () => {
    expect(
      controlledOrganizationScope('MEMBER_UNIT', baseMember.employment!.orgUnitId, '', true),
    ).toEqual({
      organizationIds: [baseMember.employment!.orgUnitId],
      includeDescendants: false,
    });
    expect(
      controlledOrganizationScope(
        'SELECTED_UNIT',
        baseMember.employment!.orgUnitId,
        '00000000-0000-7000-8000-000000000299',
        true,
      ),
    ).toEqual({
      organizationIds: ['00000000-0000-7000-8000-000000000299'],
      includeDescendants: true,
    });
    expect(controlledMemoryPolicy('BLUEPRINT_DEFAULT')).toEqual({});
    expect(controlledMemoryPolicy('ROLE_ONLY_30')).toEqual({
      roleOnly: true,
      retentionDays: 30,
    });
    expect(controlledMemoryPolicy('SHARED_90')).toEqual({
      roleOnly: false,
      retentionDays: 90,
    });
  });

  it('defaults a new assignment to the current instant without requiring a datetime field', () => {
    const now = new Date('2026-07-29T10:30:00.000Z');
    expect(assignmentEffectiveFrom(true, '', now)).toBe(now.toISOString());
    expect(assignmentEffectiveFrom(false, '2026-07-30T09:15', now)).toBe(
      new Date('2026-07-30T09:15').toISOString(),
    );
  });
});
