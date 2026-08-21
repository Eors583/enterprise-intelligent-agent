import { vi } from 'vitest';

import { AiModelConnectivityProbeService } from './ai-model-connectivity-probe.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';
const RUN_ID = '00000000-0000-7000-8000-000000000701';
const EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000801';
const CATALOG_ID = '00000000-0000-7000-8000-000000000401';

describe('AiModelConnectivityProbeService', () => {
  it('uses the normal preparation boundary and persists a real successful attempt receipt', async () => {
    const harness = createHarness();

    const result = await harness.service.run({ idempotencyKey: 'probe-once' });

    expect(harness.runs.prepare).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(harness.runtime.create).toHaveBeenCalledTimes(1);
    expect(harness.runtime.execute).toHaveBeenCalledTimes(1);
    const controlledRun = harness.runtime.create.mock.calls[0]?.[0];
    expect(controlledRun?.modelRoute?.candidates).toHaveLength(1);
    expect(controlledRun?.modelRoute?.candidates[0]?.catalogVersionId).toBe(CATALOG_ID);
    expect(harness.runs.recordModelExecutionEvidence).toHaveBeenCalledTimes(1);
    expect(harness.runs.completeSucceeded).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      runId: RUN_ID,
      targetCatalogVersionId: CATALOG_ID,
      status: 'SUCCEEDED',
      evidenceStatus: 'VERIFIED',
      reasonCode: null,
    });
    expect(harness.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'ai.model.connectivity_probe.completed',
          resourceId: RUN_ID,
        }),
      }),
    );
  });

  it('does not call Runtime when normal quota/concurrency preparation defers the probe', async () => {
    const harness = createHarness({
      preparation: { kind: 'deferred', reasonCode: 'TENANT_CONCURRENCY_LIMIT' },
    });

    const result = await harness.service.run({ idempotencyKey: 'probe-quota-blocked' });

    expect(harness.runtime.create).not.toHaveBeenCalled();
    expect(harness.runs.completeFailed).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      'TENANT_CONCURRENCY_LIMIT',
      expect.stringContaining('quota or concurrency'),
    );
    expect(result.status).toBe('FAILED');
    expect(result.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('keeps the controlled conversation active while an UNKNOWN result awaits reconciliation', async () => {
    const harness = createHarness({
      preparation: { kind: 'ambiguous_dispatch' },
    });

    const result = await harness.service.run({ idempotencyKey: 'probe-awaiting-reconciliation' });

    expect(harness.runs.completeUnknown).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      'CONNECTIVITY_PROBE_AMBIGUOUS_DISPATCH',
    );
    expect(result.status).toBe('UNKNOWN');
    expect(harness.participantsUpdate).not.toHaveBeenCalled();
  });

  it('fails preparation errors without leaving a false ambiguous provider result', async () => {
    const harness = createHarness();
    harness.runs.prepare.mockRejectedValueOnce(new Error('retrieval unavailable'));

    const result = await harness.service.run({ idempotencyKey: 'probe-preparation-failed' });

    expect(harness.runs.completeFailed).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      'CONNECTIVITY_PROBE_PREPARATION_FAILED',
      expect.stringContaining('could not prepare'),
    );
    expect(harness.runs.completeUnknown).not.toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
  });
});

