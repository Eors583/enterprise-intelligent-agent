import { Inject, Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

import { PrismaService } from '../../database/prisma.service.js';
import { KnowledgeObjectStore } from '../knowledge-ingestion/infrastructure/knowledge-object.store.js';

export interface KnowledgeStructuredQueryCandidate {
  readonly documentVersionId: string;
  readonly chunkId: string;
}

export interface KnowledgeStructuredQueryResult {
  readonly documentVersionId: string;
  readonly chunkId: string;
  readonly sheetName: string;
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
  readonly content: string;
}

interface WorkbookCell {
  readonly column: number;
  readonly display: string;
}

interface WorkbookRow {
  readonly row: number;
  readonly cells: readonly WorkbookCell[];
}

interface WorkbookSheet {
  readonly name: string;
  readonly rows: readonly WorkbookRow[];
}

interface QueryPlan {
  readonly score: number;
  readonly targetColumn: number;
  readonly targetHeader: string;
  readonly filters: readonly { column: number; value: string }[];
  readonly aggregate: 'VALUE' | 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT';
  readonly comparison: 'YOY' | 'QOQ' | null;
  readonly yearColumn: number | null;
  readonly quarterColumn: number | null;
}

@Injectable()
export class KnowledgeStructuredQueryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeObjectStore) private readonly objects: KnowledgeObjectStore,
  ) {}

  async tryQuery(input: {
    readonly tenantId: string;
    readonly query: string;
    readonly candidates: readonly KnowledgeStructuredQueryCandidate[];
  }): Promise<KnowledgeStructuredQueryResult | null> {
    const candidateByVersion = new Map(
      input.candidates.map((candidate) => [candidate.documentVersionId, candidate]),
    );
    const versionIds = [...candidateByVersion.keys()].slice(0, 20);
    if (versionIds.length === 0) return null;
    const versions = await this.prisma.withTenant(input.tenantId, (transaction) =>
      transaction.knowledgeDocumentVersion.findMany({
        where: {
          tenantId: input.tenantId,
          id: { in: versionIds },
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          structuredObjectKey: { not: null },
          structuredFormat: 'enterprise-knowledge-document/v1',
        },
        select: { id: true, structuredObjectKey: true },
      }),
    );

    for (const versionId of versionIds) {
      const version = versions.find((candidate) => candidate.id === versionId);
      const sourceCandidate = candidateByVersion.get(versionId);
      if (
        version?.structuredObjectKey === null ||
        version === undefined ||
        sourceCandidate === undefined
      ) {
        continue;
      }
      const object = await this.objects.readObject(version.structuredObjectKey);
      const bytes = await readBoundedObject(object.body, object.size);
      const workbook = parseWorkbook(bytes);
      const result = executeWorkbookQuery(workbook, input.query);
      if (result !== null) {
        return {
          documentVersionId: version.id,
          chunkId: sourceCandidate.chunkId,
          ...result,
        };
      }
    }
    return null;
  }
}

async function readBoundedObject(
  body: AsyncIterable<Uint8Array>,
  expectedSize: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 50 * 1024 * 1024) {
    throw new Error('KNOWLEDGE_STRUCTURED_OBJECT_SIZE_INVALID');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > expectedSize || size > 50 * 1024 * 1024) {
      throw new Error('KNOWLEDGE_STRUCTURED_OBJECT_SIZE_MISMATCH');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (size !== expectedSize) throw new Error('KNOWLEDGE_STRUCTURED_OBJECT_SIZE_MISMATCH');
  return Buffer.concat(chunks, size);
}

function parseWorkbook(bytes: Buffer): readonly WorkbookSheet[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  if (parsed.kind === 'docling-document') return parseDoclingWorkbook(parsed);
  if (parsed.kind !== 'workbook' || !Array.isArray(parsed.sheets)) return [];
  return parsed.sheets.flatMap((sheet): WorkbookSheet[] => {
    if (!isRecord(sheet) || typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)) return [];
    const rows = sheet.rows.flatMap((row): WorkbookRow[] => {
      if (!isRecord(row) || !Number.isSafeInteger(row.row) || !Array.isArray(row.cells)) return [];
      const cells = row.cells.flatMap((cell): WorkbookCell[] => {
        if (
          !isRecord(cell) ||
          !Number.isSafeInteger(cell.column) ||
          (cell.column as number) < 1 ||
          typeof cell.display !== 'string'
        ) {
          return [];
        }
        return [{ column: cell.column as number, display: cell.display.trim() }];
      });
      return cells.length === 0 ? [] : [{ row: row.row as number, cells }];
    });
    return rows.length < 2 ? [] : [{ name: sheet.name.slice(0, 200), rows }];
  });
}

