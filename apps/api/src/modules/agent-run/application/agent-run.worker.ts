import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AgentOperationalReadinessService } from '../../ai-safety-model-routing/agent-operational-readiness.service.js';
import { AgentRunQueueRepository } from '../domain/agent-run-queue.repository.js';
import {
  AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE,
  ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
  parseAgentRunCancelRequestedEvent,
  parseAgentRunRequestedEvent,
  type AgentRunPreparation,
  type AgentRunKnowledgeSource,
  type AgentRunUsage,
  type ClaimedAgentRunEvent,
  type PreparedAgentRun,
} from '../domain/agent-run.models.js';
import { AgentRunRepository } from '../domain/agent-run.repository.js';
import { AgentRunStreamRepository } from '../domain/agent-run-stream.repository.js';
import {
  AgentRuntimeClient,
  AgentRuntimeRequestError,
  type RuntimeRunResult,
  type RuntimeStreamEvent,
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
  private readonly cancellationWorkerId = `${this.workerId}:cancel`;
  private readonly activeControllers = new Set<AbortController>();
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private cancellationTimer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;
  private activeCancellationTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(AgentRunQueueRepository)
    private readonly queue: AgentRunQueueRepository,
    @Inject(AgentRunRepository) private readonly runs: AgentRunRepository,
    @Inject(AgentRuntimeClient) private readonly runtime: AgentRuntimeClient,
    @Inject(AgentOperationalReadinessService)
    private readonly operationalReadiness: AgentOperationalReadinessService,
    @Optional()
    @Inject(AgentRunStreamRepository)
    private readonly streamEvents?: AgentRunStreamRepository,
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
    this.scheduleCancellation(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.cancellationTimer !== undefined) clearTimeout(this.cancellationTimer);
    this.timer = undefined;
    this.cancellationTimer = undefined;
    for (const controller of this.activeControllers) {
      controller.abort(new Error('Agent Run worker is shutting down.'));
    }
    await Promise.all([this.activeTick, this.activeCancellationTick]);
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

  /** Runs one cancellation-only claim batch independently from long Runtime executions. */
  async runCancellationOnce(): Promise<number> {
    if (!this.enabled) return 0;
    const events = await this.queue.claimCancellations({
      workerId: this.cancellationWorkerId,
      batchSize: this.concurrency,
      claimTtlMs: this.claimTtlMs,
    });
    const settled = await Promise.allSettled(
      events.map((event) => this.processCancellationEvent(event, this.cancellationWorkerId)),
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Unable to persist an Agent Run cancellation transition (${errorKind(result.reason)}).`,
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

  private scheduleCancellation(delayMs: number): void {
    if (this.stopped) return;
    this.cancellationTimer = setTimeout(() => {
      const tick = this.tickCancellation();
      this.activeCancellationTick = tick;
      void tick.finally(() => {
        if (this.activeCancellationTick === tick) this.activeCancellationTick = undefined;
      });
    }, delayMs);
    this.cancellationTimer.unref();
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

  private async tickCancellation(): Promise<void> {
    try {
      await this.runCancellationOnce();
    } catch (error) {
      this.logger.error(`Agent Run cancellation polling failed (${errorKind(error)}).`);
    } finally {
      this.scheduleCancellation(this.pollIntervalMs);
    }
  }

  private async processEvent(event: ClaimedAgentRunEvent): Promise<void> {
    if (event.eventType === AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE) {
      await this.processCancellationEvent(event);
      return;
    }

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

    if (preparation.run.controlledModelConnectivityProbe !== true) {
      const availability = await this.operationalReadiness.inspectAgents(event.tenantId, [
        preparation.run.agentId,
      ]);
      if (availability.get(preparation.run.agentId)?.status !== 'AVAILABLE') {
        await this.runs.completeFailed(
          event.tenantId,
          runId,
          'AGENT_OPERATIONAL_NOT_READY',
          'Verified model availability is not ready for this Agent Run.',
        );
        await this.transitionFailed(event, 'AGENT_OPERATIONAL_NOT_READY');
        return;
      }
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      await this.executePrepared(event, preparation.run, controller.signal);
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async processCancellationEvent(
    event: ClaimedAgentRunEvent,
    workerId = this.workerId,
  ): Promise<void> {
    let runId: string;
    try {
      runId = parseAgentRunCancelRequestedEvent(event);
    } catch {
      await this.transitionFailed(event, 'MALFORMED_AGENT_RUN_CANCELLATION_EVENT', workerId);
      return;
    }

    const preparation = await this.runs.prepareCancellation(event.tenantId, runId);
    if (preparation.kind === 'complete') {
      await this.transitionPublished(event, preparation.externalRunId, workerId);
      return;
    }
    if (preparation.kind === 'deferred') {
      await this.transitionDeferred(
        event,
        preparation.reasonCode,
        preparation.availableAt,
        workerId,
      );
      return;
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      let result: RuntimeRunResult;
      try {
        result = await this.runtime.cancel(
          event.tenantId,
          preparation.externalRunId,
          controller.signal,
        );
      } catch (error) {
        if (!(error instanceof AgentRuntimeRequestError)) throw error;
        await this.transitionDeferred(event, error.code, undefined, workerId);
        return;
      }
      if (result.runId !== preparation.externalRunId || result.status !== 'cancelled') {
        await this.transitionDeferred(event, 'AI_RUNTIME_CANCEL_UNCONFIRMED', undefined, workerId);
        return;
      }
      await this.runs.confirmCancellation(
        event.tenantId,
        runId,
        preparation.externalRunId,
        usageFromRuntime(result),
      );
      await this.transitionPublished(event, preparation.externalRunId, workerId);
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
      let streamMode: 'live' | 'terminal_only' = 'terminal_only';
      if (externalRunId === null) {
        result = await this.runtime.create(run, signal);
        externalRunId = result.runId;
        const attachment = await this.runs.attachExternalRun(event.tenantId, run.id, externalRunId);
        if (attachment === 'cancellation_required') {
          await this.cancelRevokedRunAfterCreate(event, run.id, externalRunId, signal);
          return;
        }
      } else {
        result = await this.runtime.get(event.tenantId, externalRunId, signal);
      }

      if (result.status === 'queued' || result.status === 'running') {
        const streamed = await this.consumeRuntimeStream(event, run, externalRunId, signal);
        result = streamed.result;
        streamMode = streamed.mode;
        if (result.status === 'running') {
          result = await this.reconcileRunning(event, externalRunId, result, signal);
        }
      }
      await this.settleRuntimeResult(event, run, externalRunId, result, streamMode);
    } catch (error) {
      if (!(error instanceof AgentRuntimeRequestError)) throw error;
      await this.handleRuntimeRequestError(event, run.id, externalRunId, error);
    }
  }

  private async consumeRuntimeStream(
    event: ClaimedAgentRunEvent,
    run: PreparedAgentRun,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly result: RuntimeRunResult;
    readonly mode: 'live' | 'terminal_only';
  }> {
    const cursor = (await this.streamEvents?.cursor(event.tenantId, run.id)) ?? 0;
    let terminal: Extract<
      RuntimeStreamEvent,
      { readonly type: 'terminal' | 'terminal_only' }
    > | null = null;
    for await (const streamEvent of this.runtime.stream(run, externalRunId, cursor, signal)) {
      if (streamEvent.type === 'delta') {
        if (terminal !== null) {
          throw new AgentRuntimeRequestError(
            'AI_RUNTIME_INVALID_RESPONSE',
            'AI Runtime emitted a delta after terminal.',
            'unknown',
          );
        }
        await this.streamEvents?.appendDelta({
          tenantId: event.tenantId,
          runId: run.id,
          sequence: streamEvent.sequence,
          eventId: `${run.id}:${streamEvent.sequence}`,
          delta: streamEvent.delta,
          deltaHash: streamEvent.deltaHash,
          createdAt: streamEvent.createdAt,
        });
        continue;
      }
      if (terminal !== null) {
        throw new AgentRuntimeRequestError(
          'AI_RUNTIME_INVALID_RESPONSE',
          'AI Runtime emitted more than one terminal event.',
          'unknown',
        );
      }
      terminal = streamEvent;
    }
    if (terminal === null) {
      throw new AgentRuntimeRequestError(
        'AI_RUNTIME_STREAM_INTERRUPTED',
        'AI Runtime stream ended without a terminal event.',
        'unknown',
      );
    }
    return {
      result: terminal.result,
      mode: terminal.type === 'terminal_only' ? 'terminal_only' : 'live',
    };
  }

  private async cancelRevokedRunAfterCreate(
    event: ClaimedAgentRunEvent,
    runId: string,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.runtime.cancel(event.tenantId, externalRunId, signal);
      if (result.runId === externalRunId && result.status === 'cancelled') {
        await this.runs.confirmCancellation(
          event.tenantId,
          runId,
          externalRunId,
          usageFromRuntime(result),
        );
      }
    } catch (error) {
      if (!(error instanceof AgentRuntimeRequestError)) throw error;
      // The independently committed cancellation outbox event remains pending
      // and will retry this external cancellation with the now-attached id.
    }
    await this.transitionFailed(event, ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE);
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
    streamMode: 'live' | 'terminal_only' = 'terminal_only',
  ): Promise<void> {
    if (result.runId !== externalRunId) {
      throw new AgentRuntimeRequestError(
        'AI_RUNTIME_RUN_MISMATCH',
        'AI Runtime returned a mismatched Run.',
        'unknown',
      );
    }
    await this.runs.recordModelExecutionEvidence(
      event.tenantId,
      run.id,
      result.modelAttempts ?? [],
      result.outputSafetyDecision,
    );
    if (result.status === 'succeeded') {
      if (result.output === undefined || result.output.content.trim().length === 0) {
        await this.runs.completeFailed(
          event.tenantId,
          run.id,
          'AI_RUNTIME_EMPTY_OUTPUT',
          'AI Runtime completed without a text output.',
          usageFromRuntime(result),
          streamMode,
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
        streamMode,
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
        streamMode,
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
    workerId = this.workerId,
  ): Promise<void> {
    const updated = await this.queue.markPublished({
      eventId: event.id,
      workerId,
      externalRunId,
    });
    if (!updated) this.logLostLease(event.id);
  }

  private async transitionFailed(
    event: ClaimedAgentRunEvent,
    errorCode: string,
    workerId = this.workerId,
  ): Promise<void> {
    const updated = await this.queue.markFailed({
      eventId: event.id,
      workerId,
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
    workerId = this.workerId,
  ): Promise<void> {
    const updated = await this.queue.defer({
      eventId: event.id,
      workerId,
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
  return /^[A-Z0-9][A-Z0-9_]{0,119}$/.test(value) ? value : 'AGENT_RUN_FAILED';
}

function isTransientKnownRunError(code: string): boolean {
  if (
    code === 'AI_RUNTIME_TIMEOUT' ||
    code === 'AI_RUNTIME_UNAVAILABLE' ||
    code === 'AI_RUNTIME_STREAM_INTERRUPTED' ||
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
  const contentWithoutModelCitationNumbers = stripModelCitationNumbers(content);
  if (run.knowledgeGroundingRequired !== true) {
    const sanitized = stripRawSourceMarkers(contentWithoutModelCitationNumbers).trim();
    if (sanitized.length === 0 || claimsEnterpriseKnowledgeAuthority(sanitized)) {
      return noGroundedAnswer();
    }
    return { content: sanitized, citations: [] };
  }
  if (sources.length === 0) return noGroundedAnswer();

  const sourceByChunkId = new Map<string, AgentRunKnowledgeSource>();
  for (const source of sources) {
    const normalizedId = source.chunkId.toLowerCase();
    if (!sourceByChunkId.has(normalizedId)) sourceByChunkId.set(normalizedId, source);
  }

  const citations: AgentRunKnowledgeSource[] = [];
  const citationNumberByChunkId = new Map<string, number>();
  const blocks = splitGroundingBlocks(contentWithoutModelCitationNumbers);
  if (blocks.length === 0) return noGroundedAnswer();
  const normalizedBlocks: string[] = [];

  for (const block of blocks) {
    const units = extractGroundedClaimUnits(block);
    if (units === undefined) return noGroundedAnswer();
    const normalizedUnits: string[] = [];

    for (const unit of units) {
      const markerMatches = [...unit.markerSuffix.matchAll(RAW_SOURCE_PATTERN_GLOBAL)];
      if (markerMatches.length === 0) return noGroundedAnswer();
      const visibleMarkers: string[] = [];
      for (const marker of markerMatches) {
        const rawChunkId = marker[1];
        if (rawChunkId === undefined) return noGroundedAnswer();
        const chunkId = rawChunkId.toLowerCase();
        const source = sourceByChunkId.get(chunkId);
        if (source === undefined) return noGroundedAnswer();

        let citationNumber = citationNumberByChunkId.get(chunkId);
        if (citationNumber === undefined) {
          if (citations.length >= MAX_VISIBLE_CITATIONS) return noGroundedAnswer();
          citations.push(source);
          citationNumber = citations.length;
          citationNumberByChunkId.set(chunkId, citationNumber);
        }
        visibleMarkers.push(`[来源${citationNumber}]`);
      }
      normalizedUnits.push(`${unit.claim} ${visibleMarkers.join(' ')}`.trim());
    }
    normalizedBlocks.push(normalizedUnits.join(' '));
  }

  return { content: normalizedBlocks.join('\n\n'), citations };
}

const KNOWLEDGE_GROUNDING_NO_ANSWER =
  '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。';
const MAX_VISIBLE_CITATIONS = 12;
const RAW_SOURCE_PATTERN = /\[\s*SOURCE\s*:\s*([^\]\s]+)\s*\]/iu;
const RAW_SOURCE_PATTERN_GLOBAL = /\[\s*SOURCE\s*:\s*([^\]\s]+)\s*\]/giu;
// Models commonly place sentence punctuation immediately after the citation
// marker ("... [SOURCE:id]。") even though the marker is still the semantic
// suffix of that claim. Include that punctuation in the marker group so it is
// normalized away instead of rejecting a correctly grounded answer.
const TRUSTED_SOURCE_SUFFIX_PATTERN =
  /(?:\s*\[\s*SOURCE\s*:\s*[^\]\s]+\s*\])+(?:[。！？；，：.!?;,:]\s*)?$/iu;
const TRUSTED_SOURCE_GROUP_PATTERN_GLOBAL =
  /(?:\s*\[\s*SOURCE\s*:\s*[^\]\s]+\s*\])+(?:[。！？；，：.!?;,:](?=\s|$))?/giu;
const MODEL_CITATION_NUMBER_PATTERN = /\[\s*来源\s*\d+\s*\]/gu;
const ENTERPRISE_KNOWLEDGE_AUTHORITY_PATTERN =
  /(?:依据|根据|来自|引用).{0,8}(?:(?:企业|公司|内部).{0,8})?(?:知识库|资料|来源)|(?:企业|公司|内部).{0,8}(?:知识库|资料|来源).{0,8}(?:显示|规定|指出|表明)|according\s+to\s+(?:the\s+)?(?:enterprise|company|corporate|internal)\s+(?:knowledge|source|documentation)/iu;

function stripModelCitationNumbers(content: string): string {
  return content.replace(MODEL_CITATION_NUMBER_PATTERN, '');
}

function stripRawSourceMarkers(content: string): string {
  return content.replace(RAW_SOURCE_PATTERN_GLOBAL, '');
}

function claimsEnterpriseKnowledgeAuthority(content: string): boolean {
  return ENTERPRISE_KNOWLEDGE_AUTHORITY_PATTERN.test(content);
}

function hasSubstantiveClaim(content: string): boolean {
  return content.replace(/[\s#>*_`~|+\-=:[\](){}.,，。；;：!?！？]/gu, '').length > 0;
}

