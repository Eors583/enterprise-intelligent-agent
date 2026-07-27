import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiUrl, messageFromError, request } from './client';

describe('admin api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('joins relative API base and paths without duplicate slashes', () => {
    expect(apiUrl('admin/organization', '/api/v1/')).toBe('/api/v1/admin/organization');
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
  });
});
