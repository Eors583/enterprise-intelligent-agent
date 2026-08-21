import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiBaseUrl = process.env.KNOWLEDGE_SMOKE_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const credentials = {
  tenantSlug: process.env.KNOWLEDGE_SMOKE_TENANT ?? 'future-collaboration',
  email: process.env.KNOWLEDGE_SMOKE_EMAIL ?? 'lin.xiao@example.local',
  password: process.env.KNOWLEDGE_SMOKE_PASSWORD ?? 'DevPassword!2026',
  sessionLabel: 'Enterprise knowledge E2E',
};
const expectedTitleByQuery = new Map([
  ['P1 incident response target and escalation owner', 'incident-response-policy'],
  ['Which team owns the Payment API and what does it depend on?', 'service-ownership-handbook'],
  ['What is the Q2 uptime for Identity API?', 'quarterly-service-metrics'],
  ['What is the target citation accuracy in the rollout plan?', 'knowledge-rollout-plan'],
]);
const unsupportedQuery = 'What is the authorization code for lunar base Zephyr?';

let cookie = '';
let csrf = '';

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && options.method !== undefined && options.method !== 'GET') {
    headers.set('x-csrf-token', csrf);
  }
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    body:
      options.body === undefined || options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return { response, body };
}

async function login() {
  const { response, body } = await request('/auth/browser/login', {
    method: 'POST',
    body: credentials,
  });
  const values = response.headers.getSetCookie();
  const cookies = values.map((value) => value.split(';', 1)[0]);
  cookie = cookies.join('; ');
  const csrfCookie = cookies.find((value) => value.startsWith('ea_csrf='));
  if (!csrfCookie) throw new Error('Browser login did not issue a CSRF cookie.');
  csrf = decodeURIComponent(csrfCookie.slice('ea_csrf='.length));
  return body.account;
}

async function verifyNoAnswer(knowledgeBaseId) {
  const { body } = await request(`/admin/knowledge-bases/${knowledgeBaseId}/retrieval-test`, {
    method: 'POST',
    body: { query: unsupportedQuery, limit: 8 },
  });
  if (!body.noAnswer || body.items.length !== 0) {
    throw new Error(
      `Unsupported query returned ${body.items.length} evidence item(s): ${unsupportedQuery}\n${JSON.stringify(
        body.items.map((item) => ({
          title: item.title,
          excerpt: item.excerpt?.slice(0, 180) ?? null,
          keywordScore: item.keywordScore,
          fuzzyScore: item.fuzzyScore,
          semanticScore: item.semanticScore,
          fusionScore: item.fusionScore,
          rerankerScore: item.rerankerScore,
          relationshipScore: item.relationshipScore,
          finalScore: item.finalScore,
        })),
        null,
        2,
      )}`,
    );
  }
  return {
    query: unsupportedQuery,
    noAnswer: body.noAnswer,
    itemCount: body.items.length,
    mode: body.mode,
    reranker: body.reranker,
    degradedReason: body.degradedReason,
    diagnostics: body.diagnostics,
  };
}

async function verifyStructuredWorkbookQuery(knowledgeBaseId) {
  const query = 'Identity API 第二季度比第一季度的可用率环比提高多少？';
  const { body } = await request(`/admin/knowledge-bases/${knowledgeBaseId}/retrieval-test`, {
    method: 'POST',
    body: { query, limit: 8 },
  });
  const sqlApplied = body.diagnostics?.some(
    (diagnostic) => diagnostic.code === 'KNOWLEDGE_SQL_WORKBOOK_QUERY_APPLIED',
  );
  if (
    body.noAnswer ||
    body.items.length === 0 ||
    body.queryRoute?.primary !== 'SQL' ||
    !body.structuredQuerySql ||
    !sqlApplied ||
    body.items[0].title !== 'quarterly-service-metrics'
  ) {
    throw new Error(
      `Structured workbook query was not executed through the SQL route: ${JSON.stringify({
        queryRoute: body.queryRoute,
        structuredQuerySql: body.structuredQuerySql,
        diagnostics: body.diagnostics,
        noAnswer: body.noAnswer,
        topTitle: body.items[0]?.title ?? null,
      })}`,
    );
  }
  return {
    query,
    route: body.queryRoute.primary,
    topTitle: body.items[0].title,
    answer: body.items[0].excerpt,
    sql: body.structuredQuerySql,
    elapsedMs: body.elapsedMs,
  };
}

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  return {
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
  }[extension];
}

async function upload(knowledgeBaseId, path) {
  const bytes = await readFile(path);
  const type = mimeType(path);
  if (!type) throw new Error(`No MIME mapping for ${path}`);
  const name = basename(path);
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }), name);
  form.append('title', name.replace(/\.[^.]+$/u, ''));
  const { body } = await request(`/admin/knowledge-bases/${knowledgeBaseId}/documents/upload`, {
    method: 'POST',
    body: form,
  });
  return body;
}

