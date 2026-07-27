import { ConfigService } from '@nestjs/config';

import { validateEnvironment, type EnvironmentVariables } from '../../../config/environment.js';
import { AgentRunQueueRepository } from '../domain/agent-run-queue.repository.js';
import type {
  AgentRunKnowledgeSource,
  AgentRunPreparation,
  AgentRunUsage,
  ClaimedAgentRunEvent,
  PreparedAgentRun,
} from '../domain/agent-run.models.js';
import { AgentRunRepository } from '../domain/agent-run.repository.js';
import {
  AgentRuntimeClient,
  AgentRuntimeRequestError,
  type RuntimeRunResult,
} from '../domain/agent-runtime.client.js';
import { AgentRunWorker, validateGroundedOutput } from './agent-run.worker.js';

describe('AgentRunWorker', () => {
  it('creates, attaches and executes a fresh Run before publishing its outbox event', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'ready', run: preparedRun() });
    const runtime = new FakeRuntime();

    await expect(createWorker(queue, runs, runtime).runOnce()).resolves.toBe(1);

    expect(runtime.calls).toEqual(['create', 'execute']);
    expect(runs.attached).toEqual([
      { tenantId: TENANT_ID, runId: RUN_ID, externalRunId: EXTERNAL_ID },
    ]);
    expect(runs.succeeded[0]).toMatchObject({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      output: 'answer',
    });
    expect(queue.published[0]).toMatchObject({ eventId: EVENT_ID, externalRunId: EXTERNAL_ID });
    expect(queue.failed).toHaveLength(0);
    expect(queue.unknown).toHaveLength(0);
  });

  it('resumes an attached Run without ever creating a second external Run', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({
      kind: 'ready',
      run: preparedRun({ externalRunId: EXTERNAL_ID }),
    });
    const runtime = new FakeRuntime({
      get: succeededResult('recovered'),
    });

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toEqual(['get']);
    expect(runs.attached).toHaveLength(0);
    expect(runs.succeeded[0]?.output).toBe('recovered');
    expect(runs.succeeded[0]?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      toolCalls: 0,
      costMicros: 25,
      tokensReported: true,
      costReported: true,
      provider: 'openai_compatible',
      model: 'model-a',
    });
    expect(queue.published).toHaveLength(1);
  });

  it('persists an ambiguous pre-attach crash as UNKNOWN without calling Runtime', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'ambiguous_dispatch' });
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toHaveLength(0);
    expect(runs.unknown[0]).toMatchObject({ errorCode: 'AMBIGUOUS_RUNTIME_DISPATCH' });
    expect(queue.unknown[0]).toMatchObject({ errorCode: 'AMBIGUOUS_RUNTIME_DISPATCH' });
    expect(queue.failed).toHaveLength(0);
  });

  it('defers a later direct Run without invoking Runtime while an earlier Run is active', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'deferred', reasonCode: 'EARLIER_AGENT_RUN_ACTIVE' });
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toHaveLength(0);
    expect(queue.deferred[0]).toMatchObject({ reasonCode: 'EARLIER_AGENT_RUN_ACTIVE' });
    expect(queue.failed).toHaveLength(0);
    expect(queue.unknown).toHaveLength(0);
  });

  it('defers an attached Run when execute has a transient unconfirmed outcome', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'ready', run: preparedRun() });
    const runtime = new FakeRuntime({
      execute: new AgentRuntimeRequestError(
        'AI_RUNTIME_UNAVAILABLE',
        'credential-bearing detail must not persist',
        'unknown',
      ),
    });

    await createWorker(queue, runs, runtime).runOnce();

    expect(runs.attached).toHaveLength(1);
    expect(runs.unknown).toHaveLength(0);
    expect(queue.deferred[0]).toMatchObject({ reasonCode: 'AI_RUNTIME_UNAVAILABLE' });
    expect(JSON.stringify(queue.deferred)).not.toContain('credential-bearing');
  });

  it('fails a definitive create rejection and does not attempt attach or execute', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'ready', run: preparedRun() });
    const runtime = new FakeRuntime({
      create: new AgentRuntimeRequestError('AI_RUNTIME_HTTP_400', 'bad request detail', 'failed'),
    });

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toEqual(['create']);
    expect(runs.attached).toHaveLength(0);
    expect(runs.failed[0]).toMatchObject({ errorCode: 'AI_RUNTIME_HTTP_400' });
    expect(queue.failed[0]).toMatchObject({ errorCode: 'AI_RUNTIME_HTTP_400' });
  });

  it('reconciles terminal database state without invoking Runtime', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({
      kind: 'terminal',
      status: 'SUCCEEDED',
      externalRunId: EXTERNAL_ID,
      errorCode: null,
    });
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toHaveLength(0);
    expect(queue.published[0]).toMatchObject({ externalRunId: EXTERNAL_ID });
  });

  it('fails malformed outbox payloads before reading Agent Run state', async () => {
    const queue = new FakeQueue([event({ payload: { runId: 'not-the-aggregate' } })]);
    const runs = new FakeRuns({ kind: 'ambiguous_dispatch' });
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runOnce();

    expect(runs.prepareCalls).toBe(0);
    expect(runs.failed[0]).toMatchObject({
      runId: RUN_ID,
      errorCode: 'MALFORMED_AGENT_RUN_EVENT',
    });
    expect(queue.failed[0]).toMatchObject({ errorCode: 'MALFORMED_AGENT_RUN_EVENT' });
  });
});

