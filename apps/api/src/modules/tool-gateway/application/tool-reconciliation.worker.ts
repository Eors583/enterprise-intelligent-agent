import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { runtimeHash } from '../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import { validateToolJsonInput } from '../domain/tool-json-schema.validator.js';
import { ToolExecutionRepository } from '../domain/tool-execution.repository.js';
import { ToolReconciliationQueueRepository } from '../domain/tool-reconciliation-queue.repository.js';
import {
  parseToolReconciliationEvent,
  type ClaimedToolReconciliationEvent,
  type PreparedToolReconciliation,
  type ToolReconciliationResolution,
} from '../domain/tool-reconciliation.models.js';
import { ToolReconciliationRepository } from '../domain/tool-reconciliation.repository.js';
import { preparePinnedHttpTarget } from '../tool-execution-boundary.js';
import {
  ToolDnsResolverPort,
  ToolEndpointResolverPort,
  ToolProviderDispatcherPort,
  type ToolProviderResult,
} from '../tool-execution.port.js';

@Injectable()
export class ToolReconciliationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ToolReconciliationWorker.name);
  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly workerId = `tool-reconciliation:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(ToolReconciliationQueueRepository)
    private readonly queue: ToolReconciliationQueueRepository,
    @Inject(ToolReconciliationRepository)
    private readonly reconciliations: ToolReconciliationRepository,
    @Inject(ToolExecutionRepository)
    private readonly executions: ToolExecutionRepository,
    @Inject(ToolEndpointResolverPort)
    private readonly endpointResolver: ToolEndpointResolverPort,
    @Inject(ToolDnsResolverPort)
    private readonly dnsResolver: ToolDnsResolverPort,
    @Inject(ToolProviderDispatcherPort)
    private readonly dispatcher: ToolProviderDispatcherPort,
  ) {
    this.enabled = config.get('TOOL_EXECUTION_WORKER_ENABLED', { infer: true });
    this.concurrency = config.get('TOOL_EXECUTION_WORKER_CONCURRENCY', { infer: true });
    this.pollIntervalMs = config.get('TOOL_EXECUTION_POLL_INTERVAL_MS', { infer: true });
    this.claimTtlMs = config.get('TOOL_EXECUTION_CLAIM_TTL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.stopped = false;
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;
    const events = await this.queue.claim({
      workerId: this.workerId,
      batchSize: this.concurrency,
      claimTtlMs: this.claimTtlMs,
    });
    const results = await Promise.allSettled(events.map((event) => this.process(event)));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Tool reconciliation transition failed (${errorKind(result.reason)}).`);
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
      this.logger.error(`Tool reconciliation polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async process(event: ClaimedToolReconciliationEvent): Promise<void> {
    let request;
    try {
      request = parseToolReconciliationEvent(event);
    } catch {
      requireQueueTransition(
        await this.queue.markFailed({
          eventId: event.id,
          workerId: this.workerId,
          reasonCode: 'TOOL_RECONCILIATION_EVENT_MALFORMED',
        }),
      );
      return;
    }
    const preparation = await this.reconciliations.prepare(event, request);
    if (preparation.kind !== 'ready') {
      requireQueueTransition(
        await this.queue.markProcessed({
          eventId: event.id,
          workerId: this.workerId,
          providerRequestId: preparation.providerRequestId,
          outcome: preparation.kind === 'already_completed' ? preparation.outcome : 'skipped',
          reasonCode: preparation.reasonCode,
        }),
      );
      return;
    }

    const resolution = await this.lookup(preparation.reconciliation);
    const completion = await this.reconciliations.complete(preparation.reconciliation, resolution);
    requireQueueTransition(
      await this.queue.markProcessed({
        eventId: event.id,
        workerId: this.workerId,
        providerRequestId: preparation.reconciliation.providerRequestId,
        outcome: completion.outcome,
        reasonCode: completion.reasonCode,
      }),
    );
  }

  private async lookup(
    reconciliation: PreparedToolReconciliation,
  ): Promise<ToolReconciliationResolution> {
    const startedAt = new Date();
    if (reconciliation.eligibility === 'INELIGIBLE') {
      return inconclusive(startedAt, 'TOOL_RECONCILIATION_REPLAY_PROOF_REQUIRED');
    }

    try {
      const target = await preparePinnedHttpTarget(
        `${reconciliation.endpointRef}.reconcile`,
        reconciliation.allowedHostPatterns,
        this.endpointResolver,
        this.dnsResolver,
      );
      if (target.endpoint.method !== 'GET') {
        return inconclusive(startedAt, 'TOOL_RECONCILIATION_GET_REQUIRED');
      }
      await this.executions.recordDnsProof({
        tenantId: reconciliation.tenantId,
        invocationId: reconciliation.invocationId,
        invocationRevision: reconciliation.expectedRevision,
        requestedUrl: target.target.normalizedUrl,
        hostname: target.target.hostname,
        tlsServerName: target.target.tlsServerName,
        addresses: target.target.resolution.addresses,
        pinnedIpAddress: target.target.pinnedIpAddress,
        resolverName: target.target.resolution.resolverName,
        ttlSeconds: target.target.resolution.ttlSeconds,
        decision: 'ALLOWED',
        decisionReason: 'Reconciliation status endpoint passed HTTPS, DNS, and IP pin policy.',
        resolvedAt: target.target.resolution.resolvedAt,
        expiresAt: target.target.resolution.expiresAt,
      });
      const result = await this.dispatcher.dispatch({
        invocationId: reconciliation.invocationId,
        tenantId: reconciliation.tenantId,
        requesterUserId: reconciliation.requesterUserId,
        roleAssignmentId: reconciliation.roleAssignmentId,
        taskId: reconciliation.taskId,
        correlationId: reconciliation.correlationId,
        providerRequestId: reconciliation.providerRequestId,
        endpoint: target.endpoint,
        target: target.target,
        input: {
          operation: 'STATUS',
          providerRequestId: reconciliation.providerRequestId,
          tenantId: reconciliation.tenantId,
          toolVersionId: reconciliation.toolVersionId,
          inputHash: reconciliation.inputHash,
        },
        idempotencyKey: reconciliation.providerRequestId,
        timeoutMs: reconciliation.timeoutMs,
        providerDryRun: false,
      });
      return validateToolReconciliationProof(reconciliation, result);
    } catch {
      return inconclusive(startedAt, 'TOOL_RECONCILIATION_LOOKUP_UNAVAILABLE');
    }
  }
}

export function validateToolReconciliationProof(
  reconciliation: PreparedToolReconciliation,
  providerResult: ToolProviderResult,
): ToolReconciliationResolution {
  if (
    reconciliation.eligibility === 'INELIGIBLE' ||
    providerResult.outcome !== 'SUCCEEDED' ||
    providerResult.providerRequestId !== reconciliation.providerRequestId ||
    providerResult.output === null
  ) {
    return inconclusive(
      providerResult.startedAt,
      'TOOL_RECONCILIATION_PROOF_INVALID',
      providerResult.completedAt,
    );
  }
  const proof = providerResult.output;
  const providerRequestId = proof.providerRequestId;
  const tenantId = proof.tenantId;
  const toolVersionId = proof.toolVersionId;
  const inputHash = proof.inputHash;
  const proofType = proof.proofType;
  const proofId = proof.proofId;
  const observedAtText = proof.observedAt;
  const outcome = proof.outcome;
  if (
    proof.schemaVersion !== 1 ||
    providerRequestId !== reconciliation.providerRequestId ||
    tenantId !== reconciliation.tenantId ||
    toolVersionId !== reconciliation.toolVersionId ||
    inputHash !== reconciliation.inputHash ||
    (proofType !== 'STATUS' && proofType !== 'IDEMPOTENT_REPLAY') ||
    typeof proofId !== 'string' ||
    !SAFE_PROOF_ID.test(proofId) ||
    typeof observedAtText !== 'string' ||
    !Number.isFinite(Date.parse(observedAtText)) ||
    !['SUCCEEDED', 'FAILED', 'PENDING', 'UNKNOWN', 'NOT_FOUND'].includes(
      typeof outcome === 'string' ? outcome : '',
    )
  ) {
    return inconclusive(
      providerResult.startedAt,
      'TOOL_RECONCILIATION_PROOF_INVALID',
      providerResult.completedAt,
    );
  }
  const providerObservedAt = new Date(observedAtText);
  const proofHash = runtimeHash(proof);
  if (outcome === 'SUCCEEDED') {
    const output = proof.output;
    if (!isRecord(output)) {
      return inconclusive(
        providerResult.startedAt,
        'TOOL_RECONCILIATION_OUTPUT_MISSING',
        providerResult.completedAt,
        proofHash,
        proofType,
        proofId,
        providerObservedAt,
      );
    }
    const validation = validateToolJsonInput(reconciliation.outputSchema, output);
    if (
      !validation.valid ||
      (reconciliation.riskClass === 'DRAFT_ONLY' && output.artifactMode !== 'DRAFT')
    ) {
      return inconclusive(
        providerResult.startedAt,
        'TOOL_RECONCILIATION_OUTPUT_INVALID',
        providerResult.completedAt,
        proofHash,
        proofType,
        proofId,
        providerObservedAt,
      );
    }
    return {
      kind: 'SUCCEEDED',
      output,
      outputHash: runtimeHash(output),
      reasonCode: 'TOOL_RECONCILIATION_PROVED_SUCCEEDED',
      startedAt: providerResult.startedAt,
      completedAt: providerResult.completedAt,
      proofHash,
      proofType,
      proofId,
      providerObservedAt,
    };
  }
  if (outcome === 'FAILED') {
    const errorCode = proof.errorCode;
    if (typeof errorCode !== 'string' || !SAFE_CODE.test(errorCode)) {
      return inconclusive(
        providerResult.startedAt,
        'TOOL_RECONCILIATION_PROOF_INVALID',
        providerResult.completedAt,
        proofHash,
        proofType,
        proofId,
        providerObservedAt,
      );
    }
    return {
      kind: 'FAILED',
      output: null,
      outputHash: null,
      errorCode,
      reasonCode: 'TOOL_RECONCILIATION_PROVED_FAILED',
      startedAt: providerResult.startedAt,
      completedAt: providerResult.completedAt,
      proofHash,
      proofType,
      proofId,
      providerObservedAt,
    };
  }
  return inconclusive(
    providerResult.startedAt,
    `TOOL_RECONCILIATION_${outcome}`,
    providerResult.completedAt,
    proofHash,
    proofType,
    proofId,
    providerObservedAt,
  );
}

function inconclusive(
  startedAt: Date,
  reasonCode: string,
  completedAt = new Date(),
  proofHash: string | null = null,
  proofType: 'STATUS' | 'IDEMPOTENT_REPLAY' | null = null,
  proofId: string | null = null,
  providerObservedAt: Date | null = null,
): ToolReconciliationResolution {
  return {
    kind: 'INCONCLUSIVE',
    output: null,
    outputHash: null,
    reasonCode,
    startedAt,
    completedAt: completedAt < startedAt ? startedAt : completedAt,
    proofHash,
    proofType,
    proofId,
    providerObservedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function requireQueueTransition(applied: boolean): void {
  if (!applied) throw new Error('Tool reconciliation Outbox lease was lost.');
}

const SAFE_CODE = /^[A-Z0-9_]{1,120}$/u;
const SAFE_PROOF_ID = /^[A-Za-z0-9_.:/-]{1,200}$/u;
