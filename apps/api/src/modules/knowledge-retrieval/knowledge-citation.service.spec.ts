import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const MEMBER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000201';
const PARENT_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000202';
const OTHER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000203';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000301';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000401';
const VERSION_ID = '00000000-0000-7000-8000-000000000501';
const CHUNK_ID = '00000000-0000-7000-8000-000000000601';

describe('KnowledgeCitationService', () => {
  it('returns the exact archived source while applying its current department scope', async () => {
    const fixture = createFixture({
      candidate: candidate({
        knowledgeBaseStatus: 'ARCHIVED',
        documentStatus: 'ARCHIVED',
        versionStatus: 'ARCHIVED',
        scopes: [{ orgUnitId: PARENT_ORG_UNIT_ID, includeChildren: true }],
      }),
    });

    await expect(fixture.service.getOriginal(VERSION_ID, CHUNK_ID)).resolves.toEqual({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      knowledgeBaseName: '企业制度库',
      documentId: DOCUMENT_ID,
      documentTitle: '请假制度',
      documentVersionId: VERSION_ID,
      documentVersion: 3,
      chunkId: CHUNK_ID,
      headingPath: ['人事制度', '年假'],
      sourceType: 'MARKDOWN',
      content: '年假申请需至少提前一天发起。',
      updatedAt: '2026-07-20T02:00:00.000Z',
    });
    expect(fixture.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  });

  it('denies the source immediately after the user no longer belongs to an allowed department', async () => {
    const fixture = createFixture({
      candidate: candidate({
        scopes: [{ orgUnitId: OTHER_ORG_UNIT_ID, includeChildren: false }],
      }),
    });

    await expect(fixture.service.getOriginal(VERSION_ID, CHUNK_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('denies a user with no active employment even for a tenant-wide knowledge base', async () => {
    const fixture = createFixture({ candidate: candidate(), employments: [] });

    await expect(fixture.service.getOriginal(VERSION_ID, CHUNK_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not disclose a source returned from another tenant', async () => {
    const fixture = createFixture({
      candidate: candidate({ tenantId: OTHER_TENANT_ID }),
    });

    await expect(fixture.service.getOriginal(VERSION_ID, CHUNK_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects inconsistent chunk, version, document and knowledge-base lineage', async () => {
    const inconsistent = candidate();
    inconsistent.documentVersion.documentId = '00000000-0000-7000-8000-000000000499';
    const fixture = createFixture({ candidate: inconsistent });

    await expect(fixture.service.getOriginal(VERSION_ID, CHUNK_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

interface CandidateOptions {
  tenantId?: string;
  knowledgeBaseStatus?: 'ACTIVE' | 'ARCHIVED';
  documentStatus?: 'READY' | 'ARCHIVED';
  versionStatus?: 'READY' | 'ARCHIVED';
  scopes?: Array<{ orgUnitId: string; includeChildren: boolean }>;
}

function candidate(options: CandidateOptions = {}) {
  const tenantId = options.tenantId ?? TENANT_ID;
  return {
    id: CHUNK_ID,
    tenantId,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    headingPath: ['人事制度', '年假'],
    content: '年假申请需至少提前一天发起。',
    knowledgeBase: {
      id: KNOWLEDGE_BASE_ID,
      tenantId,
      name: '企业制度库',
      status: options.knowledgeBaseStatus ?? ('ACTIVE' as const),
      orgUnits: options.scopes ?? [],
    },
    document: {
      id: DOCUMENT_ID,
      tenantId,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      title: '请假制度',
      status: options.documentStatus ?? ('READY' as const),
    },
    documentVersion: {
      id: VERSION_ID,
      tenantId,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      versionNumber: 3,
      sourceType: 'MARKDOWN' as const,
      status: options.versionStatus ?? ('READY' as const),
      createdAt: new Date('2026-07-20T01:00:00.000Z'),
      publishedAt: new Date('2026-07-20T02:00:00.000Z'),
    },
  };
}

function createFixture(options: {
  candidate: ReturnType<typeof candidate> | null;
  employments?: Array<{ orgUnitId: string }>;
}) {
  const transaction = {
    user: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    employment: {
      findMany: vi
        .fn()
        .mockResolvedValue(options.employments ?? [{ orgUnitId: MEMBER_ORG_UNIT_ID }]),
    },
    orgUnit: {
      findMany: vi.fn().mockResolvedValue([
        { id: PARENT_ORG_UNIT_ID, parentId: null },
        { id: MEMBER_ORG_UNIT_ID, parentId: PARENT_ORG_UNIT_ID },
        { id: OTHER_ORG_UNIT_ID, parentId: null },
      ]),
    },
    knowledgeChunk: { findFirst: vi.fn().mockResolvedValue(options.candidate) },
  };
  const withTenant = vi.fn(
    async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
  );
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      tenant: { id: TENANT_ID, name: '企业', status: 'active' },
      user: { id: USER_ID, tenantId: TENANT_ID, name: '员工', status: 'active' },
    }),
  } as unknown as IdentityService;
  const prisma = { withTenant } as unknown as PrismaService;
  return {
    service: new KnowledgeCitationService(identity, prisma),
    withTenant,
  };
}
