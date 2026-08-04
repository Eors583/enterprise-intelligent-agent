import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootstrapError, fetchBootstrap } from './bootstrap';

const validPayload = {
  tenant: { id: 'tenant-1', name: '示例企业' },
  currentUser: { id: 'member-current', name: '当前用户' },
  navigation: [{ id: 'directory', label: '通讯录' }],
  departments: [{ id: 'department-1', name: '产品部', parentId: null, memberCount: 1 }],
  members: [
    {
      id: 'member-1',
      name: '成员一',
      title: '产品经理',
      departmentIds: ['department-1'],
      status: 'active',
      agent: {
        id: 'agent-1',
        name: '成员一的智能体',
        status: 'online',
        operationalAvailability: {
          status: 'AVAILABLE',
          evidenceStatus: 'VERIFIED',
          reasonCodes: [],
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
      capabilities: {
        canContactHuman: true,
        canContactAgent: true,
      },
    },
  ],
  departmentAgents: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBootstrap', () => {
  it('请求约定端点并接受通过校验的真实响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBootstrap(undefined, 'http://localhost:3000')).resolves.toEqual(validPayload);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/bootstrap',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('拒绝结构不完整的成功响应，不回退到静态数据', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tenant: validPayload.tenant }), {
          status: 200,
          headers: { 'x-request-id': 'request-invalid-contract' },
        }),
      ),
    );

    const error = await fetchBootstrap(undefined, 'http://localhost:3000').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BootstrapError);
    expect(error).toMatchObject({
      kind: 'contract',
      requestId: 'request-invalid-contract',
    });
  });
});