function parseDoclingWorkbook(parsed: Record<string, unknown>): readonly WorkbookSheet[] {
  const document = parsed.document;
  if (!isRecord(document) || !Array.isArray(document.tables)) return [];
  const sheetNameByGroupRef = new Map<string, string>();
  if (Array.isArray(document.groups)) {
    for (const group of document.groups) {
      if (
        !isRecord(group) ||
        typeof group.self_ref !== 'string' ||
        typeof group.name !== 'string'
      ) {
        continue;
      }
      const name = group.name.replace(/^sheet:\s*/iu, '').trim();
      if (name) sheetNameByGroupRef.set(group.self_ref, name.slice(0, 200));
    }
  }
  return document.tables.flatMap((table, tableIndex): WorkbookSheet[] => {
    if (!isRecord(table) || !isRecord(table.data) || !Array.isArray(table.data.grid)) return [];
    const rows = table.data.grid.flatMap((gridRow, rowIndex): WorkbookRow[] => {
      if (!Array.isArray(gridRow)) return [];
      const cells = gridRow.flatMap((cell, columnIndex): WorkbookCell[] => {
        if (!isRecord(cell) || typeof cell.text !== 'string') return [];
        return [{ column: columnIndex + 1, display: cell.text.trim() }];
      });
      return cells.length === 0 ? [] : [{ row: rowIndex + 1, cells }];
    });
    if (rows.length < 2) return [];
    const parentRef =
      isRecord(table.parent) && typeof table.parent.$ref === 'string' ? table.parent.$ref : '';
    return [
      {
        name: sheetNameByGroupRef.get(parentRef) ?? `工作表 ${tableIndex + 1}`,
        rows,
      },
    ];
  });
}

function executeWorkbookQuery(
  sheets: readonly WorkbookSheet[],
  query: string,
): Omit<KnowledgeStructuredQueryResult, 'documentVersionId' | 'chunkId'> | null {
  const planned = sheets
    .map((sheet) => ({ sheet, plan: planSheetQuery(sheet, query) }))
    .filter(
      (candidate): candidate is { sheet: WorkbookSheet; plan: QueryPlan } =>
        candidate.plan !== null,
    )
    .sort((left, right) => right.plan.score - left.plan.score)[0];
  if (planned === undefined) return null;
  return executePlan(planned.sheet, planned.plan, query);
}

function planSheetQuery(sheet: WorkbookSheet, query: string): QueryPlan | null {
  const headerRow = sheet.rows.find((row) => row.cells.length >= 2);
  if (headerRow === undefined) return null;
  const dataRows = sheet.rows.filter((row) => row.row > headerRow.row);
  const headers = new Map(headerRow.cells.map((cell) => [cell.column, cell.display]));
  const normalizedQuery = normalize(query);
  const numericDensity = new Map<number, number>();
  for (const column of headers.keys()) {
    const values = dataRows.map((row) => cellValue(row, column)).filter((value) => value !== '');
    numericDensity.set(
      column,
      values.length === 0
        ? 0
        : values.filter((value) => numericValue(value) !== null).length / values.length,
    );
  }
  const target = [...headers.entries()]
    .map(([column, header]) => ({
      column,
      header,
      score: headerMatchScore(header, query, normalizedQuery),
      density: numericDensity.get(column) ?? 0,
    }))
    .filter((candidate) => candidate.density >= 0.5)
    .sort((left, right) => right.score + right.density - (left.score + left.density))[0];
  if (target === undefined || (target.score === 0 && !analyticalIntent(query))) return null;

  const filters: Array<{ column: number; value: string }> = [];
  for (const [column] of headers) {
    if (column === target.column) continue;
    const values = [...new Set(dataRows.map((row) => cellValue(row, column)).filter(Boolean))];
    const matched = values.find((value) => queryContainsValue(normalizedQuery, value));
    if (matched !== undefined) filters.push({ column, value: matched });
  }
  const yearColumn = findHeaderColumn(headers, /(年|year)/iu);
  const quarterColumn = findHeaderColumn(headers, /(季度|quarter|qtr)/iu);
  const comparison = /同比|year[- ]over[- ]year/iu.test(query)
    ? 'YOY'
    : /环比|quarter[- ]over[- ]quarter|month[- ]over[- ]month/iu.test(query)
      ? 'QOQ'
      : null;
  const aggregate = detectAggregate(query, filters.length);
  return {
    score: target.score * 10 + filters.length * 2 + (comparison === null ? 0 : 5),
    targetColumn: target.column,
    targetHeader: target.header,
    filters,
    aggregate,
    comparison,
    yearColumn,
    quarterColumn,
  };
}

