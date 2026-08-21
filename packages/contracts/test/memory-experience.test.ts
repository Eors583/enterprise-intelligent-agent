import { describe, expect, it } from 'vitest';

import {
  experienceCandidateSchema,
  experienceKnowledgeProjectionSchema,
  experienceTransitionRequestSchema,
  memoryRecordSchema,
  prepareExperienceKnowledgeProjectionRequestSchema,
} from '../src/memory-experience.js';

const UUIDS = {
  tenant: '00000000-0000-7000-8000-000000000001',
  memory: '00000000-0000-7000-8000-000000000101',
  owner: '00000000-0000-7000-8000-000000000201',
  assignment: '00000000-0000-7000-8000-000000000301',
  role: '00000000-0000-7000-8000-000000000401',
  roleVersion: '00000000-0000-7000-8000-000000000402',
  source: '00000000-0000-7000-8000-000000000501',
  evidence: '00000000-0000-7000-8000-000000000601',
  task: '00000000-0000-7000-8000-000000000701',
  deliverable: '00000000-0000-7000-8000-000000000801',
  reviewer: '00000000-0000-7000-8000-000000000901',
  reviewerAssignment: '00000000-0000-7000-8000-000000000902',
  run: '00000000-0000-7000-8000-000000000903',
  dataset: '00000000-0000-7000-8000-000000000904',
  kb: '00000000-0000-7000-8000-000000000905',
  doc: '00000000-0000-7000-8000-000000000906',
  docVersion: '00000000-0000-7000-8000-000000000907',
} as const;

const HASH = 'a'.repeat(64);
const NOW = '2026-07-28T05:00:00.000Z';