describe('validateGroundedOutput', () => {
  it('只保留本次检索到的 chunk，并按正文首次出现顺序转换为来源序号', () => {
    const first = knowledgeSource({
      chunkId: '00000000-0000-7000-8000-000000000611',
      title: '产品手册',
    });
    const second = knowledgeSource({
      chunkId: '00000000-0000-7000-8000-000000000612',
      title: '服务规范',
    });
    const fakeId = '00000000-0000-7000-8000-000000000699';

    const result = validateGroundedOutput(
      `先看 [SOURCE:${second.chunkId}]，再看 [SOURCE:${first.chunkId}]。` +
        `重复 [source:${second.chunkId}]，伪造 [SOURCE:${fakeId}]。`,
      preparedRun({
        knowledgeGroundingRequired: true,
        knowledgeSources: [first, second],
      }),
    );

    expect(result.citations).toEqual([second, first]);
    expect(result.content).toBe('先看 [来源1]，再看 [来源2]。重复 [来源1]，伪造 。');
    expect(result.content).not.toContain('SOURCE:');
    expect(result.content).not.toContain(first.chunkId);
    expect(result.content).not.toContain(fakeId);
  });

  it('清理模型自带的可见来源编号，只保留由合法 SOURCE 标记生成的编号', () => {
    const source = knowledgeSource();

    const result = validateGroundedOutput(
      `伪造结论 [来源1]。可信结论 [SOURCE:${source.chunkId}]。` + `再次伪造 [ 来源 99 ]。`,
      preparedRun({
        knowledgeGroundingRequired: true,
        knowledgeSources: [source],
      }),
    );

    expect(result.citations).toEqual([source]);
    expect(result.content).toBe('伪造结论 。可信结论 [来源1]。再次伪造 。');
    expect(result.content.match(/\[来源1\]/g)).toHaveLength(1);
    expect(result.content).not.toContain('来源99');
  });

  it.each([
    { name: '本次检索无来源', sources: [], content: '似是而非的回答' },
    {
      name: '模型未引用有效来源',
      sources: [knowledgeSource()],
      content: '似是而非的回答',
    },
    {
      name: '模型只引用伪造来源',
      sources: [knowledgeSource()],
      content: '回答 [SOURCE:00000000-0000-7000-8000-000000000699]',
    },
  ])('知识绑定且$name时返回安全无答案', ({ sources, content }) => {
    const result = validateGroundedOutput(
      content,
      preparedRun({ knowledgeGroundingRequired: true, knowledgeSources: sources }),
    );

    expect(result).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
      citations: [],
    });
  });

  it('未绑定知识库时保留模型回答，不伪造引用', () => {
    expect(validateGroundedOutput('通用回答', preparedRun())).toEqual({
      content: '通用回答',
      citations: [],
    });
  });
});

