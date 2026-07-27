import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../../config/environment.js';
import {
  AgentRuntimeClient,
  AgentRuntimeRequestError,
  type RuntimeRunResult,
  type RuntimeRunStatus,
} from '../../domain/agent-runtime.client.js';
import type { PreparedAgentRun } from '../../domain/agent-run.models.js';

const CREATE_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_VALUES = new Set<RuntimeRunStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

@Injectable()
export class HttpAgentRuntimeClient extends AgentRuntimeClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.baseUrl = config.get('AI_RUNTIME_URL', { infer: true });
    this.requestTimeoutMs = config.get('AI_RUNTIME_HTTP_TIMEOUT_MS', { infer: true });
  }

  async create(run: PreparedAgentRun, signal: AbortSignal): Promise<RuntimeRunResult> {
    const body = {
      tenant_id: run.tenantId,
      principal: {
        principal_id: run.requesterUserId,
        principal_type: 'user',
        roles: [run.requesterRole.toLowerCase()],
        scopes: ['agent:run'],
      },
      agent_id: run.agentId,
      agent_version: String(run.agentVersion),
      input: {
        messages: [
          { role: 'system', content: systemPromptFor(run) },
          ...run.messages.map((message) => ({
            role:
              message.senderType === 'AGENT' && message.senderId === run.agentId
                ? 'assistant'
                : 'user',
            content:
              message.senderType === 'AGENT' && message.senderId === run.agentId
                ? message.text
                : `[${message.senderType === 'AGENT' ? '智能体' : '用户'} ${message.senderName}] ${message.text}`,
          })),
        ],
        attachments: [],
        variables: {
          conversation_id: run.conversationId,
          agent_run_id: run.id,
          turn_index: run.turnIndex,
          turn_limit: run.turnLimit,
        },
      },
      budget: {
        max_input_tokens: run.maxInputTokens,
        max_output_tokens: run.maxOutputTokens,
        max_tool_calls: 0,
        timeout_ms: 60_000,
        max_cost_micros: 1_000_000,
      },
      metadata: {
        source: 'conversation',
        conversation_id: run.conversationId,
        agent_run_id: run.id,
      },
    };
    return this.request(
      '/internal/v1/runs',
      { method: 'POST', body, tenantId: run.tenantId, requestId: requestId(run.id) },
      signal,
      Math.min(CREATE_TIMEOUT_MS, this.requestTimeoutMs),
    );
  }

  execute(
    run: PreparedAgentRun,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<RuntimeRunResult> {
    return this.request(
      `/internal/v1/runs/${encodeURIComponent(externalRunId)}/execute`,
      {
        method: 'POST',
        tenantId: run.tenantId,
        requestId: requestId(run.id),
        expectedRunId: externalRunId,
      },
      signal,
      this.requestTimeoutMs,
    );
  }

  get(tenantId: string, externalRunId: string, signal: AbortSignal): Promise<RuntimeRunResult> {
    return this.request(
      `/internal/v1/runs/${encodeURIComponent(externalRunId)}`,
      {
        method: 'GET',
        tenantId,
        requestId: requestId(externalRunId),
        expectedRunId: externalRunId,
      },
      signal,
      Math.min(10_000, this.requestTimeoutMs),
    );
  }

  cancel(tenantId: string, externalRunId: string, signal: AbortSignal): Promise<RuntimeRunResult> {
    return this.request(
      `/internal/v1/runs/${encodeURIComponent(externalRunId)}/cancel`,
      {
        method: 'POST',
        tenantId,
        requestId: requestId(externalRunId),
        expectedRunId: externalRunId,
      },
      signal,
      Math.min(10_000, this.requestTimeoutMs),
    );
  }

  private async request(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly tenantId: string;
      readonly requestId: string;
      readonly body?: unknown;
      readonly expectedRunId?: string;
    },
    outerSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<RuntimeRunResult> {
    const controller = new AbortController();
    const abortFromOuter = (): void => controller.abort(outerSignal.reason);
    const listeningToOuter = !outerSignal.aborted;
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', abortFromOuter, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('AI Runtime request timed out.')),
      timeoutMs,
    );
    timeout.unref();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Tenant-ID': options.tenantId,
          'X-Request-ID': options.requestId,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        // Explicitly discard an error body while this request's timeout still
        // owns the signal. No response content is logged or persisted.
        if (response.body !== null) {
          try {
            await Promise.race([response.body.cancel(), abortRejection(controller.signal)]);
          } catch {
            // The status line is enough to classify the request safely.
          }
        }
        // Once an external Run id is attached, an error response cannot prove
        // whether its provider-side work is still running (the Runtime state may
        // have restarted while a Manus task survived). Never free a relay chain
        // on that ambiguity. Create-time definitive 4xx responses remain failed.
        const unknown =
          options.expectedRunId !== undefined ||
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429;
        throw new AgentRuntimeRequestError(
          `AI_RUNTIME_HTTP_${response.status}`,
          'AI Runtime rejected the Run request.',
          unknown ? 'unknown' : 'failed',
        );
      }

      let value: unknown;
      try {
        value = await Promise.race([response.json(), abortRejection(controller.signal)]);
      } catch (error) {
        if (error instanceof AgentRuntimeRequestError) throw error;
        if (controller.signal.aborted) {
          throw new AgentRuntimeRequestError(
            'AI_RUNTIME_TIMEOUT',
            'AI Runtime did not return a confirmed response.',
            'unknown',
          );
        }
        throw new AgentRuntimeRequestError(
          'AI_RUNTIME_INVALID_RESPONSE',
          'AI Runtime returned an invalid success response.',
          'unknown',
        );
      }
      return parseRuntimeRun(value, options.expectedRunId);
    } catch (error) {
      if (error instanceof AgentRuntimeRequestError) throw error;
      throw new AgentRuntimeRequestError(
        controller.signal.aborted ? 'AI_RUNTIME_TIMEOUT' : 'AI_RUNTIME_UNAVAILABLE',
        'AI Runtime did not return a confirmed response.',
        'unknown',
      );
    } finally {
      clearTimeout(timeout);
      if (listeningToOuter) outerSignal.removeEventListener('abort', abortFromOuter);
    }
  }
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = (): void =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function parseRuntimeRun(value: unknown, expectedRunId?: string): RuntimeRunResult {
  if (!isRecord(value)) throw invalidResponse();
  const runId = value.run_id;
  const status = value.status;
  if (
    typeof runId !== 'string' ||
    !UUID_PATTERN.test(runId) ||
    (expectedRunId !== undefined && runId !== expectedRunId) ||
    typeof status !== 'string' ||
    !STATUS_VALUES.has(status as RuntimeRunStatus)
  ) {
    throw invalidResponse();
  }

  const result: RuntimeRunResult = { runId, status: status as RuntimeRunStatus };
  if (value.output !== undefined && value.output !== null) {
    if (
      !isRecord(value.output) ||
      typeof value.output.content !== 'string' ||
      typeof value.output.model !== 'string' ||
      value.output.model.length < 1 ||
      value.output.model.length > 256 ||
      typeof value.output.provider !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.output.provider)
    ) {
      throw invalidResponse();
    }
    Object.assign(result, {
      output: {
        content: value.output.content,
        model: value.output.model,
        provider: value.output.provider,
      },
    });
  }
  if (value.usage !== undefined && value.usage !== null) {
    const usage = parseUsage(value.usage);
    Object.assign(result, { usage });
  }
  if (isRecord(value.error)) {
    const code = safeCode(value.error.code);
    Object.assign(result, {
      error: {
        code,
        message: 'AI Runtime reported a failed Run.',
        retryable: value.error.retryable === true,
      },
    });
  }
  if (status === 'succeeded' && (result.output === undefined || result.usage === undefined)) {
    throw invalidResponse();
  }
  if (
    status === 'succeeded' &&
    result.usage?.tokensReported === true &&
    (result.usage.totalTokens === 0 || result.usage.inputTokens + result.usage.outputTokens === 0)
  ) {
    throw invalidResponse();
  }
  return result;
}

