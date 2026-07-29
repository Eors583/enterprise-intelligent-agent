import { describe, expect, it, vi } from 'vitest';

import type { PreparedToolReconciliation } from '../domain/tool-reconciliation.models.js';
import type { ToolProviderResult } from '../tool-execution.port.js';
import {
  ToolReconciliationWorker,
  validateToolReconciliationProof,
} from './tool-reconciliation.worker.js';

describe('Tool reconciliation proof validation', () => {
  it('publishes an already completed reconciliation event instead of leaving backlog', async () => {
    const invocationId = '00000000-0000-7000-8000-000000000004';
    const queue = {
      claim: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-7000-8000-000000000002',
          tenantId: '00000000-0000-7000-8000-000000000003',
          aggregateId: invocationId,
          eventType: 'ToolInvocation.ReconciliationRequested',
          payload: {
            invocationId,
            expectedRevision: 4,
            idempotencyKey: 'reconcile-4',
          },
          attempts: 2,
          leaseExpiresAt: new Date('2026-07-28T08:01:00.000Z'),
          createdAt: new Date('2026-07-28T08:00:00.000Z'),
        },
      ]),
      markProcessed: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(),
    };
    const repository = {
      prepare: vi.fn().mockResolvedValue({
        kind: 'already_completed',
        providerRequestId: 'tool-provider:invocation-1',
        outcome: 'inconclusive',
        reasonCode: 'TOOL_RECONCILIATION_PENDING',
      }),
      complete: vi.fn(),
    };
    const worker = new ToolReconciliationWorker(
      {
        get: (key: string) =>
          ({
            TOOL_EXECUTION_WORKER_ENABLED: true,
            TOOL_EXECUTION_WORKER_CONCURRENCY: 1,
            TOOL_EXECUTION_POLL_INTERVAL_MS: 1_000,
            TOOL_EXECUTION_CLAIM_TTL_MS: 30_000,
          })[key],
      } as never,
      queue as never,
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(queue.markProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: '00000000-0000-7000-8000-000000000002',
        outcome: 'inconclusive',
      }),
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('uses a pinned GET status endpoint and never sends the original Tool input', async () => {
    const prepared = reconciliation();
    const queue = {
      claim: vi.fn().mockResolvedValue([claimedEvent(prepared)]),
      markProcessed: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(),
    };
    const repository = {
      prepare: vi.fn().mockResolvedValue({ kind: 'ready', reconciliation: prepared }),
      complete: vi.fn().mockResolvedValue({
        invocationStatus: 'UNKNOWN',
        invocationRevision: 4,
        outcome: 'inconclusive',
        reasonCode: 'TOOL_RECONCILIATION_PENDING',
      }),
    };
    const endpointResolver = {
      resolve: vi.fn().mockResolvedValue({
        url: 'https://api.example.com/status',
        method: 'GET',
        headers: { authorization: 'Bearer server-only' },
        signingSecret: 'server-only-signing-key',
      }),
    };
    const dnsResolver = {
      resolve: vi.fn().mockResolvedValue({
        hostname: 'api.example.com',
        addresses: ['93.184.216.34'],
        resolverName: 'trusted-dns',
        ttlSeconds: 60,
        resolvedAt: new Date('2026-07-28T00:00:00.000Z'),
        expiresAt: new Date('2099-07-28T00:01:00.000Z'),
      }),
    };
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(
        providerResult({
          schemaVersion: 1,
          ...proofBinding(),
          proofType: 'STATUS',
          proofId: 'status:pending',
          observedAt: '2026-07-28T08:00:01.000Z',
          outcome: 'PENDING',
        }),
      ),
    };
    const execution = { recordDnsProof: vi.fn().mockResolvedValue(undefined) };
    const worker = new ToolReconciliationWorker(
      workerConfig(),
      queue as never,
      repository as never,
      execution as never,
      endpointResolver as never,
      dnsResolver as never,
      dispatcher as never,
    );

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(endpointResolver.resolve).toHaveBeenCalledWith('crm.customer.reconcile');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestId: prepared.providerRequestId,
        idempotencyKey: prepared.providerRequestId,
        endpoint: expect.objectContaining({ method: 'GET' }),
        input: {
          operation: 'STATUS',
          providerRequestId: prepared.providerRequestId,
          tenantId: prepared.tenantId,
          toolVersionId: prepared.toolVersionId,
          inputHash: prepared.inputHash,
        },
      }),
    );
    expect(dispatcher.dispatch.mock.calls[0]?.[0]).not.toHaveProperty('input.customerId');
    expect(repository.complete).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({ kind: 'INCONCLUSIVE' }),
    );
  });

  it('accepts a bound status proof for an eligible invocation', () => {
    const result = validateToolReconciliationProof(
      reconciliation(),
      providerResult({
        schemaVersion: 1,
        ...proofBinding(),
        proofType: 'STATUS',
        proofId: 'status:42',
        observedAt: '2026-07-28T08:00:01.000Z',
        outcome: 'SUCCEEDED',
        output: { customerId: 'customer-1' },
      }),
    );
    expect(result).toMatchObject({
      kind: 'SUCCEEDED',
      reasonCode: 'TOOL_RECONCILIATION_PROVED_SUCCEEDED',
      output: { customerId: 'customer-1' },
    });
  });

  it('keeps UNKNOWN when the proof request id is not the original fixed id', () => {
    const result = validateToolReconciliationProof(
      reconciliation(),
      providerResult({
        schemaVersion: 1,
        ...proofBinding(),
        providerRequestId: 'different-request',
        proofType: 'STATUS',
        proofId: 'status:42',
        observedAt: '2026-07-28T08:00:01.000Z',
        outcome: 'FAILED',
        errorCode: 'PROVIDER_REJECTED',
      }),
    );
    expect(result).toMatchObject({
      kind: 'INCONCLUSIVE',
      reasonCode: 'TOOL_RECONCILIATION_PROOF_INVALID',
    });
  });

  it('never resolves an ineligible side effect even with a success-shaped response', () => {
    const result = validateToolReconciliationProof(
      reconciliation({ eligibility: 'INELIGIBLE', riskClass: 'CONFIRM_REQUIRED' }),
      providerResult({
        schemaVersion: 1,
        ...proofBinding(),
        proofType: 'IDEMPOTENT_REPLAY',
        proofId: 'replay:42',
        observedAt: '2026-07-28T08:00:01.000Z',
        outcome: 'SUCCEEDED',
        output: { customerId: 'customer-1' },
      }),
    );
    expect(result.kind).toBe('INCONCLUSIVE');
  });

  it('rejects a claimed success that violates the immutable output schema', () => {
    const result = validateToolReconciliationProof(
      reconciliation(),
      providerResult({
        schemaVersion: 1,
        ...proofBinding(),
        proofType: 'STATUS',
        proofId: 'status:42',
        observedAt: '2026-07-28T08:00:01.000Z',
        outcome: 'SUCCEEDED',
        output: { unexpected: true },
      }),
    );
    expect(result).toMatchObject({
      kind: 'INCONCLUSIVE',
      reasonCode: 'TOOL_RECONCILIATION_OUTPUT_INVALID',
    });
  });

  it.each([
    {
      name: 'pending',
      result: providerResult({
        schemaVersion: 1,
        ...proofBinding(),
        proofType: 'STATUS',
        proofId: 'status:pending',
        observedAt: '2026-07-28T08:00:01.000Z',
        outcome: 'PENDING',
      }),
    },
    {
      name: '404',
      result: providerFailure('TOOL_PROVIDER_HTTP_404'),
    },
    {
      name: 'timeout',
      result: providerFailure('TOOL_PROVIDER_TIMEOUT', 'UNKNOWN'),
    },
  ])('keeps UNKNOWN for $name status lookup', ({ result }) => {
    expect(validateToolReconciliationProof(reconciliation(), result).kind).toBe('INCONCLUSIVE');
  });

  it('rejects proof bound to another tenant, Tool Version, or input hash', () => {
    for (const mismatch of [
      { tenantId: '00000000-0000-7000-8000-000000000099' },
      { toolVersionId: '00000000-0000-7000-8000-000000000098' },
      { inputHash: 'b'.repeat(64) },
    ]) {
      const result = validateToolReconciliationProof(
        reconciliation(),
        providerResult({
          schemaVersion: 1,
          ...proofBinding(),
          ...mismatch,
          proofType: 'STATUS',
          proofId: 'status:bound',
          observedAt: '2026-07-28T08:00:01.000Z',
          outcome: 'FAILED',
          errorCode: 'PROVIDER_REJECTED',
        }),
      );
      expect(result.kind).toBe('INCONCLUSIVE');
    }
  });
});

