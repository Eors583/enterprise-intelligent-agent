import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  getLexiangKnowledgeConnection: vi.fn(),
  connectLexiangKnowledge: vi.fn(),
  discoverLexiangKnowledgeConnection: vi.fn(),
  checkLexiangKnowledgeHealth: vi.fn(),
  disableLexiangKnowledge: vi.fn(),
  syncLexiangKnowledgeBases: vi.fn(),
}));

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { KnowledgeIntegrationsPage } from './KnowledgeIntegrationsPage';

const ACTIVE_CONNECTION = {
  id: '00000000-0000-7000-8000-000000000001',
  provider: 'LEXIANG',
  status: 'ACTIVE',
  appKeyHint: 'lexi…-app',
  teamId: 'team-1',
  operatorStaffId: 'staff-1',
  credentialsConfigured: true,
  lastHealthAt: '2026-08-13T03:00:00.000Z',
  lastHealthCode: 'LEXIANG_TOKEN_OK',
} as const;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getLexiangKnowledgeConnection.mockResolvedValue({ connection: null });
  api.connectLexiangKnowledge.mockResolvedValue({ connection: ACTIVE_CONNECTION });
  api.discoverLexiangKnowledgeConnection.mockResolvedValue({
    teamStatus: 'AVAILABLE',
    operatorStatus: 'AVAILABLE',
    teams: [{ id: 'team-1', code: 'k10001', name: '产品团队' }],
    operators: [{ staffId: 'staff-1', name: '张三' }],
  });
  api.syncLexiangKnowledgeBases.mockResolvedValue({
    discovered: 4,
    imported: 3,
    updated: 1,
    requiresPrivacyReview: 0,
    entriesDiscovered: 629,
    foldersSynchronized: 65,
    documentsDiscovered: 564,
    documentsImported: 564,
    documentsUpdated: 0,
    documentsArchived: 0,
  });
});

describe('KnowledgeIntegrationsPage', () => {
  it('shows the Lexiang entry and saves only write-only credentials through the API', async () => {
    const dom = await renderInTestDom(createElement(KnowledgeIntegrationsPage));
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('腾讯乐享知识库');
      expect(dom.container.textContent).toContain('未配置');
      const appKey = dom.container.querySelector<HTMLInputElement>('input[name="appKey"]')!;
      expect(dom.container.querySelector<HTMLInputElement>('input[name="appSecret"]')?.type).toBe(
        'password',
      );

      await dom.change(appKey, 'lexiang-app');
      const appSecret = dom.container.querySelector<HTMLInputElement>('input[name="appSecret"]')!;
      await dom.change(appSecret, 'new-secret-value');
      await dom.flush();
      const discoverButton = Array.from(dom.container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('自动获取团队与访问身份'),
      );
      expect(discoverButton).toBeTruthy();
      expect(discoverButton?.hasAttribute('disabled')).toBe(false);
      await dom.click(discoverButton!);
      await dom.flush();

      expect(api.discoverLexiangKnowledgeConnection).toHaveBeenCalledWith({
        appKey: 'lexiang-app',
        appSecret: 'new-secret-value',
      });
      expect(dom.container.querySelector<HTMLSelectElement>('select[name="teamId"]')?.value).toBe(
        'team-1',
      );
      expect(
        dom.container.querySelector<HTMLSelectElement>('select[name="operatorStaffId"]')?.value,
      ).toBe('staff-1');
      expect(dom.container.textContent).toContain('已自动回填乐享团队和访问身份');
      expect(dom.container.textContent).toContain('不对应本系统员工');
      await dom.submit(dom.container.querySelector('form')!);
      await dom.flush();
      await dom.flush();

      expect(api.connectLexiangKnowledge).toHaveBeenCalledWith({
        appKey: 'lexiang-app',
        appSecret: 'new-secret-value',
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
      });
      expect(api.syncLexiangKnowledgeBases).toHaveBeenCalledOnce();
      expect(dom.container.textContent).toContain('已连接');
      expect(dom.container.textContent).toContain('已加密保存');
      expect(dom.container.textContent).toContain('已发现 4 个知识库，新导入 3 个，更新 1 个');
      expect(dom.container.textContent).not.toContain('new-secret-value');
    } finally {
      await dom.cleanup();
    }
  });

  it('explains the only manual fallback when Lexiang hides the bound team scope', async () => {
    api.discoverLexiangKnowledgeConnection.mockResolvedValue({
      teamStatus: 'FORBIDDEN',
      operatorStatus: 'AVAILABLE',
      teams: [],
      operators: [{ staffId: 'staff-1', name: '张三' }],
    });
    const dom = await renderInTestDom(createElement(KnowledgeIntegrationsPage));
    try {
      await dom.flush();
      await dom.change(
        dom.container.querySelector<HTMLInputElement>('input[name="appKey"]')!,
        'lexiang-app',
      );
      await dom.change(
        dom.container.querySelector<HTMLInputElement>('input[name="appSecret"]')!,
        'new-secret-value',
      );
      const discoverButton = Array.from(dom.container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('自动获取团队与访问身份'),
      );
      await dom.click(discoverButton!);
      await dom.flush();

      const teamInput = dom.container.querySelector<HTMLInputElement>('input[name="teamId"]');
      expect(teamInput?.hasAttribute('disabled')).toBe(false);
      expect(
        dom.container.querySelector<HTMLSelectElement>('select[name="operatorStaffId"]')?.value,
      ).toBe('staff-1');
      expect(dom.container.textContent).toContain('开启“团队管理/获取团队列表”权限');
    } finally {
      await dom.cleanup();
    }
  });
});
