import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  request: requestMock,
}));

import { loadAdminOverview } from './api';

describe('admin overview API adapter', () => {
  beforeEach(() => requestMock.mockReset());

  it('uses the tenant-admin overview endpoint and contract schema', async () => {
    const controller = new AbortController();
    requestMock.mockResolvedValue({ generatedAt: '2026-07-28T01:00:00.000Z' });

    await loadAdminOverview(controller.signal);

    expect(requestMock).toHaveBeenCalledWith(
      '/admin/overview',
      expect.objectContaining({ signal: controller.signal, schema: expect.any(Object) }),
    );
  });
});
