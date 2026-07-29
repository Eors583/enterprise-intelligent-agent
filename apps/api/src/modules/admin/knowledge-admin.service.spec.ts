import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AiEvaluationService } from '../ai-evaluation/ai-evaluation.service.js';
import type { KnowledgeIngestionService } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import type { KnowledgeRetrievalService } from '../knowledge-retrieval/knowledge-retrieval.service.js';
import type { KnowledgeAiRuntimeClient } from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import type { AdminAccessService } from './admin-access.service.js';
import { KnowledgeAdminService } from './knowledge-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000004';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000005';
const DOCUMENT_VERSION_ID = '00000000-0000-7000-8000-000000000007';
const EVALUATION_RUN_ID = '00000000-0000-7000-8000-000000000008';
const EVALUATION_DATASET_VERSION_ID = '00000000-0000-7000-8000-000000000009';
const EVALUATION_SNAPSHOT_HASH = 'b'.repeat(64);
const DATABASE_NOW = new Date('2026-07-29T05:00:00.000Z');

describe('KnowledgeAdminService', () => {
  it('uses an explicit lightweight document select for knowledge-base lists', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createService({ transaction: { knowledgeBase: { findMany } } });

    await expect(service.list()).resolves.toEqual({ items: [] });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.include.documents.select).toMatchObject({
      id: true,
      title: true,
      versions: expect.any(Object),
    });
    expect(query.include.documents.select).not.toHaveProperty('contentText');
    expect(query.include.documents).not.toHaveProperty('include');
  });

  it('routes text publication through the versioned ingestion service', async () => {
    const ingestion = { createTextVersion: vi.fn().mockResolvedValue(DOCUMENT_ID) };
    const service = createService({ ingestion });
    const getDocument = vi
      .spyOn(service, 'getDocument')
      .mockResolvedValue(documentResponse('READY'));

    const response = await service.createDocument(KNOWLEDGE_BASE_ID, {
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      contentText: '# Handbook',
      status: 'READY',
    });

    expect(ingestion.createTextVersion).toHaveBeenCalledWith({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      content: '# Handbook',
      publish: true,
    });
    expect(getDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, DOCUMENT_ID);
    expect(response.status).toBe('READY');
  });

  it('requires file documents to use the bounded multipart upload endpoint', async () => {
    const ingestion = { createTextVersion: vi.fn() };
    const service = createService({ ingestion });

    await expect(
      service.createDocument(KNOWLEDGE_BASE_ID, {
        title: 'Unsafe shortcut',
        sourceType: 'FILE',
        contentText: 'not a real file',
        status: 'DRAFT',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.createTextVersion).not.toHaveBeenCalled();
  });

  it('uploads a new file version into the existing stable document', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Employee handbook',
          sourceType: 'FILE',
          status: 'READY',
        }),
      },
    };
    const ingestion = { uploadFileVersion: vi.fn().mockResolvedValue(DOCUMENT_ID) };
    const service = createService({ transaction, ingestion });
    vi.spyOn(service, 'getDocument').mockResolvedValue({
      ...documentResponse('READY'),
      sourceType: 'FILE',
      fileName: 'handbook.pdf',
    });
    const bytes = Buffer.from('updated file');

    const response = await service.uploadDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
      bytes,
      mimeType: 'application/pdf',
      fileName: 'handbook-2026.pdf',
      changeSummary: 'Annual update',
    });

    expect(ingestion.uploadFileVersion).toHaveBeenCalledWith({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      title: 'Employee handbook',
      bytes,
      mimeType: 'application/pdf',
      fileName: 'handbook-2026.pdf',
      changeSummary: 'Annual update',
    });
    expect(response.id).toBe(DOCUMENT_ID);
  });

  it('does not accept an uploaded file version for a text document', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Employee handbook',
          sourceType: 'MARKDOWN',
          status: 'READY',
        }),
      },
    };
    const ingestion = { uploadFileVersion: vi.fn() };
    const service = createService({ transaction, ingestion });

    await expect(
      service.uploadDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
        bytes: Buffer.from('updated file'),
        mimeType: 'text/plain',
        fileName: 'handbook.txt',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.uploadFileVersion).not.toHaveBeenCalled();
  });

  it('tests retrieval as the selected tenant user and preserves measured lexical scores', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID }) },
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        mode: 'LEXICAL',
        embeddingModel: null,
        reranker: 'LEXICAL',
        rerankerModel: null,
        degradedReason: null,
        lexicalCandidateCount: 1,
        vectorCandidateCount: 0,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        semanticCoverage: 0,
        diagnostics: [
          {
            stage: 'LEXICAL',
            status: 'APPLIED',
            code: 'KNOWLEDGE_LEXICAL_RETRIEVAL_APPLIED',
            candidateCount: 1,
          },
        ],
        items: [
          {
            chunkId: '00000000-0000-7000-8000-000000000006',
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            knowledgeBaseName: 'Company policies',
            documentId: DOCUMENT_ID,
            documentVersionId: '00000000-0000-7000-8000-000000000007',
            documentVersion: 2,
            title: 'Leave policy',
            headingPath: ['Benefits', 'Leave'],
            content: '  Employees   receive  ten days.  ',
            sourceType: 'TEXT',
            updatedAt: new Date('2026-07-20T00:00:00.000Z'),
            keywordScore: 0.75,
            fuzzyScore: 0.25,
            semanticScore: null,
            fusionScore: 0,
            rerankerScore: null,
            relationshipScore: 0,
            relationshipEvidence: [],
            finalScore: 0.575,
          },
        ],
      }),
    };
    const service = createService({ transaction, retrieval });

    const response = await service.testRetrieval(KNOWLEDGE_BASE_ID, {
      query: 'leave allowance',
      userId: USER_ID,
      limit: 5,
    });

    expect(retrieval.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      previewDraftKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      query: 'leave allowance',
      limit: 5,
    });
    expect(response.noAnswer).toBe(false);
    expect(response.items[0]).toMatchObject({
      excerpt: 'Employees receive ten days.',
      keywordScore: 0.75,
      fuzzyScore: 0.25,
      finalScore: 0.575,
    });
  });

  it('previews only an approved candidate version through the admin retrieval boundary', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'READY',
          sourceType: 'FILE',
          parseReviewStatus: 'APPROVED',
          governanceReviewStatus: 'APPROVED',
          _count: { chunks: 2 },
        }),
      },
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        mode: 'LEXICAL',
        embeddingModel: null,
        reranker: 'LEXICAL',
        rerankerModel: null,
        degradedReason: null,
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        semanticCoverage: 0,
        diagnostics: [],
        items: [],
      }),
    };
    const service = createService({ transaction, retrieval });

    await service.testRetrieval(KNOWLEDGE_BASE_ID, {
      query: 'candidate policy',
      userId: USER_ID,
      documentVersionId: DOCUMENT_VERSION_ID,
      limit: 5,
    });

    expect(transaction.knowledgeDocumentVersion.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        id: DOCUMENT_VERSION_ID,
      },
      select: {
        status: true,
        sourceType: true,
        parseReviewStatus: true,
        governanceReviewStatus: true,
        _count: { select: { chunks: true } },
      },
    });
    expect(retrieval.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      previewDraftKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      previewKnowledgeVersionIds: [DOCUMENT_VERSION_ID],
      query: 'candidate policy',
      limit: 5,
    });
  });

  it('does not run a retrieval test for a user outside the current tenant', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const retrieval = { search: vi.fn() };
    const service = createService({ transaction, retrieval });

    await expect(
      service.testRetrieval(KNOWLEDGE_BASE_ID, {
        query: 'leave allowance',
        userId: USER_ID,
        limit: 5,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(retrieval.search).not.toHaveBeenCalled();
  });

  it('rejects stale document revisions before creating an immutable version', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentVersion: 3,
        }),
      },
    };
    const ingestion = { createTextVersion: vi.fn() };
    const service = createService({ transaction, ingestion });

    await expect(
      service.updateDocument(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
        contentText: 'new text',
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ingestion.createTextVersion).not.toHaveBeenCalled();
  });

  it('publishes an indexed Knowledge Version only with its exact passing Evaluation Run', async () => {
    const candidate = {
      id: DOCUMENT_VERSION_ID,
      versionNumber: 2,
      status: 'READY',
      publishedAt: null,
    };
    const indexedVersion = {
      ...candidate,
      ...approvedGovernanceRecord(),
      tenantId: TENANT_ID,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      sourceType: 'FILE',
      contentText: 'Indexed content',
      checksum: 'c'.repeat(64),
      objectKey: 'tenant/version/source.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'source.docx',
      parseReviewStatus: 'APPROVED',
      evaluationRunId: null,
      evaluationDatasetVersionId: null,
      evaluationSnapshotHash: null,
      _count: { chunks: 3 },
    };
    const updateVersion = vi.fn().mockResolvedValue({ count: 1 });
    const graphProjectionId = '00000000-0000-7000-8000-000000000020';
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ databaseNow: DATABASE_NOW }])
        .mockResolvedValueOnce([{ id: graphProjectionId, graph_hash: 'd'.repeat(64) }])
        .mockResolvedValueOnce([{ open_schema_gap_count: 0, ungoverned_relation_count: 0 }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(indexedVersion),
        updateMany: updateVersion,
      },
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          currentVersionId: null,
          documentVersion: 0,
          status: 'READY',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const evaluations = {
      requireReferencedRunReady: vi.fn().mockResolvedValue({
        ready: true,
        datasetVersionId: EVALUATION_DATASET_VERSION_ID,
        currentSnapshotHash: EVALUATION_SNAPSHOT_HASH,
        passingRunId: EVALUATION_RUN_ID,
      }),
    };
    const service = createService({ transaction, evaluations });
    vi.spyOn(service, 'getDocument').mockResolvedValue(documentResponse('READY'));

    await service.publishDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
      evaluationRunId: EVALUATION_RUN_ID,
    });

    expect(evaluations.requireReferencedRunReady).toHaveBeenCalledWith({
      evaluationRunId: EVALUATION_RUN_ID,
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: DOCUMENT_VERSION_ID,
      subjectVersion: 2,
    });
    expect(updateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: DOCUMENT_VERSION_ID,
          publishedAt: null,
          parseReviewStatus: 'APPROVED',
        }),
        data: expect.objectContaining({
          publishedAt: DATABASE_NOW,
          evaluationRunId: EVALUATION_RUN_ID,
          evaluationDatasetVersionId: EVALUATION_DATASET_VERSION_ID,
          evaluationSnapshotHash: EVALUATION_SNAPSHOT_HASH,
        }),
      }),
    );
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'knowledge.document-version.published.v1',
          aggregateId: DOCUMENT_VERSION_ID,
          payload: expect.objectContaining({ graphProjectionId }),
        }),
      }),
    );
  });

  it('blocks file publication until the independent parse review is approved', async () => {
    const evaluations = { requireReferencedRunReady: vi.fn() };
    const updateMany = vi.fn();
    const service = createService({
      transaction: {
        $queryRaw: vi.fn().mockResolvedValue([{ databaseNow: DATABASE_NOW }]),
        knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
        knowledgeDocumentVersion: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              status: 'READY',
              publishedAt: null,
            })
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              sourceType: 'FILE',
              status: 'READY',
              publishedAt: null,
              ...approvedGovernanceRecord(),
              parseReviewStatus: 'PENDING',
              evaluationRunId: null,
              _count: { chunks: 2 },
            }),
          updateMany,
        },
      },
      evaluations,
    });

    await expect(
      service.publishDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
        evaluationRunId: EVALUATION_RUN_ID,
      }),
    ).rejects.toThrow('independent approved parse review');
    expect(evaluations.requireReferencedRunReady).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(['FILE', 'WEB'] as const)(
    'enforces maker-checker separation for %s parse review',
    async (sourceType) => {
      const service = createService({
        transaction: {
          $queryRaw: vi.fn().mockResolvedValue([]),
          knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
          knowledgeDocumentVersion: {
            findFirst: vi.fn().mockResolvedValue({
              id: DOCUMENT_VERSION_ID,
              sourceType,
              status: 'READY',
              publishedAt: null,
              createdById: ADMIN_ID,
              parseReviewStatus: 'PENDING',
              parseReviewRevision: 2,
              parseQualityScore: null,
            }),
            updateMany: vi.fn(),
          },
        },
      });

      await expect(
        service.reviewDocumentVersionParse(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
          decision: 'APPROVE',
          expectedReviewRevision: 2,
        }),
      ).rejects.toThrow('cannot approve or reject their own');
    },
  );

  it('rejects a stale parse-review revision without writing audit or outbox events', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_VERSION_ID,
          sourceType: 'FILE',
          status: 'READY',
          publishedAt: null,
          createdById: USER_ID,
          parseReviewStatus: 'PENDING',
          parseReviewRevision: 3,
          parseQualityScore: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      auditEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const service = createService({ transaction });

    await expect(
      service.reviewDocumentVersionParse(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
        decision: 'REJECT',
        expectedReviewRevision: 2,
        note: 'Missing tables.',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('updates an unpublished knowledge policy with a revision CAS and canonical scope arrays', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const outboxCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_VERSION_ID,
          publishedAt: null,
          governanceRevision: 3,
          governanceHash: 'a'.repeat(64),
        }),
        updateMany,
        findFirstOrThrow: vi.fn().mockResolvedValue({
          governanceRevision: 4,
          governanceHash: 'b'.repeat(64),
          governanceReviewStatus: 'PENDING',
        }),
      },
      auditEvent: { create: auditCreate },
      outboxEvent: { create: outboxCreate },
    };
    const service = createService({ transaction });
    vi.spyOn(service, 'getDocumentVersion').mockResolvedValue({} as never);

    await service.updateDocumentVersionGovernance(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      {
        expectedRevision: 3,
        policy: {
          ownerUserId: USER_ID,
          classification: 'SENSITIVE',
          scopeMode: 'RESTRICTED',
          organizationScopeIds: [],
          projectScopeIds: [
            '00000000-0000-7000-8000-000000000011',
            '00000000-0000-7000-8000-000000000010',
            '00000000-0000-7000-8000-000000000011',
          ],
          taskScopeIds: [],
          roleTemplateScopeIds: [],
          dataLabels: ['CLASSIFICATION:SENSITIVE', 'role:hr', 'role:hr'],
          effectiveFrom: '2026-07-01T00:00:00.000Z',
          expiresAt: null,
          retentionUntil: null,
          retentionAction: 'ARCHIVE',
          supersedesVersionId: null,
        },
      },
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ governanceRevision: 3, publishedAt: null }),
        data: expect.objectContaining({
          governanceRevision: { increment: 1 },
          projectScopeIds: [
            '00000000-0000-7000-8000-000000000010',
            '00000000-0000-7000-8000-000000000011',
          ],
          dataLabels: ['CLASSIFICATION:SENSITIVE', 'role:hr'],
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.knowledge-document-version.governance-updated',
        }),
      }),
    );
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'knowledge.document-version.governance-updated.v1',
          payload: expect.objectContaining({
            previousRevision: 3,
            revision: 4,
            reviewStatus: 'PENDING',
          }),
        }),
      }),
    );
  });

  it('requires an independent reviewer and records a successful governance approval', async () => {
    const selfReviewService = createService({
      transaction: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        knowledgeDocumentVersion: {
          findFirst: vi.fn().mockResolvedValue({
            id: DOCUMENT_VERSION_ID,
            createdById: ADMIN_ID,
            governanceOwnerUserId: USER_ID,
            governanceRevision: 4,
            governanceReviewStatus: 'PENDING',
            governanceHash: 'b'.repeat(64),
            publishedAt: null,
          }),
        },
      },
    });
    await expect(
      selfReviewService.reviewDocumentVersionGovernance(
        KNOWLEDGE_BASE_ID,
        DOCUMENT_ID,
        DOCUMENT_VERSION_ID,
        { decision: 'APPROVE', expectedRevision: 4 },
      ),
    ).rejects.toThrow('cannot review their own');

    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const outboxCreate = vi.fn().mockResolvedValue({});
    const service = createService({
      transaction: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        knowledgeDocumentVersion: {
          findFirst: vi.fn().mockResolvedValue({
            id: DOCUMENT_VERSION_ID,
            createdById: USER_ID,
            governanceOwnerUserId: USER_ID,
            governanceRevision: 4,
            governanceReviewStatus: 'PENDING',
            governanceHash: 'b'.repeat(64),
            publishedAt: null,
          }),
          updateMany,
        },
        auditEvent: { create: vi.fn().mockResolvedValue({}) },
        outboxEvent: { create: outboxCreate },
      },
    });
    vi.spyOn(service, 'getDocumentVersion').mockResolvedValue({} as never);

    await service.reviewDocumentVersionGovernance(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      { decision: 'APPROVE', expectedRevision: 4, note: 'Scope verified.' },
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          governanceRevision: 4,
          governanceReviewStatus: 'PENDING',
        }),
        data: expect.objectContaining({
          governanceReviewStatus: 'APPROVED',
          governanceReviewedById: ADMIN_ID,
          governanceReviewNote: 'Scope verified.',
          governanceRevision: { increment: 1 },
        }),
      }),
    );
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'knowledge.document-version.governance-reviewed.v1',
          payload: expect.objectContaining({ decision: 'APPROVE', revision: 5 }),
        }),
      }),
    );
  });

  it('blocks publication before evaluation when version governance is not independently approved', async () => {
    const evaluations = { requireReferencedRunReady: vi.fn() };
    const updateMany = vi.fn();
    const service = createService({
      transaction: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
        knowledgeDocumentVersion: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              status: 'READY',
              publishedAt: null,
            })
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              sourceType: 'MARKDOWN',
              status: 'READY',
              publishedAt: null,
              governanceReviewStatus: 'PENDING',
              effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
              expiresAt: null,
              _count: { chunks: 2 },
            }),
          updateMany,
        },
      },
      evaluations,
    });

    await expect(
      service.publishDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
        evaluationRunId: EVALUATION_RUN_ID,
      }),
    ).rejects.toThrow('independent governance approval');
    expect(evaluations.requireReferencedRunReady).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not mutate publication state when the referenced Evaluation Run is blocked', async () => {
    const updateVersion = vi.fn();
    const evaluations = {
      requireReferencedRunReady: vi
        .fn()
        .mockRejectedValue(new ConflictException('evaluation blocked')),
    };
    const service = createService({
      transaction: {
        $queryRaw: vi.fn().mockResolvedValue([{ databaseNow: DATABASE_NOW }]),
        knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
        knowledgeDocumentVersion: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              status: 'READY',
              publishedAt: null,
            })
            .mockResolvedValueOnce({
              id: DOCUMENT_VERSION_ID,
              versionNumber: 2,
              status: 'READY',
              publishedAt: null,
              ...approvedGovernanceRecord(),
              evaluationRunId: null,
              _count: { chunks: 1 },
            }),
          updateMany: updateVersion,
        },
        knowledgeDocument: {
          findFirst: vi.fn().mockResolvedValue({
            currentVersionId: null,
            documentVersion: 0,
            status: 'READY',
          }),
        },
      },
      evaluations,
    });

    await expect(
      service.publishDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, DOCUMENT_VERSION_ID, {
        evaluationRunId: EVALUATION_RUN_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('archives without inventing a document content version', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          tenantId: TENANT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          status: 'READY',
          documentVersion: 3,
        }),
        updateMany,
        findFirstOrThrow: vi.fn().mockResolvedValue(storedDocument('ARCHIVED', 3)),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({ transaction });

    const archived = await service.archiveDocument(KNOWLEDGE_BASE_ID, DOCUMENT_ID, 3);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ documentVersion: 3 }),
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(archived).toMatchObject({ status: 'ARCHIVED', documentVersion: 3 });
  });

  it('returns full text only from an explicitly requested document version', async () => {
    const versionId = DOCUMENT_VERSION_ID;
    const projectionId = '00000000-0000-7000-8000-000000000021';
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: projectionId, status: 'CANDIDATE', graph_hash: 'e'.repeat(64) }]),
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: versionId,
          tenantId: TENANT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentId: DOCUMENT_ID,
          versionNumber: 2,
          sourceType: 'MARKDOWN',
          mimeType: 'text/markdown',
          fileName: null,
          objectKey: null,
          checksum: null,
          contentText: '# New draft',
          status: 'DRAFT',
          changeSummary: 'Continue editing',
          createdById: ADMIN_ID,
          createdAt: new Date('2026-07-20T00:00:00.000Z'),
          publishedAt: null,
          ...approvedGovernanceRecord(),
          _count: { chunks: 0 },
          ingestionJobs: [],
        }),
      },
    };
    const service = createService({ transaction });

    await expect(
      service.getDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, versionId),
    ).resolves.toMatchObject({
      id: versionId,
      documentId: DOCUMENT_ID,
      versionNumber: 2,
      status: 'DRAFT',
      contentText: '# New draft',
      graphProjectionId: projectionId,
      graphProjectionStatus: 'CANDIDATE',
    });
  });

  it('returns a paginated chunk preview with distinct embedding models and coverage', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: { findFirst: vi.fn().mockResolvedValue({ id: DOCUMENT_ID }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({ id: DOCUMENT_VERSION_ID }),
      },
      knowledgeChunk: {
        count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
        findMany: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-7000-8000-000000000008',
            chunkIndex: 1,
            headingPath: ['Benefits', 'Leave'],
            content: 'Employees receive annual leave.',
            tokenCount: 8,
            contentHash: 'a'.repeat(64),
            metadata: { pageStart: 2, pageEnd: 3 },
            embeddings: [{ embeddingModel: 'embedding-v1' }, { embeddingModel: 'embedding-v2' }],
          },
        ]),
      },
    };
    const service = createService({ transaction });

    const response = await service.listDocumentVersionChunks(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      1,
      25,
    );

    expect(response).toEqual({
      documentVersionId: DOCUMENT_VERSION_ID,
      total: 3,
      offset: 1,
      limit: 25,
      embeddedChunkCount: 2,
      semanticCoverage: 2 / 3,
      items: [
        {
          id: '00000000-0000-7000-8000-000000000008',
          chunkIndex: 1,
          headingPath: ['Benefits', 'Leave'],
          content: 'Employees receive annual leave.',
          tokenCount: 8,
          contentHash: 'a'.repeat(64),
          pageStart: 2,
          pageEnd: 3,
          embeddingModels: ['embedding-v1', 'embedding-v2'],
        },
      ],
    });
    expect(transaction.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 25 }),
    );
  });

  it('rejects invalid chunk-preview pagination before accessing tenant data', async () => {
    const service = createService({ transaction: {} });

    await expect(
      service.listDocumentVersionChunks(
        KNOWLEDGE_BASE_ID,
        DOCUMENT_ID,
        DOCUMENT_VERSION_ID,
        -1,
        101,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not activate an empty or unindexed knowledge base', async () => {
    const updateMany = vi.fn();
    const transaction = {
      knowledgeBase: {
        findFirst: vi.fn().mockResolvedValue({
          id: KNOWLEDGE_BASE_ID,
          tenantId: TENANT_ID,
          status: 'DRAFT',
          version: 1,
        }),
        updateMany,
      },
      knowledgeDocument: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = createService({ transaction });

    await expect(
      service.update(KNOWLEDGE_BASE_ID, {
        status: 'ACTIVE',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction.knowledgeDocument.findMany).toHaveBeenCalled();
  });

  it('does not activate a semantically ready knowledge base without an evidence-backed graph', async () => {
    const transaction = {
      knowledgeBase: {
        findFirst: vi.fn().mockResolvedValue({
          id: KNOWLEDGE_BASE_ID,
          tenantId: TENANT_ID,
          status: 'DRAFT',
          version: 1,
        }),
        updateMany: vi.fn(),
      },
    };
    const service = createService({ transaction });
    vi.spyOn(service, 'readiness').mockResolvedValue({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: { total: 1, ready: 1, failed: 0, processing: 0, draft: 0, archived: 0 },
      publishedChunkCount: 1,
      embeddedChunkCount: 1,
      semanticCoverage: 1,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-v1',
        dimensions: 1536,
      },
      rerank: {
        status: 'READY',
        provider: 'cohere_compatible',
        model: 'reranker-v1',
        dimensions: null,
      },
      retrievalMode: 'HYBRID',
      degradedReason: null,
      activationAllowed: true,
      activationBlockers: [],
    });
    vi.spyOn(service, 'graphOverview').mockResolvedValue({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      status: 'DEGRADED',
      entityCount: 3,
      relationCount: 0,
      mentionCount: 3,
      evidenceCount: 0,
      orphanEntityCount: 0,
      relationsWithoutEvidenceCount: 0,
      publishedChunkCount: 1,
      linkedChunkCount: 1,
      mentionCoverage: 1,
      evidenceCoverage: 0,
      entityTypes: [{ type: 'TOPIC', count: 3 }],
      relationTypes: [],
      strongRetrievalReady: false,
      readinessBlockers: ['NO_RELATIONS'],
      lastBuiltAt: null,
    });

    await expect(
      service.update(KNOWLEDGE_BASE_ID, {
        status: 'ACTIVE',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.knowledgeBase.updateMany).not.toHaveBeenCalled();
  });

  it('does not reapply new activation gates to an already active knowledge base', async () => {
    const active = {
      id: KNOWLEDGE_BASE_ID,
      tenantId: TENANT_ID,
      key: 'company-policies',
      name: 'Company policies',
      description: null,
      status: 'ACTIVE',
      version: 1,
      orgUnits: [],
      documents: [],
      _count: { documents: 0 },
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    };
    const updated = { ...active, name: 'Updated policies', version: 2 };
    const transaction = {
      knowledgeBase: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeDocument: { findFirst: vi.fn() },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: true,
      embeddingDimensions: 1536,
      capabilities: vi.fn(),
    };
    const service = createService({ transaction, semantic });
    const readiness = vi.spyOn(service, 'readiness');

    await expect(
      service.update(KNOWLEDGE_BASE_ID, {
        name: 'Updated policies',
        status: 'ACTIVE',
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({
      id: KNOWLEDGE_BASE_ID,
      name: 'Updated policies',
      status: 'ACTIVE',
      version: 2,
    });

    expect(readiness).not.toHaveBeenCalled();
    expect(semantic.capabilities).not.toHaveBeenCalled();
    expect(transaction.knowledgeDocument.findFirst).not.toHaveBeenCalled();
  });

  it('reports current-model vector coverage and safe provider readiness', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: 'READY',
            currentVersion: {
              id: DOCUMENT_VERSION_ID,
              status: 'READY',
              _count: { chunks: 4 },
            },
            versions: [
              {
                status: 'READY',
                ingestionJobs: [{ status: 'SUCCEEDED' }],
              },
            ],
          },
          {
            status: 'READY',
            currentVersion: {
              id: '00000000-0000-7000-8000-000000000008',
              status: 'READY',
              _count: { chunks: 2 },
            },
            versions: [
              {
                status: 'FAILED',
                ingestionJobs: [{ status: 'FAILED' }],
              },
            ],
          },
        ]),
      },
      knowledgeChunk: { count: vi.fn().mockResolvedValue(5) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: true,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockResolvedValue({
        embeddings: {
          status: 'ready',
          provider: 'openai_compatible',
          model: 'embedding-v1',
          dimensions: 1536,
        },
        rerank: {
          status: 'ready',
          provider: 'cohere_compatible',
          model: 'reranker-v1',
        },
      }),
    };
    const service = createService({ transaction, semantic });

    await expect(service.readiness(KNOWLEDGE_BASE_ID)).resolves.toMatchObject({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: { total: 2, ready: 1, failed: 1, processing: 0 },
      publishedChunkCount: 6,
      embeddedChunkCount: 5,
      semanticCoverage: 5 / 6,
      embedding: { status: 'READY', model: 'embedding-v1' },
      rerank: { status: 'READY', model: 'reranker-v1' },
      retrievalMode: 'LEXICAL',
      degradedReason: 'EMBEDDING_COVERAGE_INCOMPLETE',
      activationAllowed: false,
    });
    expect(transaction.knowledgeChunk.count).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documentVersionId: {
          in: [DOCUMENT_VERSION_ID, '00000000-0000-7000-8000-000000000008'],
        },
        embeddings: { some: { embeddingModel: 'embedding-v1' } },
      },
    });
  });

  it('converts runtime capability failures to safe unavailable states', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: false,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockRejectedValue(new Error('upstream secret and URL')),
    };
    const service = createService({ transaction, semantic });

    const response = await service.readiness(KNOWLEDGE_BASE_ID);
    expect(response.embedding).toEqual({
      status: 'UNAVAILABLE',
      provider: 'openai_compatible',
      model: null,
      dimensions: 1536,
    });
    expect(response.rerank).toEqual({
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: null,
    });
    expect(JSON.stringify(response)).not.toContain('upstream');
    expect(JSON.stringify(response)).not.toContain('URL');
  });

  it('excludes REVIEW and DEPRECATED graph records from overview and readiness counts', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          entity_count: 0,
          relation_count: 0,
          published_ontology_version_count: 0,
          ungoverned_relation_count: 0,
          open_conflict_count: 0,
          mention_count: 0,
          evidence_count: 0,
          orphan_entity_count: 0,
          relations_without_evidence_count: 0,
          published_chunk_count: 1,
          linked_chunk_count: 0,
          processing_count: 0,
          failed_count: 0,
          last_built_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = createService({
      transaction: {
        knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
        $queryRaw: queryRaw,
      },
    });

    const result = await service.graphOverview(KNOWLEDGE_BASE_ID);

    expect(result).toMatchObject({
      entityCount: 0,
      relationCount: 0,
      mentionCount: 0,
      evidenceCount: 0,
      strongRetrievalReady: false,
    });
    const sql = queryRaw.mock.calls.map((call) => prismaSqlText(call[0])).join('\n');
    expect(sql).toContain(`mentioned_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"`);
    expect(sql).toContain('public."knowledge_graph_retrieval_relations"');
    expect(sql).toContain(`source_relation."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"`);
    expect(sql).toContain(`ontology_version."status" = 'PUBLISHED'`);
    expect(sql).toContain(`graph_conflict."status" IN ('OPEN', 'IN_REVIEW')`);
    expect(sql).toContain(`subject_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"`);
    expect(sql).toContain(`object_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"`);
    expect(sql).toContain(`document."current_version_id" = chunk."document_version_id"`);
    expect(sql).toContain(`version."status" = 'READY'::"KnowledgeDocumentVersionStatus"`);
  });

  it('does not expose non-ACTIVE graph entities through the graph query', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]);
    const service = createService({
      transaction: {
        knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
        $queryRaw: queryRaw,
      },
    });

    const result = await service.graph(KNOWLEDGE_BASE_ID, { limit: 20 });

    expect(result).toMatchObject({
      totalEntities: 0,
      totalRelations: 0,
      entities: [],
      relations: [],
    });
    const sql = queryRaw.mock.calls.map((call) => prismaSqlText(call[0])).join('\n');
    expect(sql).toContain(`mentioned_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"`);
    expect(sql).toContain('public."knowledge_graph_retrieval_relations"');
  });
});

