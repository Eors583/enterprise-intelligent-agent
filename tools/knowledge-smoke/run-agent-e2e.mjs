import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiBaseUrl = process.env.KNOWLEDGE_AGENT_SMOKE_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const tenantSlug = process.env.KNOWLEDGE_AGENT_SMOKE_TENANT ?? 'future-collaboration';
const requesterEmail =
  process.env.KNOWLEDGE_AGENT_SMOKE_REQUESTER_EMAIL ?? 'lin.xiao@example.local';
const requesterPassword =
  process.env.KNOWLEDGE_AGENT_SMOKE_REQUESTER_PASSWORD ?? 'DevPassword!2026';
const otherMemberEmail =
  process.env.KNOWLEDGE_AGENT_SMOKE_OTHER_MEMBER_EMAIL ?? 'chen.yao@example.local';
const otherMemberPassword =
  process.env.KNOWLEDGE_AGENT_SMOKE_OTHER_MEMBER_PASSWORD ?? 'DevPassword!2026';
const question =
  process.env.KNOWLEDGE_AGENT_SMOKE_QUESTION ??
  '请根据知识库回答：青杉-0727 对应的知识库验收信息是什么？只回答知识库中有依据的内容并注明来源。';
const expectedAnswer = process.env.KNOWLEDGE_AGENT_SMOKE_EXPECTED_ANSWER ?? '青杉-0727';
const configuredAgentId = process.env.KNOWLEDGE_AGENT_SMOKE_AGENT_ID?.trim() || null;
const timeoutMs = positiveInteger(
  process.env.KNOWLEDGE_AGENT_SMOKE_TIMEOUT_MS,
  150_000,
  'KNOWLEDGE_AGENT_SMOKE_TIMEOUT_MS',
);

const requester = await login(requesterEmail, requesterPassword, 'Knowledge Agent E2E requester');
const bootstrap = await jsonRequest('/bootstrap', { token: requester.accessToken });
const agent = selectAgent(bootstrap);
if (agent.operationalAvailability?.status !== 'AVAILABLE') {
  throw new Error(
    `Agent ${agent.id} is not operationally available: ${agent.operationalAvailability?.status ?? 'UNKNOWN'} ` +
      `(${(agent.operationalAvailability?.reasonCodes ?? []).join(', ') || 'no reason code'})`,
  );
}

const conversation = await jsonRequest('/conversations', {
  method: 'POST',
  token: requester.accessToken,
  body: { type: 'direct', target: { type: 'agent', agentId: agent.id } },
});
const clientMessageId = `knowledge-agent-smoke-${randomUUID()}`;
const inputMessage = await jsonRequest(`/conversations/${conversation.id}/messages`, {
  method: 'POST',
  token: requester.accessToken,
  headers: { 'Idempotency-Key': clientMessageId },
  body: {
    clientMessageId,
    content: { type: 'text', text: question },
    responseTarget: { type: 'agent', agentId: agent.id },
  },
});

const completed = await waitForRun(conversation.id, inputMessage.id, requester.accessToken);
if (completed.run.status !== 'SUCCEEDED') {
  throw new Error(
    `Agent Run ${completed.run.id} ended as ${completed.run.status}: ` +
      `${completed.run.errorCode ?? 'NO_ERROR_CODE'} ${completed.run.errorMessage ?? ''}`,
  );
}
const answer = completed.messages.items.find(
  (message) => message.id === completed.run.outputMessageId,
);
if (answer?.sender?.type !== 'agent' || answer.content?.type !== 'text') {
  throw new Error('Succeeded Agent Run did not produce a bound Agent text message.');
}
if (!answer.content.text.includes(expectedAnswer)) {
  throw new Error(`Agent answer did not contain the expected evidence text: ${expectedAnswer}`);
}
const citations = answer.content.citations ?? [];
if (citations.length === 0) throw new Error('Agent answer did not contain a knowledge citation.');
if (citations.some((citation) => citation.verificationStatus !== 'LINEAGE_VERIFIED')) {
  throw new Error('Agent answer contained a citation without verified document/chunk lineage.');
}

const firstCitation = citations[0];
if (firstCitation.documentVersionId === null || firstCitation.chunkId === null) {
  throw new Error('Verified citation did not contain a document version and chunk id.');
}
const citationPath =
  `/knowledge-citations/${encodeURIComponent(firstCitation.documentVersionId)}` +
  `/chunks/${encodeURIComponent(firstCitation.chunkId)}` +
  `?messageId=${encodeURIComponent(answer.id)}`;