function executePlan(
  sheet: WorkbookSheet,
  plan: QueryPlan,
  query: string,
): Omit<KnowledgeStructuredQueryResult, 'documentVersionId' | 'chunkId'> | null {
  const headerRow = sheet.rows.find((row) => row.cells.length >= 2);
  if (headerRow === undefined) return null;
  const columns = [...new Set(headerRow.cells.map((cell) => cell.column))].sort((a, b) => a - b);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      `CREATE TABLE workbook_rows (${columns.map((column) => `c${column} TEXT, n${column} REAL`).join(', ')}) STRICT`,
    );
    const placeholders = columns.flatMap(() => ['?', '?']).join(', ');
    const insert = db.prepare(`INSERT INTO workbook_rows VALUES (${placeholders})`);
    for (const row of sheet.rows.filter((candidate) => candidate.row > headerRow.row)) {
      insert.run(
        ...columns.flatMap((column) => {
          const display = cellValue(row, column);
          return [display, numericValue(display)];
        }),
      );
    }
    if (plan.comparison !== null) return executeComparison(db, sheet, plan, query);

    const where = sqlFilters(plan.filters);
    const expression = {
      VALUE: `n${plan.targetColumn}`,
      SUM: `SUM(n${plan.targetColumn})`,
      AVG: `AVG(n${plan.targetColumn})`,
      MAX: `MAX(n${plan.targetColumn})`,
      MIN: `MIN(n${plan.targetColumn})`,
      COUNT: `COUNT(n${plan.targetColumn})`,
    }[plan.aggregate];
    const sql = `SELECT ${expression} AS value FROM workbook_rows${where.clause}${plan.aggregate === 'VALUE' ? ' LIMIT 2' : ''}`;
    const rows = db.prepare(sql).all(...where.parameters) as Array<{ value: number | null }>;
    if (rows.length === 0 || rows[0]?.value === null || rows[0]?.value === undefined) return null;
    if (plan.aggregate === 'VALUE' && rows.length > 1) return null;
    const value = rows[0].value;
    return {
      sheetName: sheet.name,
      sql,
      parameters: where.parameters,
      content: structuredEvidence({
        query,
        sheetName: sheet.name,
        metric: plan.targetHeader,
        result: formatMetricValue(value, plan.targetHeader),
        sql,
        parameters: where.parameters,
      }),
    };
  } finally {
    db.close();
  }
}