const EVENT_ID = '00000000-0000-7000-8000-000000000801';
const TENANT_ID = '00000000-0000-7000-8000-000000000009';
const RUN_ID = '00000000-0000-7000-8000-000000000802';
const EXTERNAL_ID = '00000000-0000-7000-8000-000000000803';

function event(overrides: Partial<ClaimedAgentRunEvent> = {}): ClaimedAgentRunEvent {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    aggregateId: RUN_ID,
    eventType: 'agent.run_requested.v1',
    payload: { runId: RUN_ID },
    attempts: 1,
    firstAttemptedAt: new Date('2026-07-15T00:00:01.000Z'),
    leaseExpiresAt: new Date(Date.now() + 120_000),
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    ...overrides,
  };
}

function preparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    id: RUN_ID,
    tenantId: TENANT_ID,
    conversationId: '00000000-0000-7000-8000-000000000804',
    requesterUserId: '00000000-0000-7000-8000-000000000901',
    requesterRole: 'MEMBER',
    agentId: '00000000-0000-7000-8000-000000000201',
    agentName: 'Agent A',
    agentVersionId: '00000000-0000-7000-8000-000000000301',
    agentVersion: 1,
    systemPrompt: 'Be useful.',
    externalRunId: null,
    turnIndex: 1,
    turnLimit: 1,
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    messages: [
      {
        senderType: 'USER',
        senderId: '00000000-0000-7000-8000-000000000901',
        senderName: 'Requester',
        text: 'question',
      },
    ],
    ...overrides,
  };
}

function knowledgeSource(
  overrides: Partial<AgentRunKnowledgeSource> = {},
): AgentRunKnowledgeSource {
  return {
    documentId: '00000000-0000-7000-8000-000000000601',
    documentVersionId: '00000000-0000-7000-8000-000000000602',
    chunkId: '00000000-0000-7000-8000-000000000603',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000604',
    knowledgeBaseName: '企业制度库',
    title: '请假制度',
    documentVersion: 3,
    headingPath: ['人事制度', '年假'],
    sourceType: 'MARKDOWN',
    excerpt: '年假申请的相关说明。',
    updatedAt: '2026-07-20T02:00:00.000Z',
    ...overrides,
  };
}

function createWorker(
  queue: AgentRunQueueRepository,
  runs: AgentRunRepository,
  runtime: AgentRuntimeClient,
): AgentRunWorker {
  const values = validateEnvironment({
    NODE_ENV: 'test',
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: 'postgresql://localhost/test',
    AGENT_RUN_WORKER_ENABLED: 'true',
  });
  return new AgentRunWorker(
    new ConfigService<EnvironmentVariables, true>(values),
    queue,
    runs,
    runtime,
  );
}

class FakeQueue extends AgentRunQueueRepository {
  published: Array<Parameters<AgentRunQueueRepository['markPublished']>[0]> = [];
  failed: Array<Parameters<AgentRunQueueRepository['markFailed']>[0]> = [];
  unknown: Array<Parameters<AgentRunQueueRepository['markUnknown']>[0]> = [];
  deferred: Array<Parameters<AgentRunQueueRepository['defer']>[0]> = [];

  constructor(private readonly events: readonly ClaimedAgentRunEvent[]) {
    super();
  }

  claim(): Promise<readonly ClaimedAgentRunEvent[]> {
    return Promise.resolve(this.events);
  }

  markPublished(input: Parameters<AgentRunQueueRepository['markPublished']>[0]): Promise<boolean> {
    this.published.push(input);
    return Promise.resolve(true);
  }

  markFailed(input: Parameters<AgentRunQueueRepository['markFailed']>[0]): Promise<boolean> {
    this.failed.push(input);
    return Promise.resolve(true);
  }

  markUnknown(input: Parameters<AgentRunQueueRepository['markUnknown']>[0]): Promise<boolean> {
    this.unknown.push(input);
    return Promise.resolve(true);
  }

