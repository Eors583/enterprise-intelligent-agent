import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { validateToolJsonInput } from '../domain/tool-json-schema.validator.js';
import { ToolExecutionQueueRepository } from '../domain/tool-execution-queue.repository.js';
import { ToolExecutionRepository } from '../domain/tool-execution.repository.js';
import {
  parseToolCommandEvent,
  type ClaimedToolExecutionEvent,
  type PreparedToolExecution,
  type ToolExecutionSettlement,
} from '../domain/tool-execution.models.js';
import { preparePinnedHttpTarget } from '../tool-execution-boundary.js';
import {
  ToolDnsResolverPort,
  ToolEndpointResolverPort,
  ToolProviderDispatcherPort,
  type PreparedHttpTarget,
  type ToolProviderResult,
} from '../tool-execution.port.js';
import { ToolEndpointResolutionError } from '../infrastructure/config/config-tool-endpoint.resolver.js';
import { ToolDnsResolutionError } from '../infrastructure/dns/configured-tool-dns.resolver.js';
import { ToolExecutionCircuitBreaker } from './tool-execution-circuit-breaker.js';

@Injectable()
export class ToolExecutionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ToolExecutionWorker.name);
  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly workerId = `tool-execution:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(ToolExecutionQueueRepository)
    private readonly queue: ToolExecutionQueueRepository,
    @Inject(ToolExecutionRepository)
    private readonly executions: ToolExecutionRepository,
    @Inject(ToolEndpointResolverPort)
    private readonly endpointResolver: ToolEndpointResolverPort,
    @Inject(ToolDnsResolverPort)
    private readonly dnsResolver: ToolDnsResolverPort,
    @Inject(ToolProviderDispatcherPort)
    private readonly dispatcher: ToolProviderDispatcherPort,
    @Inject(ToolExecutionCircuitBreaker)
    private readonly circuits: ToolExecutionCircuitBreaker,
  ) {
    this.enabled = config.get('TOOL_EXECUTION_WORKER_ENABLED', { infer: true });
    this.concurrency = config.get('TOOL_EXECUTION_WORKER_CONCURRENCY', { infer: true });
    this.pollIntervalMs = config.get('TOOL_EXECUTION_POLL_INTERVAL_MS', { infer: true });
    this.claimTtlMs = config.get('TOOL_EXECUTION_CLAIM_TTL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Tool Execution worker is disabled.');
      return;
    }
    this.stopped = false;
    this.logger.log(`Starting Tool Execution worker ${this.workerId}.`);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  /** Runs one bounded Outbox batch; exposed for deterministic tests and probes. */
  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;
    const events = await this.queue.claim({
      workerId: this.workerId,
      batchSize: this.concurrency,
      claimTtlMs: this.claimTtlMs,
    });
    const settled = await Promise.allSettled(events.map((event) => this.processEvent(event)));
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.error(`Tool execution transition failed (${errorKind(result.reason)}).`);
      }
    }
    return events.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const tick = this.tick();
      this.activeTick = tick;
      void tick.finally(() => {
        if (this.activeTick === tick) this.activeTick = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Tool execution polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async processEvent(event: ClaimedToolExecutionEvent): Promise<void> {
    let commandEvent;
    try {
      commandEvent = parseToolCommandEvent(event.payload);
    } catch {
      requireQueueTransition(
        await this.queue.markFailed({
          eventId: event.id,
          workerId: this.workerId,
          reasonCode: 'TOOL_COMMAND_EVENT_MALFORMED',
        }),
      );
      return;
    }

    const inspection = await this.executions.inspect(
      event.tenantId,
      event.aggregateId,
      commandEvent,
    );
    if (inspection.kind === 'skip') {
      requireQueueTransition(
        await this.queue.markPublished({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: inspection.providerRequestId,
          outcome: 'skipped',
          reasonCode: inspection.reasonCode,
        }),
      );
      return;
    }
    if (inspection.kind === 'ambiguous_dispatch') {
      requireInvocationTransition(
        await this.executions.markAmbiguous(inspection.execution, inspection.reasonCode),
      );
      requireQueueTransition(
        await this.queue.markUnknown({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: inspection.execution.providerRequestId,
          reasonCode: inspection.reasonCode,
        }),
      );
      return;
    }

    const circuit = this.circuits.allow(inspection.execution.toolVersionId);
    if (!circuit.allowed) {
      requireQueueTransition(
        await this.queue.defer({
          eventId: event.id,
          workerId: this.workerId,
          availableAt: circuit.reopenAt ?? new Date(Date.now() + 30_000),
          reasonCode: 'TOOL_PROVIDER_CIRCUIT_OPEN',
        }),
      );
      return;
    }

    const start = await this.executions.start(inspection.execution);
    if (start.kind === 'deferred') {
      requireQueueTransition(
        await this.queue.defer({
          eventId: event.id,
          workerId: this.workerId,
          availableAt: start.availableAt,
          reasonCode: start.reasonCode,
        }),
      );
      return;
    }
    if (start.kind === 'stale') {
      requireQueueTransition(
        await this.queue.markPublished({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: inspection.execution.providerRequestId,
          outcome: 'skipped',
          reasonCode: 'STALE_EXECUTION_EVENT',
        }),
      );
      return;
    }
    await this.execute(event, start.execution);
  }

  private async execute(
    event: ClaimedToolExecutionEvent,
    execution: PreparedToolExecution,
  ): Promise<void> {
    if (execution.adapter !== 'HTTP') {
      await this.failBeforeDispatch(
        event,
        execution,
        'TOOL_ADAPTER_NOT_CONFIGURED',
        `Adapter ${execution.adapter} requires a separately registered sandboxed provider.`,
      );
      return;
    }

    let target: PreparedHttpTarget;
    try {
      target = await preparePinnedHttpTarget(
        execution.endpointRef,
        execution.allowedHostPatterns,
        this.endpointResolver,
        this.dnsResolver,
      );
      if (!execution.allowedHttpMethods.includes(target.endpoint.method)) {
        throw new ToolPreDispatchError(
          'TOOL_HTTP_METHOD_NOT_ALLOWED',
          'Resolved endpoint method is not allowed by the immutable Tool Version.',
        );
      }
      await this.executions.recordDnsProof({
        tenantId: execution.tenantId,
        invocationId: execution.id,
        invocationRevision: execution.revision,
        requestedUrl: target.target.normalizedUrl,
        hostname: target.target.hostname,
        tlsServerName: target.target.tlsServerName,
        addresses: target.target.resolution.addresses,
        pinnedIpAddress: target.target.pinnedIpAddress,
        resolverName: target.target.resolution.resolverName,
        ttlSeconds: target.target.resolution.ttlSeconds,
        decision: 'ALLOWED',
        decisionReason: 'HTTPS host, DNS answers, and pinned address passed policy.',
        resolvedAt: target.target.resolution.resolvedAt,
        expiresAt: target.target.resolution.expiresAt,
      });
    } catch (error) {
      const described = describePreDispatchError(error);
      await this.failBeforeDispatch(event, execution, described.code, described.detail);
      return;
    }

    let result: ToolProviderResult;
    try {
      result = await this.dispatcher.dispatch({
        invocationId: execution.id,
        tenantId: execution.tenantId,
        requesterUserId: execution.requesterUserId,
        roleAssignmentId: execution.roleAssignmentId,
        taskId: execution.taskId,
        correlationId: execution.correlationId,
        providerRequestId: execution.providerRequestId,
        endpoint: target.endpoint,
        target: target.target,
        input: execution.input,
        idempotencyKey: execution.providerRequestId,
        timeoutMs: execution.timeoutMs,
        providerDryRun: execution.providerDryRun,
      });
    } catch {
      const now = new Date();
      result = {
        providerRequestId: execution.providerRequestId,
        outcome: 'UNKNOWN',
        output: null,
        errorCode: 'TOOL_PROVIDER_DELIVERY_UNKNOWN',
        errorDetail: 'Provider delivery could not be proven; reconcile before retry.',
        startedAt: execution.startedAt ?? now,
        completedAt: now,
        cost: { kind: 'UNATTESTED' },
      };
    }

    const settlement = validateProviderResult(execution, result);
    const persisted = await this.executions.settle(execution, settlement, target);
    if (!persisted) {
      throw new Error('Tool execution settlement lost its revision or lease.');
    }
    if (settlement.outcome === 'SUCCEEDED') {
      this.circuits.succeed(execution.toolVersionId);
      requireQueueTransition(
        await this.queue.markPublished({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: execution.providerRequestId,
          outcome: 'executed',
          reasonCode: 'TOOL_PROVIDER_SUCCEEDED',
        }),
      );
      return;
    }
    if (isCircuitFailure(settlement)) this.circuits.fail(execution.toolVersionId);
    if (settlement.outcome === 'UNKNOWN') {
      requireQueueTransition(
        await this.queue.markUnknown({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: execution.providerRequestId,
          reasonCode: settlement.errorCode ?? 'TOOL_PROVIDER_DELIVERY_UNKNOWN',
        }),
      );
      return;
    }
    requireQueueTransition(
      await this.queue.markPublished({
        eventId: event.id,
        workerId: this.workerId,
        providerRequestId: execution.providerRequestId,
        outcome: 'failed',
        reasonCode: settlement.errorCode ?? 'TOOL_PROVIDER_FAILED',
      }),
    );
  }

  private async failBeforeDispatch(
    event: ClaimedToolExecutionEvent,
    execution: PreparedToolExecution,
    code: string,
    detail: string,
  ): Promise<void> {
    requireInvocationTransition(await this.executions.failBeforeDispatch(execution, code, detail));
    requireQueueTransition(
      await this.queue.markPublished({
        eventId: event.id,
        workerId: this.workerId,
        providerRequestId: execution.providerRequestId,
        outcome: 'failed',
        reasonCode: code,
      }),
    );
  }
}

function validateProviderResult(
  execution: PreparedToolExecution,
  result: ToolProviderResult,
): ToolExecutionSettlement {
  const now = new Date();
  if (
    result.providerRequestId !== execution.providerRequestId ||
    !Number.isFinite(result.startedAt.getTime()) ||
    !Number.isFinite(result.completedAt.getTime()) ||
    result.completedAt < result.startedAt ||
    (result.cost.kind === 'PROVIDER_ATTESTED' && result.cost.costMicros < 0n)
  ) {
    return unknownSettlement(
      execution,
      'TOOL_PROVIDER_RECEIPT_INVALID',
      'Provider returned an invalid or mismatched execution receipt.',
      now,
    );
  }
  if (result.outcome !== 'SUCCEEDED') {
    return {
      outcome: result.outcome,
      providerRequestId: execution.providerRequestId,
      output: null,
      errorCode: safeCode(result.errorCode ?? `TOOL_PROVIDER_${result.outcome}`),
      errorDetail:
        result.errorDetail ?? 'The provider did not return a trusted successful execution result.',
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      cost: result.cost,
    };
  }
  if (result.output === null) {
    return unknownSettlement(
      execution,
      'TOOL_PROVIDER_RESPONSE_INVALID',
      'Provider success did not include a JSON object output.',
      result.completedAt,
      result.startedAt,
    );
  }
  const outputValidation = validateToolJsonInput(execution.outputSchema, result.output);
  if (!outputValidation.valid) {
    return unknownSettlement(
      execution,
      'TOOL_OUTPUT_SCHEMA_INVALID',
      'Provider reported success with an output that violates the immutable schema.',
      result.completedAt,
      result.startedAt,
    );
  }
  if (execution.riskClass === 'DRAFT_ONLY' && result.output.artifactMode !== 'DRAFT') {
    return unknownSettlement(
      execution,
      'TOOL_DRAFT_BOUNDARY_VIOLATED',
      'A draft-only provider did not prove that its result is a draft artifact.',
      result.completedAt,
      result.startedAt,
    );
  }
  return {
    outcome: 'SUCCEEDED',
    providerRequestId: execution.providerRequestId,
    output: result.output,
    errorCode: null,
    errorDetail: null,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    cost: result.cost,
  };
}

function unknownSettlement(
  execution: PreparedToolExecution,
  errorCode: string,
  errorDetail: string,
  completedAt: Date,
  startedAt = execution.startedAt ?? completedAt,
): ToolExecutionSettlement {
  return {
    outcome: 'UNKNOWN',
    providerRequestId: execution.providerRequestId,
    output: null,
    errorCode,
    errorDetail,
    startedAt,
    completedAt: completedAt < startedAt ? startedAt : completedAt,
    cost: { kind: 'UNATTESTED' },
  };
}

function describePreDispatchError(error: unknown): {
  readonly code: string;
  readonly detail: string;
} {
  if (error instanceof ToolEndpointResolutionError || error instanceof ToolDnsResolutionError) {
    return { code: safeCode(error.code), detail: error.message };
  }
  if (error instanceof ToolPreDispatchError) {
    return { code: error.code, detail: error.message };
  }
  if (error instanceof UnprocessableEntityException) {
    const response = error.getResponse();
    const reason =
      typeof response === 'object' &&
      response !== null &&
      'reasonCode' in response &&
      typeof response.reasonCode === 'string'
        ? response.reasonCode
        : 'POLICY_DENIED';
    return {
      code: safeCode(`TOOL_OUTBOUND_${reason}`),
      detail: 'Tool endpoint failed outbound URL or DNS/IP policy.',
    };
  }
  return {
    code: 'TOOL_EXECUTION_PRE_DISPATCH_FAILED',
    detail: 'Tool execution failed before any provider request was dispatched.',
  };
}

function isCircuitFailure(settlement: ToolExecutionSettlement): boolean {
  if (settlement.outcome === 'UNKNOWN') return true;
  const code = settlement.errorCode ?? '';
  return (
    code === 'TOOL_PROVIDER_CONNECT_FAILED' ||
    code === 'TOOL_PROVIDER_TIMEOUT' ||
    code === 'TOOL_PROVIDER_HTTP_408' ||
    code === 'TOOL_PROVIDER_HTTP_429' ||
    /^TOOL_PROVIDER_HTTP_5\d\d$/u.test(code)
  );
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'TOOL_PROVIDER_FAILED';
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function requireQueueTransition(applied: boolean): void {
  if (!applied) throw new Error('Tool execution Outbox lease or state transition was lost.');
}

function requireInvocationTransition(applied: boolean): void {
  if (!applied) throw new Error('Tool Invocation execution transition lost its revision.');
}

class ToolPreDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolPreDispatchError';
  }
}
