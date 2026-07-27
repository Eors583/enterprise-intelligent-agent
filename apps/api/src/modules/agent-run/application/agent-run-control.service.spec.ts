import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../database/prisma.service.js';
import type { IdentityService } from '../../identity/application/identity.service.js';
import type { AgentRuntimeClient } from '../domain/agent-runtime.client.js';
import { AgentRunControlService } from './agent-run-control.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000003';
const RUN_ID = '00000000-0000-7000-8000-000000000004';
const EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000005';

describe('AgentRunControlService cancellation', () => {
  it('keeps a running Run and its reservation when Runtime cancellation is not confirmed', async () => {
    const fixture = createFixture();
    fixture.runtime.cancel.mockRejectedValue(new Error('runtime unavailable'));

    await expect(fixture.service.cancel(CONVERSATION_ID, RUN_ID)).rejects.toMatchObject({
      status: 503,
    });
    expect(fixture.transaction.agentRun.update).not.toHaveBeenCalled();
  });

  it('persists CANCELLED only after Runtime confirmation and retains an unverified token hold', async () => {
    const fixture = createFixture();
    fixture.runtime.cancel.mockResolvedValue({
      runId: EXTERNAL_RUN_ID,
      status: 'cancelled',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        costMicros: 0,
        tokensReported: false,
        costReported: false,
      },
    });

    await expect(fixture.service.cancel(CONVERSATION_ID, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'cancelled',
    });
    expect(fixture.transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({ status: 'CANCELLED', toolCalls: 0 }),
    });
    const update = fixture.transaction.agentRun.update.mock.calls[0]?.[0];
    expect(update?.data).not.toHaveProperty('reservedTokens');
    expect(update?.data).not.toHaveProperty('usageRecordedAt');
  });
});

function createFixture() {
  const run = {
    id: RUN_ID,
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    status: 'RUNNING',
    externalRunId: EXTERNAL_RUN_ID,
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    agentRun: {
      findFirst: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue(run),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      user: { id: USER_ID, tenantId: TENANT_ID },
    }),
  };
  const runtime = {
    cancel: vi.fn(),
  };
  return {
    service: new AgentRunControlService(
      prisma as unknown as PrismaService,
      identity as unknown as IdentityService,
      runtime as unknown as AgentRuntimeClient,
    ),
    transaction,
    runtime,
  };
}
