import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/environment.js';
import type {
  ResolvedToolEndpoint,
  ToolProviderRequest,
  ToolProviderResult,
  TrustedDnsResolution,
} from '../tool-execution.port.js';
import {
  ToolDnsResolverPort,
  ToolEndpointResolverPort,
  ToolProviderDispatcherPort,
} from '../tool-execution.port.js';
import { ToolExecutionQueueRepository } from '../domain/tool-execution-queue.repository.js';
import { ToolExecutionRepository } from '../domain/tool-execution.repository.js';
import type {
  ClaimedToolExecutionEvent,
  ParsedToolCommandEvent,
  PreparedToolExecution,
  ToolDnsProofInput,
  ToolExecutionInspection,
  ToolExecutionSettlement,
  ToolExecutionStartResult,
} from '../domain/tool-execution.models.js';
import type { PreparedHttpTarget } from '../tool-execution.port.js';
import { ToolExecutionCircuitBreaker } from './tool-execution-circuit-breaker.js';
import { ToolExecutionWorker } from './tool-execution.worker.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const INVOCATION_ID = '00000000-0000-7000-8000-000000000201';
const VERSION_ID = '00000000-0000-7000-8000-000000000202';
const COMMAND_ID = '00000000-0000-7000-8000-000000000203';

describe('ToolExecutionWorker', () => {
  it('dispatches once with the bound employee/Role identity and persists a trusted success', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const repository = new FakeExecutionRepository({
      kind: 'ready',
      execution: execution({ status: 'APPROVED', revision: 2 }),
    });
    const dispatcher = new FakeDispatcher({
      providerRequestId: `tool-provider:${INVOCATION_ID}`,
      outcome: 'SUCCEEDED',
      output: { customerName: 'Blue Ocean' },
      errorCode: null,
      errorDetail: null,
      startedAt: new Date('2026-07-28T00:00:01.000Z'),
      completedAt: new Date('2026-07-28T00:00:01.125Z'),
      cost: { kind: 'PROVIDER_ATTESTED', costMicros: 12n },
    });
    const worker = createWorker(queue, repository, dispatcher);

    expect(await worker.runOnce()).toBe(1);

    expect(dispatcher.requests).toHaveLength(1);
    expect(dispatcher.requests[0]).toMatchObject({
      tenantId: TENANT_ID,
      requesterUserId: '00000000-0000-7000-8000-000000000101',
      roleAssignmentId: '00000000-0000-7000-8000-000000000301',
      taskId: '00000000-0000-7000-8000-000000000401',
      providerRequestId: `tool-provider:${INVOCATION_ID}`,
    });
    expect(repository.dnsProofs).toHaveLength(1);
    expect(repository.settlements[0]?.settlement).toMatchObject({
      outcome: 'SUCCEEDED',
      output: { customerName: 'Blue Ocean' },
    });
    expect(queue.published[0]).toMatchObject({
      outcome: 'executed',
      reasonCode: 'TOOL_PROVIDER_SUCCEEDED',
    });
  });

  it('never redispatches an ambiguous recovered execution and requires reconciliation', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const recovered = execution({ status: 'EXECUTING', revision: 3 });
    const repository = new FakeExecutionRepository({
      kind: 'ambiguous_dispatch',
      execution: recovered,
      reasonCode: 'TOOL_PROVIDER_DISPATCH_AMBIGUOUS',
    });
    const dispatcher = new FakeDispatcher(successResult());
    const worker = createWorker(queue, repository, dispatcher);

    await worker.runOnce();

    expect(repository.ambiguous).toEqual([recovered]);
    expect(dispatcher.requests).toHaveLength(0);
    expect(queue.unknown[0]).toMatchObject({
      reasonCode: 'TOOL_PROVIDER_DISPATCH_AMBIGUOUS',
    });
  });

  it('does not acknowledge an ambiguous Outbox delivery when the Invocation CAS was lost', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const repository = new FakeExecutionRepository(
      {
        kind: 'ambiguous_dispatch',
        execution: execution({ status: 'EXECUTING', revision: 3 }),
        reasonCode: 'TOOL_PROVIDER_DISPATCH_AMBIGUOUS',
      },
      { ambiguousTransitionApplied: false },
    );
    const worker = createWorker(queue, repository, new FakeDispatcher(successResult()));

    await worker.runOnce();

    expect(queue.unknown).toHaveLength(0);
  });

  it('marks a provider schema violation UNKNOWN instead of enabling a blind retry', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const repository = new FakeExecutionRepository({
      kind: 'ready',
      execution: execution({ status: 'APPROVED', revision: 2 }),
    });
    const dispatcher = new FakeDispatcher({
      ...successResult(),
      output: { unexpected: true },
    });
    const worker = createWorker(queue, repository, dispatcher);

    await worker.runOnce();

    expect(repository.settlements[0]?.settlement).toMatchObject({
      outcome: 'UNKNOWN',
      errorCode: 'TOOL_OUTPUT_SCHEMA_INVALID',
    });
    expect(queue.unknown[0]).toMatchObject({
      reasonCode: 'TOOL_OUTPUT_SCHEMA_INVALID',
    });
  });

  it('fails closed before dispatch when the immutable endpoint violates its host allowlist', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const repository = new FakeExecutionRepository({
      kind: 'ready',
      execution: execution({
        status: 'APPROVED',
        revision: 2,
        allowedHostPatterns: ['crm.example.com'],
      }),
    });
    const dispatcher = new FakeDispatcher(successResult());
    const endpoint = new StaticEndpointResolver({
      url: 'https://evil.example.net/customer',
      method: 'POST',
      headers: {},
      signingSecret: null,
    });
    const worker = createWorker(queue, repository, dispatcher, endpoint);

    await worker.runOnce();

    expect(repository.preDispatchFailures[0]).toMatchObject({
      reasonCode: 'TOOL_OUTBOUND_HOST_NOT_ALLOWED',
    });
    expect(dispatcher.requests).toHaveLength(0);
    expect(queue.published[0]).toMatchObject({ outcome: 'failed' });
  });

  it('defers without dispatch when the database-wide Tool capacity gate is full', async () => {
    const queue = new FakeQueue([toolEvent()]);
    const repository = new FakeExecutionRepository(
      {
        kind: 'ready',
        execution: execution({ status: 'APPROVED', revision: 2 }),
      },
      {
        startResult: {
          kind: 'deferred',
          reasonCode: 'TOOL_CONCURRENCY_LIMIT',
          availableAt: new Date('2026-07-28T00:00:05.000Z'),
        },
      },
    );
    const dispatcher = new FakeDispatcher(successResult());
    const worker = createWorker(queue, repository, dispatcher);

    await worker.runOnce();

    expect(dispatcher.requests).toHaveLength(0);
    expect(queue.deferred[0]).toMatchObject({
      reasonCode: 'TOOL_CONCURRENCY_LIMIT',
      availableAt: new Date('2026-07-28T00:00:05.000Z'),
    });
  });

  it('rejects malformed command events without reading or mutating an Invocation', async () => {
    const queue = new FakeQueue([{ ...toolEvent(), payload: { schemaVersion: 999 } }]);
    const repository = new FakeExecutionRepository({
      kind: 'skip',
      reasonCode: 'STALE_EXECUTION_EVENT',
      providerRequestId: null,
    });
    const worker = createWorker(queue, repository, new FakeDispatcher(successResult()));

    await worker.runOnce();

    expect(repository.inspections).toHaveLength(0);
    expect(queue.failed[0]).toMatchObject({ reasonCode: 'TOOL_COMMAND_EVENT_MALFORMED' });
  });
});