function reconciliation(
  override: Partial<PreparedToolReconciliation> = {},
): PreparedToolReconciliation {
  return {
    attemptId: '00000000-0000-7000-8000-000000000001',
    outboxEventId: '00000000-0000-7000-8000-000000000002',
    tenantId: '00000000-0000-7000-8000-000000000003',
    invocationId: '00000000-0000-7000-8000-000000000004',
    expectedRevision: 4,
    toolVersionId: '00000000-0000-7000-8000-000000000005',
    endpointRef: 'crm.customer',
    riskClass: 'READ_ONLY',
    idempotencyMode: 'SYSTEM_LEDGER',
    eligibility: 'READ_ONLY',
    requesterUserId: '00000000-0000-7000-8000-000000000006',
    roleAssignmentId: '00000000-0000-7000-8000-000000000007',
    taskId: '00000000-0000-7000-8000-000000000008',
    correlationId: '00000000-0000-7000-8000-000000000009',
    providerRequestId: 'tool-provider:invocation-1',
    inputHash: 'a'.repeat(64),
    outputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    allowedHostPatterns: ['api.example.com'],
    startedAt: new Date('2026-07-28T08:00:00.000Z'),
    ...override,
  };
}

function claimedEvent(reconciliation: PreparedToolReconciliation) {
  return {
    id: reconciliation.outboxEventId,
    tenantId: reconciliation.tenantId,
    aggregateId: reconciliation.invocationId,
    eventType: 'ToolInvocation.ReconciliationRequested',
    payload: {
      invocationId: reconciliation.invocationId,
      expectedRevision: reconciliation.expectedRevision,
      idempotencyKey: 'reconcile-4',
    },
    attempts: 1,
    leaseExpiresAt: new Date('2026-07-28T08:01:00.000Z'),
    createdAt: new Date('2026-07-28T08:00:00.000Z'),
  };
}