function parseUsage(value: unknown): NonNullable<RuntimeRunResult['usage']> {
  if (!isRecord(value)) throw invalidResponse();
  const inputTokens = nonNegativeSafeInteger(value.input_tokens, 2_147_483_647);
  const outputTokens = nonNegativeSafeInteger(value.output_tokens, 2_147_483_647);
  const totalTokens = nonNegativeSafeInteger(value.total_tokens, 2_147_483_647);
  const toolCalls = nonNegativeSafeInteger(value.tool_calls, 2_147_483_647);
  const costMicros = nonNegativeSafeInteger(value.cost_micros, Number.MAX_SAFE_INTEGER);
  const tokensReported = reportingFlag(value.tokens_reported, [
    inputTokens,
    outputTokens,
    totalTokens,
  ]);
  const costReported = reportingFlag(value.cost_reported, [costMicros]);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    toolCalls === null ||
    costMicros === null ||
    tokensReported === null ||
    costReported === null ||
    totalTokens < inputTokens + outputTokens ||
    (!tokensReported && (inputTokens !== 0 || outputTokens !== 0 || totalTokens !== 0)) ||
    (!costReported && costMicros !== 0)
  ) {
    throw invalidResponse();
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    toolCalls,
    costMicros,
    tokensReported,
    costReported,
  };
}

