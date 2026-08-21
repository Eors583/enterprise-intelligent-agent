import { Readable } from 'node:stream';

import type { PrismaService } from '../../database/prisma.service.js';
import type { KnowledgeObjectStore } from '../knowledge-ingestion/infrastructure/knowledge-object.store.js';
import { routeKnowledgeQuery } from './domain/knowledge-query-router.js';
import { KnowledgeStructuredQueryService } from './knowledge-structured-query.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const VERSION_ID = '00000000-0000-7000-8000-000000000002';
const CHUNK_ID = '00000000-0000-7000-8000-000000000003';

describe('KnowledgeStructuredQueryService', () => {
  it('executes an exact parameterized SQL lookup over a stored workbook', async () => {
    const service = createService([
      ['服务', '季度', '可用率'],
      ['Identity API', 'Q1', '99.9%'],
      ['Identity API', 'Q2', '99.95%'],
      ['Billing API', 'Q2', '98.5%'],
    ]);

    const result = await service.tryQuery({
      tenantId: TENANT_ID,
      query: 'Identity API 第二季度的可用率是多少？',
      candidates: [{ documentVersionId: VERSION_ID, chunkId: CHUNK_ID }],
    });

    expect(result).toMatchObject({
      documentVersionId: VERSION_ID,
      chunkId: CHUNK_ID,
      sheetName: 'SLA',
    });
    expect(result?.content).toContain('结果：99.95%');
    expect(result?.sql).toContain('WHERE c1 = ? AND c2 = ?');
    expect(result?.parameters).toEqual(['Identity API', 'Q2']);
  });

  it('computes year-over-year changes from two SQL aggregates', async () => {
    const service = createService([
      ['服务', '年份', '季度', '请求量'],
      ['Identity API', '2025', 'Q2', '1000'],
      ['Identity API', '2026', 'Q2', '1250'],
    ]);

    const result = await service.tryQuery({
      tenantId: TENANT_ID,
      query: 'Identity API 2026 年第二季度请求量同比是多少？',
      candidates: [{ documentVersionId: VERSION_ID, chunkId: CHUNK_ID }],
    });

    expect(result?.content).toContain('同比：当前 1,250，上期 1,000，差额 250，变化 25%');
    expect(result?.sql.split(';')).toHaveLength(2);
  });

  it('queries the real Docling workbook table representation and normalizes ratio display', async () => {
    const service = createServiceFromStructured({
      schemaVersion: 'enterprise-knowledge-document/v1',
      kind: 'docling-document',
      document: {
        groups: [{ self_ref: '#/groups/0', name: 'sheet: Service Metrics' }],
        tables: [
          {
            parent: { $ref: '#/groups/0' },
            data: {
              grid: [
                ['Service', 'Q1 uptime', 'Q2 uptime'],
                ['Identity API', '0.997', '0.999'],
                ['Payment API', '0.999', '0.998'],
              ].map((row) => row.map((text) => ({ text }))),
            },
          },
        ],
      },
    });

    const result = await service.tryQuery({
      tenantId: TENANT_ID,
      query: 'Identity API 第二季度的可用率是多少？',
      candidates: [{ documentVersionId: VERSION_ID, chunkId: CHUNK_ID }],
    });

    expect(result).toMatchObject({ sheetName: 'Service Metrics' });
    expect(result?.content).toContain('指标：Q2 uptime');
    expect(result?.content).toContain('结果：99.9%');

    const comparison = await service.tryQuery({
      tenantId: TENANT_ID,
      query: 'Identity API 第二季度比第一季度的可用率环比提高多少？',
      candidates: [{ documentVersionId: VERSION_ID, chunkId: CHUNK_ID }],
    });
    expect(comparison?.content).toContain(
      '环比：当前 99.9%，上期 99.7%，差额 0.2 个百分点，变化 0.200602%',
    );
  });
});

describe('routeKnowledgeQuery', () => {
  it.each([
    ['第二季度销售额同比是多少', 'SQL'],
    ['张三属于哪个部门', 'RELATIONSHIP'],
    ['当前项目是否延期', 'BUSINESS_API'],
    ['年假怎么申请', 'DOCUMENT'],
  ] as const)('routes %s to %s', (query, expected) => {
    expect(routeKnowledgeQuery(query).primary).toBe(expected);
  });

  it('keeps analytical words inside a quoted explanation request on document retrieval', () => {
    for (const query of [
      '请根据《quarterly-service-metrics》说明这段原文的含义：Q1 uptime | Q2 uptime | Average',
      '在《quarterly-service-metrics》“正文”主题下，文档对“Service、Q1 uptime、Q2 uptime、Average、Payment API、0.999”是怎样表述的？',
    ]) {
      expect(routeKnowledgeQuery(query)).toMatchObject({
        primary: 'DOCUMENT',
        reasonCode: 'KNOWLEDGE_ROUTE_DOCUMENT_EXPLANATION',
      });
    }
  });
});

function createService(rows: readonly (readonly string[])[]): KnowledgeStructuredQueryService {
  return createServiceFromStructured({
    schemaVersion: 'enterprise-knowledge-document/v1',
    kind: 'workbook',
    sheets: [
      {
        name: 'SLA',
        rows: rows.map((values, rowIndex) => ({
          row: rowIndex + 1,
          cells: values.map((display, columnIndex) => ({
            address: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`,
            column: columnIndex + 1,
            display,
          })),
        })),
      },
    ],
  });
}

function createServiceFromStructured(value: unknown): KnowledgeStructuredQueryService {
  const structured = Buffer.from(JSON.stringify(value));
  const transaction = {
    knowledgeDocumentVersion: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: VERSION_ID,
          structuredObjectKey: `${TENANT_ID}/document/${VERSION_ID}.structured.json`,
        },
      ]),
    },
  };
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  } as unknown as PrismaService;
  const objects = {
    readObject: vi.fn().mockImplementation(() =>
      Promise.resolve({
        body: Readable.from([structured]),
        size: structured.byteLength,
      }),
    ),
  } as unknown as KnowledgeObjectStore;
  return new KnowledgeStructuredQueryService(prisma, objects);
}
