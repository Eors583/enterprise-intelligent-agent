import type { AdminMember } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { buildMemberUpdateRequest } from './MembersPage';

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
  it('only submits the local enterprise role for a Feishu-managed member', () => {
    expect(
      buildMemberUpdateRequest(member, {
        displayName: '不应提交的姓名',
        role: 'ADMIN',
        status: 'LOCKED',
        orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
        title: '不应提交的职位',
      }),
    ).toEqual({ role: 'ADMIN' });
  });

  it('keeps all editable fields for a locally managed member', () => {
    expect(
      buildMemberUpdateRequest(
        { ...member, source: 'LOCAL' },
        {
          displayName: '本地成员',
          role: 'KNOWLEDGE_ADMIN',
          status: 'INACTIVE',
          orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
          title: '知识管理员',
        },
      ),
    ).toEqual({
      displayName: '本地成员',
      role: 'KNOWLEDGE_ADMIN',
      status: 'INACTIVE',
      orgUnitId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
      title: '知识管理员',
    });
  });
});