function workerConfig() {
  return {
    get: (key: string) =>
      ({
        TOOL_EXECUTION_WORKER_ENABLED: true,
        TOOL_EXECUTION_WORKER_CONCURRENCY: 1,
        TOOL_EXECUTION_POLL_INTERVAL_MS: 1_000,
        TOOL_EXECUTION_CLAIM_TTL_MS: 30_000,
      })[key],
  } as never;
}

function proofBinding() {
  return {
    providerRequestId: 'tool-provider:invocation-1',
    tenantId: '00000000-0000-7000-8000-000000000003',
    toolVersionId: '00000000-0000-7000-8000-000000000005',
    inputHash: 'a'.repeat(64),
  };
}

function providerResult(output: Record<string, unknown>): ToolProviderResult {
  return {
    providerRequestId: 'tool-provider:invocation-1',
    outcome: 'SUCCEEDED',
    output,
    errorCode: null,
    errorDetail: null,
    startedAt: new Date('2026-07-28T08:00:00.000Z'),
    completedAt: new Date('2026-07-28T08:00:02.000Z'),
    cost: { kind: 'UNATTESTED' },
  };
}

function providerFailure(
  errorCode: string,
  outcome: ToolProviderResult['outcome'] = 'FAILED',
): ToolProviderResult {
  return {
    providerRequestId: 'tool-provider:invocation-1',
    outcome,
    output: null,
    errorCode,
    errorDetail: 'Status lookup did not return a terminal proof.',
    startedAt: new Date('2026-07-28T08:00:00.000Z'),
    completedAt: new Date('2026-07-28T08:00:02.000Z'),
    cost: { kind: 'UNATTESTED' },
  };
}