function createService(input: {
  transaction?: Record<string, unknown>;
  evaluations?: Record<string, unknown>;
  ingestion?: Record<string, unknown>;
  retrieval?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
}): KnowledgeAdminService {
  const transaction = input.transaction ?? {};
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  };
  const access = {
    requireKnowledgeWrite: vi.fn(() => ({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      role: 'ADMIN',
      authenticationSource: 'session',
    })),
  };
  return new KnowledgeAdminService(
    prisma as unknown as AdminPrismaService,
    access as unknown as AdminAccessService,
    (input.evaluations ?? {
      requireReferencedRunReady: vi.fn().mockResolvedValue({
        ready: true,
        datasetVersionId: EVALUATION_DATASET_VERSION_ID,
        currentSnapshotHash: EVALUATION_SNAPSHOT_HASH,
        passingRunId: EVALUATION_RUN_ID,
      }),
    }) as unknown as AiEvaluationService,
    (input.ingestion ?? {}) as unknown as KnowledgeIngestionService,
    (input.retrieval ?? {}) as unknown as KnowledgeRetrievalService,
    (input.semantic ?? {
      semanticEnabled: false,
      rerankEnabled: false,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockResolvedValue({
        embeddings: {
          status: 'disabled',
          provider: 'disabled',
          model: null,
          dimensions: 1536,
        },
        rerank: { status: 'disabled', provider: 'disabled', model: null },
      }),
    }) as unknown as KnowledgeAiRuntimeClient,
  );
}