function executeComparison(
  db: DatabaseSync,
  sheet: WorkbookSheet,
  plan: QueryPlan,
  query: string,
): Omit<KnowledgeStructuredQueryResult, 'documentVersionId' | 'chunkId'> | null {
  if (plan.yearColumn === null && plan.quarterColumn === null) {
    return executeWidePeriodComparison(db, sheet, plan, query);
  }
  const baseFilters = plan.filters.filter(
    (filter) => filter.column !== plan.yearColumn && filter.column !== plan.quarterColumn,
  );
  const timeFilters = plan.filters.filter(
    (filter) => filter.column === plan.yearColumn || filter.column === plan.quarterColumn,
  );
  const currentYear = readTimeValue(timeFilters, plan.yearColumn);
  const currentQuarter = readTimeValue(timeFilters, plan.quarterColumn);
  const allPeriods = db
    .prepare(
      `SELECT DISTINCT ${plan.yearColumn === null ? "''" : `c${plan.yearColumn}`} AS year, ${plan.quarterColumn === null ? "''" : `c${plan.quarterColumn}`} AS quarter FROM workbook_rows`,
    )
    .all() as Array<{ year: string; quarter: string }>;
  const current = chooseCurrentPeriod(allPeriods, currentYear, currentQuarter);
  if (current === null) return null;
  const previous = previousPeriod(current, plan.comparison ?? 'YOY', allPeriods);
  if (previous === null) return null;
  const currentFilters = [
    ...baseFilters,
    ...(plan.yearColumn === null ? [] : [{ column: plan.yearColumn, value: current.year }]),
    ...(plan.quarterColumn === null
      ? []
      : [{ column: plan.quarterColumn, value: current.quarter }]),
  ];
  const previousFilters = [
    ...baseFilters,
    ...(plan.yearColumn === null ? [] : [{ column: plan.yearColumn, value: previous.year }]),
    ...(plan.quarterColumn === null
      ? []
      : [{ column: plan.quarterColumn, value: previous.quarter }]),
  ];
  const aggregate = plan.aggregate === 'VALUE' ? 'AVG' : plan.aggregate;
  const currentQuery = aggregateSql(plan.targetColumn, aggregate, currentFilters);
  const previousQuery = aggregateSql(plan.targetColumn, aggregate, previousFilters);
  const currentValue = queryNumber(db, currentQuery.sql, currentQuery.parameters);
  const previousValue = queryNumber(db, previousQuery.sql, previousQuery.parameters);
  if (currentValue === null || previousValue === null) return null;
  const delta = currentValue - previousValue;
  const rate = previousValue === 0 ? null : (delta / Math.abs(previousValue)) * 100;
  const label = plan.comparison === 'YOY' ? '同比' : '环比';
  const sql = `${currentQuery.sql}; ${previousQuery.sql}`;
  const parameters = [...currentQuery.parameters, ...previousQuery.parameters];
  return {
    sheetName: sheet.name,
    sql,
    parameters,
    content: structuredEvidence({
      query,
      sheetName: sheet.name,
      metric: plan.targetHeader,
      result: comparisonResult({
        label,
        metric: plan.targetHeader,
        currentValue,
        previousValue,
        delta,
        rate,
      }),
      sql,
      parameters,
    }),
  };
}

function executeWidePeriodComparison(
  db: DatabaseSync,
  sheet: WorkbookSheet,
  plan: QueryPlan,
  query: string,
): Omit<KnowledgeStructuredQueryResult, 'documentVersionId' | 'chunkId'> | null {
  if (plan.comparison !== 'QOQ') return null;
  const headerRow = sheet.rows.find((row) => row.cells.length >= 2);
  const targetQuarter = quarterNumber(plan.targetHeader);
  if (headerRow === undefined || targetQuarter === null || targetQuarter === 1) return null;
  const previousColumn = headerRow.cells.find(
    (cell) =>
      cell.column !== plan.targetColumn && quarterNumber(cell.display) === targetQuarter - 1,
  );
  if (previousColumn === undefined) return null;
  const aggregate = plan.aggregate === 'VALUE' ? 'AVG' : plan.aggregate;
  const currentQuery = aggregateSql(plan.targetColumn, aggregate, plan.filters);
  const previousQuery = aggregateSql(previousColumn.column, aggregate, plan.filters);
  const currentValue = queryNumber(db, currentQuery.sql, currentQuery.parameters);
  const previousValue = queryNumber(db, previousQuery.sql, previousQuery.parameters);
  if (currentValue === null || previousValue === null) return null;
  const delta = currentValue - previousValue;
  const rate = previousValue === 0 ? null : (delta / Math.abs(previousValue)) * 100;
  const sql = `${currentQuery.sql}; ${previousQuery.sql}`;
  const parameters = [...currentQuery.parameters, ...previousQuery.parameters];
  return {
    sheetName: sheet.name,
    sql,
    parameters,
    content: structuredEvidence({
      query,
      sheetName: sheet.name,
      metric: plan.targetHeader,
      result: comparisonResult({
        label: '环比',
        metric: plan.targetHeader,
        currentValue,
        previousValue,
        delta,
        rate,
      }),
      sql,
      parameters,
    }),
  };
}

