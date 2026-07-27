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
import { AgentRunQueueRepository } from '../domain/agent-run-queue.repository.js';
import {
  parseAgentRunRequestedEvent,
  type AgentRunPreparation,
  type AgentRunKnowledgeSource,
  type AgentRunUsage,
  type ClaimedAgentRunEvent,
  type PreparedAgentRun,
} from '../domain/agent-run.models.js';
import { AgentRunRepository } from '../domain/agent-run.repository.js';
import {
  AgentRuntimeClient,
  AgentRuntimeRequestError,
  type RuntimeRunResult,
} from '../domain/agent-runtime.client.js';

@Injectable()
export class AgentRunWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentRunWorker.name);
  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly reconciliationWindowMs: number;
  private readonly workerId = `agent-run:${process.pid}:${randomUUID()}`;
  private readonly activeControllers = new Set<AbortController>();
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(AgentRunQueueRepository)
    private readonly queue: AgentRunQueueRepository,
    @Inject(AgentRunRepository) private readonly runs: AgentRunRepository,
    @Inject(AgentRuntimeClient) private readonly runtime: AgentRuntimeClient,
  ) {
    this.enabled = config.get('AGENT_RUN_WORKER_ENABLED', { infer: true });
    this.concurrency = config.get('AGENT_RUN_WORKER_CONCURRENCY', { infer: true });
    this.pollIntervalMs = config.get('AGENT_RUN_POLL_INTERVAL_MS', { infer: true });
    this.claimTtlMs = config.get('AGENT_RUN_CLAIM_TTL_MS', { infer: true });
    this.reconciliationWindowMs = Math.min(60_000, Math.max(1_000, this.claimTtlMs - 5_000));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Agent Run worker is disabled.');
      return;
    }
    this.stopped = false;
    this.logger.log(`Starting Agent Run worker ${this.workerId}.`);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.activeControllers) {
      controller.abort(new Error('Agent Run worker is shutting down.'));
    }
    await this.activeTick;
  }

  /** Runs one bounded claim batch; exposed for deterministic operational tests. */
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
        this.logger.error(
          `Unable to persist an Agent Run transition (${errorKind(result.reason)}).`,
        );
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
      this.logger.error(`Agent Run polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async processEvent(event: ClaimedAgentRunEvent): Promise<void> {
    let runId: string;
    try {
      runId = parseAgentRunRequestedEvent(event);
    } catch {
      await this.runs.completeFailed(
        event.tenantId,
        event.aggregateId,
        'MALFORMED_AGENT_RUN_EVENT',
        'Agent Run outbox event validation failed.',
      );
      await this.transitionFailed(event, 'MALFORMED_AGENT_RUN_EVENT');
      return;
    }

    const preparation = await this.runs.prepare(event.tenantId, runId);
    if (preparation.kind === 'deferred') {
      await this.transitionDeferred(event, preparation.reasonCode, preparation.availableAt);
      return;
    }
    if (preparation.kind === 'terminal') {
      await this.settleTerminal(event, preparation);
      return;
    }
    if (preparation.kind === 'ambiguous_dispatch') {
      await this.runs.completeUnknown(event.tenantId, runId, 'AMBIGUOUS_RUNTIME_DISPATCH');
      await this.transitionUnknown(event, 'AMBIGUOUS_RUNTIME_DISPATCH');
      return;
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      await this.executePrepared(event, preparation.run, controller.signal);
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async executePrepared(
    event: ClaimedAgentRunEvent,
    run: PreparedAgentRun,
    signal: AbortSignal,
  ): Promise<void> {
    let externalRunId = run.externalRunId;
    try {
      let result: RuntimeRunResult;
      if (externalRunId === null) {
        result = await this.runtime.create(run, signal);
        externalRunId = result.runId;
        await this.runs.attachExternalRun(event.tenantId, run.id, externalRunId);
      } else {
        result = await this.runtime.get(event.tenantId, externalRunId, signal);
      }

      if (result.status === 'queued') {
        result = await this.runtime.execute(run, externalRunId, signal);
      }
      if (result.status === 'running') {
        result = await this.reconcileRunning(event, externalRunId, result, signal);
      }
      await this.settleRuntimeResult(event, run, externalRunId, result);
    } catch (error) {
      if (!(error instanceof AgentRuntimeRequestError)) throw error;
      await this.handleRuntimeRequestError(event, run.id, externalRunId, error);
    }
  }

  private async handleRuntimeRequestError(
    event: ClaimedAgentRunEvent,
    runId: string,
    externalRunId: string | null,
    error: AgentRuntimeRequestError,
  ): Promise<void> {
    if (error.outcome === 'failed') {
      await this.runs.completeFailed(
        event.tenantId,
        runId,
        safeCode(error.code),
        'AI Runtime rejected the Agent Run.',
      );
      await this.transitionFailed(event, error.code);
      return;
    }
    // A known external id is safe to reconcile without ever creating another
    // provider task. Transient transport failures and shutdown aborts therefore
    // retain RUNNING + PENDING. A non-recoverable ambiguity such as Runtime 404
    // still becomes UNKNOWN and requires operator reconciliation.
    if (externalRunId !== null && isTransientKnownRunError(error.code)) {
      await this.transitionDeferred(event, error.code);
      return;
    }
    await this.runs.completeUnknown(event.tenantId, runId, safeCode(error.code));
    await this.transitionUnknown(event, error.code);
  }

  private async reconcileRunning(
    event: ClaimedAgentRunEvent,
    externalRunId: string,
    initial: RuntimeRunResult,
    signal: AbortSignal,
  ): Promise<RuntimeRunResult> {
    const deadline = Math.min(
      Date.now() + this.reconciliationWindowMs,
      event.leaseExpiresAt.getTime() - 5_000,
    );
    let current = initial;
    while (current.status === 'running' && Date.now() < deadline) {
      await abortableDelay(Math.min(500, Math.max(1, deadline - Date.now())), signal);
      current = await this.runtime.get(event.tenantId, externalRunId, signal);
    }
    return current;
  }

  private async settleRuntimeResult(
    event: ClaimedAgentRunEvent,
    run: PreparedAgentRun,
    externalRunId: string,
    result: RuntimeRunResult,
  ): Promise<void> {
    if (result.runId !== externalRunId) {
      throw new AgentRuntimeRequestError(
        'AI_RUNTIME_RUN_MISMATCH',
        'AI Runtime returned a mismatched Run.',
        'unknown',
      );
    }
    if (result.status === 'succeeded') {
      if (result.output === undefined || result.output.content.trim().length === 0) {
        await this.runs.completeFailed(
          event.tenantId,
          run.id,
          'AI_RUNTIME_EMPTY_OUTPUT',
          'AI Runtime completed without a text output.',
          usageFromRuntime(result),
        );
        await this.transitionFailed(event, 'AI_RUNTIME_EMPTY_OUTPUT');
        return;
      }
      const grounded = validateGroundedOutput(result.output.content, run);
      const completed = await this.runs.completeSucceeded(
        event.tenantId,
        run.id,
        grounded.content,
        grounded.citations,
        usageFromRuntime(result),
      );
      await this.transitionPublished(event, completed.externalRunId);
      return;
    }
    if (result.status === 'failed' || result.status === 'cancelled') {
      const code =
        result.status === 'cancelled'
          ? 'AI_RUNTIME_CANCELLED'
          : safeCode(result.error?.code ?? 'AI_RUNTIME_FAILED');
      await this.runs.completeFailed(
        event.tenantId,
        run.id,
        code,
        result.status === 'cancelled'
          ? 'AI Runtime cancelled the Agent Run.'
          : 'AI Runtime reported a failed Agent Run.',
        usageFromRuntime(result),
      );
      await this.transitionFailed(event, code);
      return;
    }

    await this.transitionDeferred(event, 'AI_RUNTIME_NONTERMINAL_RESPONSE');
  }

  private async settleTerminal(
    event: ClaimedAgentRunEvent,
    preparation: Extract<AgentRunPreparation, { readonly kind: 'terminal' }>,
  ): Promise<void> {
    switch (preparation.status) {
      case 'SUCCEEDED':
        await this.transitionPublished(event, preparation.externalRunId);
        return;
      case 'UNKNOWN':
        await this.transitionUnknown(event, preparation.errorCode ?? 'AGENT_RUN_UNKNOWN');
        return;
      case 'FAILED':
      case 'CANCELLED':
        await this.transitionFailed(
          event,
          preparation.errorCode ??
            (preparation.status === 'CANCELLED' ? 'AGENT_RUN_CANCELLED' : 'AGENT_RUN_FAILED'),
        );
    }
  }

  private async transitionPublished(
    event: ClaimedAgentRunEvent,
    externalRunId: string | null,
  ): Promise<void> {
    const updated = await this.queue.markPublished({
      eventId: event.id,
      workerId: this.workerId,
      externalRunId,
    });
    if (!updated) this.logLostLease(event.id);
  }

  private async transitionFailed(event: ClaimedAgentRunEvent, errorCode: string): Promise<void> {
    const updated = await this.queue.markFailed({
      eventId: event.id,
      workerId: this.workerId,
      errorCode: safeCode(errorCode),
    });
    if (!updated) this.logLostLease(event.id);
  }

  private async transitionUnknown(event: ClaimedAgentRunEvent, errorCode: string): Promise<void> {
    const updated = await this.queue.markUnknown({
      eventId: event.id,
      workerId: this.workerId,
      errorCode: safeCode(errorCode),
    });
    if (!updated) this.logLostLease(event.id);
  }

  private async transitionDeferred(
    event: ClaimedAgentRunEvent,
    reasonCode: string,
    availableAt = new Date(Date.now() + 1_000),
  ): Promise<void> {
    const updated = await this.queue.defer({
      eventId: event.id,
      workerId: this.workerId,
      availableAt,
      reasonCode: safeCode(reasonCode),
    });
    if (!updated) this.logLostLease(event.id);
  }

  private logLostLease(eventId: string): void {
    this.logger.warn(`Ignored stale Agent Run transition for event ${eventId}; its lease changed.`);
  }
}

function usageFromRuntime(result: RuntimeRunResult): AgentRunUsage | undefined {
  if (result.usage === undefined) return undefined;
  return {
    ...result.usage,
    provider: result.output?.provider ?? null,
    model: result.output?.model ?? null,
  };
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/.test(value) ? value : 'AGENT_RUN_FAILED';
}

function isTransientKnownRunError(code: string): boolean {
  if (
    code === 'AI_RUNTIME_TIMEOUT' ||
    code === 'AI_RUNTIME_UNAVAILABLE' ||
    code === 'AI_RUNTIME_HTTP_408' ||
    code === 'AI_RUNTIME_HTTP_429'
  ) {
    return true;
  }
  const match = /^AI_RUNTIME_HTTP_(\d{3})$/.exec(code);
  return match !== null && Number(match[1]) >= 500;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function validateGroundedOutput(
  content: string,
  run: PreparedAgentRun,
): { readonly content: string; readonly citations: readonly AgentRunKnowledgeSource[] } {
  const sources = run.knowledgeSources ?? [];
  if (run.knowledgeGroundingRequired !== true) return { content, citations: [] };
  if (sources.length === 0) return noGroundedAnswer();

  const sourceByChunkId = new Map<string, AgentRunKnowledgeSource>();
  for (const source of sources) {
    const normalizedId = source.chunkId.toLowerCase();
    if (!sourceByChunkId.has(normalizedId)) sourceByChunkId.set(normalizedId, source);
  }

  const citations: AgentRunKnowledgeSource[] = [];
  const citationNumberByChunkId = new Map<string, number>();
  // Visible citation numbers are presentation output owned by this validator. Strip any
  // numbers supplied by the model before converting trusted SOURCE markers so a model
  // cannot make an unrelated sentence look grounded by reusing `[来源N]` itself.
  const contentWithoutModelCitationNumbers = content.replace(/\[\s*来源\s*\d+\s*\]/g, '');
  const normalizedContent = contentWithoutModelCitationNumbers.replace(
    /\[\s*SOURCE\s*:\s*([^\]\s]+)\s*\]/gi,
    (_marker, rawChunkId: string) => {
      const chunkId = rawChunkId.toLowerCase();
      const source = sourceByChunkId.get(chunkId);
      if (source === undefined) return '';

      let citationNumber = citationNumberByChunkId.get(chunkId);
      if (citationNumber === undefined) {
        if (citations.length >= 12) return '';
        citations.push(source);
        citationNumber = citations.length;
        citationNumberByChunkId.set(chunkId, citationNumber);
      }
      return `[来源${citationNumber}]`;
    },
  );

  if (citations.length === 0) return noGroundedAnswer();
  return { content: normalizedContent.trim(), citations };
}

const KNOWLEDGE_GROUNDING_NO_ANSWER =
  '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。';

function noGroundedAnswer(): {
  readonly content: string;
  readonly citations: readonly AgentRunKnowledgeSource[];
} {
  return { content: KNOWLEDGE_GROUNDING_NO_ANSWER, citations: [] };
}
