import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CollaborationCommandRequest,
  CorrectionFeedbackRequest,
  CreateCollaborationRequest,
} from '@enterprise/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import {
  ADMIN_PRINCIPAL,
  COLLABORATION_ID,
  CORRECTION_ID,
  NEXT_UPDATED_AT,
  ROLE_ASSIGNMENT_ID,
  TASK_ID,
  TENANT_ID,
  USER_ID,
  collaboration,
  collaborationDetail,
  correction,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import type {
  AuthorizedRuntimeTaskScope,
  CollaborationCorrectionAuthorizationPort,
} from './collaboration-correction-authorization.port.js';
import type { CollaborationCorrectionRepository } from './collaboration-correction.repository.js';
import { CollaborationCorrectionService } from './collaboration-correction.service.js';

const TASK_SCOPE: AuthorizedRuntimeTaskScope = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  taskId: TASK_ID,
  decisionId: 'decision-task-read',
  managementBypass: false,
  roleAssignmentIds: [ROLE_ASSIGNMENT_ID],
  organizationIds: [],
  projectIds: [],
  permissionLabelScopes: [['internal']],
  permissionLabels: ['internal'],
};

const ACKNOWLEDGE_FEEDBACK: CorrectionFeedbackRequest = {
  expectedRevision: 1,
  action: 'ACKNOWLEDGE',
  comment: 'I will provide the missing approval.',
  evidenceIds: [],
  effectiveAt: NEXT_UPDATED_AT,
  idempotencyKey: 'correction:acknowledge:1',
};

const RECIPIENT_ROLE_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000099';

const CREATE_COLLABORATION: CreateCollaborationRequest = {
  actingRoleAssignmentId: ROLE_ASSIGNMENT_ID,
  recipientRoleAssignmentIds: [RECIPIENT_ROLE_ASSIGNMENT_ID],
  background: 'Customer knowledge accuracy is below target.',
  commonGoal: 'Restore the customer knowledge accuracy target.',
  requestedInput: 'Provide a sealed regression report.',
  expectedOutputSchema: { type: 'object', required: ['reportUri'] },
  dueAt: '2099-07-29T05:00:00.000Z',
  contextRefs: [{ type: 'TASK', id: TASK_ID, version: 1 }],
  idempotencyKey: 'collaboration:create:1',
};

const COMMIT_COLLABORATION: CollaborationCommandRequest = {
  expectedRevision: 1,
  type: 'COMMIT',
  payload: {
    committedDueAt: '2099-07-29T05:00:00.000Z',
    outputSchema: { type: 'object', required: ['reportUri'] },
    conditions: [],
  },
  idempotencyKey: 'collaboration:commit:2',
};