function aggregateSql(
  targetColumn: number,
  aggregate: Exclude<QueryPlan['aggregate'], 'VALUE'>,
  filters: readonly { column: number; value: string }[],
): { sql: string; parameters: string[] } {
  const where = sqlFilters(filters);
  return {
    sql: `SELECT ${aggregate}(n${targetColumn}) AS value FROM workbook_rows${where.clause}`,
    parameters: where.parameters,
  };
}

function sqlFilters(filters: readonly { column: number; value: string }[]): {
  clause: string;
  parameters: string[];
} {
  return {
    clause:
      filters.length === 0
        ? ''
        : ` WHERE ${filters.map((filter) => `c${filter.column} = ?`).join(' AND ')}`,
    parameters: filters.map((filter) => filter.value),
  };
}

function queryNumber(db: DatabaseSync, sql: string, parameters: readonly string[]): number | null {
  const row = db.prepare(sql).get(...parameters) as { value?: number | null } | undefined;
  return typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : null;
}

function detectAggregate(query: string, filterCount: number): QueryPlan['aggregate'] {
  if (/合计|总计|总和|sum/iu.test(query)) return 'SUM';
  if (/平均|均值|average|avg/iu.test(query)) return 'AVG';
  if (/最大|maximum|max/iu.test(query)) return 'MAX';
  if (/最小|minimum|min/iu.test(query)) return 'MIN';
  if (/数量|个数|count/iu.test(query)) return 'COUNT';
  return filterCount > 0 ? 'VALUE' : 'AVG';
}

function analyticalIntent(query: string): boolean {
  return /(同比|环比|合计|总计|总和|平均|均值|最大|最小|多少|是多少|sum|avg|average|count)/iu.test(
    query,
  );
}

function findHeaderColumn(headers: ReadonlyMap<number, string>, pattern: RegExp): number | null {
  return [...headers.entries()].find(([, header]) => pattern.test(header))?.[0] ?? null;
}

function cellValue(row: WorkbookRow, column: number): string {
  return row.cells.find((cell) => cell.column === column)?.display ?? '';
}

function numericValue(value: string): number | null {
  const normalized = value
    .replaceAll(',', '')
    .replace(/[￥$¥€£\s]/gu, '')
    .trim();
  const percent = normalized.endsWith('%');
  const number = Number(percent ? normalized.slice(0, -1) : normalized);
  if (!Number.isFinite(number)) return null;
  return percent ? number : number;
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s_\-—–:：/\\]+/gu, '');
}

function queryContainsValue(normalizedQuery: string, value: string): boolean {
  const normalizedValue = normalize(value);
  if (normalizedValue.length >= 2 && normalizedQuery.includes(normalizedValue)) return true;
  const quarter = quarterNumber(value);
  return quarter !== null && quarterNumber(normalizedQuery) === quarter;
}

function quarterNumber(value: string): number | null {
  const normalized = normalize(value);
  const digit =
    /^(?:q|第)?([1-4])(?:季度)?$/iu.exec(normalized)?.[1] ?? /q([1-4])/iu.exec(normalized)?.[1];
  if (digit !== undefined) return Number(digit);
  const chinese = /(?:第)?([一二三四])季度/u.exec(normalized)?.[1];
  return chinese === undefined
    ? null
    : ({ 一: 1, 二: 2, 三: 3, 四: 4 } as const)[chinese as '一' | '二' | '三' | '四'];
}

function readTimeValue(
  filters: readonly { column: number; value: string }[],
  column: number | null,
): string | null {
  return column === null
    ? null
    : (filters.find((filter) => filter.column === column)?.value ?? null);
}

function chooseCurrentPeriod(
  periods: readonly { year: string; quarter: string }[],
  year: string | null,
  quarter: string | null,
): { year: string; quarter: string } | null {
  const matching = periods.filter(
    (period) =>
      (year === null || normalize(period.year) === normalize(year)) &&
      (quarter === null || quarterNumber(period.quarter) === quarterNumber(quarter)),
  );
  return [...matching].sort(comparePeriod).at(-1) ?? null;
}

