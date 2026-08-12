import type { KnowledgeBase } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  ensureKnowledgeFolders: vi.fn(),
  inspectKnowledgeUpload: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  uploadKnowledgeDocumentVersion: vi.fn(),
}));
vi.mock('@/api/admin-api', () => api);

import { KnowledgeFolderUploadModal } from './KnowledgeFolderUploadModal';

beforeEach(() => {
  api.ensureKnowledgeFolders.mockReset();
  api.inspectKnowledgeUpload.mockReset();
  api.uploadKnowledgeDocument.mockReset();
  api.uploadKnowledgeDocumentVersion.mockReset();
});

describe('KnowledgeFolderUploadModal', () => {
  it('shows skipped and failed files and retries only failed uploads', async () => {
    api.ensureKnowledgeFolders.mockResolvedValue({
      items: [
        { id: 'folder-a', path: '企业战略' },
        { id: 'folder-b', path: '项目资料' },
      ],
    });
    api.inspectKnowledgeUpload.mockImplementation(
      (_knowledgeBaseId: string, input: { fileName: string }) =>
        Promise.resolve(
          input.fileName === '重复资料.txt'
            ? { decision: 'EXACT_DUPLICATE', matchingDocument: null }
            : { decision: 'NEW_DOCUMENT', matchingDocument: null },
        ),
    );
    api.uploadKnowledgeDocument
      .mockRejectedValueOnce(new Error('上传服务暂时不可用'))
      .mockResolvedValueOnce({ id: 'uploaded' });

    const onUploaded = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeFolderUploadModal, {
        knowledgeBase: knowledgeBase(),
        files: [
          folderFile('重复资料.txt', '企业战略/重复资料.txt'),
          folderFile('待重试.txt', '项目资料/待重试.txt'),
        ],
        onClose: vi.fn(),
        onUploaded,
      }),
    );

    try {
      await dom.submit(dom.container.querySelector('form') as HTMLFormElement);
      await dom.flush();
      await dom.flush();

      expect(dom.container.textContent).toContain('被跳过（1）');
      expect(dom.container.textContent).toContain('与知识库中已有文件版本完全相同');
      expect(dom.container.textContent).toContain('上传失败（1）');
      expect(dom.container.textContent).toContain('上传服务暂时不可用');

      const retry = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('重新上传失败项（1）'),
      );
      expect(retry).toBeTruthy();
      await dom.click(retry!);
      await dom.flush();
      await dom.flush();

      expect(api.uploadKnowledgeDocument).toHaveBeenCalledTimes(2);
      expect(dom.container.textContent).not.toContain('上传失败（1）');
      expect(dom.container.textContent).toContain('被跳过（1）');
      const complete = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '完成',
      );
      expect(complete).toBeTruthy();
      await dom.click(complete!);
      expect(onUploaded).toHaveBeenCalledWith('文件夹上传完成：新增或更新 1 个，跳过 1 个。');
    } finally {
      await dom.cleanup();
    }
  });
});

function folderFile(name: string, path: string): File {
  const file = new File(['knowledge content'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: path });
  return file;
}

function knowledgeBase(): KnowledgeBase {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    key: 'enterprise',
    name: '企业知识库',
    description: null,
    status: 'ACTIVE',
    space: {
      type: 'COMPANY',
      targetId: '00000000-0000-7000-8000-000000000099',
      targetName: '全公司',
    },
    version: 1,
    retrievalConfig: {
      mode: 'HYBRID',
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
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}
