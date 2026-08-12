import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listMemberInvitations: vi.fn(),
  updateMember: vi.fn(),
}));

vi.mock('@/api/member-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/member-api')>()),
  ...api,
}));

import { MembersPage } from './MembersPage';

const ORGANIZATION = {
  organization: {
    id: '00000000-0000-7000-8000-000000000001',
    name: '示例企业',
    legalName: null,
    timezone: 'Asia/Shanghai',
    version: 1,
  },
  orgUnits: [
    {
      id: '00000000-0000-7000-8000-000000000002',
      organizationId: '00000000-0000-7000-8000-000000000001',
      parentId: null,
      name: '产品部',
      sortOrder: 0,
      status: 'ACTIVE',
      version: 1,
      memberCount: 0,
      source: 'LOCAL',
    },
  ],
  members: [],
} as const;

const FEISHU_MEMBER = {
  id: '00000000-0000-7000-8000-000000000003',
  email: 'feishu-user@external.invalid',
  displayName: '飞书成员',
  status: 'ACTIVE',
  role: 'MEMBER',
  source: 'FEISHU',
  employment: {
    id: '00000000-0000-7000-8000-000000000004',
    organizationId: ORGANIZATION.organization.id,
    orgUnitId: ORGANIZATION.orgUnits[0].id,
    title: '产品经理',
    status: 'ACTIVE',
  },
} as const;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOrganization.mockResolvedValue(ORGANIZATION);
  api.listMemberInvitations.mockResolvedValue([]);
  api.updateMember.mockResolvedValue(FEISHU_MEMBER);
});

describe('MembersPage account onboarding', () => {
  it('uses one complete local member form without a Feishu or legacy-password dependency', async () => {
    const dom = await renderInTestDom(
      createElement(MembersPage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const invite = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '添加成员',
      );
      expect(invite?.className).toContain('primary');
      expect(dom.container.textContent).not.toContain('使用初始密码建号');
      expect(dom.container.textContent).not.toContain('高级');
      expect(dom.container.querySelector('input[type="password"]')).toBeNull();

      await dom.click(invite!);
      const dialog = dom.container.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('基础信息');
      expect(dialog?.textContent).toContain('工作信息');
      expect(dialog?.textContent).toContain('在用户端自行完善个人使用说明书');
      expect(dialog?.textContent).not.toContain('您可能会问这些问题');
      expect(dialog?.textContent).toContain('正式');
      expect(dialog?.textContent).toContain('实习');
      expect(dialog?.textContent).toContain('外包');
      expect(dialog?.textContent).toContain('劳务');
      expect(dialog?.textContent).toContain('顾问');
      expect(dialog?.querySelector('input[name="phoneNumber"]')).not.toBeNull();
      expect(dialog?.querySelector('select[name="directManagerUserId"]')).not.toBeNull();
      expect(dialog?.querySelector('textarea[name="jobResponsibilities"]')).toBeNull();
      expect(dialog?.textContent).not.toContain('初始密码');
    } finally {
      await dom.cleanup();
    }
  });

  it('allows a Feishu member login email to be replaced while keeping synced fields read-only', async () => {
    api.getOrganization.mockResolvedValue({ ...ORGANIZATION, members: [FEISHU_MEMBER] });
    const dom = await renderInTestDom(
      createElement(MembersPage, {
        currentUserId: '00000000-0000-7000-8000-000000000099',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const manage = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '管理',
      );
      await dom.click(manage!);

      const dialog = dom.container.querySelector('[role="dialog"]');
      const email = dialog?.querySelector('input[aria-label="登录邮箱"]') as HTMLInputElement;
      const syncedInputs = [...(dialog?.querySelectorAll('input') ?? [])].filter(
        (input) => input !== email,
      );
      const invitation = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '发送一次性邀请',
      );

      expect(email.value).toBe('feishu-user@external.invalid');
      expect(email.disabled).toBe(false);
      expect(syncedInputs.some((input) => input.disabled)).toBe(true);
      expect(dialog?.textContent).toContain('登录邮箱与企业角色由本地身份系统维护');
      expect(dialog?.textContent).toContain('请先填写并保存真实登录邮箱');
      expect(invitation?.hasAttribute('disabled')).toBe(true);

      await dom.change(email, ' Real.Member@Example.COM ');
      const savedMember = { ...FEISHU_MEMBER, email: 'real.member@example.com' };
      api.updateMember.mockResolvedValue(savedMember);
      api.getOrganization.mockResolvedValue({ ...ORGANIZATION, members: [savedMember] });
      const form = email.closest('form') as HTMLFormElement;
      await dom.submit(form);
      await dom.flush();
      await dom.flush();

      expect(api.updateMember).toHaveBeenCalledWith(FEISHU_MEMBER.id, {
        email: 'real.member@example.com',
        role: 'MEMBER',
      });

      const reopenedManage = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '管理',
      );
      await dom.click(reopenedManage!);
      const reopenedDialog = dom.container.querySelector('[role="dialog"]');
      const reopenedInvitation = [...(reopenedDialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '发送一次性邀请',
      );
      expect(
        (reopenedDialog?.querySelector('input[aria-label="登录邮箱"]') as HTMLInputElement).value,
      ).toBe('real.member@example.com');
      expect(reopenedInvitation?.hasAttribute('disabled')).toBe(false);
      expect(reopenedDialog?.textContent).not.toContain('请先填写并保存真实登录邮箱');
    } finally {
      await dom.cleanup();
    }
  });
});