function previousPeriod(
  current: { year: string; quarter: string },
  comparison: 'YOY' | 'QOQ',
  periods: readonly { year: string; quarter: string }[],
): { year: string; quarter: string } | null {
  const currentYear = Number(/\d{4}/u.exec(current.year)?.[0]);
  const currentQuarter = quarterNumber(current.quarter);
  if (comparison === 'YOY' && Number.isFinite(currentYear)) {
    return (
      periods.find(
        (period) =>
          Number(/\d{4}/u.exec(period.year)?.[0]) === currentYear - 1 &&
          (currentQuarter === null || quarterNumber(period.quarter) === currentQuarter),
      ) ?? null
    );
  }
  if (currentQuarter !== null) {
    const previousQuarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
    const previousYear = currentQuarter === 1 ? currentYear - 1 : currentYear;
    return (
      periods.find(
        (period) =>
          quarterNumber(period.quarter) === previousQuarter &&
          (!Number.isFinite(previousYear) ||
            Number(/\d{4}/u.exec(period.year)?.[0]) === previousYear),
      ) ?? null
    );
  }
  return null;
}

function comparePeriod(
  left: { year: string; quarter: string },
  right: { year: string; quarter: string },
): number {
  const leftYear = Number(/\d{4}/u.exec(left.year)?.[0] ?? 0);
  const rightYear = Number(/\d{4}/u.exec(right.year)?.[0] ?? 0);
  return (
    leftYear * 10 +
    (quarterNumber(left.quarter) ?? 0) -
    (rightYear * 10 + (quarterNumber(right.quarter) ?? 0))
  );
}

function structuredEvidence(input: {
  readonly query: string;
  readonly sheetName: string;
  readonly metric: string;
  readonly result: string;
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}): string {
  return [
    '[结构化 SQL 查询结果]',
    `问题：${input.query}`,
    `工作表：${input.sheetName}`,
    `指标：${input.metric}`,
    `结果：${input.result}`,
    `SQL：${input.sql}`,
    `参数：${JSON.stringify(input.parameters)}`,
  ].join('\n');
}

function headerMatchScore(header: string, query: string, normalizedQuery: string): number {
  const normalizedHeader = normalize(header);
  if (!normalizedHeader) return 0;
  if (normalizedQuery.includes(normalizedHeader)) return 4;
  let score = 0;
  const headerQuarter = quarterNumber(normalizedHeader);
  const queryQuarter = quarterNumber(normalizedQuery);
  if (headerQuarter !== null && queryQuarter !== null) {
    score += headerQuarter === queryQuarter ? 3 : -3;
  }
  if (/uptime|availability|可用率/iu.test(header) && /uptime|availability|可用率/iu.test(query)) {
    score += 2;
  }
  if (/成本|cost/iu.test(header) && /成本|cost/iu.test(query)) score += 2;
  if (/数量|count|volume/iu.test(header) && /数量|个数|count|volume/iu.test(query)) score += 2;
  return score;
}

function isRateMetric(header: string): boolean {
  return /率|比例|percent|rate|uptime|availability/iu.test(header);
}

function formatMetricValue(value: number, header: string): string {
  if (!isRateMetric(header)) return formatNumber(value);
  return `${formatNumber(Math.abs(value) <= 1 ? value * 100 : value)}%`;
}

function comparisonResult(input: {
  readonly label: string;
  readonly metric: string;
  readonly currentValue: number;
  readonly previousValue: number;
  readonly delta: number;
  readonly rate: number | null;
}): string {
  if (isRateMetric(input.metric)) {
    const scale =
      Math.max(Math.abs(input.currentValue), Math.abs(input.previousValue)) <= 1 ? 100 : 1;
    return `${input.label}：当前 ${formatNumber(input.currentValue * scale)}%，上期 ${formatNumber(input.previousValue * scale)}%，差额 ${formatNumber(input.delta * scale)} 个百分点${input.rate === null ? '' : `，变化 ${formatNumber(input.rate)}%`}`;
  }
  return `${input.label}：当前 ${formatNumber(input.currentValue)}，上期 ${formatNumber(input.previousValue)}，差额 ${formatNumber(input.delta)}${input.rate === null ? '' : `，变化 ${formatNumber(input.rate)}%`}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
