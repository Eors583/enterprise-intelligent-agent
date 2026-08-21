import { describe, expect, it, vi } from 'vitest';

import { LexiangSpaceClient } from './lexiang-space.client.js';
import type { LexiangTokenProvider } from './lexiang-token.provider.js';

const context = {
  connectionId: 'connection-1',
  credential: { appKey: 'app-key', appSecret: 'secret-value' },
  teamId: 'team-1',
  operatorStaffId: 'admin-1',
};

describe('LexiangSpaceClient', () => {
  it('discovers team and administrator candidates from official read APIs', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                type: 'team',
                id: 'team-1',
                attributes: { code: 'k10001', name: '产品团队', is_secret: 1 },
              },
            ],
            meta: { page_token: '' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ staff_id: 'staff-1', name: '张三' }], code: 0 }), {
          status: 200,
        }),
      );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(client.listTeams(context)).resolves.toEqual([
      { id: 'team-1', code: 'k10001', name: '产品团队' },
    ]);
    await expect(client.listTenantManagers(context)).resolves.toEqual([
      { staffId: 'staff-1', name: '张三' },
    ]);

    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain('/cgi-bin/v1/kb/teams');
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain(
      '/cgi-bin/v1/contact/user/managers',
    );
  });

  it('creates a private space with no inherited team access and reads its stable identity', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(spaceResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(client.createSpace({ ...context, name: '产品知识库' })).resolves.toMatchObject({
      id: 'space-1',
      teamId: 'team-1',
      rootEntryId: 'root-1',
      visibleType: 0,
    });

    const [, init] = fetchImplementation.mock.calls[0]!;
    expect(init.headers).toMatchObject({ 'x-staff-id': 'admin-1' });
    expect(JSON.parse(init.body)).toMatchObject({
      data: {
        attributes: {
          visible_type: 0,
          manager_inherit_type: 'none',
          member_inherit_type: 'none',
        },
        relationships: {
          team: { data: { type: 'team', id: 'team-1' } },
          subject: {
            data: [{ type: 'staff', id: 'admin-1', attributes: { role: 'manager' } }],
          },
        },
      },
    });
  });

  it('deletes the exact remote space with the configured operator identity', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await client.deleteSpace({ ...context, spaceId: 'space-1' });

    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      'https://lxapi.lexiangla.com/cgi-bin/v1/kb/spaces/space-1',
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'x-staff-id': 'admin-1' }),
    });
  });

  it('recovers a managed space by its stable marker before a create retry', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                type: 'kb_space',
                id: 'space-1',
                attributes: { name: '产品知识库 · BMS:local-id', logo: '' },
                relationships: {
                  root_entry: { data: { type: 'kb_entry', id: 'root-1' } },
                },
              },
            ],
            meta: { page_token: '' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(spaceResponse()), { status: 200 }));
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(
      client.findSpaceByManagedMarker({ ...context, marker: ' · BMS:local-id' }),
    ).resolves.toMatchObject({ id: 'space-1', rootEntryId: 'root-1' });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('lists every knowledge space in the bound team across cursor pages', async () => {
    const page = (id: string, token: string) => ({
      data: [
        {
          type: 'kb_space',
          id,
          attributes: { name: `知识库 ${id}`, logo: '' },
          relationships: { root_entry: { data: { type: 'kb_entry', id: `root-${id}` } } },
        },
      ],
      meta: { page_token: token },
    });
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('space-1', 'next-page'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('space-2', ''))));
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(client.listSpaces(context)).resolves.toEqual([
      { id: 'space-1', rootEntryId: 'root-space-1', name: '知识库 space-1' },
      { id: 'space-2', rootEntryId: 'root-space-2', name: '知识库 space-2' },
    ]);
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain('page_token=next-page');
  });

  it('treats an empty page as the end even when Lexiang repeats its cursor', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                type: 'kb_space',
                id: 'space-1',
                attributes: { name: '知识库', logo: '' },
                relationships: {
                  root_entry: { data: { type: 'kb_entry', id: 'root-1' } },
                },
              },
            ],
            meta: { page_token: 'W10=' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], meta: { page_token: 'W10=' } })),
      );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(client.listSpaces(context)).resolves.toEqual([
      { id: 'space-1', rootEntryId: 'root-1', name: '知识库' },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('recursively lists files in folders and accepts a repeated cursor on an empty tail page', async () => {
    const fetchImplementation = vi.fn().mockImplementation((requested: URL) => {
      const url = new URL(String(requested));
      const parentId = url.searchParams.get('parent_id');
      const pageToken = url.searchParams.get('page_token');
      if (parentId === null) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                entryResponse('folder-1', '制度', 'folder', true),
                entryResponse('file-1', '公司手册.pdf', 'file', false),
              ],
              meta: { page_token: '' },
            }),
          ),
        );
      }
      if (parentId === 'folder-1' && pageToken === null) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [entryResponse('page-1', '报销说明', 'page', false)],
              meta: { page_token: 'W10=' },
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], meta: { page_token: 'W10=' } })),
      );
    });
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(client.listEntries({ ...context, spaceId: 'space-1' })).resolves.toEqual([
      expect.objectContaining({ id: 'folder-1', parentEntryId: null, entryType: 'folder' }),
      expect.objectContaining({ id: 'file-1', parentEntryId: null, entryType: 'file' }),
      expect.objectContaining({ id: 'page-1', parentEntryId: 'folder-1', entryType: 'page' }),
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('creates a folder under the selected remote parent', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: entryResponse('folder-2', '项目资料', 'folder', false) }),
          { status: 200 },
        ),
      );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(
      client.createFolder({
        ...context,
        spaceId: 'space-1',
        parentEntryId: 'folder-1',
        name: '项目资料',
      }),
    ).resolves.toMatchObject({
      id: 'folder-2',
      parentEntryId: 'folder-1',
      entryType: 'folder',
    });

    const [requested, init] = fetchImplementation.mock.calls[0]!;
    expect(String(requested)).toContain('/cgi-bin/v1/kb/entries?space_id=space-1');
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'x-staff-id': 'admin-1' }),
    });
    expect(JSON.parse(init.body)).toEqual({
      data: {
        attributes: { name: '项目资料', entry_type: 'folder' },
        relationships: {
          parent_entry: { data: { type: 'kb_entry', id: 'folder-1' } },
        },
      },
    });
  });

  it('uploads file bytes to the signed Tencent COS target before creating the knowledge entry', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: {
              state: 'upload-state-1',
              upload_url: 'https://bucket.cos.ap-shanghai.myqcloud.com/object?signature=temporary',
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename="policy.pdf"',
              },
              auth: { XCosSecurityToken: 'temporary-security-token' },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { etag: '"uploaded-etag"' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: entryResponse('file-2', 'policy.pdf', 'file', false) }),
          { status: 200 },
        ),
      );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(
      client.uploadFile({
        ...context,
        spaceId: 'space-1',
        parentEntryId: 'folder-1',
        name: 'policy.pdf',
        bytes: Buffer.from('pdf bytes'),
      }),
    ).resolves.toMatchObject({
      id: 'file-2',
      parentEntryId: 'folder-1',
      entryType: 'file',
    });

    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain('/kb/files/upload-params');
    expect(JSON.parse(fetchImplementation.mock.calls[0]?.[1].body)).toEqual({
      name: 'policy.pdf',
      media_type: 'file',
    });
    const cosHeaders = fetchImplementation.mock.calls[1]?.[1].headers as Headers;
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain('.myqcloud.com/');
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
    });
    expect(cosHeaders.get('authorization')).toBeNull();
    expect(cosHeaders.get('content-type')).toBe('application/pdf');
    expect(cosHeaders.get('x-cos-security-token')).toBe('temporary-security-token');
    const entryUrl = new URL(String(fetchImplementation.mock.calls[2]?.[0]));
    expect(entryUrl.searchParams.get('space_id')).toBe('space-1');
    expect(entryUrl.searchParams.get('state')).toBe('upload-state-1');
  });

  it('reuploads a same-name file into its existing stable knowledge entry', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(uploadParametersResponse()), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: '"new-etag"' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: entryResponse('file-1', 'policy.pdf', 'file', false) }),
          { status: 200 },
        ),
      );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(
      client.reuploadFile({
        ...context,
        entryId: 'file-1',
        name: 'policy.pdf',
        bytes: Buffer.from('new pdf bytes'),
      }),
    ).resolves.toMatchObject({ id: 'file-1', entryType: 'file' });

    const entryUrl = new URL(String(fetchImplementation.mock.calls[2]?.[0]));
    expect(entryUrl.pathname).toContain('/kb/entries/file-1/upload');
    expect(entryUrl.searchParams.get('state')).toBe('upload-state-1');
    expect(fetchImplementation.mock.calls[2]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'x-staff-id': 'admin-1' },
    });
  });

  it('rejects a signed upload target outside Tencent COS before transmitting file bytes', async () => {
    const parameters = uploadParametersResponse();
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...parameters,
          object: { ...parameters.object, upload_url: 'https://attacker.example/upload' },
        }),
        { status: 200 },
      ),
    );
    const client = new LexiangSpaceClient(tokens(), fetchImplementation);

    await expect(
      client.uploadFile({
        ...context,
        spaceId: 'space-1',
        parentEntryId: null,
        name: 'policy.pdf',
        bytes: Buffer.from('confidential bytes'),
      }),
    ).rejects.toMatchObject({ code: 'LEXIANG_FILE_UPLOAD_PARAMETERS_INVALID_RESPONSE' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

function tokens(): LexiangTokenProvider {
  return {
    get: vi.fn().mockResolvedValue('access-token'),
    invalidate: vi.fn(),
  } as unknown as LexiangTokenProvider;
}

function spaceResponse() {
  return {
    data: {
      type: 'kb_space',
      id: 'space-1',
      attributes: {
        name: '产品知识库',
        description: '产品资料',
        logo: '',
        visible_type: 0,
        manager_inherit_type: 'none',
        member_inherit_type: 'none',
      },
      relationships: {
        team: { data: { type: 'team', id: 'team-1' } },
        root_entry: { data: { type: 'kb_entry', id: 'root-1' } },
      },
    },
  };
}

function entryResponse(id: string, name: string, entryType: string, hasChildren: boolean) {
  return {
    type: 'kb_entry',
    id,
    attributes: {
      name,
      entry_type: entryType,
      has_children: hasChildren,
      created_at: '2026-08-13 10:00:00',
      updated_at: '2026-08-13 11:00:00',
    },
  };
}

function uploadParametersResponse() {
  return {
    object: {
      state: 'upload-state-1',
      upload_url: 'https://bucket.cos.ap-shanghai.myqcloud.com/object?signature=temporary',
      headers: { 'Content-Type': 'application/pdf' },
      auth: { XCosSecurityToken: 'temporary-security-token' },
    },
  };
}
