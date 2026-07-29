import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  collaborationCandidateListSchema,
  collaborationDetailResponseSchema,
  collaborationListResponseSchema,
  correctionCaseListResponseSchema,
  correctionCaseSchema,
} from '@enterprise/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  COLLABORATION_ID,
  CORRECTION_ID,
  NEXT_UPDATED_AT,
  TASK_ID,
  collaboration,
  collaborationDetail,
  correction,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import { CollaborationCorrectionController } from './collaboration-correction.controller.js';
import { CollaborationCorrectionService } from './collaboration-correction.service.js';

const FEEDBACK_REQUEST = {
  expectedRevision: 1,
  action: 'ACKNOWLEDGE',
  comment: 'I will provide the missing approval.',
  evidenceIds: [],
  effectiveAt: NEXT_UPDATED_AT,
  idempotencyKey: 'correction:acknowledge:1',
} as const;

const ROLE_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000006';
const RECIPIENT_ROLE_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000099';
const USER_ID = '00000000-0000-7000-8000-000000000002';

const CREATE_REQUEST = {
  actingRoleAssignmentId: ROLE_ASSIGNMENT_ID,
  recipientRoleAssignmentIds: [RECIPIENT_ROLE_ASSIGNMENT_ID],
  background: 'Customer knowledge accuracy is below target.',
  commonGoal: 'Restore the customer knowledge accuracy target.',
  requestedInput: 'Provide a sealed regression report.',
  expectedOutputSchema: { type: 'object', required: ['reportUri'] },
  dueAt: '2099-07-29T05:00:00.000Z',
  contextRefs: [{ type: 'TASK', id: TASK_ID, version: 1 }],
  idempotencyKey: 'collaboration:create:1',
} as const;

const COMMIT_REQUEST = {
  expectedRevision: 1,
  type: 'COMMIT',
  payload: {
    committedDueAt: '2099-07-29T05:00:00.000Z',
    outputSchema: { type: 'object', required: ['reportUri'] },
    conditions: [],
  },
  idempotencyKey: 'collaboration:commit:2',
} as const;

describe('CollaborationCorrectionController', () => {
  let app: INestApplication;
  const listCollaborationCandidates = vi.fn();
  const createCollaboration = vi.fn();
  const submitCollaborationCommand = vi.fn();
  const listCollaborations = vi.fn();
  const getCollaboration = vi.fn();
  const listCorrections = vi.fn();
  const submitCorrectionFeedback = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CollaborationCorrectionController],
      providers: [
        {
          provide: CollaborationCorrectionService,
          useValue: {
            listCollaborationCandidates,
            createCollaboration,
            submitCollaborationCommand,
            listCollaborations,
            getCollaboration,
            listCorrections,
            submitCorrectionFeedback,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes server-resolved Collaboration candidates', async () => {
    listCollaborationCandidates.mockResolvedValueOnce({
      items: [
        {
          roleAssignmentId: ROLE_ASSIGNMENT_ID,
          userId: USER_ID,
          userName: 'Runtime Owner',
          roleName: 'Customer Success Owner',
          orgUnitName: 'Customer Success',
          canActAsRequester: true,
        },
      ],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/workbench/tasks/${TASK_ID}/collaboration-candidates`)
      .expect(200);

    expect(collaborationCandidateListSchema.parse(response.body).items).toHaveLength(1);
    expect(listCollaborationCandidates).toHaveBeenCalledWith(TASK_ID);
  });

  it('creates a Collaboration without accepting a request-controlled sender identity', async () => {
    createCollaboration.mockResolvedValueOnce(collaborationDetail());

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${TASK_ID}/collaborations`)
      .send(CREATE_REQUEST)
      .expect(201);

    expect(collaborationDetailResponseSchema.parse(response.body).collaboration.id).toBe(
      COLLABORATION_ID,
    );
    expect(createCollaboration).toHaveBeenCalledWith(TASK_ID, CREATE_REQUEST);

    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${TASK_ID}/collaborations`)
      .send({ ...CREATE_REQUEST, senderUserId: USER_ID })
      .expect(400);
  });

  it('submits a structured Collaboration command', async () => {
    submitCollaborationCommand.mockResolvedValueOnce(collaborationDetail());

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${TASK_ID}/collaborations/${COLLABORATION_ID}/commands`)
      .send(COMMIT_REQUEST)
      .expect(201);

    expect(collaborationDetailResponseSchema.parse(response.body).messages).toHaveLength(1);
    expect(submitCollaborationCommand).toHaveBeenCalledWith(
      TASK_ID,
      COLLABORATION_ID,
      COMMIT_REQUEST,
    );
  });

  it('exposes the task-scoped Collaboration list endpoint', async () => {
    listCollaborations.mockResolvedValueOnce({
      items: [collaboration()],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/workbench/tasks/${TASK_ID}/collaborations?cursor=opaque`)
      .expect(200);

    expect(collaborationListResponseSchema.parse(response.body).items).toHaveLength(1);
    expect(listCollaborations).toHaveBeenCalledWith(TASK_ID, 'opaque');
  });

  it('exposes a complete task-scoped Collaboration trace', async () => {
    getCollaboration.mockResolvedValueOnce(collaborationDetail());

    const response = await request(app.getHttpServer())
      .get(`/api/v1/workbench/tasks/${TASK_ID}/collaborations/${COLLABORATION_ID}`)
      .expect(200);

    expect(collaborationDetailResponseSchema.parse(response.body).collaboration.id).toBe(
      COLLABORATION_ID,
    );
    expect(getCollaboration).toHaveBeenCalledWith(TASK_ID, COLLABORATION_ID);
  });

  it('exposes the task-scoped Correction Case list endpoint', async () => {
    listCorrections.mockResolvedValueOnce({
      items: [correction()],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/workbench/tasks/${TASK_ID}/corrections`)
      .expect(200);

    expect(correctionCaseListResponseSchema.parse(response.body).items).toHaveLength(1);
    expect(listCorrections).toHaveBeenCalledWith(TASK_ID, undefined);
  });

  it('accepts correction feedback without any request-controlled actor ID', async () => {
    submitCorrectionFeedback.mockResolvedValueOnce(
      correction({
        status: 'ACKNOWLEDGED',
        revision: 2,
        updatedAt: NEXT_UPDATED_AT,
      }),
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${TASK_ID}/corrections/${CORRECTION_ID}/feedback`)
      .send(FEEDBACK_REQUEST)
      .expect(201);

    expect(correctionCaseSchema.parse(response.body).status).toBe('ACKNOWLEDGED');
    expect(submitCorrectionFeedback).toHaveBeenCalledWith(TASK_ID, CORRECTION_ID, FEEDBACK_REQUEST);
  });

  it('rejects a request-controlled correction actor identity', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${TASK_ID}/corrections/${CORRECTION_ID}/feedback`)
      .send({
        ...FEEDBACK_REQUEST,
        actorRoleAssignmentId: '00000000-0000-7000-8000-000000000999',
      })
      .expect(400);
  });
});
