import type { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { knowledgeCitationDetailSchema } from '@enterprise/contracts';
import request from 'supertest';

import { PrismaAiEvaluationRepository } from '../src/modules/ai-evaluation/infrastructure/prisma-ai-evaluation.repository.js';
import { KnowledgeBoundaryReadService } from '../src/modules/knowledge-gateway/knowledge-boundary-read.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import {
  seedPassingEvaluationRun,
  seedPublishedEvaluationDataset,
} from './ai-evaluation-test-fixture.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '10000000-0000-7000-8000-000000000001';
const requesterId = '10000000-0000-7000-8000-000000000101';
const otherRoleUserId = '10000000-0000-7000-8000-000000000102';
const organizationId = '10000000-0000-7000-8000-000000000201';
const orgUnitId = '10000000-0000-7000-8000-000000000202';
const employmentId = '10000000-0000-7000-8000-000000000203';
const otherEmploymentId = '10000000-0000-7000-8000-000000000204';
const templateId = '10000000-0000-7000-8000-000000000301';
const agentVersionId = '10000000-0000-7000-8000-000000000302';
const agentId = '10000000-0000-7000-8000-000000000303';
const assignmentId = '10000000-0000-7000-8000-000000000304';
const knowledgeBaseId = '10000000-0000-7000-8000-000000000401';
const documentId = '10000000-0000-7000-8000-000000000402';
const documentVersionId = '10000000-0000-7000-8000-000000000403';
const allowedChunkId = '10000000-0000-7000-8000-000000000404';
const wrongLabelChunkId = '10000000-0000-7000-8000-000000000405';
const wrongProjectChunkId = '10000000-0000-7000-8000-000000000406';
const nonCitedChunkId = '10000000-0000-7000-8000-000000000407';
const parentChunkId = '10000000-0000-7000-8000-000000000408';
const conversationId = '10000000-0000-7000-8000-000000000501';
const inputMessageId = '10000000-0000-7000-8000-000000000502';
const outputMessageId = '10000000-0000-7000-8000-000000000503';
const runId = '10000000-0000-7000-8000-000000000504';
const unboundMessageId = '10000000-0000-7000-8000-000000000505';
const taskMismatchInputMessageId = '10000000-0000-7000-8000-000000000506';
const taskMismatchOutputMessageId = '10000000-0000-7000-8000-000000000507';
const taskMismatchRunId = '10000000-0000-7000-8000-000000000508';
const taskId = '10000000-0000-7000-8000-000000000601';
const otherTaskId = '10000000-0000-7000-8000-000000000602';
const projectId = '10000000-0000-7000-8000-000000000603';
const otherProjectId = '10000000-0000-7000-8000-000000000604';