  defer(input: Parameters<AgentRunQueueRepository['defer']>[0]): Promise<boolean> {
    this.deferred.push(input);
    return Promise.resolve(true);
  }
}

class FakeRuns extends AgentRunRepository {
  prepareCalls = 0;
  attached: Array<{ tenantId: string; runId: string; externalRunId: string }> = [];
  succeeded: Array<{
    tenantId: string;
    runId: string;
    output: string;
    citations: readonly AgentRunKnowledgeSource[];
    usage: AgentRunUsage | undefined;
  }> = [];
  failed: Array<{
    tenantId: string;
    runId: string;
    errorCode: string;
    safeMessage: string;
    usage: AgentRunUsage | undefined;
  }> = [];
  unknown: Array<{
    tenantId: string;
    runId: string;
    errorCode: string;
    usage: AgentRunUsage | undefined;
  }> = [];

  constructor(private readonly preparation: AgentRunPreparation) {
    super();
  }

  prepare(): Promise<AgentRunPreparation> {
    this.prepareCalls += 1;
    return Promise.resolve(this.preparation);
  }

  attachExternalRun(tenantId: string, runId: string, externalRunId: string): Promise<void> {
    this.attached.push({ tenantId, runId, externalRunId });
    return Promise.resolve();
  }

  completeSucceeded(
    tenantId: string,
    runId: string,
    output: string,
    citations: readonly AgentRunKnowledgeSource[] = [],
    usage?: AgentRunUsage,
  ): Promise<{ outputMessageId: string; externalRunId: string | null }> {
    this.succeeded.push({ tenantId, runId, output, citations, usage });
    return Promise.resolve({
      outputMessageId: '00000000-0000-7000-8000-000000000805',
      externalRunId: EXTERNAL_ID,
    });
  }

  completeFailed(
    tenantId: string,
    runId: string,
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
  ): Promise<void> {
    this.failed.push({ tenantId, runId, errorCode, safeMessage, usage });
    return Promise.resolve();
  }

  completeUnknown(
    tenantId: string,
    runId: string,
    errorCode: string,
    usage?: AgentRunUsage,
  ): Promise<void> {
    this.unknown.push({ tenantId, runId, errorCode, usage });
    return Promise.resolve();
  }
}

class FakeRuntime extends AgentRuntimeClient {
  calls: string[] = [];
  private readonly createResult: RuntimeRunResult | Error;
  private readonly executeResult: RuntimeRunResult | Error;
  private readonly getResult: RuntimeRunResult | Error;

  constructor(
    results: {
      create?: RuntimeRunResult | Error;
      execute?: RuntimeRunResult | Error;
      get?: RuntimeRunResult | Error;
    } = {},
  ) {
    super();
    this.createResult = results.create ?? { runId: EXTERNAL_ID, status: 'queued' };
    this.executeResult = results.execute ?? succeededResult('answer');
    this.getResult = results.get ?? { runId: EXTERNAL_ID, status: 'running' };
  }

  create(): Promise<RuntimeRunResult> {
    this.calls.push('create');
    return resultOrThrow(this.createResult);
  }

  execute(): Promise<RuntimeRunResult> {
    this.calls.push('execute');
    return resultOrThrow(this.executeResult);
  }

  get(): Promise<RuntimeRunResult> {
    this.calls.push('get');
    return resultOrThrow(this.getResult);
  }

  cancel(): Promise<RuntimeRunResult> {
    this.calls.push('cancel');
    return Promise.resolve({ runId: EXTERNAL_ID, status: 'cancelled' });
  }
}

function succeededResult(content: string): RuntimeRunResult {
  return {
    runId: EXTERNAL_ID,
    status: 'succeeded',
    output: { content, model: 'model-a', provider: 'openai_compatible' },
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      toolCalls: 0,
      costMicros: 25,
      tokensReported: true,
      costReported: true,
    },
  };
}

function resultOrThrow(value: RuntimeRunResult | Error): Promise<RuntimeRunResult> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}