function reportingFlag(value: unknown, measurements: Array<number | null>): boolean | null {
  if (typeof value === 'boolean') return value;
  // Runtime releases before usage trust flags existed emitted numeric zero
  // placeholders. They are safe to interpret as unreported only when every
  // corresponding measurement is present and exactly zero. Never infer trust
  // for a positive value or for any other malformed/missing flag value.
  if (value === undefined && measurements.every((measurement) => measurement === 0)) return false;
  return null;
}

function nonNegativeSafeInteger(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function invalidResponse(): AgentRuntimeRequestError {
  return new AgentRuntimeRequestError(
    'AI_RUNTIME_INVALID_RESPONSE',
    'AI Runtime returned an invalid success response.',
    'unknown',
  );
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z0-9_]{1,120}$/.test(value)
    ? value
    : 'AI_RUNTIME_FAILED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: string): string {
  return `agent-run-${value}`.slice(0, 128);
}

function knowledgePromptFor(run: PreparedAgentRun): string {
  const knowledgeSources = run.knowledgeSources ?? [];
  if (knowledgeSources.length === 0) {
    return '\n\n当前没有检索到可用的企业知识来源。不要声称引用了企业知识。';
  }
  const sources = knowledgeSources
    .map(
      (source) =>
        `SOURCE_ID: ${source.chunkId}\n` +
        `DOCUMENT: ${source.title}\n` +
        `VERSION: ${source.documentVersion}\n` +
        `SECTION: ${source.headingPath.join(' / ') || '正文'}\n` +
        `CONTENT: ${source.excerpt}`,
    )
    .join('\n\n');
  return (
    '\n\n以下是经过权限过滤的企业知识来源。只能依据这些来源回答企业事实。每个关键结论必须使用' +
    ' [SOURCE:<SOURCE_ID>] 标注；不得编造来源编号。无法从来源确认时必须明确拒绝猜测。\n' +
    sources
  );
}

function systemPromptFor(run: PreparedAgentRun): string {
  const identity = run.agentName.replace(/\s+/g, ' ').trim().slice(0, 200);
  return (
    `${run.systemPrompt}${knowledgePromptFor(run)}\n\n` +
    `运行时身份：你是企业智能体「${identity}」。` +
    '你必须只以该身份回答，并清楚区分对话中标注的其他智能体。'
  );
}
