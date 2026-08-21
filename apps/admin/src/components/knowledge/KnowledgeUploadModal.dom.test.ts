import { createElement } from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  inspectKnowledgeUpload: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  uploadKnowledgeDocumentVersion: vi.fn(),
}));

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { KnowledgeUploadModal } from './KnowledgeUploadModal';

const knowledgeBaseId = '00000000-0000-7000-8000-000000000010';
const departmentId = '00000000-0000-7000-8000-000000000020';

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectKnowledgeUpload.mockResolvedValue({
    decision: 'NEW_DOCUMENT',
    matchingDocument: null,
  });
  api.updateKnowledgeBase.mockResolvedValue({});
  api.uploadKnowledgeDocument.mockResolvedValue({
    id: '00000000-0000-7000-8000-000000000030',
    versions: [],
  });
});

describe('KnowledgeUploadModal access control', () => {
  it('saves the selected knowledge-base access scope before uploading the file', async () => {
    const onUploaded = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeUploadModal, {
        knowledgeBase: {
          id: knowledgeBaseId,
          name: '员工制度库',
          version: 7,
          orgUnitScopes: [],
          memberUserIds: [],
        },
        organization: {
          organization: {
            id: '00000000-0000-7000-8000-000000000001',
            name: '示例企业',
            legalName: null,
            timezone: 'Asia/Shanghai',
            version: 1,
          },
          orgUnits: [
            {
              id: departmentId,
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
        },
        organizationReady: true,
        onClose: vi.fn(),
        onUploaded,
      }),
    );

    try {
      const fileInput = dom.container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(fileInput).not.toBeNull();
      const file = new File(['员工制度内容'], '员工制度.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [file],
      });
      await act(async () => {
        fileInput!.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await dom.flush();
      await dom.flush();

      const restricted = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('仅指定部门或成员可访问'),
      );
      expect(restricted).toBeDefined();
      await dom.click(restricted!.querySelector('input')!);

      const productDepartment = [...dom.container.querySelectorAll('label')].find(
        (label) => label.textContent?.trim() === '产品部',
      );
      expect(productDepartment).toBeDefined();
      await dom.click(productDepartment!.querySelector('input')!);

      const form = dom.container.querySelector<HTMLFormElement>('form');
      expect(form).not.toBeNull();
      await dom.submit(form!);
      await dom.flush();

      expect(api.updateKnowledgeBase).toHaveBeenCalledWith(knowledgeBaseId, {
        orgUnitScopes: [{ orgUnitId: departmentId, includeChildren: true }],
        memberUserIds: [],
        expectedVersion: 7,
      });
      expect(api.uploadKnowledgeDocument).toHaveBeenCalledWith(
        knowledgeBaseId,
        expect.objectContaining({ file, title: '员工制度' }),
      );
      expect(api.updateKnowledgeBase.mock.invocationCallOrder[0]).toBeLessThan(
        api.uploadKnowledgeDocument.mock.invocationCallOrder[0]!,
      );
      expect(onUploaded).toHaveBeenCalledTimes(1);
    } finally {
      await dom.cleanup();
    }
  });

  it('does not upload when saving the access scope fails', async () => {
    api.updateKnowledgeBase.mockRejectedValueOnce(new Error('知识库已被其他人修改'));
    const dom = await renderInTestDom(
      createElement(KnowledgeUploadModal, {
        knowledgeBase: {
          id: knowledgeBaseId,
          name: '员工制度库',
          version: 7,
          orgUnitScopes: [],
          memberUserIds: [],
        },
        organization: {
          organization: {
            id: '00000000-0000-7000-8000-000000000001',
            name: '示例企业',
            legalName: null,
            timezone: 'Asia/Shanghai',
            version: 1,
          },
          orgUnits: [
            {
              id: departmentId,
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
        },
        organizationReady: true,
        onClose: vi.fn(),
        onUploaded: vi.fn(),
      }),
    );

    try {
      const fileInput = dom.container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File(['员工制度内容'], '员工制度.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      await act(async () => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await dom.flush();
      await dom.flush();

      const restricted = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('仅指定部门或成员可访问'),
      )!;
      await dom.click(restricted.querySelector('input')!);
      const productDepartment = [...dom.container.querySelectorAll('label')].find(
        (label) => label.textContent?.trim() === '产品部',
      )!;
      await dom.click(productDepartment.querySelector('input')!);
      await dom.submit(dom.container.querySelector('form')!);
      await dom.flush();

      expect(api.updateKnowledgeBase).toHaveBeenCalledTimes(1);
      expect(api.uploadKnowledgeDocument).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain('知识库已被其他人修改');
    } finally {
      await dom.cleanup();
    }
  });
});