function extractGroundedClaimUnits(
  block: string,
): readonly { readonly claim: string; readonly markerSuffix: string }[] | undefined {
  const units: { claim: string; markerSuffix: string }[] = [];
  const isCodeFence = /^(?:```|~~~)/u.test(block.trimStart());
  let cursor = 0;

  for (const markerGroup of block.matchAll(TRUSTED_SOURCE_GROUP_PATTERN_GLOBAL)) {
    const markerIndex = markerGroup.index;
    const markerSuffix = markerGroup[0];
    if (markerIndex === undefined || markerSuffix === undefined) return undefined;
    const claim = block.slice(cursor, markerIndex).trim();
    if (
      !hasSubstantiveClaim(claim) ||
      RAW_SOURCE_PATTERN.test(claim) ||
      (!isCodeFence && containsMultipleIndependentSentences(claim))
    ) {
      return undefined;
    }
    units.push({ claim, markerSuffix });
    cursor = markerIndex + markerSuffix.length;
  }

  if (units.length === 0 || block.slice(cursor).trim().length > 0) return undefined;
  return units;
}

function containsMultipleIndependentSentences(content: string): boolean {
  const withoutLinks = content.replace(/https?:\/\/\S+/giu, '');
  const chineseBoundaries = withoutLinks.match(/[。！？；]/gu)?.length ?? 0;
  const englishBoundaries = withoutLinks.match(/[.!?;](?=\s|$)/gu)?.length ?? 0;
  return chineseBoundaries + englishBoundaries > 1;
}

/**
 * Split Markdown into presentation blocks. Blank-line paragraphs are separate;
 * list/table items and headings are also independent. Validation then splits
 * each prose block into independently cited claim units. Fenced code remains
 * one unit and may place its source marker on the first line after the closing
 * fence.
 */
function splitGroundingBlocks(content: string): string[] {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let justClosedFence = false;
  let currentIsListOrTable = false;

  const flush = (): void => {
    const value = current.join('\n').trim();
    if (value.length > 0) blocks.push(value);
    current = [];
    currentIsListOrTable = false;
    justClosedFence = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fence = /^```|^~~~/u.test(trimmed);
    if (inFence) {
      current.push(line);
      if (fence) {
        inFence = false;
        justClosedFence = true;
      }
      continue;
    }
    if (justClosedFence) {
      if (trimmed.length > 0 && TRUSTED_SOURCE_SUFFIX_PATTERN.test(trimmed)) {
        current.push(line);
        flush();
        continue;
      }
      flush();
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (fence) {
      flush();
      current.push(line);
      inFence = true;
      continue;
    }

    const isListOrTable =
      /^(?:[-+*]\s+|\d+[.)]\s+|\|)/u.test(trimmed) || /^(?:#{1,6}\s+|>\s+)/u.test(trimmed);
    if (isListOrTable && current.length > 0) flush();
    if (isListOrTable && currentIsListOrTable && current.length > 0) flush();
    current.push(line);
    currentIsListOrTable = isListOrTable;
  }
  flush();
  return blocks;
}

function noGroundedAnswer(): {
  readonly content: string;
  readonly citations: readonly AgentRunKnowledgeSource[];
} {
  return { content: KNOWLEDGE_GROUNDING_NO_ANSWER, citations: [] };
}
