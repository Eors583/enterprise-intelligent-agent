import { ConfigService } from '@nestjs/config';

import { validateEnvironment, type EnvironmentVariables } from '../../../config/environment.js';
import { AgentRunQueueRepository } from '../domain/agent-run-queue.repository.js';
import type {
  AgentRunCancellationPreparation,
  AgentRunExternalAttachment,
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
  type RuntimeStreamEvent,
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

  it('fails closed before Runtime dispatch when verified model availability is absent', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({ kind: 'ready', run: preparedRun() });
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime, 'UNKNOWN').runOnce();

    expect(runtime.calls).toHaveLength(0);
    expect(runs.failed[0]).toMatchObject({
      runId: RUN_ID,
      errorCode: 'AGENT_OPERATIONAL_NOT_READY',
    });
    expect(queue.failed[0]).toMatchObject({ errorCode: 'AGENT_OPERATIONAL_NOT_READY' });
  });

  it('reconciles a server-controlled connectivity probe without circular readiness evidence', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({
      kind: 'ready',
      run: preparedRun({
        externalRunId: EXTERNAL_ID,
        controlledModelConnectivityProbe: true,
        maxSteps: 1,
      }),
    });
    const runtime = new FakeRuntime({ get: succeededResult('MODEL_CONNECTIVITY_OK') });

    await createWorker(queue, runs, runtime, 'UNKNOWN').runOnce();

    expect(runtime.calls).toEqual(['get']);
    expect(runs.succeeded[0]).toMatchObject({
      runId: RUN_ID,
      output: 'MODEL_CONNECTIVITY_OK',
    });
    expect(queue.published).toHaveLength(1);
    expect(queue.failed).toHaveLength(0);
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

  it('resumes the same attached Runtime Run after a stream disconnect', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns({
      kind: 'ready',
      run: preparedRun({ externalRunId: EXTERNAL_ID }),
    });
    const runtime = new StreamInterruptedRuntime({
      get: { runId: EXTERNAL_ID, status: 'running' },
    });

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toEqual(['get', 'stream']);
    expect(runs.attached).toHaveLength(0);
    expect(runs.unknown).toHaveLength(0);
    expect(queue.deferred[0]).toMatchObject({
      reasonCode: 'AI_RUNTIME_STREAM_INTERRUPTED',
    });
    expect(JSON.stringify(queue.deferred)).not.toContain('partial upstream bytes');
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

  it('durably cancels a revoked Role Agent Run before publishing the cancellation event', async () => {
    const queue = new FakeQueue([], [cancellationEvent()]);
    const runs = new FakeRuns(
      {
        kind: 'terminal',
        status: 'CANCELLED',
        externalRunId: EXTERNAL_ID,
        errorCode: 'ROLE_ASSIGNMENT_REVOKED',
      },
      { cancellation: { kind: 'ready', externalRunId: EXTERNAL_ID } },
    );
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runCancellationOnce();

    expect(runs.prepareCalls).toBe(0);
    expect(runtime.calls).toEqual(['cancel']);
    expect(runs.confirmedCancellations).toEqual([
      {
        tenantId: TENANT_ID,
        runId: RUN_ID,
        externalRunId: EXTERNAL_ID,
        usage: undefined,
      },
    ]);
    expect(queue.published[0]).toMatchObject({
      eventId: EVENT_ID,
      externalRunId: EXTERNAL_ID,
    });
    expect(queue.deferred).toHaveLength(0);
  });

  it('keeps an external cancellation pending when Runtime does not confirm it', async () => {
    const queue = new FakeQueue([], [cancellationEvent()]);
    const runs = new FakeRuns(
      {
        kind: 'terminal',
        status: 'CANCELLED',
        externalRunId: EXTERNAL_ID,
        errorCode: 'ROLE_ASSIGNMENT_REVOKED',
      },
      { cancellation: { kind: 'ready', externalRunId: EXTERNAL_ID } },
    );
    const runtime = new FakeRuntime({
      cancel: new AgentRuntimeRequestError(
        'AI_RUNTIME_UNAVAILABLE',
        'provider detail must not persist',
        'unknown',
      ),
    });

    await createWorker(queue, runs, runtime).runCancellationOnce();

    expect(runtime.calls).toEqual(['cancel']);
    expect(runs.confirmedCancellations).toHaveLength(0);
    expect(queue.published).toHaveLength(0);
    expect(queue.deferred[0]).toMatchObject({ reasonCode: 'AI_RUNTIME_UNAVAILABLE' });
    expect(JSON.stringify(queue.deferred)).not.toContain('provider detail');
  });

  it('cancels instead of executing when revocation wins the create-to-attach race', async () => {
    const queue = new FakeQueue([event()]);
    const runs = new FakeRuns(
      { kind: 'ready', run: preparedRun() },
      { attachment: 'cancellation_required' },
    );
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runOnce();

    expect(runtime.calls).toEqual(['create', 'cancel']);
    expect(runs.succeeded).toHaveLength(0);
    expect(runs.confirmedCancellations).toHaveLength(1);
    expect(queue.failed[0]).toMatchObject({
      eventId: EVENT_ID,
      errorCode: 'ROLE_ASSIGNMENT_REVOKED',
    });
  });

  it('settles an already-completed cancellation event without another Runtime call', async () => {
    const queue = new FakeQueue([], [cancellationEvent()]);
    const runs = new FakeRuns(
      {
        kind: 'terminal',
        status: 'CANCELLED',
        externalRunId: EXTERNAL_ID,
        errorCode: 'ROLE_ASSIGNMENT_REVOKED',
      },
      { cancellation: { kind: 'complete', externalRunId: EXTERNAL_ID } },
    );
    const runtime = new FakeRuntime();

    await createWorker(queue, runs, runtime).runCancellationOnce();

    expect(runtime.calls).toHaveLength(0);
    expect(queue.published[0]).toMatchObject({ externalRunId: EXTERNAL_ID });
  });

  it('claims and cancels independently while the ordinary Runtime execution is blocked', async () => {
    const cancellation = cancellationEvent({
      id: '00000000-0000-7000-8000-000000000811',
    });
    const queue = new FakeQueue([event()], [cancellation]);
    const runs = new FakeRuns(
      { kind: 'ready', run: preparedRun() },
      { cancellation: { kind: 'ready', externalRunId: EXTERNAL_ID } },
    );
    const runtime = new BlockingExecuteRuntime();
    const worker = createWorker(queue, runs, runtime);

    const ordinaryTick = worker.runOnce();
    await runtime.executeStarted;

    await expect(worker.runCancellationOnce()).resolves.toBe(1);
    expect(runtime.calls).toEqual(['create', 'execute', 'cancel']);
    expect(queue.published).toContainEqual(
      expect.objectContaining({
        eventId: cancellation.id,
        workerId: expect.stringContaining(':cancel'),
      }),
    );

    runtime.releaseExecution({ runId: EXTERNAL_ID, status: 'cancelled' });
    await ordinaryTick;
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
    const result = validateGroundedOutput(
      `先看服务规范。[SOURCE:${second.chunkId}]\n\n` +
        `再看产品手册并复核服务规范。[SOURCE:${first.chunkId}] [source:${second.chunkId}]`,
      preparedRun({
        knowledgeGroundingRequired: true,
        knowledgeSources: [first, second],
      }),
    );

    expect(result.citations).toEqual([second, first]);
    expect(result.content).toBe(
      '先看服务规范。 [来源1]\n\n再看产品手册并复核服务规范。 [来源2] [来源1]',
    );
    expect(result.content).not.toContain('SOURCE:');
    expect(result.content).not.toContain(first.chunkId);
  });

  it('清理模型自带的可见来源编号，只保留由合法 SOURCE 标记生成的编号', () => {
    const source = knowledgeSource();

    const result = validateGroundedOutput(
      `可信结论 [来源1]，模型还声称 [ 来源 99 ]。[SOURCE:${source.chunkId}]`,
      preparedRun({
        knowledgeGroundingRequired: true,
        knowledgeSources: [source],
      }),
    );

    expect(result.citations).toEqual([source]);
    expect(result.content).toBe('可信结论 ，模型还声称 。 [来源1]');
    expect(result.content.match(/\[来源1\]/g)).toHaveLength(1);
    expect(result.content).not.toContain('来源99');
  });

  it('接受模型把中文句号放在 SOURCE 标记之后的自然书写形式', () => {
    const source = knowledgeSource();

    const result = validateGroundedOutput(
      `知识库验收口令为青杉-0727 [SOURCE:${source.chunkId}]。`,
      preparedRun({
        knowledgeGroundingRequired: true,
        knowledgeSources: [source],
      }),
    );

    expect(result).toEqual({
      content: '知识库验收口令为青杉-0727 [来源1]',
      citations: [source],
    });
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
    {
      name: '合法来源不在段尾',
      sources: [knowledgeSource()],
      content: '回答 [SOURCE:00000000-0000-7000-8000-000000000603] 后追加无依据文字',
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

  it('任一非空段落未引用本次证据时整条回答安全降级', () => {
    const source = knowledgeSource();
    expect(
      validateGroundedOutput(
        `第一段有依据。[SOURCE:${source.chunkId}]\n\n第二段没有依据。`,
        preparedRun({ knowledgeGroundingRequired: true, knowledgeSources: [source] }),
      ),
    ).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
      citations: [],
    });
  });

  it('列表中的每个条目都必须独立引用本次证据', () => {
    const source = knowledgeSource();
    expect(
      validateGroundedOutput(
        `- 已支持的条目。[SOURCE:${source.chunkId}]\n- 未支持的条目。`,
        preparedRun({ knowledgeGroundingRequired: true, knowledgeSources: [source] }),
      ),
    ).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
      citations: [],
    });
  });

  it('同一段中的每个独立句子都必须分别引用本次证据', () => {
    const source = knowledgeSource();
    expect(
      validateGroundedOutput(
        `制度要求先审批。额度上限为一万元。[SOURCE:${source.chunkId}]`,
        preparedRun({ knowledgeGroundingRequired: true, knowledgeSources: [source] }),
      ),
    ).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
      citations: [],
    });
  });

  it('同一段中的多个句子在逐句引用后可保留各自的来源链路', () => {
    const first = knowledgeSource({
      chunkId: '00000000-0000-7000-8000-000000000613',
      title: '审批制度',
    });
    const second = knowledgeSource({
      chunkId: '00000000-0000-7000-8000-000000000614',
      title: '额度规范',
    });

    expect(
      validateGroundedOutput(
        `制度要求先审批。[SOURCE:${first.chunkId}] 额度上限为一万元。[SOURCE:${second.chunkId}]`,
        preparedRun({
          knowledgeGroundingRequired: true,
          knowledgeSources: [first, second],
        }),
      ),
    ).toEqual({
      content: '制度要求先审批。 [来源1] 额度上限为一万元。 [来源2]',
      citations: [first, second],
    });
  });

  it('超过十二个唯一来源时拒绝生成不完整的可见引用集', () => {
    const sources = Array.from({ length: 13 }, (_, index) =>
      knowledgeSource({
        chunkId: `00000000-0000-7000-8000-${String(700 + index).padStart(12, '0')}`,
      }),
    );
    const markers = sources.map((source) => `[SOURCE:${source.chunkId}]`).join(' ');
    expect(
      validateGroundedOutput(
        `来源集合过大。${markers}`,
        preparedRun({ knowledgeGroundingRequired: true, knowledgeSources: sources }),
      ),
    ).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
      citations: [],
    });
  });

  it('未绑定知识库时清理模型伪造的两类引用标记', () => {
    const source = knowledgeSource();
    expect(
      validateGroundedOutput(`通用回答 [来源8] [SOURCE:${source.chunkId}]`, preparedRun()),
    ).toEqual({
      content: '通用回答',
      citations: [],
    });
  });

  it('未绑定知识库却声称依据企业知识时安全降级', () => {
    expect(validateGroundedOutput('根据企业知识库规定，答案是 42。', preparedRun())).toEqual({
      content:
        '当前企业知识库中没有找到足够可靠的依据。你可以补充关键词，或联系知识管理员完善相关资料。',
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

function cancellationEvent(overrides: Partial<ClaimedAgentRunEvent> = {}): ClaimedAgentRunEvent {
  return event({
    eventType: 'agent.run_cancel_requested.v1',
    payload: { runId: RUN_ID, roleAssignmentId: '00000000-0000-7000-8000-000000000099' },
    ...overrides,
  });
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
    classification: 'INTERNAL',
    governanceHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    updatedAt: '2026-07-20T02:00:00.000Z',
    ...overrides,
  };
}

function createWorker(
  queue: AgentRunQueueRepository,
  runs: AgentRunRepository,
  runtime: AgentRuntimeClient,
  operationalStatus: 'AVAILABLE' | 'NOT_READY' | 'DEGRADED' | 'UNKNOWN' = 'AVAILABLE',
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
    {
      inspectAgents: (_tenantId: string, agentIds: readonly string[]) =>
        Promise.resolve(
          new Map(
            agentIds.map((agentId) => [
              agentId,
              {
                status: operationalStatus,
                evidenceStatus:
                  operationalStatus === 'AVAILABLE' ? 'VERIFIED' : 'INSUFFICIENT_EVIDENCE',
                reasonCodes:
                  operationalStatus === 'AVAILABLE' ? [] : ['RUNTIME_READINESS_UNAVAILABLE'],
                checkedAt: operationalStatus === 'AVAILABLE' ? new Date().toISOString() : null,
              },
            ]),
          ),
        ),
    } as never,
  );
}

class FakeQueue extends AgentRunQueueRepository {
  published: Array<Parameters<AgentRunQueueRepository['markPublished']>[0]> = [];
  failed: Array<Parameters<AgentRunQueueRepository['markFailed']>[0]> = [];
  unknown: Array<Parameters<AgentRunQueueRepository['markUnknown']>[0]> = [];
  deferred: Array<Parameters<AgentRunQueueRepository['defer']>[0]> = [];

  constructor(
    private readonly events: readonly ClaimedAgentRunEvent[],
    private readonly cancellationEvents: readonly ClaimedAgentRunEvent[] = [],
  ) {
    super();
  }

  claim(): Promise<readonly ClaimedAgentRunEvent[]> {
    return Promise.resolve(this.events);
  }

  claimCancellations(): Promise<readonly ClaimedAgentRunEvent[]> {
    return Promise.resolve(this.cancellationEvents);
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
  confirmedCancellations: Array<{
    tenantId: string;
    runId: string;
    externalRunId: string;
    usage: AgentRunUsage | undefined;
  }> = [];
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

  private readonly attachment: AgentRunExternalAttachment;
  private readonly cancellation: AgentRunCancellationPreparation;

  constructor(
    private readonly preparation: AgentRunPreparation,
    options: {
      readonly attachment?: AgentRunExternalAttachment;
      readonly cancellation?: AgentRunCancellationPreparation;
    } = {},
  ) {
    super();
    this.attachment = options.attachment ?? 'attached';
    this.cancellation = options.cancellation ?? { kind: 'complete', externalRunId: null };
  }

  prepare(): Promise<AgentRunPreparation> {
    this.prepareCalls += 1;
    return Promise.resolve(this.preparation);
  }

  attachExternalRun(
    tenantId: string,
    runId: string,
    externalRunId: string,
  ): Promise<AgentRunExternalAttachment> {
    this.attached.push({ tenantId, runId, externalRunId });
    return Promise.resolve(this.attachment);
  }

  prepareCancellation(): Promise<AgentRunCancellationPreparation> {
    return Promise.resolve(this.cancellation);
  }

  confirmCancellation(
    tenantId: string,
    runId: string,
    externalRunId: string,
    usage?: AgentRunUsage,
  ): Promise<void> {
    this.confirmedCancellations.push({ tenantId, runId, externalRunId, usage });
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

  recordModelExecutionEvidence(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeRuntime extends AgentRuntimeClient {
  calls: string[] = [];
  private readonly createResult: RuntimeRunResult | Error;
  private readonly executeResult: RuntimeRunResult | Error;
  private readonly getResult: RuntimeRunResult | Error;
  private readonly cancelResult: RuntimeRunResult | Error;

  constructor(
    results: {
      create?: RuntimeRunResult | Error;
      execute?: RuntimeRunResult | Error;
      get?: RuntimeRunResult | Error;
      cancel?: RuntimeRunResult | Error;
    } = {},
  ) {
    super();
    this.createResult = results.create ?? { runId: EXTERNAL_ID, status: 'queued' };
    this.executeResult = results.execute ?? succeededResult('answer');
    this.getResult = results.get ?? { runId: EXTERNAL_ID, status: 'running' };
    this.cancelResult = results.cancel ?? { runId: EXTERNAL_ID, status: 'cancelled' };
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
    return resultOrThrow(this.cancelResult);
  }
}

class BlockingExecuteRuntime extends FakeRuntime {
  private markExecuteStarted!: () => void;
  private finishExecution!: (result: RuntimeRunResult) => void;
  readonly executeStarted = new Promise<void>((resolve) => {
    this.markExecuteStarted = resolve;
  });
  private readonly executionResult = new Promise<RuntimeRunResult>((resolve) => {
    this.finishExecution = resolve;
  });

  override execute(): Promise<RuntimeRunResult> {
    this.calls.push('execute');
    this.markExecuteStarted();
    return this.executionResult;
  }

  releaseExecution(result: RuntimeRunResult): void {
    this.finishExecution(result);
  }
}

class StreamInterruptedRuntime extends FakeRuntime {
  override async *stream(): AsyncIterable<RuntimeStreamEvent> {
    this.calls.push('stream');
    throw new AgentRuntimeRequestError(
      'AI_RUNTIME_STREAM_INTERRUPTED',
      'partial upstream bytes must not become a second provider call',
      'unknown',
    );
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