describe('memory contracts', () => {
  it('accepts purpose-bound employee-private memory', () => {
    expect(
      memoryRecordSchema.parse({
        id: UUIDS.memory,
        tenantId: UUIDS.tenant,
        scope: 'EMPLOYEE_PRIVATE',
        status: 'ACTIVE',
        version: 1,
        revision: 1,
        title: 'Personal preference',
        summary: 'The employee confirmed a private working preference.',
        contentHash: HASH,
        sourceType: 'USER_CONFIRMED',
        sourceId: UUIDS.source,
        sourceVersion: 1,
        sourceEvidenceIds: [UUIDS.evidence],
        ownerUserId: UUIDS.owner,
        roleTemplateId: UUIDS.role,
        roleVersionId: UUIDS.roleVersion,
        roleAssignmentId: UUIDS.assignment,
        taskId: null,
        conversationId: null,
        permissionLabels: ['employee-private'],
        sensitivity: 'CONFIDENTIAL',
        consent: {
          required: true,
          grantedByUserId: UUIDS.owner,
          grantedAt: NOW,
          purpose: 'Personal assistance in this assignment',
        },
        effectiveFrom: NOW,
        effectiveTo: null,
        expiresAt: null,
        retentionAction: 'SEAL',
        sealedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }).scope,
    ).toBe('EMPLOYEE_PRIVATE');
  });

  it('rejects ambiguous scope identity and ownerless private memory', () => {
    const result = memoryRecordSchema.safeParse({
      id: UUIDS.memory,
      tenantId: UUIDS.tenant,
      scope: 'EMPLOYEE_PRIVATE',
      status: 'ACTIVE',
      version: 1,
      revision: 1,
      title: 'Invalid',
      summary: 'Invalid ownerless private memory.',
      contentHash: HASH,
      sourceType: 'USER_CONFIRMED',
      sourceId: UUIDS.source,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      ownerUserId: null,
      roleTemplateId: UUIDS.role,
      roleVersionId: UUIDS.roleVersion,
      roleAssignmentId: UUIDS.assignment,
      taskId: UUIDS.task,
      conversationId: null,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL',
      consent: {
        required: false,
        grantedByUserId: null,
        grantedAt: null,
        purpose: null,
      },
      effectiveFrom: NOW,
      effectiveTo: null,
      expiresAt: null,
      retentionAction: 'SEAL',
      sealedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('requires a finite TTL for conversation memory', () => {
    const base = enterpriseMemory();
    expect(
      memoryRecordSchema.safeParse({
        ...base,
        scope: 'CONVERSATION',
        conversationId: UUIDS.source,
        expiresAt: null,
      }).success,
    ).toBe(false);
  });
});

describe('experience governance contracts', () => {
  it('accepts a fully sanitized, reviewed, validated, published experience', () => {
    expect(experienceCandidateSchema.parse(publishedExperience()).status).toBe('PUBLISHED');
  });

  it('rejects self-review and unsanitized publication', () => {
    const candidate = publishedExperience();
    const result = experienceCandidateSchema.safeParse({
      ...candidate,
      sanitization: {
        ...candidate.sanitization!,
        secretsRemoved: false,
      },
      review: {
        ...candidate.review!,
        reviewerUserId: candidate.contributorUserId,
      },
    });
    expect(result.success).toBe(false);
  });

  it('binds each transition action to a strict payload and rejects actor injection', () => {
    const request = {
      expectedRevision: 1,
      action: 'SANITIZE',
      reason: 'Remove all private and secret material before structuring.',
      payload: {
        sanitizedContent: 'A sanitized and reusable operating practice.',
        sanitizedHash: HASH,
        piiRemoved: true,
        secretsRemoved: true,
        customerIdentifiersRemoved: true,
        findings: [],
      },
      idempotencyKey: 'sanitize-1',
    };
    expect(experienceTransitionRequestSchema.safeParse(request).success).toBe(true);
    expect(
      experienceTransitionRequestSchema.safeParse({
        ...request,
        actorUserId: UUIDS.reviewer,
      }).success,
    ).toBe(false);
    expect(
      experienceTransitionRequestSchema.safeParse({
        ...request,
        payload: { evidenceIds: [UUIDS.evidence] },
      }).success,
    ).toBe(false);
  });

  it('rejects a published experience without passing validation', () => {
    const candidate = publishedExperience();
    expect(
      experienceCandidateSchema.safeParse({
        ...candidate,
        validation: {
          ...candidate.validation!,
          passed: false,
          score: 0.2,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects inconsistent monitoring counters', () => {
    expect(
      experienceCandidateSchema.safeParse({
        ...publishedExperience(),
        status: 'MONITORED',
        monitoredUseCount: 1,
        monitoredAdoptionCount: 2,
      }).success,
    ).toBe(false);
  });

  it('requires an explicit governed target before preparing a Knowledge projection', () => {
    expect(
      prepareExperienceKnowledgeProjectionRequestSchema.parse({
        expectedRevision: 5,
        knowledgeBaseId: UUIDS.kb,
        targetRoleTemplateIds: [UUIDS.role],
        targetOrgUnitIds: [],
        idempotencyKey: 'experience-projection-1',
      }),
    ).toMatchObject({
      expectedRevision: 5,
      knowledgeBaseId: UUIDS.kb,
      targetRoleTemplateIds: [UUIDS.role],
    });
    expect(
      prepareExperienceKnowledgeProjectionRequestSchema.safeParse({
        expectedRevision: 5,
        knowledgeBaseId: UUIDS.kb,
        targetRoleTemplateIds: [],
        targetOrgUnitIds: [],
        idempotencyKey: 'experience-projection-without-scope',
      }).success,
    ).toBe(false);
  });

  it('does not call a Knowledge projection ready until its exact version identity exists', () => {
    const base = {
      id: UUIDS.source,
      experienceId: UUIDS.memory,
      expectedExperienceRevision: 5,
      knowledgeBaseId: UUIDS.kb,
      documentId: UUIDS.doc,
      documentVersionId: UUIDS.docVersion,
      documentVersion: 1,
      targetRoleTemplateIds: [UUIDS.role],
      targetOrgUnitIds: [],
      publicationHash: HASH,
      status: 'READY',
      ingestionStatus: 'SUCCEEDED',
      governanceReviewStatus: 'APPROVED',
      publishedAt: null,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(experienceKnowledgeProjectionSchema.safeParse(base).success).toBe(true);
    expect(
      experienceKnowledgeProjectionSchema.safeParse({
        ...base,
        documentVersionId: null,
      }).success,
    ).toBe(false);
  });
});

function enterpriseMemory() {
  return {
    id: UUIDS.memory,
    tenantId: UUIDS.tenant,
    scope: 'ENTERPRISE',
    status: 'ACTIVE',
    version: 1,
    revision: 1,
    title: 'Enterprise memory',
    summary: 'A governed enterprise memory record.',
    contentHash: HASH,
    sourceType: 'KNOWLEDGE',
    sourceId: UUIDS.source,
    sourceVersion: 1,
    sourceEvidenceIds: [UUIDS.evidence],
    ownerUserId: null,
    roleTemplateId: null,
    roleVersionId: null,
    roleAssignmentId: null,
    taskId: null,
    conversationId: null,
    permissionLabels: [],
    sensitivity: 'INTERNAL',
    consent: {
      required: false,
      grantedByUserId: null,
      grantedAt: null,
      purpose: null,
    },
    effectiveFrom: NOW,
    effectiveTo: null,
    expiresAt: null,
    retentionAction: 'ARCHIVE',
    sealedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function publishedExperience() {
  return {
    id: UUIDS.memory,
    tenantId: UUIDS.tenant,
    status: 'PUBLISHED',
    revision: 6,
    title: 'Reliable delivery practice',
    contributorUserId: UUIDS.owner,
    contributorRoleAssignmentId: UUIDS.assignment,
    sourceTaskId: UUIDS.task,
    sourceDeliverableIds: [UUIDS.deliverable],
    sourceEvidenceIds: [UUIDS.evidence],
    rawInputHash: HASH,
    candidateSummary: 'A reusable practice derived from sealed delivery evidence.',
    sanitization: {
      sanitizedContent: 'A de-identified reusable delivery practice.',
      sanitizedHash: HASH,
      piiRemoved: true,
      secretsRemoved: true,
      customerIdentifiersRemoved: true,
      findings: [],
      sanitizedByUserId: UUIDS.reviewer,
      sanitizedAt: NOW,
    },
    structuredContent: {
      scenario: 'Enterprise delivery',
      problem: 'Prevent late acceptance.',
      steps: ['Define acceptance before execution.'],
      preconditions: ['A versioned task exists.'],
      counterexamples: ['Do not infer acceptance from chat.'],
      risks: ['Unsealed evidence is not authoritative.'],
      outcomes: ['Acceptance is traceable.'],
      applicabilityBoundaries: ['Only applies to governed delivery tasks.'],
    },
    structuredHash: HASH,
    review: {
      reviewerUserId: UUIDS.reviewer,
      reviewerRoleAssignmentId: UUIDS.reviewerAssignment,
      decision: 'APPROVED',
      reason: 'Evidence and reuse boundary were independently verified.',
      evidenceIds: [UUIDS.evidence],
      decidedAt: NOW,
    },
    validation: {
      validationRunId: UUIDS.run,
      datasetVersionId: UUIDS.dataset,
      passed: true,
      score: 0.92,
      threshold: 0.8,
      sideEffects: [],
      validatedByUserId: UUIDS.reviewer,
      validatedAt: NOW,
    },
    publication: {
      knowledgeBaseId: UUIDS.kb,
      documentId: UUIDS.doc,
      documentVersionId: UUIDS.docVersion,
      documentVersion: 1,
      targetRoleTemplateIds: [UUIDS.role],
      targetOrgUnitIds: [],
      publicationHash: HASH,
      publishedByUserId: UUIDS.reviewer,
      publishedAt: NOW,
    },
    permissionLabels: ['delivery'],
    sensitivity: 'INTERNAL',
    monitoredUseCount: 0,
    monitoredAdoptionCount: 0,
    monitoredComplaintCount: 0,
    expiresAt: null,
    retiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}