describe('ToolExecutionCircuitBreaker', () => {
  it('opens after the threshold and permits a half-open probe after the cool-down', () => {
    const circuit = new ToolExecutionCircuitBreaker(2, 1_000);
    const start = new Date('2026-07-28T00:00:00.000Z');
    circuit.fail(VERSION_ID, start);
    expect(circuit.allow(VERSION_ID, start)).toEqual({ allowed: true, reopenAt: null });
    circuit.fail(VERSION_ID, start);
    expect(circuit.allow(VERSION_ID, new Date(start.getTime() + 500))).toMatchObject({
      allowed: false,
    });
    expect(circuit.allow(VERSION_ID, new Date(start.getTime() + 1_001))).toEqual({
      allowed: true,
      reopenAt: null,
    });
    circuit.succeed(VERSION_ID);
    expect(circuit.allow(VERSION_ID, start)).toEqual({ allowed: true, reopenAt: null });
  });
});

function createWorker(
  queue: FakeQueue,
  repository: FakeExecutionRepository,
  dispatcher: FakeDispatcher,
  endpoint: ToolEndpointResolverPort = new StaticEndpointResolver({
    url: 'https://crm.example.com/customer',
    method: 'POST',
    headers: { authorization: 'Bearer server-only' },
    signingSecret: '12345678901234567890123456789012',
  }),
): ToolExecutionWorker {
  const values: Partial<EnvironmentVariables> = {
    TOOL_EXECUTION_WORKER_ENABLED: true,
    TOOL_EXECUTION_WORKER_CONCURRENCY: 2,
    TOOL_EXECUTION_POLL_INTERVAL_MS: 500,
    TOOL_EXECUTION_CLAIM_TTL_MS: 180_000,
    TOOL_MAX_CONCURRENT_PER_VERSION: 4,
    TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION: 60,
  };
  const config = {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as ConfigService<EnvironmentVariables, true>;
  return new ToolExecutionWorker(
    config,
    queue,
    repository,
    endpoint,
    new StaticDnsResolver(),
    dispatcher,
    new ToolExecutionCircuitBreaker(5, 30_000),
  );
}

function toolEvent(): ClaimedToolExecutionEvent {
  return {
    id: '00000000-0000-7000-8000-000000000501',
    tenantId: TENANT_ID,
    aggregateId: INVOCATION_ID,
    eventType: 'ToolInvocationCommandRecorded',
    payload: {
      schemaVersion: 1,
      commandId: COMMAND_ID,
      command: 'APPROVE',
      expectedRevision: 1,
      resultRevision: 2,
    },
    attempts: 1,
    firstAttemptedAt: new Date('2026-07-28T00:00:00.000Z'),
    leaseExpiresAt: new Date('2026-07-28T00:03:00.000Z'),
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
  };
}

function execution(overrides: Partial<PreparedToolExecution> = {}): PreparedToolExecution {
  return {
    id: INVOCATION_ID,
    tenantId: TENANT_ID,
    toolId: '00000000-0000-7000-8000-000000000204',
    toolVersionId: VERSION_ID,
    toolVersion: 1,
    configurationHash: 'a'.repeat(64),
    endpointRef: 'secret://tenant/crm/customer',
    adapter: 'HTTP',
    riskClass: 'HIGH_RISK_APPROVAL',
    dataClassification: 'CONFIDENTIAL',
    idempotencyMode: 'PROVIDER_SUPPORTED',
    dryRunMode: 'NATIVE',
    requesterUserId: '00000000-0000-7000-8000-000000000101',
    roleAssignmentId: '00000000-0000-7000-8000-000000000301',
    taskId: '00000000-0000-7000-8000-000000000401',
    correlationId: '00000000-0000-7000-8000-000000000402',
    status: 'EXECUTING',
    revision: 3,
    providerRequestId: `tool-provider:${INVOCATION_ID}`,
    providerDryRun: false,
    input: { customerId: 'C-001' },
    inputHash: 'b'.repeat(64),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['customerName'],
      properties: { customerName: { type: 'string' } },
    },
    timeoutMs: 10_000,
    maxAttempts: 3,
    allowedHttpMethods: ['POST'],
    allowedHostPatterns: ['crm.example.com'],
    executionAttempt: 1,
    startedAt: new Date('2026-07-28T00:00:01.000Z'),
    ...overrides,
  };
}