describe('CollaborationCorrectionService', () => {
  it('lists only server-resolved collaboration candidates', async () => {
    const listCollaborationCandidates = vi.fn().mockResolvedValue([
      {
        roleAssignmentId: ROLE_ASSIGNMENT_ID,
        userId: USER_ID,
        userName: 'Runtime Owner',
        roleName: 'Customer Success Owner',
        orgUnitName: 'Customer Success',
        canActAsRequester: true,
      },
    ]);
    const requireTaskAccess = vi.fn().mockResolvedValue(TASK_SCOPE);
    const { service } = createService({
      repository: { listCollaborationCandidates },
      authorization: { requireTaskAccess },
    });

    const response = await service.listCollaborationCandidates(TASK_ID);

    expect(response.items).toHaveLength(1);
    expect(requireTaskAccess).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      taskId: TASK_ID,
      action: 'collaboration.candidates',
    });
    expect(listCollaborationCandidates).toHaveBeenCalledWith(TASK_SCOPE);
  });

  it('creates a Collaboration through the trusted execute scope', async () => {
    const createCollaboration = vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: collaborationDetail(),
    });
    const requireTaskAccess = vi.fn().mockResolvedValue(TASK_SCOPE);
    const { service } = createService({
      repository: { createCollaboration },
      authorization: { requireTaskAccess },
    });

    const response = await service.createCollaboration(TASK_ID, CREATE_COLLABORATION);

    expect(response.collaboration.id).toBe(COLLABORATION_ID);
    expect(requireTaskAccess).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      taskId: TASK_ID,
      action: 'collaboration.create',
    });
    expect(createCollaboration).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      scope: TASK_SCOPE,
      request: CREATE_COLLABORATION,
    });
  });

  it('rejects an expired Collaboration deadline before persistence', async () => {
    const createCollaboration = vi.fn();
    const { service } = createService({
      repository: { createCollaboration },
    });

    await expect(
      service.createCollaboration(TASK_ID, {
        ...CREATE_COLLABORATION,
        dueAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(createCollaboration).not.toHaveBeenCalled();
  });

  it('submits Collaboration commands with server-owned actor identity', async () => {
    const applyCollaborationCommand = vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: collaborationDetail(),
    });
    const requireTaskAccess = vi.fn().mockResolvedValue(TASK_SCOPE);
    const { service } = createService({
      repository: { applyCollaborationCommand },
      authorization: { requireTaskAccess },
    });

    await service.submitCollaborationCommand(TASK_ID, COLLABORATION_ID, COMMIT_COLLABORATION);

    expect(requireTaskAccess).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      taskId: TASK_ID,
      action: 'collaboration.command',
    });
    expect(applyCollaborationCommand).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      scope: TASK_SCOPE,
      collaborationId: COLLABORATION_ID,
      request: COMMIT_COLLABORATION,
    });
  });

  it('passes only trusted task scope filters to collaboration reads', async () => {
    const listCollaborations = vi.fn().mockResolvedValue({
      items: [collaboration()],
      nextCursor: 'next',
    });
    const requireTaskAccess = vi.fn().mockResolvedValue(TASK_SCOPE);
    const { service } = createService({
      repository: { listCollaborations },
      authorization: { requireTaskAccess },
    });

    const response = await service.listCollaborations(TASK_ID, ' cursor ');

    expect(response.pageInfo).toEqual({ nextCursor: 'next', hasMore: true });
    expect(requireTaskAccess).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      taskId: TASK_ID,
      action: 'collaboration.list',
    });
    expect(listCollaborations).toHaveBeenCalledWith(TASK_SCOPE, {
      cursor: 'cursor',
      limit: 100,
    });
  });

  it('fails closed if an adapter widens the authorized task scope', async () => {
    const { service } = createService({
      repository: {
        listCollaborations: vi.fn().mockResolvedValue({
          items: [
            collaboration({
              taskId: '00000000-0000-7000-8000-000000000999',
            }),
          ],
          nextCursor: null,
        }),
      },
    });

    await expect(service.listCollaborations(TASK_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an unavailable authorized collaboration to 404', async () => {
    const { service } = createService({
      repository: { findCollaboration: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.getCollaboration(TASK_ID, COLLABORATION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns a complete authorized Collaboration detail', async () => {
    const findCollaboration = vi.fn().mockResolvedValue(collaborationDetail());
    const { service } = createService({
      repository: { findCollaboration },
    });

    const response = await service.getCollaboration(TASK_ID, COLLABORATION_ID);

    expect(response.collaboration.id).toBe(COLLABORATION_ID);
    expect(response.messages).toHaveLength(1);
    expect(findCollaboration).toHaveBeenCalledWith(TASK_SCOPE, COLLABORATION_ID);
  });

  it('returns task-scoped Correction Cases through the authorized filter', async () => {
    const listCorrections = vi.fn().mockResolvedValue({
      items: [correction()],
      nextCursor: null,
    });
    const { service } = createService({
      repository: { listCorrections },
    });

    const response = await service.listCorrections(TASK_ID);

    expect(response.items).toHaveLength(1);
    expect(listCorrections).toHaveBeenCalledWith(TASK_SCOPE, {
      cursor: null,
      limit: 100,
    });
  });

  it('rejects an incoherent authorization scope before querying persistence', async () => {
    const listCorrections = vi.fn();
    const { service } = createService({
      repository: { listCorrections },
      authorization: {
        requireTaskAccess: vi.fn().mockResolvedValue({
          ...TASK_SCOPE,
          taskId: '00000000-0000-7000-8000-000000000999',
        }),
      },
    });

    await expect(service.listCorrections(TASK_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(listCorrections).not.toHaveBeenCalled();
  });

  it('rejects records outside the trusted data-label scope', async () => {
    const { service } = createService({
      repository: {
        listCorrections: vi.fn().mockResolvedValue({
          items: [correction({ permissionLabels: ['confidential'] })],
          nextCursor: null,
        }),
      },
    });

    await expect(service.listCorrections(TASK_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the trusted actor Role Assignment for correction feedback', async () => {
    const applyCorrectionFeedback = vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: correction({
        status: 'ACKNOWLEDGED',
        revision: 2,
        updatedAt: NEXT_UPDATED_AT,
      }),
    });
    const buildCorrectionFeedbackContext = vi.fn().mockResolvedValue(feedbackContext());
    const { service } = createService({
      repository: { applyCorrectionFeedback },
      authorization: { buildCorrectionFeedbackContext },
    });

    const response = await service.submitCorrectionFeedback(
      TASK_ID,
      CORRECTION_ID,
      ACKNOWLEDGE_FEEDBACK,
    );

    expect(response.status).toBe('ACKNOWLEDGED');
    expect(buildCorrectionFeedbackContext).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      scope: TASK_SCOPE,
      correction: correction(),
      feedback: ACKNOWLEDGE_FEEDBACK,
    });
    expect(applyCorrectionFeedback).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      scope: TASK_SCOPE,
      correctionId: CORRECTION_ID,
      trustedActorRoleAssignmentId: ROLE_ASSIGNMENT_ID,
      nextStatus: 'ACKNOWLEDGED',
      feedback: ACKNOWLEDGE_FEEDBACK,
    });
  });

  it('maps stale feedback to 409 without writing a feedback record', async () => {
    const applyCorrectionFeedback = vi.fn();
    const { service } = createService({
      repository: { applyCorrectionFeedback },
    });

    await expect(
      service.submitCorrectionFeedback(TASK_ID, CORRECTION_ID, {
        ...ACKNOWLEDGE_FEEDBACK,
        expectedRevision: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(applyCorrectionFeedback).not.toHaveBeenCalled();
  });

  it('maps illegal correction transitions to 422', async () => {
    const applyCorrectionFeedback = vi.fn();
    const { service } = createService({
      repository: {
        findCorrectionForFeedback: vi.fn().mockResolvedValue(correction({ status: 'RESOLVED' })),
        applyCorrectionFeedback,
      },
    });

    await expect(
      service.submitCorrectionFeedback(TASK_ID, CORRECTION_ID, ACKNOWLEDGE_FEEDBACK),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(applyCorrectionFeedback).not.toHaveBeenCalled();
  });

  it('denies an actor context without a trusted active Role Assignment', async () => {
    const { service } = createService({
      authorization: {
        buildCorrectionFeedbackContext: vi.fn().mockResolvedValue({
          ...feedbackContext(),
          actor: {
            type: 'USER',
            tenantId: TENANT_ID,
            userId: USER_ID,
            roleAssignment: null,
          },
        }),
      },
    });

    await expect(
      service.submitCorrectionFeedback(TASK_ID, CORRECTION_ID, ACKNOWLEDGE_FEEDBACK),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps an atomic repository idempotency collision to 409', async () => {
    const { service } = createService({
      repository: {
        applyCorrectionFeedback: vi.fn().mockResolvedValue({ kind: 'IDEMPOTENCY_CONFLICT' }),
      },
    });

    await expect(
      service.submitCorrectionFeedback(TASK_ID, CORRECTION_ID, ACKNOWLEDGE_FEEDBACK),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

function feedbackContext() {
  return {
    actor: {
      type: 'USER' as const,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleAssignment: {
        id: ROLE_ASSIGNMENT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'ACTIVE' as const,
        employmentStatus: 'ACTIVE' as const,
        orgUnitStatus: 'ACTIVE' as const,
        roleVersionStatus: 'PUBLISHED' as const,
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: null,
      },
    },
    subjectRoleAssignment: {
      id: ROLE_ASSIGNMENT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
    },
    evidence: [],
    now: new Date(NEXT_UPDATED_AT),
  };
}

function createService(input: {
  readonly repository?: Partial<CollaborationCorrectionRepository>;
  readonly authorization?: Partial<CollaborationCorrectionAuthorizationPort>;
}) {
  const repository = {
    listCollaborationCandidates: vi.fn().mockResolvedValue([]),
    createCollaboration: vi.fn(),
    applyCollaborationCommand: vi.fn(),
    listCollaborations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findCollaboration: vi.fn().mockResolvedValue(collaborationDetail()),
    listCorrections: vi.fn().mockResolvedValue({ items: [correction()], nextCursor: null }),
    findCorrectionForFeedback: vi.fn().mockResolvedValue(correction()),
    applyCorrectionFeedback: vi.fn(),
    ...input.repository,
  } as unknown as CollaborationCorrectionRepository;
  const authorization = {
    requireTaskAccess: vi.fn().mockResolvedValue(TASK_SCOPE),
    buildCorrectionFeedbackContext: vi.fn().mockResolvedValue(feedbackContext()),
    ...input.authorization,
  } as unknown as CollaborationCorrectionAuthorizationPort;
  const identity = {
    current: () => ADMIN_PRINCIPAL,
  } as RuntimeIdentityPort;
  return {
    service: new CollaborationCorrectionService(repository, authorization, identity),
    repository,
    authorization,
  };
}