const requesterCitation = await rawRequest(citationPath, { token: requester.accessToken });
if (requesterCitation.response.status !== 200) {
  throw new Error(
    `The requesting employee could not reopen the cited source (${requesterCitation.response.status}).`,
  );
}

const otherMember = await login(
  otherMemberEmail,
  otherMemberPassword,
  'Knowledge Agent E2E boundary member',
);
const foreignCitation = await rawRequest(citationPath, { token: otherMember.accessToken });
if (foreignCitation.response.status !== 404) {
  throw new Error(
    `Citation boundary failed closed: another member received ${foreignCitation.response.status}, expected 404.`,
  );
}

const report = {
  checkedAt: new Date().toISOString(),
  apiBaseUrl,
  tenantSlug,
  requester: {
    userId: bootstrap.currentUser.id,
    name: bootstrap.currentUser.name,
  },
  agent: {
    id: agent.id,
    name: agent.name,
    operationalStatus: agent.operationalAvailability.status,
    evidenceStatus: agent.operationalAvailability.evidenceStatus,
  },
  conversationId: conversation.id,
  inputMessageId: inputMessage.id,
  run: {
    id: completed.run.id,
    status: completed.run.status,
  },
  answer: {
    messageId: answer.id,
    text: answer.content.text,
    expectedAnswer,
  },
  citations: citations.map((citation) => ({
    knowledgeBaseId: citation.knowledgeBaseId,
    knowledgeBaseName: citation.knowledgeBaseName,
    documentId: citation.documentId,
    documentVersionId: citation.documentVersionId,
    chunkId: citation.chunkId,
    title: citation.title,
    verificationStatus: citation.verificationStatus,
  })),
  permissionBoundary: {
    requesterCitationStatus: requesterCitation.response.status,
    otherMemberCitationStatus: foreignCitation.response.status,
    expectedOtherMemberStatus: 404,
    passed: true,
  },
};

const reportDirectory = resolve(root, '.data', 'knowledge-smoke');
await mkdir(reportDirectory, { recursive: true });
await writeFile(
  resolve(reportDirectory, 'agent-e2e-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(report, null, 2));

function selectAgent(payload) {
  const memberAgents = (payload.members ?? []).flatMap((member) =>
    member.agent == null ? [] : [{ ...member.agent, ownerUserId: member.id }],
  );
  const departmentAgents = payload.departmentAgents ?? [];
  const candidates = [...memberAgents, ...departmentAgents];
  if (configuredAgentId !== null) {
    const configured = candidates.find((candidate) => candidate.id === configuredAgentId);
    if (configured === undefined) {
      throw new Error(`Configured Agent ${configuredAgentId} is not visible to the requester.`);
    }
    return configured;
  }
  const personal = memberAgents.find(
    (candidate) => candidate.ownerUserId === payload.currentUser?.id,
  );
  if (personal !== undefined) return personal;
  const available = candidates.find(
    (candidate) => candidate.operationalAvailability?.status === 'AVAILABLE',
  );
  if (available === undefined) throw new Error('No visible and operational Agent is available.');
  return available;
}

async function waitForRun(conversationId, inputMessageId, token) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await jsonRequest(`/conversations/${conversationId}/messages?limit=100`, {
      token,
    });
    const run = (messages.runs ?? []).find(
      (candidate) => candidate.inputMessageId === inputMessageId,
    );
    if (run !== undefined && ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(run.status)) {
      return { run, messages };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Agent Run did not reach a terminal state within ${timeoutMs} ms.`);
}

async function login(email, password, sessionLabel) {
  const session = await jsonRequest('/auth/login', {
    method: 'POST',
    body: { tenantSlug, email, password, sessionLabel },
  });
  if (typeof session.accessToken !== 'string') {
    throw new Error(`Login for ${email} did not return an access token.`);
  }
  return session;
}

async function jsonRequest(path, options = {}) {
  const result = await rawRequest(path, options);
  if (!result.response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${path} failed with ${result.response.status}: ${safeMessage(result.body)}`,
    );
  }
  return result.body;
}

async function rawRequest(path, options = {}) {
  const headers = {
    accept: 'application/json',
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(options.headers ?? {}),
  };
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: 'Non-JSON response body was omitted.' };
    }
  }
  return { response, body };
}

function safeMessage(value) {
  if (typeof value?.message === 'string') return value.message.slice(0, 500);
  if (Array.isArray(value?.message)) return value.message.join('; ').slice(0, 500);
  return 'No safe diagnostic message was returned.';
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
