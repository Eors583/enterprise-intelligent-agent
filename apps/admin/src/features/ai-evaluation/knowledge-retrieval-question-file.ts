import {
  bulkKnowledgeRetrievalEvaluationCaseSchema,
  type BulkKnowledgeRetrievalEvaluationCase,
} from '@enterprise/contracts';

export interface ParsedQuestionFile {
  readonly cases: readonly BulkKnowledgeRetrievalEvaluationCase[];
  readonly errors: readonly string[];
  readonly fileName: string;
}

export function questionCoverage(cases: readonly BulkKnowledgeRetrievalEvaluationCase[]): {
  readonly answerable: number;
  readonly noAnswer: number;
  readonly acl: number;
  readonly routed: number;
} {
  return {
    answerable: cases.filter(({ groundTruth }) => !groundTruth.expectedNoAnswer).length,
    noAnswer: cases.filter(({ groundTruth }) => groundTruth.expectedNoAnswer).length,
    acl: cases.filter(
      ({ groundTruth }) =>
        groundTruth.forbiddenChunkIds.length +
          groundTruth.forbiddenDocumentIds.length +
          groundTruth.forbiddenKnowledgeBaseIds.length >
        0,
    ).length,
    routed: cases.filter(({ groundTruth }) => groundTruth.expectedRoute !== null).length,
  };
}

export function parseQuestionFile(fileName: string, text: string): ParsedQuestionFile {
  const trimmed = text.replace(/^\uFEFF/u, '').trim();
  if (!trimmed) throw new Error('题集文件是空的。');
  let rows: readonly unknown[];
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith('.csv')) {
    rows = csvObjects(trimmed).map(csvQuestion);
  } else if (lowerFileName.endsWith('.jsonl')) {
    rows = trimmed
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } else if (trimmed.startsWith('[')) {
    const value: unknown = JSON.parse(trimmed);
    if (!Array.isArray(value)) throw new Error('JSON 顶层必须是题目数组。');
    rows = value;
  } else if (trimmed.startsWith('{')) {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value) && Array.isArray(value['cases'])) rows = value['cases'];
    else rows = [value];
  } else {
    rows = trimmed
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  const cases: BulkKnowledgeRetrievalEvaluationCase[] = [];
  const errors: string[] = [];
  rows.forEach((row, index) => {
    const result = bulkKnowledgeRetrievalEvaluationCaseSchema.safeParse(row);
    if (result.success) cases.push(result.data);
    else errors.push(`第 ${index + 1} 行：${result.error.issues[0]?.message ?? '格式不正确'}`);
  });
  const duplicates = duplicateValues(cases.map(({ caseKey }) => caseKey));
  if (duplicates.length > 0) errors.push(`题号重复：${duplicates.join('、')}`);
  return { cases, errors, fileName };
}

function csvQuestion(row: Readonly<Record<string, string>>): unknown {
  return {
    caseKey: row['caseKey'],
    query: row['query'],
    expectedAnswer: row['expectedAnswer'],
    groundTruth: {
      schemaVersion: 1,
      knowledgeBaseId: row['knowledgeBaseId'],
      simulatedUserId: row['simulatedUserId'],
      expectedNoAnswer: booleanValue(row['expectedNoAnswer']),
      semanticRequired:
        row['semanticRequired'] === '' ? true : booleanValue(row['semanticRequired']),
      relevance: jsonObject(row['relevance']),
      forbiddenChunkIds: jsonArray(row['forbiddenChunkIds']),
      forbiddenDocumentIds: jsonArray(row['forbiddenDocumentIds']),
      forbiddenKnowledgeBaseIds: jsonArray(row['forbiddenKnowledgeBaseIds']),
      expectedRoute: row['expectedRoute'] || null,
      limit: row['limit'] ? Number(row['limit']) : 10,
    },
  };
}

function csvObjects(text: string): Readonly<Record<string, string>>[] {
  const rows = parseCsv(text);
  const headers = rows[0]?.map((value) => value.trim()) ?? [];
  return rows
    .slice(1)
    .filter((row) => row.some(Boolean))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ''])),
    );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  row.push(field);
  rows.push(row);
  if (quoted) throw new Error('CSV 存在未闭合的双引号。');
  return rows;
}

function booleanValue(value: string | undefined): boolean {
  if (value === 'true' || value === '1' || value === '是') return true;
  if (value === 'false' || value === '0' || value === '否' || value === '') return false;
  throw new Error(`无法识别布尔值：${value ?? ''}`);
}

function jsonObject(value: string | undefined): unknown {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('relevance 必须是 JSON 对象。');
  return parsed;
}

function jsonArray(value: string | undefined): unknown[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('禁止项必须是 JSON 数组。');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  values.forEach((value) => (seen.has(value) ? duplicates.add(value) : seen.add(value)));
  return [...duplicates];
}
