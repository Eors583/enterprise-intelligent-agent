import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../admin/admin-access.service.js';
import { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import type { LexiangSpaceClient } from '../infrastructure/lexiang/lexiang-space.client.js';
import { KnowledgeProviderSpaceService } from './knowledge-provider-space.service.js';

const PRINCIPAL: AdminPrincipal = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  userId: '00000000-0000-7000-8000-000000000002',
  role: 'ADMIN',
  authenticationSource: 'session',
};
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000003';
const CONNECTION_ID = '00000000-0000-7000-8000-000000000004';

describe('KnowledgeProviderSpaceService', () => {
  it('persists the remote identity before marking a private Lexiang space active', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const credentialCiphertext = vault.encrypt('stored-secret', {
      tenantId: PRINCIPAL.tenantId,
      appKey: 'app-key',
    });
    const connection = {
      id: CONNECTION_ID,
      status: 'ACTIVE',
      appKey: 'app-key',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
      credentialCiphertext,
    };
    let binding = bindingFixture();
    const updates: Array<Record<string, unknown>> = [];
    const transaction = {
      knowledgeProviderConnection: { findUnique: vi.fn().mockResolvedValue(connection) },
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(binding),
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          binding = {
            ...binding,
            ...data,
            version: binding.version + 1,
          } as typeof binding;
          return binding;
        }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const remote = {
      id: 'space-1',
      teamId: 'team-1',
      rootEntryId: 'root-1',
      name: '产品知识库',
      description: null,
      logo: null,
      visibleType: 0,
      managerInheritType: 'none',
      memberInheritType: 'none',
    };
    const spaces = {
      findSpaceByManagedMarker: vi.fn().mockResolvedValue(null),
      createSpace: vi.fn().mockResolvedValue(remote),
      getSpace: vi.fn().mockResolvedValue({
        ...remote,
        visibleType: null,
        managerInheritType: null,
        memberInheritType: null,
      }),
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );

    await expect(
      service.provision(PRINCIPAL, KNOWLEDGE_BASE_ID, '产品知识库'),
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      externalSpaceId: 'space-1',
      externalRootEntryId: 'root-1',
      visibleType: 0,
      managerInheritType: 'none',
      memberInheritType: 'none',
    });

    expect(spaces.createSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        operatorStaffId: 'staff-1',
        name: `产品知识库 · BMS:${KNOWLEDGE_BASE_ID}`,
      }),
    );
    const identityIndex = updates.findIndex((data) => data.externalSpaceId === 'space-1');
    const activeIndex = updates.findIndex((data) => data.status === 'ACTIVE');
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(activeIndex).toBeGreaterThan(identityIndex);
    expect(spaces.createSpace).toHaveBeenCalledTimes(1);
  });

  it('imports an existing space without changing it and blocks retrieval when remote privacy leaks', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const connection = {
      id: CONNECTION_ID,
      status: 'ACTIVE',
      appKey: 'app-key',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
      credentialCiphertext: vault.encrypt('stored-secret', {
        tenantId: PRINCIPAL.tenantId,
        appKey: 'app-key',
      }),
    };
    let binding = {
      ...bindingFixture(),
      externalSpaceId: 'space-existing',
      externalRootEntryId: 'root-existing',
    };
    const transaction = {
      knowledgeProviderConnection: { findUnique: vi.fn().mockResolvedValue(connection) },
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(binding),
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          binding = { ...binding, ...data, version: binding.version + 1 } as typeof binding;
          return binding;
        }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const spaces = { updateSpace: vi.fn(), deleteSpace: vi.fn() };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );

    await expect(
      service.bindExisting(PRINCIPAL, KNOWLEDGE_BASE_ID, {
        id: 'space-existing',
        teamId: 'team-1',
        rootEntryId: 'root-existing',
        name: '历史知识库',
        description: '乐享已有知识',
        logo: null,
        visibleType: 1,
        managerInheritType: 'viewer',
        memberInheritType: 'viewer',
      }),
    ).resolves.toMatchObject({
      status: 'SYNC_FAILED',
      externalSpaceId: 'space-existing',
      visibleType: 1,
      lastErrorCode: 'LEXIANG_SPACE_PRIVACY_MISMATCH',
    });
    expect(spaces.updateSpace).not.toHaveBeenCalled();
    expect(spaces.deleteSpace).not.toHaveBeenCalled();
  });

  it('converts an asynchronous privacy rejection into a persisted sync failure', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const connection = {
      id: CONNECTION_ID,
      status: 'ACTIVE',
      appKey: 'app-key',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
      credentialCiphertext: vault.encrypt('stored-secret', {
        tenantId: PRINCIPAL.tenantId,
        appKey: 'app-key',
      }),
    };
    let binding = {
      ...bindingFixture(),
      externalSpaceId: 'space-existing',
      externalRootEntryId: 'root-existing',
      visibleType: 0,
      managerInheritType: 'none',
      memberInheritType: 'none',
    };
    const transaction = {
      knowledgeProviderConnection: { findUnique: vi.fn().mockResolvedValue(connection) },
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue(binding),
        upsert: vi.fn().mockResolvedValue(binding),
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          binding = { ...binding, ...data, version: binding.version + 1 } as typeof binding;
          return binding;
        }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const spaces = {
      findSpaceByManagedMarker: vi.fn(),
      createSpace: vi.fn(),
      getSpace: vi.fn().mockResolvedValue({
        id: 'space-existing',
        teamId: 'team-1',
        rootEntryId: 'root-existing',
        name: 'existing',
        description: null,
        logo: null,
        visibleType: 1,
        managerInheritType: 'viewer',
        memberInheritType: 'viewer',
      }),
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );

    await expect(
      service.provision(PRINCIPAL, KNOWLEDGE_BASE_ID, 'existing'),
    ).resolves.toMatchObject({
      status: 'SYNC_FAILED',
      lastErrorCode: 'LEXIANG_SPACE_PRIVACY_MISMATCH',
    });
    expect(spaces.createSpace).not.toHaveBeenCalled();
  });

  it('creates local folder and document shadows for every Lexiang entry', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const connection = connectionFixture(vault);
    const folderCreate = vi.fn().mockResolvedValue({ id: 'folder-local-1' });
    const documentCreate = vi.fn().mockResolvedValue({ id: 'document-local-1' });
    const entryCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue({
          ...bindingFixture(),
          externalSpaceId: 'space-1',
          connection,
        }),
      },
      knowledgeExternalEntryBinding: {
        findMany: vi.fn().mockResolvedValue([]),
        create: entryCreate,
      },
      knowledgeFolder: { create: folderCreate },
      knowledgeDocument: { create: documentCreate },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const spaces = {
      listEntries: vi.fn().mockResolvedValue([
        {
          id: 'folder-1',
          parentEntryId: null,
          name: '制度',
          entryType: 'folder',
          hasChildren: true,
          createdAt: '2026-08-13 10:00:00',
          updatedAt: '2026-08-13 11:00:00',
        },
        {
          id: 'file-1',
          parentEntryId: 'folder-1',
          name: '员工手册.pdf',
          entryType: 'file',
          hasChildren: false,
          createdAt: '2026-08-13 10:00:00',
          updatedAt: '2026-08-13 11:00:00',
        },
      ]),
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );

    await expect(service.syncEntries(PRINCIPAL, KNOWLEDGE_BASE_ID)).resolves.toEqual({
      entriesDiscovered: 2,
      foldersSynchronized: 1,
      documentsDiscovered: 1,
      documentsImported: 1,
      documentsUpdated: 0,
      documentsArchived: 0,
    });
    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        folderId: 'folder-local-1',
        title: '员工手册.pdf',
        sourceType: 'FILE',
        status: 'DRAFT',
      }),
    });
    expect(entryCreate).toHaveBeenCalledTimes(2);
    expect(entryCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        externalEntryId: 'file-1',
        documentId: 'document-local-1',
      }),
    });
  });

  it('creates only missing remote folder segments and synchronizes their shadows', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const connection = connectionFixture(vault);
    const transaction = {
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue({
          ...bindingFixture(),
          status: 'ACTIVE',
          externalSpaceId: 'space-1',
          externalRootEntryId: 'root-1',
          connection,
        }),
      },
    };
    const spaces = {
      listEntries: vi.fn().mockResolvedValue([
        {
          id: 'folder-1',
          parentEntryId: null,
          name: '制度',
          entryType: 'folder',
          hasChildren: false,
          createdAt: null,
          updatedAt: null,
        },
      ]),
      createFolder: vi.fn().mockResolvedValue({
        id: 'folder-2',
        parentEntryId: 'folder-1',
        name: '财务',
        entryType: 'folder',
        hasChildren: false,
        createdAt: null,
        updatedAt: null,
      }),
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );
    vi.spyOn(service, 'syncEntries').mockResolvedValue({
      entriesDiscovered: 2,
      foldersSynchronized: 2,
      documentsDiscovered: 0,
      documentsImported: 0,
      documentsUpdated: 0,
      documentsArchived: 0,
    });

    await service.ensureFolders(PRINCIPAL, KNOWLEDGE_BASE_ID, ['制度', '制度/财务']);

    expect(spaces.createFolder).toHaveBeenCalledOnce();
    expect(spaces.createFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        operatorStaffId: 'staff-1',
        parentEntryId: 'folder-1',
        name: '财务',
      }),
    );
    expect(service.syncEntries).toHaveBeenCalledWith(PRINCIPAL, KNOWLEDGE_BASE_ID);
  });

  it('uploads a new file into Lexiang and persists only its local directory shadow', async () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 9)]]),
    );
    const connection = connectionFixture(vault);
    const documentCreate = vi.fn().mockResolvedValue({ id: 'document-local-1' });
    const entryCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      knowledgeExternalSpaceBinding: {
        findUnique: vi.fn().mockResolvedValue({
          ...bindingFixture(),
          status: 'ACTIVE',
          externalSpaceId: 'space-1',
          externalRootEntryId: 'root-1',
          connection,
        }),
      },
      knowledgeExternalEntryBinding: {
        findFirst: vi.fn().mockResolvedValue({ externalEntryId: 'folder-1' }),
        create: entryCreate,
      },
      knowledgeDocument: {
        findMany: vi.fn().mockResolvedValue([]),
        create: documentCreate,
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const spaces = {
      uploadFile: vi.fn().mockResolvedValue({
        id: 'file-1',
        parentEntryId: 'folder-1',
        name: '报销制度.pdf',
        entryType: 'file',
        hasChildren: false,
        createdAt: '2026-08-13 16:00:00',
        updatedAt: '2026-08-13 16:00:00',
      }),
      deleteEntry: vi.fn(),
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const service = new KnowledgeProviderSpaceService(
      prisma,
      vault,
      spaces as unknown as LexiangSpaceClient,
    );

    await expect(
      service.uploadFile(PRINCIPAL, KNOWLEDGE_BASE_ID, {
        title: '报销制度',
        bytes: Buffer.from('pdf bytes'),
        mimeType: 'application/pdf',
        fileName: '报销制度.pdf',
        folderId: 'folder-local-1',
      }),
    ).resolves.toBe('document-local-1');

    expect(spaces.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        parentEntryId: 'folder-1',
        name: '报销制度.pdf',
        bytes: expect.any(Buffer),
      }),
    );
    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        folderId: 'folder-local-1',
        fileName: '报销制度.pdf',
        status: 'DRAFT',
      }),
    });
    expect(documentCreate.mock.calls[0]?.[0].data).not.toHaveProperty('objectKey');
    expect(documentCreate.mock.calls[0]?.[0].data).not.toHaveProperty('contentText');
    expect(entryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalEntryId: 'file-1',
        externalParentEntryId: 'folder-1',
        documentId: 'document-local-1',
      }),
    });
    expect(spaces.deleteEntry).not.toHaveBeenCalled();
  });
});

function connectionFixture(vault: LexiangCredentialVault) {
  return {
    id: CONNECTION_ID,
    status: 'ACTIVE' as const,
    appKey: 'app-key',
    teamId: 'team-1',
    operatorStaffId: 'staff-1',
    credentialCiphertext: vault.encrypt('stored-secret', {
      tenantId: PRINCIPAL.tenantId,
      appKey: 'app-key',
    }),
  };
}

function bindingFixture() {
  return {
    id: '00000000-0000-7000-8000-000000000005',
    tenantId: PRINCIPAL.tenantId,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    connectionId: CONNECTION_ID,
    provider: 'LEXIANG' as const,
    status: 'PROVISIONING' as const,
    externalTeamId: 'team-1',
    externalSpaceId: null,
    externalRootEntryId: null,
    remoteName: null,
    remoteDescription: null,
    remoteLogo: null,
    visibleType: null,
    managerInheritType: null,
    memberInheritType: null,
    lastSyncedAt: null,
    lastErrorCode: null,
    version: 1,
    createdAt: new Date('2026-08-13T03:00:00.000Z'),
    updatedAt: new Date('2026-08-13T03:00:00.000Z'),
  };
}