async function waitForReady(knowledgeBaseId, document) {
  const deadline = Date.now() + 12 * 60_000;
  const versionId = document.versions[0].id;
  while (Date.now() < deadline) {
    const { body } = await request(
      `/admin/knowledge-bases/${knowledgeBaseId}/documents/${document.id}`,
    );
    const version = body.versions.find((item) => item.id === versionId);
    if (version?.status === 'READY') return { document: body, version };
    if (version?.status === 'FAILED' || version?.ingestionJob?.status === 'FAILED') {
      throw new Error(
        `${document.title} ingestion failed: ${version?.ingestionJob?.errorCode ?? 'UNKNOWN'} ${version?.ingestionJob?.errorMessage ?? ''}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`${document.title} ingestion timed out.`);
}

async function verifyExisting(account, knowledgeBaseId) {
  const { body: list } = await request('/admin/knowledge-bases');
  const knowledgeBase = list.items.find((item) => item.id === knowledgeBaseId);
  if (!knowledgeBase) throw new Error(`Knowledge base ${knowledgeBaseId} was not found.`);
  const documents = knowledgeBase.documents.map((document) => {
    const version = document.versions.find((item) => item.id === document.currentVersionId);
    if (!version || version.status !== 'READY') {
      throw new Error(`${document.title} does not have a published READY version.`);
    }
    return { document, version };
  });
  const structured = [];
  for (const item of documents) {
    const { body: preview } = await request(
      `/admin/knowledge-bases/${knowledgeBaseId}/documents/${item.document.id}/versions/${item.version.id}/structured`,
    );
    structured.push({
      title: item.document.title,
      format: preview.format,
      size: preview.size,
      truncated: preview.truncated,
    });
  }
  const queries = [
    'P1 incident response target and escalation owner',
    'Which team owns the Payment API and what does it depend on?',
    'What is the Q2 uptime for Identity API?',
    'What is the target citation accuracy in the rollout plan?',
  ];
  const retrieval = [];
  for (const query of queries) {
    const { body } = await request(`/admin/knowledge-bases/${knowledgeBaseId}/retrieval-test`, {
      method: 'POST',
      body: { query, limit: 8 },
    });
    if (body.noAnswer || body.items.length === 0) {
      throw new Error(`Retrieval returned no evidence for: ${query}`);
    }
    const expectedTitle = expectedTitleByQuery.get(query);
    if (expectedTitle && body.items[0].title !== expectedTitle) {
      throw new Error(
        `Retrieval ranked ${body.items[0].title} first for ${query}; expected ${expectedTitle}.`,
      );
    }
    retrieval.push({
      query,
      mode: body.mode,
      reranker: body.reranker,
      degradedReason: body.degradedReason,
      topTitle: body.items[0].title,
      topScore: body.items[0].finalScore,
      itemCount: body.items.length,
      diagnostics: body.diagnostics,
      items: body.items.map((item) => ({
        title: item.title,
        finalScore: item.finalScore,
        rerankerScore: item.rerankerScore,
        fusionScore: item.fusionScore,
        keywordScore: item.keywordScore,
        semanticScore: item.semanticScore,
        relationshipScore: item.relationshipScore,
      })),
    });
  }
  const structuredQuery = await verifyStructuredWorkbookQuery(knowledgeBaseId);
  const negativeRetrieval = await verifyNoAnswer(knowledgeBaseId);
  const readiness = await request(`/admin/knowledge-bases/${knowledgeBaseId}/readiness`);
  const report = {
    completedAt: new Date().toISOString(),
    reusedExistingKnowledgeBase: true,
    account: { tenantId: account.tenantId, userId: account.userId, role: account.role },
    knowledgeBase: {
      id: knowledgeBase.id,
      key: knowledgeBase.key,
      status: knowledgeBase.status,
      documentCount: knowledgeBase.documentCount,
    },
    documents: documents.map((item) => ({
      id: item.document.id,
      title: item.document.title,
      sourceType: item.version.sourceType,
      mimeType: item.version.mimeType,
      chunkCount: item.version.chunkCount,
      parserName: item.version.parserName,
      parseQualityScore: item.version.parseQualityScore,
      structuredArtifact: item.version.structuredArtifact,
    })),
    structured,
    retrieval,
    structuredQuery,
    negativeRetrieval,
    knowledgeReadiness: readiness,
  };
  const reportDirectory = resolve(root, '.data', 'knowledge-smoke');
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, 'e2e-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
}

async function main() {
  const account = await login();
  if (process.env.KNOWLEDGE_SMOKE_NEGATIVE_ONLY && process.env.KNOWLEDGE_SMOKE_KB_ID) {
    console.log(JSON.stringify(await verifyNoAnswer(process.env.KNOWLEDGE_SMOKE_KB_ID), null, 2));
    return;
  }
  if (process.env.KNOWLEDGE_SMOKE_KB_ID) {
    await verifyExisting(account, process.env.KNOWLEDGE_SMOKE_KB_ID);
    return;
  }
  const unique = Date.now().toString(36);
  const { body: knowledgeBase } = await request('/admin/knowledge-bases', {
    method: 'POST',
    body: {
      key: `rag-smoke-${unique}`,
      name: `企业知识库验收 ${unique}`,
      description: 'MinIO + Docling + Qdrant hybrid retrieval end-to-end acceptance',
      status: 'DRAFT',
      orgUnitIds: [],
      orgUnitScopes: [],
      retrievalConfig: {
        mode: 'HYBRID',
        topK: 8,
        scoreThreshold: 0.05,
        semanticWeight: 0.7,
        keywordWeight: 0.3,
        rerankEnabled: true,
        relationshipRetrievalEnabled: true,
        maxChunksPerDocument: 3,
      },
      chunkingConfig: { targetTokens: 300, overlapTokens: 50 },
    },
  });

  const fixtureDirectory = resolve(root, '.data', 'knowledge-smoke', 'fixtures');
  const paths = [
    resolve('C:/Users/PC/Documents/企业级知识库搭建指南.md'),
    resolve(fixtureDirectory, 'incident-response-policy.pdf'),
    resolve(fixtureDirectory, 'service-ownership-handbook.docx'),
    resolve(fixtureDirectory, 'quarterly-service-metrics.xlsx'),
    resolve(fixtureDirectory, 'knowledge-rollout-plan.pptx'),
    resolve(fixtureDirectory, 'incident-dashboard.png'),
  ];
  const uploaded = [];
  for (const path of paths) uploaded.push(await upload(knowledgeBase.id, path));

  const ready = [];
  for (const document of uploaded) ready.push(await waitForReady(knowledgeBase.id, document));

  const structured = [];
  for (const item of ready) {
    const { body: preview } = await request(
      `/admin/knowledge-bases/${knowledgeBase.id}/documents/${item.document.id}/versions/${item.version.id}/structured`,
    );
    structured.push({
      title: item.document.title,
      format: preview.format,
      size: preview.size,
      truncated: preview.truncated,
    });
    await request(
      `/admin/knowledge-bases/${knowledgeBase.id}/documents/${item.document.id}/versions/${item.version.id}/publish`,
      { method: 'POST', body: {} },
    );
  }

  const { body: activeKnowledgeBase } = await request(
    `/admin/knowledge-bases/${knowledgeBase.id}`,
    { method: 'PATCH', body: { status: 'ACTIVE', expectedVersion: knowledgeBase.version } },
  );

  const queries = [
    'P1 incident response target and escalation owner',
    'Which team owns the Payment API and what does it depend on?',
    'What is the Q2 uptime for Identity API?',
    'What is the target citation accuracy in the rollout plan?',
  ];
  const retrieval = [];
  for (const query of queries) {
    const { body } = await request(`/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`, {
      method: 'POST',
      body: { query, limit: 8 },
    });
    if (body.noAnswer || body.items.length === 0) {
      throw new Error(`Retrieval returned no evidence for: ${query}`);
    }
    const expectedTitle = expectedTitleByQuery.get(query);
    if (expectedTitle && body.items[0].title !== expectedTitle) {
      throw new Error(
        `Retrieval ranked ${body.items[0].title} first for ${query}; expected ${expectedTitle}.`,
      );
    }
    retrieval.push({
      query,
      mode: body.mode,
      reranker: body.reranker,
      degradedReason: body.degradedReason,
      topTitle: body.items[0].title,
      topScore: body.items[0].finalScore,
      itemCount: body.items.length,
    });
  }
  const structuredQuery = await verifyStructuredWorkbookQuery(knowledgeBase.id);
  const negativeRetrieval = await verifyNoAnswer(knowledgeBase.id);

  const readiness = await request(`/admin/knowledge-bases/${knowledgeBase.id}/readiness`);

  const report = {
    completedAt: new Date().toISOString(),
    account: { tenantId: account.tenantId, userId: account.userId, role: account.role },
    knowledgeBase: {
      id: activeKnowledgeBase.id,
      key: activeKnowledgeBase.key,
      status: activeKnowledgeBase.status,
      documentCount: activeKnowledgeBase.documentCount,
    },
    documents: ready.map((item) => ({
      id: item.document.id,
      title: item.document.title,
      sourceType: item.version.sourceType,
      mimeType: item.version.mimeType,
      chunkCount: item.version.chunkCount,
      parserName: item.version.parserName,
      parseQualityScore: item.version.parseQualityScore,
      structuredArtifact: item.version.structuredArtifact,
    })),
    structured,
    retrieval,
    structuredQuery,
    negativeRetrieval,
    knowledgeReadiness: readiness,
  };
  const reportDirectory = resolve(root, '.data', 'knowledge-smoke');
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, 'e2e-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
}

await main();