function successResult(): ToolProviderResult {
  return {
    providerRequestId: `tool-provider:${INVOCATION_ID}`,
    outcome: 'SUCCEEDED',
    output: { customerName: 'Blue Ocean' },
    errorCode: null,
    errorDetail: null,
    startedAt: new Date('2026-07-28T00:00:01.000Z'),
    completedAt: new Date('2026-07-28T00:00:01.125Z'),
    cost: { kind: 'UNATTESTED' },
  };
}

class FakeQueue extends ToolExecutionQueueRepository {
  readonly published: Array<Record<string, unknown>> = [];
  readonly unknown: Array<Record<string, unknown>> = [];
  readonly failed: Array<Record<string, unknown>> = [];
  readonly deferred: Array<Record<string, unknown>> = [];

  constructor(private readonly events: readonly ClaimedToolExecutionEvent[]) {
    super();
  }

  claim(): Promise<readonly ClaimedToolExecutionEvent[]> {
    return Promise.resolve(this.events);
  }

  markPublished(input: Record<string, unknown>): Promise<boolean> {
    this.published.push(input);
    return Promise.resolve(true);
  }

  markUnknown(input: Record<string, unknown>): Promise<boolean> {
    this.unknown.push(input);
    return Promise.resolve(true);
  }

  markFailed(input: Record<string, unknown>): Promise<boolean> {
    this.failed.push(input);
    return Promise.resolve(true);
  }

