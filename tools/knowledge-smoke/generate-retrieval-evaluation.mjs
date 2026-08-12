import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = requireFromApi('@prisma/client');

const options = parseArguments(process.argv.slice(2));
const prisma = new PrismaClient();

try {
  const chunks = await prisma.$queryRawUnsafe(
    `
      SELECT
        chunk.id::text AS chunk_id,
        document.title,
        chunk.heading_path,
        chunk.content
      FROM public.knowledge_chunks chunk
      JOIN public.knowledge_documents document
        ON document.tenant_id = chunk.tenant_id
       AND document.knowledge_base_id = chunk.knowledge_base_id
       AND document.id = chunk.document_id
       AND document.current_version_id = chunk.document_version_id
       AND document.status = 'READY'
      JOIN public.knowledge_document_versions version
        ON version.tenant_id = chunk.tenant_id
       AND version.knowledge_base_id = chunk.knowledge_base_id
       AND version.document_id = chunk.document_id
       AND version.id = chunk.document_version_id
       AND version.status = 'READY'
       AND version.published_at IS NOT NULL
      WHERE chunk.knowledge_base_id = $1::uuid
        AND length(btrim(chunk.content)) >= 40
      ORDER BY document.title, chunk.chunk_index, chunk.id
    `,
    options.knowledgeBaseId,
  );
  if (chunks.length < 20)
    throw new Error(`Knowledge base has only ${chunks.length} usable current chunks.`);
  const answerableCount = options.count - options.noAnswerCount;
  const cases = Array.from({ length: options.count }, (_, index) => {
    const chunk = chunks[index % chunks.length];
    const variant = Math.floor(index / chunks.length);
    const heading = headingLabel(chunk.heading_path);
    const content = cleanText(chunk.content);
    const excerpt = questionExcerpt(content);
    const answer = cleanText(chunk.content).slice(0, 800);
    const expectedNoAnswer = index >= answerableCount;
    return {
      caseKey: `KRE.${expectedNoAnswer ? 'ACL' : 'DOC'}.${String(index + 1).padStart(3, '0')}`,
      query: expectedNoAnswer
        ? `已停用员工询问《${chunk.title}》“${heading}”中的内容：${excerpt}`
        : questionVariant(variant, chunk.title, heading, excerpt),
      expectedAnswer: expectedNoAnswer ? '该模拟用户已停用，不应返回任何知识库内容。' : answer,
      groundTruth: {
        schemaVersion: 1,
        knowledgeBaseId: options.knowledgeBaseId,
        simulatedUserId: expectedNoAnswer ? options.deniedUserId : options.answerableUserId,
        expectedNoAnswer,
        semanticRequired: !expectedNoAnswer,
        relevance: expectedNoAnswer ? {} : { [chunk.chunk_id]: 3 },
        forbiddenChunkIds: [],
        forbiddenDocumentIds: [],
        forbiddenKnowledgeBaseIds: expectedNoAnswer ? [options.knowledgeBaseId] : [],
        expectedRoute: 'DOCUMENT',
        limit: 10,
      },
    };
  });
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ output, count: cases.length, answerableCount, noAnswerCount: options.noAnswerCount })}\n`,
  );
} finally {
  await prisma.$disconnect();
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Invalid argument near ${key ?? ''}.`);
    result[key.slice(2)] = value;
  }
  const count = Number(result.count ?? 200);
  const noAnswerCount = Number(result['no-answer-count'] ?? 25);
  if (!Number.isInteger(count) || count < 200 || count > 500)
    throw new Error('--count must be 200..500.');
  if (!Number.isInteger(noAnswerCount) || noAnswerCount < 25 || noAnswerCount >= count) {
    throw new Error('--no-answer-count must be at least 25 and smaller than count.');
  }
  return {
    knowledgeBaseId: required(result, 'knowledge-base-id'),
    answerableUserId: required(result, 'answerable-user-id'),
    deniedUserId: required(result, 'denied-user-id'),
    output: result.output ?? '.data/semantic-acceptance/source-grounded-questions.json',
    count,
    noAnswerCount,
  };
}

function required(result, key) {
  const value = result[key];
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function headingLabel(value) {
  if (Array.isArray(value)) {
    const labels = value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
    if (labels.length > 0) return labels.join(' / ').slice(0, 160);
  }
  return '正文';
}

function cleanText(value) {
  return String(value).replace(/\s+/gu, ' ').trim();
}

function questionExcerpt(content) {
  const tableCells = content
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell && !/^:?-{3,}:?$/u.test(cell));
  const readable = tableCells.length >= 4 ? tableCells.slice(0, 10).join('、') : content;
  const excerpt = readable.slice(0, 120).trim();
  return excerpt.length < readable.length ? `${excerpt}…` : excerpt;
}

function questionVariant(variant, title, heading, excerpt) {
  const templates = [
    `请根据《${title}》“${heading}”说明这段原文的含义：${excerpt}`,
    `员工查阅《${title}》的“${heading}”时，应如何理解原文“${excerpt}”？`,
    `在《${title}》“${heading}”主题下，文档对“${excerpt}”是怎样表述的？`,
    `如果同事询问《${title}》“${heading}”中的“${excerpt}”，可引用哪些原文内容？`,
    `请概括《${title}》“${heading}”里与“${excerpt}”相关的要求。`,
  ];
  return templates[variant % templates.length];
}
