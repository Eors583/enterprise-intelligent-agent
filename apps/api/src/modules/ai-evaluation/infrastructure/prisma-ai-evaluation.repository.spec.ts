import { describe, expect, it, vi } from 'vitest';

import { PrismaAiEvaluationRepository } from './prisma-ai-evaluation.repository.js';
import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import { KnowledgeBoundaryReadService } from '../../knowledge-gateway/knowledge-boundary-read.service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '10000000-0000-4000-8000-000000000002';
const SUBJECT_ID = '10000000-0000-4000-8000-000000000003';

describe('PrismaAiEvaluationRepository list filters', () => {
  it('applies the exact subject tuple and status in tenant-scoped SQL', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const transaction = { $queryRaw: queryRaw };
    const prisma = {
      withTenant: vi.fn(
        async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const repository = new PrismaAiEvaluationRepository(
      prisma as unknown as AdminPrismaService,
      new KnowledgeBoundaryReadService(prisma as unknown as AdminPrismaService),
    );

    await repository.listRuns(
      {
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: 'ADMIN',
        authenticationSource: 'session',
      },
      {
        subjectType: 'KNOWLEDGE_VERSION',
        subjectId: SUBJECT_ID,
        subjectVersion: 4,
        status: 'PASSED',
        limit: 50,
      },
    );

    const statement = queryRaw.mock.calls[1]?.[0] as
      { readonly strings?: readonly string[]; readonly values?: readonly unknown[] } | undefined;
    const sql = statement?.strings?.join('?') ?? '';
    expect(sql).toContain('run."tenant_id"');
    expect(sql).toContain('run."subject_type"');
    expect(sql).toContain('run."subject_id"');
    expect(sql).toContain('run."subject_version"');
    expect(sql).toContain('run."status"');
    expect(statement?.values).toEqual(
      expect.arrayContaining([TENANT_ID, 'KNOWLEDGE_VERSION', SUBJECT_ID, 4, 'PASSED']),
    );
  });

  it('invalidates a trusted Knowledge Version snapshot when its governance policy changes', async () => {
    let governanceHash = 'a'.repeat(64);
    let governanceRevision = 2;
    let graphHash = 'c'.repeat(64);
    const queryRaw = vi.fn(async (statement: unknown) => {
      const sql = prismaSqlText(statement);
      if (
        sql.includes('SELECT version."id", version."version_number", version."checksum"') &&
        sql.includes('version."document_id"')
      ) {
        return [
          {
            id: SUBJECT_ID,
            version_number: 4,
            checksum: 'c'.repeat(64),
            status: 'READY',
            knowledge_base_id: '10000000-0000-4000-8000-000000000004',
            document_id: '10000000-0000-4000-8000-000000000005',
            governance_hash: governanceHash,
            governance_revision: governanceRevision,
            governance_review_status: 'APPROVED',
            classification: 'INTERNAL',
            scope_mode: 'TENANT',
            effective_from: new Date('2026-07-01T00:00:00.000Z'),
            expires_at: null,
            retention_until: null,
            retention_action: 'ARCHIVE',
          },
        ];
      }
      if (sql.includes('FROM public."knowledge_graph_projections" projection')) {
        return [
          {
            id: '10000000-0000-4000-8000-000000000007',
            knowledge_base_id: '10000000-0000-4000-8000-000000000004',
            document_id: '10000000-0000-4000-8000-000000000005',
            document_version_id: SUBJECT_ID,
            status: 'CANDIDATE',
            graph_hash: graphHash,
            entity_count: 2,
            mention_count: 2,
            relation_count: 1,
            evidence_count: 1,
          },
        ];
      }
      return [];
    });
    const transaction = { $queryRaw: queryRaw };
    const prisma = {
      withTenant: vi.fn(
        async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const repository = new PrismaAiEvaluationRepository(
      prisma as unknown as AdminPrismaService,
      new KnowledgeBoundaryReadService(prisma as unknown as AdminPrismaService),
    );
    const principal = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: 'ADMIN' as const,
      authenticationSource: 'session' as const,
    };
    const query = {
      subjectType: 'KNOWLEDGE_VERSION' as const,
      subjectId: SUBJECT_ID,
      subjectVersion: 4,
      datasetVersionId: '10000000-0000-4000-8000-000000000006',
      currentSnapshotHash: '0'.repeat(64),
    };

    const original = await repository.loadReadiness(principal, query);
    governanceHash = 'b'.repeat(64);
    governanceRevision = 3;
    const changed = await repository.loadReadiness(principal, query);
    graphHash = 'd'.repeat(64);
    const graphChanged = await repository.loadReadiness(principal, query);

    expect(original.currentSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.currentSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.currentSnapshotHash).not.toBe(original.currentSnapshotHash);
    expect(graphChanged.currentSnapshotHash).not.toBe(changed.currentSnapshotHash);
    expect(queryRaw.mock.calls.map(([statement]) => prismaSqlText(statement)).join('\n')).toContain(
      'version."governance_hash"',
    );
    expect(queryRaw.mock.calls.map(([statement]) => prismaSqlText(statement)).join('\n')).toContain(
      'projection."graph_hash"',
    );
  });

  it('returns immutable answer-feedback Run and citation lineage with an automatic bad case', async () => {
    const badCaseId = '10000000-0000-4000-8000-000000000010';
    const feedbackId = '10000000-0000-4000-8000-000000000011';
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ set_config: USER_ID }])
      .mockResolvedValueOnce([
        {
          id: badCaseId,
          tenant_id: TENANT_ID,
          source_type: 'ANSWER_FEEDBACK',
          source_id: feedbackId,
          source_version: 1,
          category: 'CITATION',
          sanitized_input: 'Which policy applies?',
          source_snapshot_hash: 'a'.repeat(64),
          status: 'RECEIVED',
          revision: 1,
          reported_by_user_id: USER_ID,
          mapped_dataset_version_id: null,
          mapped_case_id: null,
          triaged_by_user_id: null,
          triage_reason: null,
          created_at: new Date('2026-07-28T01:00:00.000Z'),
          updated_at: new Date('2026-07-28T01:00:00.000Z'),
          request_hash: 'a'.repeat(64),
          feedback_source_feedback_id: feedbackId,
          feedback_source_conversation_id: '10000000-0000-4000-8000-000000000012',
          feedback_source_message_id: '10000000-0000-4000-8000-000000000013',
          feedback_source_input_message_id: '10000000-0000-4000-8000-000000000014',
          feedback_source_agent_run_id: '10000000-0000-4000-8000-000000000015',
          feedback_source_agent_id: '10000000-0000-4000-8000-000000000016',
          feedback_source_agent_version_id: '10000000-0000-4000-8000-000000000017',
          feedback_source_reported_by_user_id: USER_ID,
          feedback_source_feedback_reason: 'IRRELEVANT_CITATION',
          feedback_source_feedback_recorded_at: new Date('2026-07-28T01:00:00.000Z'),
          feedback_source_prompt_snapshot_hash: 'b'.repeat(64),
          feedback_source_answer_snapshot_hash: 'c'.repeat(64),
          feedback_source_citations_snapshot_hash: 'd'.repeat(64),
          feedback_source_citations: [
            {
              knowledgeBaseId: '10000000-0000-4000-8000-000000000018',
              documentId: '10000000-0000-4000-8000-000000000019',
              documentVersionId: '10000000-0000-4000-8000-000000000020',
              chunkId: '10000000-0000-4000-8000-000000000021',
            },
          ],
        },
      ]);
    const transaction = { $queryRaw: queryRaw };
    const prisma = {
      withTenant: vi.fn(
        async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const repository = new PrismaAiEvaluationRepository(
      prisma as unknown as AdminPrismaService,
      new KnowledgeBoundaryReadService(prisma as unknown as AdminPrismaService),
    );

    await expect(
      repository.listBadCases(
        {
          tenantId: TENANT_ID,
          userId: USER_ID,
          role: 'ADMIN',
          authenticationSource: 'session',
        },
        { limit: 50 },
      ),
    ).resolves.toMatchObject({
      items: [
        {
          id: badCaseId,
          answerFeedbackSource: {
            feedbackId,
            agentVersionId: '10000000-0000-4000-8000-000000000017',
            feedbackReason: 'IRRELEVANT_CITATION',
            citations: [
              {
                chunkId: '10000000-0000-4000-8000-000000000021',
              },
            ],
          },
        },
      ],
    });

    expect(prismaSqlText(queryRaw.mock.calls[1]?.[0])).toContain(
      'ai_evaluation_answer_feedback_sources',
    );
  });
});

function prismaSqlText(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'strings' in value &&
    Array.isArray(value.strings)
  ) {
    return value.strings.join('?');
  }
  if (Array.isArray(value)) return value.join('?');
  return '';
}