  defer(input: Record<string, unknown>): Promise<boolean> {
    this.deferred.push(input);
    return Promise.resolve(true);
  }
}

class FakeExecutionRepository extends ToolExecutionRepository {
  readonly inspections: ParsedToolCommandEvent[] = [];
  readonly dnsProofs: ToolDnsProofInput[] = [];
  readonly settlements: Array<{
    execution: PreparedToolExecution;
    settlement: ToolExecutionSettlement;
  }> = [];
  readonly ambiguous: PreparedToolExecution[] = [];
  readonly preDispatchFailures: Array<{
    execution: PreparedToolExecution;
    reasonCode: string;
    detail: string;
  }> = [];

  constructor(
    private readonly inspection: ToolExecutionInspection,
    private readonly behavior: {
      ambiguousTransitionApplied?: boolean;
      startResult?: ToolExecutionStartResult;
    } = {},
  ) {
    super();
  }

  inspect(
    _tenantId: string,
    _invocationId: string,
    event: ParsedToolCommandEvent,
  ): Promise<ToolExecutionInspection> {
    this.inspections.push(event);
    return Promise.resolve(this.inspection);
  }

  start(current: PreparedToolExecution): Promise<ToolExecutionStartResult> {
    if (this.behavior.startResult !== undefined) {
      return Promise.resolve(this.behavior.startResult);
    }
    return Promise.resolve({
      kind: 'started',
      execution: execution({ ...current, status: 'EXECUTING', revision: 3 }),
    });
  }

  recordDnsProof(input: ToolDnsProofInput): Promise<void> {
    this.dnsProofs.push(input);
    return Promise.resolve();
  }

  settle(
    execution: PreparedToolExecution,
    settlement: ToolExecutionSettlement,
    _target: PreparedHttpTarget | null,
  ): Promise<boolean> {
    this.settlements.push({ execution, settlement });
    return Promise.resolve(true);
  }

  failBeforeDispatch(
    execution: PreparedToolExecution,
    reasonCode: string,
    detail: string,
  ): Promise<boolean> {
    this.preDispatchFailures.push({ execution, reasonCode, detail });
    return Promise.resolve(true);
  }

  markAmbiguous(execution: PreparedToolExecution): Promise<boolean> {
    this.ambiguous.push(execution);
    return Promise.resolve(this.behavior.ambiguousTransitionApplied ?? true);
  }
}

class StaticEndpointResolver extends ToolEndpointResolverPort {
  constructor(private readonly endpoint: ResolvedToolEndpoint) {
    super();
  }

  resolve(): Promise<ResolvedToolEndpoint> {
    return Promise.resolve(this.endpoint);
  }
}

class StaticDnsResolver extends ToolDnsResolverPort {
  resolve(hostname: string): Promise<TrustedDnsResolution> {
    const resolvedAt = new Date();
    return Promise.resolve({
      hostname,
      addresses: ['93.184.216.34'],
      resolverName: 'test-recursive',
      ttlSeconds: 300,
      resolvedAt,
      expiresAt: new Date(resolvedAt.getTime() + 300_000),
    });
  }
}

class FakeDispatcher extends ToolProviderDispatcherPort {
  readonly requests: ToolProviderRequest[] = [];

  constructor(private readonly result: ToolProviderResult) {
    super();
  }

  dispatch(request: ToolProviderRequest): Promise<ToolProviderResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}
