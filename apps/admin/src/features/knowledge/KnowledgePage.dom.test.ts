import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  getLexiangKnowledgeConnection: vi.fn(),
  syncExternalKnowledgeBase: vi.fn(),
  syncLexiangKnowledgeBases: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  listKnowledgeSourceConnectors: vi.fn(),
  testKnowledgeRetrieval: vi.fn(),
}));

const organizationFixture = {
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
      status: 'ACTIVE' as const,
      version: 1,
      memberCount: 0,
      source: 'LOCAL' as const,
    },
  ],
  members: [],
};

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { KnowledgePage } from './KnowledgePage';

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOrganization.mockResolvedValue(organizationFixture);
  api.listKnowledgeBases.mockResolvedValue({ items: [] });
  api.getLexiangKnowledgeConnection.mockResolvedValue({ connection: null });
  api.listKnowledgeSourceConnectors.mockResolvedValue({ items: [] });
});

describe('KnowledgePage creation defaults', () => {
  it('labels and runs an active Lexiang knowledge base test as remote AI search', async () => {
    const existing = {
      ...knowledgeBase(),
      name: '咨询圈文库资料1',
      storageProvider: 'LEXIANG' as const,
      externalSpace: {
        provider: 'LEXIANG' as const,
        status: 'ACTIVE' as const,
        externalTeamId: 'team-1',
        externalSpaceId: 'space-1',
        externalRootEntryId: 'root-1',
        name: '咨询圈文库资料1',
        description: null,
        logo: null,
        visibleType: 0,
        managerInheritType: 'none',
        memberInheritType: 'none',
        lastSyncedAt: '2026-08-13T00:00:00.000Z',
        lastErrorCode: null,
      },
    };
    api.listKnowledgeBases.mockResolvedValue({ items: [existing] });
    api.testKnowledgeRetrieval.mockResolvedValue({
      query: '华为客户关系',
      simulatedUserId: '00000000-0000-7000-8000-000000000003',
      accessibleKnowledgeBaseIds: [existing.id],
      mode: 'HYBRID',
      embeddingModel: null,
      reranker: 'WEIGHTED_SCORE',
      rerankerModel: null,
      degradedReason: null,
      lexicalCandidateCount: 0,
      vectorCandidateCount: 0,
      relationshipCandidateCount: 0,
      relationshipExpandedCount: 0,
      semanticCoverage: 0,
      diagnostics: [
        {
          stage: 'EXTERNAL',
          status: 'APPLIED',
          code: 'LEXIANG_AI_SEARCH_APPLIED',
          candidateCount: 0,
        },
      ],
      noAnswer: true,
      elapsedMs: 32,
      items: [],
    });
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const retrievalTab = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '检索测试',
      );
      await dom.click(retrievalTab!);
      expect(dom.container.textContent).toContain('调用腾讯乐享 AI 搜索检索当前知识库');
      expect(dom.container.textContent).toContain('腾讯乐享当前内容（远程检索）');

      const query = dom.container.querySelector<HTMLTextAreaElement>(
        '.knowledge-retrieval-form textarea',
      );
      const form = dom.container.querySelector<HTMLFormElement>('.knowledge-retrieval-form');
      expect(query).not.toBeNull();
      expect(form).not.toBeNull();
      await dom.change(query!, '华为客户关系');
      await dom.submit(form!);
      await dom.flush();

      expect(api.testKnowledgeRetrieval).toHaveBeenCalledWith(existing.id, {
        query: '华为客户关系',
        limit: 8,
      });
      expect(dom.container.textContent).toContain('由腾讯乐享 AI 搜索返回证据');
      expect(dom.container.textContent).toContain('腾讯乐享 AI 搜索');
    } finally {
      await dom.cleanup();
    }
  });

  it('uploads files into the selected Lexiang knowledge base without creating another library', async () => {
    const existing = {
      ...knowledgeBase(),
      name: '现有空乐享库',
      storageProvider: 'LEXIANG' as const,
      externalSpace: {
        provider: 'LEXIANG' as const,
        status: 'ACTIVE' as const,
        externalTeamId: 'team-1',
        externalSpaceId: 'space-existing',
        externalRootEntryId: 'root-existing',
        name: '现有空乐享库',
        description: null,
        logo: null,
        visibleType: 0,
        managerInheritType: 'none',
        memberInheritType: 'none',
        lastSyncedAt: '2026-08-13T00:00:00.000Z',
        lastErrorCode: null,
      },
    };
    api.listKnowledgeBases.mockResolvedValue({ items: [existing] });
    api.uploadKnowledgeDocument.mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000030',
      versions: [],
    });
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传到当前库'),
      );
      expect(upload).toBeDefined();
      expect(upload?.disabled).toBe(false);
      await dom.click(upload!);
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
        '文件只会写入当前知识库，不会创建新的知识库',
      );
      expect(dom.container.textContent).not.toContain('知识存放位置');

      const fileInput = dom.container.querySelector<HTMLInputElement>(
        '[role="dialog"] input[type="file"]',
      );
      expect(fileInput).not.toBeNull();
      const file = new File(['制度内容'], '员工制度.pdf', { type: 'application/pdf' });
      Object.defineProperty(fileInput!, 'files', { configurable: true, value: [file] });
      await act(async () => {
        fileInput!.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await dom.flush();
      const form = dom.container.querySelector<HTMLFormElement>('[role="dialog"] form');
      expect(form).not.toBeNull();
      await dom.submit(form!);
      await dom.flush();
      await dom.flush();

      expect(api.createKnowledgeBase).not.toHaveBeenCalled();
      expect(api.uploadKnowledgeDocument).toHaveBeenCalledWith(existing.id, {
        file,
        title: '员工制度.pdf',
      });
      expect(dom.container.textContent).toContain('已向“现有空乐享库”上传 1 份文件');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows a direct delete action for an empty knowledge base instead of hiding it in status settings', async () => {
    const emptyKnowledgeBase = knowledgeBase();
    api.listKnowledgeBases.mockResolvedValue({ items: [emptyKnowledgeBase] });
    api.updateKnowledgeBase.mockResolvedValue({});
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    try {
      await dom.flush();
      await dom.flush();
      const settings = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('知识库设置'),
      );
      await dom.click(settings!);
      const deleteButton = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '删除知识库',
      );
      expect(deleteButton).toBeDefined();
      expect(dom.container.textContent).not.toContain('删除（停止检索）');

      await dom.click(deleteButton!);
      expect(confirm).toHaveBeenCalledOnce();
      expect(api.deleteKnowledgeBase).toHaveBeenCalledWith(
        emptyKnowledgeBase.id,
        emptyKnowledgeBase.version,
      );
    } finally {
      await dom.cleanup();
    }
  });

  it('prioritizes file upload and hides internal key and initial status from empty-library creation', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传资料'),
      );
      expect(upload?.className).toContain('primary');
      expect(dom.container.querySelector('.page-action-advanced')).toBeNull();
      expect(dom.container.textContent).toContain('公司知识');
      expect(dom.container.textContent).toContain('部门知识');
      expect(dom.container.textContent).toContain('项目知识');
      expect(dom.container.textContent).toContain('成员知识');

      const emptyLibrary = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建空库'),
      );
      expect(emptyLibrary).toBeDefined();
      const synchronize = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('同步乐享知识库'),
      );
      expect(synchronize?.disabled).toBe(true);
      expect(synchronize?.title).toContain('知识来源');
      await dom.click(emptyLibrary!);
      expect(dom.container.textContent).toContain('自动生成内部标识');
      expect(dom.container.textContent).not.toContain('唯一标识');
      expect(dom.container.textContent).not.toContain('初始状态');
      expect(dom.container.textContent).toContain('系统完成解析、切片和索引后');
      expect(dom.container.textContent).toContain('自动对员工可用');
      expect(dom.container.textContent).toContain('知识归属账号固定为当前登录账号');
      expect(dom.container.textContent).toContain('知识存放位置');
      expect(dom.container.textContent).not.toContain('所属成员');
      const memberSpace = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('成员知识'),
      );
      expect(memberSpace).toBeDefined();
      await dom.click(memberSpace!.querySelector('input')!);
      expect(dom.container.textContent).toContain('成员知识归入当前登录账号：当前管理员');
      expect(dom.container.textContent).not.toContain('暂无可选成员');
    } finally {
      await dom.cleanup();
    }
  });

  it('creates a Lexiang-managed knowledge base when an active team connection is available', async () => {
    const created = {
      ...knowledgeBase(),
      storageProvider: 'LEXIANG' as const,
      externalSpace: {
        provider: 'LEXIANG' as const,
        status: 'ACTIVE' as const,
        externalTeamId: 'team-1',
        externalSpaceId: 'space-1',
        externalRootEntryId: 'root-1',
        name: '空知识库',
        description: null,
        logo: null,
        visibleType: 0,
        managerInheritType: 'none',
        memberInheritType: 'none',
        lastSyncedAt: '2026-08-13T00:00:00.000Z',
        lastErrorCode: null,
      },
    };
    api.getLexiangKnowledgeConnection.mockResolvedValue({
      connection: {
        id: '00000000-0000-7000-8000-000000000020',
        provider: 'LEXIANG',
        status: 'ACTIVE',
        appKeyHint: 'app…key',
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
        credentialsConfigured: true,
        lastHealthAt: '2026-08-13T00:00:00.000Z',
        lastHealthCode: 'LEXIANG_KB_TEAM_OK',
      },
    });
    api.createKnowledgeBase.mockResolvedValue(created);
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const create = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建空库'),
      );
      await dom.click(create!);
      const dialog = dom.container.querySelector('[role="dialog"]')!;
      const storage = [...dialog.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('知识库存储'))
        ?.querySelector('select');
      expect(storage?.value).toBe('LEXIANG');
      await dom.submit(dialog.querySelector('form')!);
      await dom.flush();

      expect(api.createKnowledgeBase).toHaveBeenCalledWith(
        expect.objectContaining({ storageProvider: 'LEXIANG' }),
      );
      expect(dom.container.textContent).toContain('已在腾讯乐享创建并完成本地绑定');
    } finally {
      await dom.cleanup();
    }
  });

  it('imports existing Lexiang spaces from the bound team and explains safe draft access', async () => {
    api.getLexiangKnowledgeConnection.mockResolvedValue({
      connection: {
        id: '00000000-0000-7000-8000-000000000020',
        provider: 'LEXIANG',
        status: 'ACTIVE',
        appKeyHint: 'app…key',
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
        credentialsConfigured: true,
        lastHealthAt: '2026-08-13T00:00:00.000Z',
        lastHealthCode: 'LEXIANG_KB_TEAM_OK',
      },
    });
    api.syncLexiangKnowledgeBases.mockResolvedValue({
      discovered: 4,
      imported: 3,
      updated: 1,
      requiresPrivacyReview: 2,
      entriesDiscovered: 629,
      foldersSynchronized: 65,
      documentsDiscovered: 564,
      documentsImported: 564,
      documentsUpdated: 0,
      documentsArchived: 0,
    });
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const synchronize = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('同步乐享知识库'),
      );
      expect(synchronize).toBeDefined();
      expect(synchronize?.disabled).toBe(false);
      await dom.click(synchronize!);
      await dom.flush();

      expect(api.syncLexiangKnowledgeBases).toHaveBeenCalledOnce();
      expect(dom.container.textContent).toContain('已发现 4 个乐享知识库，新导入 3 个，更新 1 个');
      expect(dom.container.textContent).toContain('新导入知识库以草稿保存');
      expect(dom.container.textContent).toContain('2 个知识库仍继承乐享侧权限');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps file upload as the primary document action and text as a secondary source', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item: {
          id: '00000000-0000-7000-8000-000000000010',
          name: '员工制度库',
          status: 'DRAFT',
          version: 1,
          orgUnitScopes: [],
          memberUserIds: [],
          documents: [],
        } as never,
        organization: organizationFixture as never,
        organizationReady: true,
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传文件'),
      );
      const textEntry = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('粘贴文本'),
      );
      expect(upload?.className).toContain('primary');
      expect(textEntry).toBeDefined();
      expect(textEntry?.closest('details')).toBeNull();
      expect(dom.container.textContent).not.toContain('更多录入方式');
      expect(dom.container.textContent).toContain('PDF、Word、Excel、TXT 或 Markdown');
      expect(dom.container.textContent).not.toContain('手工录入');

      await dom.click(upload!);
      await dom.flush();
      const uploadDialog = dom.container.querySelector('[role="dialog"]');
      expect(uploadDialog?.textContent).toContain('谁可以让智能体使用这些知识');
      expect(uploadDialog?.textContent).toContain('全公司成员可访问');
      expect(uploadDialog?.textContent).toContain('仅指定部门或成员可访问');
      expect(uploadDialog?.textContent).not.toContain('新文件和新版本都会继承');

      const closeUpload = [...(uploadDialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '取消',
      );
      await dom.click(closeUpload!);

      const otherSources = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('其他来源接入'),
      );
      expect(otherSources).toBeDefined();
      expect(dom.container.textContent).not.toContain('企业网盘与文档源');
      await dom.click(otherSources!);
      await dom.flush();
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain('其他来源接入');
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
        '企业网盘与文档源',
      );
    } finally {
      await dom.cleanup();
    }
  });

  it('offers folder upload for an active Lexiang-managed knowledge base', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item: {
          ...knowledgeBase(),
          name: '乐享制度库',
          storageProvider: 'LEXIANG',
          externalSpace: { status: 'ACTIVE' },
        } as never,
        organization: organizationFixture as never,
        organizationReady: true,
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      const folderUpload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('导入文件夹'),
      );
      expect(folderUpload).toBeDefined();
      expect(folderUpload?.disabled).toBe(false);
      expect(dom.container.querySelector('input[webkitdirectory]')).not.toBeNull();
      expect(dom.container.textContent).toContain('上传第一个文件夹');
      expect(dom.container.textContent).toContain('会写入腾讯乐享');
      expect(dom.container.textContent).not.toContain('上传文件');
      expect(dom.container.textContent).not.toContain('粘贴文本');
    } finally {
      await dom.cleanup();
    }
  });
});

function knowledgeBase() {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    key: 'empty-library',
    name: '空知识库',
    description: null,
    status: 'ACTIVE' as const,
    space: {
      type: 'COMPANY' as const,
      targetId: '00000000-0000-7000-8000-000000000001',
      targetName: '公司知识',
    },
    version: 1,
    retrievalConfig: {
      mode: 'HYBRID' as const,
      topK: 8,
      scoreThreshold: 0.08,
      semanticWeight: 0.7,
      keywordWeight: 0.3,
      rerankEnabled: true,
      relationshipRetrievalEnabled: true,
      maxChunksPerDocument: 3,
    },
    chunkingConfig: { targetTokens: 500, overlapTokens: 80 },
    activeEmbeddingIndexVersion: null,
    pendingEmbeddingIndexVersion: null,
    orgUnitIds: [],
    orgUnitScopes: [],
    memberUserIds: [],
    documentCount: 0,
    folders: [],
    documents: [],
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}