describe.runIf(enabled)('PostgreSQL knowledge citation authorization', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await cleanup();
    await seed();
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await administrator.$disconnect();
  });

  it('returns only a message-bound source after current authorization revalidation', async () => {
    const response = await request(app.getHttpServer())
      .get(citationPath(outputMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(200);

    expect(knowledgeCitationDetailSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toMatchObject({
      documentVersionId,
      chunkId: allowedChunkId,
      content: 'Only the governed role may use this policy.',
    });
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId,
          actorId: requesterId,
          action: 'knowledge.citation.read',
          resourceId: outputMessageId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('returns 404 for guessed IDs and an agent message without AgentRun lineage', async () => {
    await request(app.getHttpServer())
      .get(citationPath('10000000-0000-7000-8000-000000009999', allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);
    await request(app.getHttpServer())
      .get(citationPath(unboundMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);
  });

  it('returns 404 to a non-requester even when that role remains a conversation participant', async () => {
    await request(app.getHttpServer())
      .get(citationPath(outputMessageId, allowedChunkId))
      .set(identityHeaders(otherRoleUserId))
      .expect(404);
  });

  it('returns 404 for a non-cited chunk and current project/label mismatches', async () => {
    await request(app.getHttpServer())
      .get(citationPath(outputMessageId, nonCitedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);

    await administrator.roleAssignment.update({
      where: { id: assignmentId },
      data: {
        permissionScope: {
          actions: ['knowledge.retrieve'],
          projectIds: [otherProjectId],
          taskIds: [taskId],
          dataLabels: ['role:governed'],
        },
      },
    });
    await request(app.getHttpServer())
      .get(citationPath(outputMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);

    await administrator.roleAssignment.update({
      where: { id: assignmentId },
      data: {
        permissionScope: {
          actions: ['knowledge.retrieve'],
          projectIds: [projectId],
          taskIds: [taskId],
          dataLabels: ['role:restricted'],
        },
      },
    });
    await request(app.getHttpServer())
      .get(citationPath(outputMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);

    await administrator.roleAssignment.update({
      where: { id: assignmentId },
      data: {
        permissionScope: {
          actions: ['knowledge.retrieve'],
          projectIds: [projectId],
          taskIds: [taskId],
          dataLabels: ['role:governed'],
        },
      },
    });
  });

  it('returns 404 when the bound Run task is outside the current assignment', async () => {
    await request(app.getHttpServer())
      .get(citationPath(taskMismatchOutputMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);
  });

  it('returns 404 immediately after assignment revocation', async () => {
    await administrator.roleAssignment.update({
      where: { id: assignmentId },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedById: requesterId,
        revokeReason: 'Citation authorization integration revocation.',
        version: { increment: 1 },
      },
    });
    await request(app.getHttpServer())
      .get(citationPath(outputMessageId, allowedChunkId))
      .set(identityHeaders(requesterId))
      .expect(404);
  });

  async function seed(): Promise<void> {
    await administrator.tenant.create({
      data: {
        id: tenantId,
        slug: 'knowledge-citation-integration',
        name: 'Knowledge Citation Integration',
      },
    });
    await administrator.user.createMany({
      data: [
        {
          id: requesterId,
          tenantId,
          email: 'requester@knowledge-citation.integration',
          emailNormalized: 'requester@knowledge-citation.integration',
          displayName: 'Citation Requester',
          status: 'ACTIVE',
        },
        {
          id: otherRoleUserId,
          tenantId,
          email: 'other-role@knowledge-citation.integration',
          emailNormalized: 'other-role@knowledge-citation.integration',
          displayName: 'Other Role',
          status: 'ACTIVE',
        },
      ],
    });
    await administrator.organization.create({
      data: { id: organizationId, tenantId, name: 'Citation Organization' },
    });
    await administrator.orgUnit.create({
      data: {
        id: orgUnitId,
        tenantId,
        organizationId,
        name: 'Citation Unit',
        status: 'ACTIVE',
      },
    });
    await administrator.employment.createMany({
      data: [
        {
          id: employmentId,
          tenantId,
          userId: requesterId,
          organizationId,
          orgUnitId,
          status: 'ACTIVE',
          isPrimary: true,
        },
        {
          id: otherEmploymentId,
          tenantId,
          userId: otherRoleUserId,
          organizationId,
          orgUnitId,
          status: 'ACTIVE',
          isPrimary: true,
        },
      ],
    });
    await administrator.agentTemplate.create({
      data: { id: templateId, tenantId, key: 'citation-role', name: 'Citation Role' },
    });
    await administrator.agentVersion.create({
      data: {
        id: agentVersionId,
        tenantId,
        templateId,
        version: 1,
        status: 'PUBLISHED',
        systemPrompt: 'Answer only with governed evidence.',
        modelPolicy: {},
        toolPolicy: { allow: [] },
        knowledgeScope: { ids: [knowledgeBaseId] },
        createdById: requesterId,
      },
    });
    await administrator.agentInstance.create({
      data: {
        id: agentId,
        tenantId,
        key: 'citation-role-instance',
        versionId: agentVersionId,
        ownerUserId: requesterId,
        createdById: requesterId,
        name: 'Citation Role Agent',
        status: 'ONLINE',
        settings: { visibility: 'tenant', roleAssignmentId: assignmentId },
      },
    });
    await administrator.roleAssignment.create({
      data: {
        id: assignmentId,
        tenantId,
        key: 'assignment:citation-role',
        idempotencyKey: 'citation-role-assignment-v1',
        requestHash: 'a'.repeat(64),
        userId: requesterId,
        employmentId,
        roleTemplateId: templateId,
        roleVersionId: agentVersionId,
        agentInstanceId: agentId,
        status: 'ACTIVE',
        effectiveFrom: new Date(Date.now() - 60_000),
        organizationScope: { organizationIds: [orgUnitId], includeDescendants: true },
        permissionScope: {
          actions: ['knowledge.retrieve'],
          projectIds: [projectId],
          taskIds: [taskId],
          dataLabels: ['role:governed'],
        },
        memoryPolicy: {},
        createdById: requesterId,
      },
    });
    await administrator.knowledgeBase.create({
      data: {
        id: knowledgeBaseId,
        tenantId,
        key: 'citation-governed-knowledge',
        name: 'Citation Governed Knowledge',
        status: 'ACTIVE',
        spaceTargetId: tenantId,
        spaceTargetName: 'Citation Governance Tenant',
        createdById: requesterId,
        orgUnits: { create: { orgUnitId, includeChildren: true } },
      },
    });
    await administrator.knowledgeDocument.create({
      data: {
        id: documentId,
        tenantId,
        knowledgeBaseId,
        title: 'Governed citation policy',
        sourceType: 'TEXT',
        contentText: 'Only the governed role may use this policy.',
        status: 'READY',
        documentVersion: 1,
        createdById: requesterId,
      },
    });
    await administrator.knowledgeDocumentVersion.create({
      data: {
        id: documentVersionId,
        tenantId,
        knowledgeBaseId,
        documentId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Only the governed role may use this policy.',
        checksum: 'b'.repeat(64),
        status: 'READY',
        governanceOwnerUserId: requesterId,
        classification: 'INTERNAL',
        scopeMode: 'RESTRICTED',
        organizationScopeIds: [orgUnitId],
        projectScopeIds: [projectId],
        taskScopeIds: [taskId],
        roleTemplateScopeIds: [templateId],
        dataLabels: ['role:governed'],
        createdById: requesterId,
      },
    });
    await administrator.knowledgeDocumentVersion.update({
      where: { id: documentVersionId },
      data: {
        governanceReviewStatus: 'APPROVED',
        governanceReviewedById: otherRoleUserId,
        governanceReviewedAt: new Date(),
        governanceReviewNote: 'Independent citation fixture approval.',
        governanceRevision: { increment: 1 },
      },
    });
    await publishKnowledgeVersion();
    await administrator.knowledgeParentChunk.create({
      data: {
        id: parentChunkId,
        tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
        parentIndex: 0,
        content: 'Only the governed role may use this policy.',
        tokenCount: 10,
        contentHash: 'e'.repeat(64),
      },
    });
    await administrator.knowledgeChunk.createMany({
      data: [
        chunk(allowedChunkId, 0, { orgUnitId, projectId, taskId, dataLabels: ['role:governed'] }),
        chunk(wrongLabelChunkId, 1, {
          orgUnitId,
          projectId,
          taskId,
          dataLabels: ['role:restricted'],
        }),
        chunk(wrongProjectChunkId, 2, {
          orgUnitId,
          projectId: otherProjectId,
          taskId,
          dataLabels: ['role:governed'],
        }),
        chunk(nonCitedChunkId, 3, {
          orgUnitId,
          projectId,
          taskId,
          dataLabels: ['role:governed'],
        }),
      ],
    });
    await administrator.conversation.create({
      data: {
        id: conversationId,
        tenantId,
        directKey: 'knowledge-citation-integration-conversation',
        createdById: requesterId,
      },
    });
    await administrator.conversationParticipant.createMany({
      data: [
        {
          tenantId,
          conversationId,
          type: 'USER',
          participantKey: `user:${requesterId}`,
          userId: requesterId,
          displayName: 'Citation Requester',
        },
        {
          tenantId,
          conversationId,
          type: 'USER',
          participantKey: `user:${otherRoleUserId}`,
          userId: otherRoleUserId,
          displayName: 'Other Role',
        },
        {
          tenantId,
          conversationId,
          type: 'AGENT',
          participantKey: `agent:${agentId}`,
          agentId,
          displayName: 'Citation Role Agent',
        },
      ],
    });
    await administrator.message.createMany({
      data: [
        userMessage(inputMessageId, 'citation-input'),
        agentMessage(outputMessageId, runId),
        agentMessage(unboundMessageId, '10000000-0000-7000-8000-000000009998'),
        userMessage(taskMismatchInputMessageId, 'citation-task-mismatch-input'),
        agentMessage(taskMismatchOutputMessageId, taskMismatchRunId),
      ],
    });
    await administrator.$transaction(async (tx) => {
      // Citation authorization only needs stable Task identities. The complete
      // business-semantics graph is covered by its own integration suite, so
      // this fixture bypasses FK triggers while retaining every Task CHECK.
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO public."tasks" (
          "id", "tenant_id", "code", "version", "revision",
          "strategy_id", "strategy_version",
          "objective_id", "objective_version",
          "value_definition_id", "value_version_id", "value_version_number",
          "process_definition_id", "process_definition_code",
          "process_version_id", "process_version",
          "process_node_id", "process_node_code",
          "title", "description", "status", "priority",
          "owner_role_assignment_id", "permission_labels",
          "effective_from", "due_at", "ready_at",
          "idempotency_key", "request_hash", "updated_at"
        )
        VALUES
          (
            ${taskId}::uuid, ${tenantId}::uuid, 'CITATION_TASK', 1, 1,
            '10000000-0000-7000-8000-000000000611'::uuid, 1,
            '10000000-0000-7000-8000-000000000612'::uuid, 1,
            '10000000-0000-7000-8000-000000000613'::uuid,
            '10000000-0000-7000-8000-000000000614'::uuid, 1,
            '10000000-0000-7000-8000-000000000615'::uuid, 'CITATION_PROCESS',
            '10000000-0000-7000-8000-000000000616'::uuid, 1,
            '10000000-0000-7000-8000-000000000617'::uuid, 'CITATION_NODE',
            'Citation authorization task', 'Fixture task for citation authorization.',
            'READY', 'MEDIUM', ${assignmentId}::uuid, '["role:governed"]'::jsonb,
            CURRENT_TIMESTAMP - INTERVAL '1 minute',
            CURRENT_TIMESTAMP + INTERVAL '1 day',
            CURRENT_TIMESTAMP,
            'citation-task-v1', ${'c'.repeat(64)}, CURRENT_TIMESTAMP
          ),
          (
            ${otherTaskId}::uuid, ${tenantId}::uuid, 'CITATION_OTHER_TASK', 1, 1,
            '10000000-0000-7000-8000-000000000621'::uuid, 1,
            '10000000-0000-7000-8000-000000000622'::uuid, 1,
            '10000000-0000-7000-8000-000000000623'::uuid,
            '10000000-0000-7000-8000-000000000624'::uuid, 1,
            '10000000-0000-7000-8000-000000000625'::uuid, 'CITATION_PROCESS',
            '10000000-0000-7000-8000-000000000626'::uuid, 1,
            '10000000-0000-7000-8000-000000000627'::uuid, 'CITATION_NODE',
            'Citation authorization mismatch task',
            'Negative fixture task for citation authorization.',
            'READY', 'MEDIUM', ${assignmentId}::uuid, '["role:governed"]'::jsonb,
            CURRENT_TIMESTAMP - INTERVAL '1 minute',
            CURRENT_TIMESTAMP + INTERVAL '1 day',
            CURRENT_TIMESTAMP,
            'citation-other-task-v1', ${'d'.repeat(64)}, CURRENT_TIMESTAMP
          )
      `;
    });
    await administrator.agentRun.createMany({
      data: [
        run(runId, inputMessageId, outputMessageId, taskId, 'citation-run-v1'),
        run(
          taskMismatchRunId,
          taskMismatchInputMessageId,
          taskMismatchOutputMessageId,
          otherTaskId,
          'citation-task-mismatch-run-v1',
        ),
      ],
    });
  }

  function chunk(id: string, chunkIndex: number, metadata: Prisma.InputJsonObject) {
    return {
      id,
      tenantId,
      knowledgeBaseId,
      documentId,
      documentVersionId,
      parentChunkId,
      chunkIndex,
      content:
        id === allowedChunkId
          ? 'Only the governed role may use this policy.'
          : `Governed citation negative fixture ${chunkIndex}.`,
      tokenCount: 10,
      contentHash: String(chunkIndex + 1).repeat(64),
      metadata,
    };
  }

  function userMessage(id: string, clientMessageId: string) {
    return {
      id,
      tenantId,
      conversationId,
      senderType: 'USER' as const,
      senderUserId: requesterId,
      senderKey: `user:${requesterId}`,
      senderName: 'Citation Requester',
      clientMessageId,
      contentType: 'TEXT' as const,
      content: { type: 'text', text: 'Show the governed policy.' },
    };
  }

  function agentMessage(id: string, sourceRunId: string) {
    return {
      id,
      tenantId,
      conversationId,
      senderType: 'AGENT' as const,
      senderAgentId: agentId,
      senderKey: `agent:${agentId}`,
      senderName: 'Citation Role Agent',
      clientMessageId: `agent-run:${sourceRunId}`,
      contentType: 'TEXT' as const,
      content: {
        type: 'text',
        text: 'The governed policy applies. [来源1]',
        citations: [
          citation(allowedChunkId, 'Only the governed role may use this policy.'),
          citation(wrongLabelChunkId, 'Wrong label fixture.'),
          citation(wrongProjectChunkId, 'Wrong project fixture.'),
        ],
      },
    };
  }

  function citation(chunkId: string, excerpt: string) {
    return {
      knowledgeBaseId,
      knowledgeBaseName: 'Citation Governed Knowledge',
      documentId,
      documentVersionId,
      chunkId,
      title: 'Governed citation policy',
      documentVersion: 1,
      headingPath: [],
      sourceType: 'TEXT',
      excerpt,
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
  }

  function run(
    id: string,
    inputId: string,
    outputId: string,
    runTaskId: string,
    idempotencyKey: string,
  ) {
    return {
      id,
      tenantId,
      taskId: runTaskId,
      conversationId,
      inputMessageId: inputId,
      outputMessageId: outputId,
      requesterUserId: requesterId,
      agentId,
      agentVersionId,
      status: 'SUCCEEDED' as const,
      externalRunId: id,
      idempotencyKey,
      policySnapshot: { snapshotSchemaVersion: 2, roleAssignmentId: assignmentId },
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      usageRecordedAt: new Date(),
      finishedAt: new Date(),
    };
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantId]);
  }

  async function publishKnowledgeVersion(): Promise<void> {
    const fixtureName = `CITATION-${documentVersionId}`;
    const fixture = await seedPublishedEvaluationDataset({
      prisma: administrator,
      tenantId,
      submitterUserId: requesterId,
      reviewerUserId: otherRoleUserId,
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: documentVersionId,
      subjectVersion: 1,
      fixtureName,
    });
    const knowledgePrisma = {
      withTenant: <T>(
        scopedTenantId: string,
        operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) =>
        administrator.$transaction(async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT set_config('app.tenant_id', ${scopedTenantId}, true)`,
          );
          return operation(transaction);
        }),
    } as never;
    const repository = new PrismaAiEvaluationRepository(
      knowledgePrisma,
      new KnowledgeBoundaryReadService(knowledgePrisma),
    );
    const principal = {
      tenantId,
      userId: otherRoleUserId,
      role: 'ADMIN' as const,
      authenticationSource: 'trusted-proxy' as const,
    };
    const snapshot = await repository.loadReadiness(principal, {
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: documentVersionId,
      subjectVersion: 1,
      datasetVersionId: fixture.datasetVersionId,
      currentSnapshotHash: '0'.repeat(64),
    });
    const evaluationRunId = await seedPassingEvaluationRun({
      prisma: administrator,
      tenantId,
      submitterUserId: requesterId,
      reviewerUserId: otherRoleUserId,
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: documentVersionId,
      subjectVersion: 1,
      fixtureName,
      datasetVersionId: fixture.datasetVersionId,
      evidenceId: fixture.evidenceId,
      caseIds: fixture.caseIds,
      subjectSnapshotHash: snapshot.currentSnapshotHash,
    });
    await repository.recordReadiness(
      principal,
      {
        subjectType: 'KNOWLEDGE_VERSION',
        subjectId: documentVersionId,
        subjectVersion: 1,
        datasetVersionId: fixture.datasetVersionId,
        currentSnapshotHash: snapshot.currentSnapshotHash,
        evaluationRunId,
      },
      {
        ready: true,
        passingRunId: evaluationRunId,
        evaluatedSnapshotHash: snapshot.currentSnapshotHash,
        blockers: [],
        checkedAt: new Date().toISOString(),
      },
    );
    await administrator.knowledgeDocumentVersion.update({
      where: { id: documentVersionId },
      data: {
        publishedAt: new Date(),
        evaluationRunId,
        evaluationDatasetVersionId: fixture.datasetVersionId,
        evaluationSnapshotHash: snapshot.currentSnapshotHash,
      },
    });
    await administrator.knowledgeDocument.update({
      where: { id: documentId },
      data: { currentVersionId: documentVersionId, status: 'READY', documentVersion: 1 },
    });
  }
});

function citationPath(messageId: string, chunkId: string): string {
  return `/api/v1/knowledge-citations/${documentVersionId}/chunks/${chunkId}?messageId=${messageId}`;
}

function identityHeaders(userId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId, 'x-user-id': userId };
}
