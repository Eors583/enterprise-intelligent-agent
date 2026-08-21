import type { AdminMember } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildMemberInvitationRequest,
  buildMemberUpdateRequest,
  isPlaceholderMemberEmail,
} from './MembersPage';

const member: AdminMember = {
  id: '83ceae87-554e-451d-b411-c336f1d02bf9',
  email: 'member@example.com',
  displayName: '飞书成员',
  status: 'ACTIVE',
  role: 'MEMBER',
  source: 'FEISHU',
  employment: {
    id: '84462570-5da1-4715-b1f7-0a8a66ec3e7f',
    organizationId: 'b39eb6b8-d537-4e83-b096-25375c4c6f51',
    orgUnitId: 'f5643c90-0f0f-4df8-a2b5-42c9a9c97736',
    title: '产品经理',
    status: 'ACTIVE',
  },
};

describe('member synchronization ownership policy', () => {
  it('builds a complete passwordless local member invitation payload', () => {
    const form = new FormData();
    for (const [name, value] of Object.entries({
      displayName: '张晨',
      email: 'zhang.chen@example.com',
      role: 'MEMBER',
      orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
      phoneCountryCode: '+86',
      phoneNumber: '13800000000',
      employmentType: 'REGULAR',
      hireDate: '2026-08-10',
      countryOrRegion: '中国',
      city: '深圳',
      jobResponsibilities: '负责产品规划与交付。',
      coreSkills: '产品设计、业务分析。',
    })) {
      form.set(name, value);
    }

    const request = buildMemberInvitationRequest(form);
    expect(request).toMatchObject({
      displayName: '张晨',
      phone: '+86 13800000000',
      employmentType: 'REGULAR',
      hireDate: '2026-08-10',
      countryOrRegion: '中国',
      city: '深圳',
    });
    expect(request).not.toHaveProperty('personalManual');
  });

  it('submits the local login email and enterprise role for a Feishu-managed member', () => {
    expect(
      buildMemberUpdateRequest(member, {
        email: '  New.Login@Example.COM ',
        displayName: '不应提交的姓名',
        role: 'ADMIN',
        status: 'LOCKED',
        orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
        title: '不应提交的职位',
      }),
    ).toEqual({ email: 'new.login@example.com', role: 'ADMIN' });
  });

  it('keeps all editable fields for a locally managed member', () => {
    expect(
      buildMemberUpdateRequest(
        { ...member, source: 'LOCAL' },
        {
          email: 'Local.Member@Example.COM',
          displayName: '本地成员',
          role: 'KNOWLEDGE_ADMIN',
          status: 'INACTIVE',
          orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
          title: '知识管理员',
        },
      ),
    ).toEqual({
      email: 'local.member@example.com',
      displayName: '本地成员',
      role: 'KNOWLEDGE_ADMIN',
      status: 'INACTIVE',
      orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
      title: '知识管理员',
    });
  });

  it('recognizes generated Feishu placeholder addresses case-insensitively', () => {
    expect(isPlaceholderMemberEmail('feishu-123@external.invalid')).toBe(true);
    expect(isPlaceholderMemberEmail(' FEISHU-123@EXTERNAL.INVALID ')).toBe(true);
    expect(isPlaceholderMemberEmail('member@example.com')).toBe(false);
  });

  it('does not resubmit an unchanged placeholder when only the local role changes', () => {
    expect(
      buildMemberUpdateRequest(member, {
        email: member.email,
        displayName: member.displayName,
        role: 'ADMIN',
        status: member.status,
        orgUnitId: member.employment!.orgUnitId,
        title: member.employment!.title ?? '',
      }),
    ).toEqual({ role: 'ADMIN' });
  });
});