function createHarness(options?: {
  readonly preparation?:
    | {
        readonly kind: 'deferred';
        readonly reasonCode: string;
      }
    | { readonly kind: 'ambiguous_dispatch' };
}) {
  let runStatus:
    'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED' =
    'QUEUED';
  let runErrorCode: string | null = null;
  let receiptRecorded = false;
  const auditCreate = vi.fn().mockResolvedValue({});
  const participantsUpdate = vi.fn().mockResolvedValue({ count: 2 });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    agentRun: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          id: RUN_ID,
          agentId: AGENT_ID,
          status: runStatus,
        })
        .mockImplementation(() => Promise.resolve({ status: runStatus, errorCode: runErrorCode })),
    },
    aiModelConnectivityProbe: {
      findFirst: vi.fn().mockResolvedValue({ targetCatalogVersionId: CATALOG_ID }),
    },
    aiModelAttemptReceipt: {
      findMany: vi.fn(() =>
        Promise.resolve(receiptRecorded ? [{ catalogVersionId: CATALOG_ID }] : []),
      ),
    },
    auditEvent: { create: auditCreate },
    conversationParticipant: { updateMany: participantsUpdate },
  };
  const prisma = {
    enabled: true,
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => Promise<unknown>) =>
      operation(transaction),
    ),
  };
  const readyPreparation = {
    kind: 'ready' as const,
    run: {
      id: RUN_ID,
      tenantId: TENANT_ID,
      conversationId: '00000000-0000-7000-8000-000000000601',
      requesterUserId: USER_ID,
      requesterRole: 'ADMIN',
      agentId: AGENT_ID,
      agentName: 'Probe Agent',
      agentVersionId: '00000000-0000-7000-8000-000000000202',
      agentVersion: 1,
      systemPrompt: 'Be concise.',
      externalRunId: null,
      turnIndex: 1,
      turnLimit: 1,
      maxInputTokens: 16_000,
      maxOutputTokens: 4_000,
      messages: [
        {
          senderType: 'USER' as const,
          senderId: USER_ID,
          senderName: 'Admin',
          text: 'MODEL_CONNECTIVITY_OK',
        },
      ],
      modelRoute: {
        schemaVersion: 1 as const,
        policyVersionId: '00000000-0000-7000-8000-000000000301',
        policyVersion: 1,
        policyHash: 'a'.repeat(64),
        taskClass: 'GENERAL_QA',
        maximumClassification: 'INTERNAL' as const,
        requiredCapabilities: ['chat'],
        maximumAttempts: 2,
        circuitFailureThreshold: 5,
        circuitOpenSeconds: 60,
        candidates: [
          {
            ordinal: 1,
            catalogVersionId: CATALOG_ID,
            routeKey: 'GENERAL.PRIMARY',
            provider: 'OPENAI_COMPATIBLE' as const,
            model: 'model-a',
            credentialReference: 'vault://model-a',
          },
          {
            ordinal: 2,
            catalogVersionId: '00000000-0000-7000-8000-000000000402',
            routeKey: 'GENERAL.FALLBACK',
            provider: 'OPENAI_COMPATIBLE' as const,
            model: 'model-b',
            credentialReference: 'vault://model-b',
          },
        ],
      },
    },
  };
  const runs = {
    prepare: vi.fn().mockResolvedValue(options?.preparation ?? readyPreparation),
    attachExternalRun: vi.fn().mockImplementation(() => {
      runStatus = 'RUNNING';
      return Promise.resolve('attached');
    }),
    recordModelExecutionEvidence: vi.fn().mockImplementation(() => {
      receiptRecorded = true;
      return Promise.resolve();
    }),
    completeSucceeded: vi.fn().mockImplementation(() => {
      runStatus = 'SUCCEEDED';
      runErrorCode = null;
      return Promise.resolve({ outputMessageId: USER_ID, externalRunId: EXTERNAL_RUN_ID });
    }),
    completeFailed: vi
      .fn()
      .mockImplementation((_tenantId: string, _runId: string, errorCode: string) => {
        runStatus = 'FAILED';
        runErrorCode = errorCode;
        return Promise.resolve();
      }),
    completeUnknown: vi
      .fn()
      .mockImplementation((_tenantId: string, _runId: string, errorCode: string) => {
        runStatus = 'UNKNOWN';
        runErrorCode = errorCode;
        return Promise.resolve();
      }),
  };
  const attempt = {
    attemptNumber: 1,
    catalogVersionId: CATALOG_ID,
    routeKey: 'GENERAL.PRIMARY',
    provider: 'OPENAI_COMPATIBLE' as const,
    model: 'model-a',
    outcome: 'SUCCEEDED' as const,
    reasonCode: null,
    retrySafe: false,
    startedAt: new Date(),
    finishedAt: new Date(),
  };
  const runtime = {
    create: vi.fn().mockResolvedValue({ runId: EXTERNAL_RUN_ID, status: 'queued' }),
    execute: vi.fn().mockResolvedValue({
      runId: EXTERNAL_RUN_ID,
      status: 'succeeded',
      output: { content: 'MODEL_CONNECTIVITY_OK', provider: 'provider', model: 'model-a' },
      modelAttempts: [attempt],
    }),
  };
  const service = new AiModelConnectivityProbeService(
    prisma as never,
    {
      requireDirectoryWrite: vi.fn().mockReturnValue({
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: 'ADMIN',
      }),
    } as never,
    runs as never,
    runtime as never,
  );
  return { service, runs, runtime, auditCreate, participantsUpdate };
}