function prismaSqlText(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('strings' in value) ||
    !Array.isArray(value.strings)
  ) {
    return '';
  }
  return value.strings.join('?');
}

function documentResponse(status: 'DRAFT' | 'READY') {
  return {
    id: DOCUMENT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    title: 'Employee handbook',
    sourceType: 'MARKDOWN' as const,
    mimeType: 'text/markdown',
    fileName: null,
    contentText: '# Handbook',
    checksum: null,
    status,
    documentVersion: 1,
    currentVersionId: status === 'READY' ? '00000000-0000-7000-8000-000000000007' : null,
    versions: [],
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function storedDocument(status: 'READY' | 'ARCHIVED', documentVersion: number) {
  return {
    id: DOCUMENT_ID,
    tenantId: TENANT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    title: 'Employee handbook',
    sourceType: 'FILE' as const,
    mimeType: 'application/pdf',
    fileName: 'handbook.pdf',
    contentText: 'Handbook content',
    objectKey: 'tenant/document/version.bin',
    checksum: null,
    status,
    documentVersion,
    currentVersionId: '00000000-0000-7000-8000-000000000007',
    createdById: ADMIN_ID,
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    versions: [],
  };
}

function approvedGovernanceRecord() {
  return {
    governanceOwnerUserId: USER_ID,
    classification: 'INTERNAL' as const,
    scopeMode: 'TENANT' as const,
    organizationScopeIds: [] as string[],
    projectScopeIds: [] as string[],
    taskScopeIds: [] as string[],
    roleTemplateScopeIds: [] as string[],
    dataLabels: [] as string[],
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    expiresAt: null,
    retentionUntil: null,
    retentionAction: 'ARCHIVE' as const,
    supersedesVersionId: null,
    governanceRevision: 2,
    governanceReviewStatus: 'APPROVED' as const,
    governanceReviewedById: ADMIN_ID,
    governanceReviewedAt: new Date('2026-07-02T00:00:00.000Z'),
    governanceReviewNote: 'Approved for publication.',
    governanceHash: 'a'.repeat(64),
  };
}
