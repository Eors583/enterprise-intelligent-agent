import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AdminToolGatewayController,
  WorkbenchAvailableToolsController,
  WorkbenchToolApprovalsController,
  WorkbenchToolGatewayController,
} from './tool-gateway.controller.js';
import { ToolGatewayService } from './tool-gateway.service.js';

const TOOL_ID = '00000000-0000-7000-8000-000000000201';
const VERSION_ID = '00000000-0000-7000-8000-000000000202';
const TASK_ID = '00000000-0000-7000-8000-000000000203';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000204';
const INVOCATION_ID = '00000000-0000-7000-8000-000000000205';

describe('Tool Gateway controllers', () => {
  let app: INestApplication;
  const service = {
    listDefinitions: vi.fn(),
    listAvailableTools: vi.fn(),
    listReviewableInvocations: vi.fn(),
    getDefinition: vi.fn(),
    createDefinition: vi.fn(),
    createVersion: vi.fn(),
    transitionVersion: vi.fn(),
    listInvocations: vi.fn(),
    getInvocation: vi.fn(),
    createInvocation: vi.fn(),
    createCompensation: vi.fn(),
    decideInvocation: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        AdminToolGatewayController,
        WorkbenchAvailableToolsController,
        WorkbenchToolApprovalsController,
        WorkbenchToolGatewayController,
      ],
      providers: [{ provide: ToolGatewayService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('registers a Tool Definition without a request-controlled tenant', async () => {
    service.createDefinition.mockResolvedValueOnce({ id: TOOL_ID });
    await request(app.getHttpServer())
      .post('/api/v1/admin/tool-definitions')
      .send({
        key: 'crm.customer.read',
        name: 'Read customer',
        description: 'Read a customer through the governed gateway.',
        permissionLabels: ['crm.read'],
        idempotencyKey: 'tool-definition-1',
      })
      .expect(201);
    expect(service.createDefinition).toHaveBeenCalledWith(
      expect.not.objectContaining({ tenantId: expect.anything() }),
    );
  });

  it('registers a closed-schema Tool Version and lifecycle transition', async () => {
    service.createVersion.mockResolvedValueOnce({ id: VERSION_ID });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/tool-definitions/${TOOL_ID}/versions`)
      .send(toolVersionRequest())
      .expect(201);
    expect(service.createVersion).toHaveBeenCalledWith(TOOL_ID, toolVersionRequest());

    service.transitionVersion.mockResolvedValueOnce({ definition: { id: TOOL_ID } });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/tool-definitions/${TOOL_ID}/versions/${VERSION_ID}/lifecycle`)
      .send({
        action: 'TEST',
        expectedDefinitionRevision: 1,
        reason: 'Move the immutable draft into the test gate.',
        idempotencyKey: 'tool-test-1',
      })
      .expect(201);
  });

  it('creates a Tool Invocation without accepting requester or Assignment identity', async () => {
    service.createInvocation.mockResolvedValueOnce({ id: INVOCATION_ID });
    const body = invocationRequest();
    await request(app.getHttpServer())
      .post('/api/v1/workbench/tool-invocations')
      .send(body)
      .expect(201);
    expect(service.createInvocation).toHaveBeenCalledWith(body);

    await request(app.getHttpServer())
      .post('/api/v1/workbench/tool-invocations')
      .send({
        ...body,
        requesterUserId: '00000000-0000-7000-8000-000000000999',
      })
      .expect(400);
  });

  it('discovers task-scoped tools without accepting actor identity in the query', async () => {
    service.listAvailableTools.mockResolvedValueOnce({ items: [] });
    await request(app.getHttpServer())
      .get(`/api/v1/workbench/tools?taskId=${TASK_ID}`)
      .expect(200, { items: [] });
    expect(service.listAvailableTools).toHaveBeenCalledWith(TASK_ID);

    await request(app.getHttpServer())
      .get(`/api/v1/workbench/tools?taskId=${TASK_ID}&requesterUserId=${TOOL_ID}`)
      .expect(200);
    expect(service.listAvailableTools).toHaveBeenLastCalledWith(TASK_ID);

    await request(app.getHttpServer()).get('/api/v1/workbench/tools?taskId=not-a-uuid').expect(400);
  });

  it('lists only task-scoped approvals authorized for the current reviewer', async () => {
    service.listReviewableInvocations.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    await request(app.getHttpServer())
      .get(`/api/v1/workbench/tool-approvals?taskId=${TASK_ID}`)
      .expect(200, { items: [], nextCursor: null });
    expect(service.listReviewableInvocations).toHaveBeenCalledWith(TASK_ID);

    await request(app.getHttpServer())
      .get('/api/v1/workbench/tool-approvals?taskId=not-a-uuid')
      .expect(400);
  });

  it('exposes confirmation/approval actions without accepting an actor identity', async () => {
    service.decideInvocation.mockResolvedValueOnce({ id: INVOCATION_ID });
    const decision = {
      expectedRevision: 2,
      action: 'CONFIRM',
      reason: 'I confirm this exact input and policy snapshot.',
      idempotencyKey: 'confirm-1',
    };
    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tool-invocations/${INVOCATION_ID}/actions`)
      .send(decision)
      .expect(201);
    expect(service.decideInvocation).toHaveBeenCalledWith(INVOCATION_ID, decision);

    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tool-invocations/${INVOCATION_ID}/actions`)
      .send({ ...decision, actorRoleAssignmentId: TOOL_ID })
      .expect(400);
  });

  it('requests compensation without accepting provider or Tool binding overrides', async () => {
    const compensation = {
      expectedRevision: 4,
      reason: 'Reverse the immutable completed provider write.',
      idempotencyKey: 'compensate-1',
    };
    service.createCompensation.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000206',
      compensationForInvocationId: INVOCATION_ID,
    });
    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tool-invocations/${INVOCATION_ID}/compensations`)
      .send(compensation)
      .expect(201);
    expect(service.createCompensation).toHaveBeenCalledWith(INVOCATION_ID, compensation);

    await request(app.getHttpServer())
      .post(`/api/v1/workbench/tool-invocations/${INVOCATION_ID}/compensations`)
      .send({
        ...compensation,
        input: { forged: true },
        providerRequestId: 'attacker-request',
      })
      .expect(400);
  });
});

function toolVersionRequest() {
  return {
    name: 'Read customer',
    description: 'Read a customer through a tenant-specific CRM endpoint.',
    adapter: 'HTTP',
    endpointRef: 'secret://tenant/crm/read-customer',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
    riskClass: 'READ_ONLY',
    dataClassification: 'INTERNAL',
    timeoutMs: 5_000,
    maxAttempts: 2,
    idempotencyMode: 'REQUIRED',
    dryRunMode: 'VALIDATE_ONLY',
    allowedHttpMethods: ['GET'],
    allowedHostPatterns: ['crm.example.com'],
    sensitiveInputPaths: [],
    effectiveFrom: '2026-07-28T00:00:00.000Z',
    idempotencyKey: 'tool-version-1',
  };
}

function invocationRequest() {
  return {
    toolVersionId: VERSION_ID,
    taskId: TASK_ID,
    correlationId: CORRELATION_ID,
    dryRun: true,
    input: { customerId: 'customer-1' },
    reason: 'Validate the request without dispatching the provider.',
    idempotencyKey: 'tool-invocation-1',
  };
}
