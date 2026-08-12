import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiUrl, messageFromError, request, requestBlob } from './client';

describe('admin api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('joins relative API base and paths without duplicate slashes', () => {
    expect(apiUrl('admin/organization', '/api/v1/')).toBe('/api/v1/admin/organization');
  });

  it('reads binary responses and decodes their UTF-8 source filename', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('pdf-source', {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent('员工制度.pdf')}`,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob('/admin/knowledge/source');

    expect(result.fileName).toBe('员工制度.pdf');
    expect(result.mimeType).toBe('application/pdf');
    await expect(result.blob.text()).resolves.toBe('pdf-source');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
    });
  });

  it('keeps useful API errors for UI feedback', () => {
    expect(messageFromError(new ApiError('部门存在成员，无法归档。'))).toBe(
      '部门存在成员，无法归档。',
    );
    expect(
      messageFromError(
        new ApiError('An unexpected error occurred.', {
          status: 500,
          requestId: 'request-knowledge-500',
        }),
      ),
    ).toBe('An unexpected error occurred.（请求 ID：request-knowledge-500）');
    expect(messageFromError('unknown')).toBe('操作失败，请稍后重试。');
  });

  it('lets the browser set the multipart boundary for FormData uploads', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const body = new FormData();
    body.append('title', '员工手册');

    await request('/admin/knowledge-bases/example/documents/upload', {
      method: 'POST',
      body,
      schema: z.object({}),
      authenticated: false,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(body);
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('uses the browser CSRF proof for authenticated mutations without exposing bearer tokens', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'ea_csrf=csrf%20proof' });

    await request('/admin/organization', {
      method: 'POST',
      body: { name: '安全会话企业' },
      schema: z.object({}),
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.credentials).toBe('include');
    expect(headers.get('X-CSRF-Token')).toBe('csrf proof');
    expect(headers.has('Authorization')).toBe(false);
  });

  it('accepts an explicit JSON null for a nullable response contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      request('/admin/integrations/feishu/organization-sync/preview', {
        schema: z.string().nullable(),
        authenticated: false,
      }),
    ).resolves.toBeNull();
  });

  it('does not reinterpret HTTP 204 as a JSON null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    );

    await expect(
      request('/admin/integrations/feishu/organization-sync/preview', {
        schema: z.string().nullable(),
        authenticated: false,
      }),
    ).rejects.toThrow('服务响应与客户端契约不一致');
  });

  it('reports an empty HTTP 200 body as invalid JSON instead of a nullable empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      request('/admin/integrations/feishu/organization-sync/preview', {
        schema: z.string().nullable(),
        authenticated: false,
      }),
    ).rejects.toThrow('服务响应不是有效的 JSON');
  });
});
