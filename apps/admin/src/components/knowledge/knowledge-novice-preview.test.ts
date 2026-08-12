import { describe, expect, it } from 'vitest';

import {
  knowledgeEvidenceExcerpt,
  structuredCalculationResult,
} from './KnowledgeRetrievalTestPanel';
import { extractWorkbookTables } from './KnowledgeStructuredPreviewModal';
import { knowledgeSourceLocatorLabel } from './KnowledgeSourcePreviewModal';

describe('knowledge novice previews', () => {
  it('converts a Docling workbook artifact into readable sheets and cells', () => {
    expect(
      extractWorkbookTables({
        kind: 'docling-document',
        document: {
          groups: [{ self_ref: '#/groups/0', name: 'sheet: Service Metrics' }],
          tables: [
            {
              parent: { $ref: '#/groups/0' },
              data: {
                grid: [
                  [{ text: 'Service' }, { text: 'Q2 uptime' }],
                  [{ text: 'Identity API' }, { text: '0.999' }],
                ],
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        name: 'Service Metrics',
        rows: [
          ['Service', 'Q2 uptime'],
          ['Identity API', '0.999'],
        ],
      },
    ]);
  });

  it('extracts the calculation result and hides SQL details from the main evidence', () => {
    const excerpt = [
      '[结构化 SQL 查询结果]',
      '问题：Identity API 第二季度可用率是多少？',
      '工作表：Service Metrics',
      '指标：Q2 uptime',
      '结果：99.9%',
      'SQL：SELECT n3 AS value FROM workbook_rows WHERE c1 = ?',
      '参数：["Identity API"]',
    ].join('\n');

    expect(structuredCalculationResult(excerpt)).toBe('99.9%');
    expect(knowledgeEvidenceExcerpt(excerpt)).toContain('结果：99.9%');
    expect(knowledgeEvidenceExcerpt(excerpt)).not.toContain('SELECT');
    expect(knowledgeEvidenceExcerpt(excerpt)).not.toContain('参数');
  });

  it('handles structured evidence normalized into a single line by the retrieval pipeline', () => {
    const excerpt =
      '[结构化 SQL 查询结果] 问题：Identity API 环比多少？ 工作表：Service Metrics 指标：Q2 uptime 结果：当前 99.9%，上期 99.7%，差额 0.2 个百分点 SQL：SELECT AVG(n3) 参数：["Identity API"]';

    expect(structuredCalculationResult(excerpt)).toBe('当前 99.9%，上期 99.7%，差额 0.2 个百分点');
    expect(knowledgeEvidenceExcerpt(excerpt)).toBe(
      '问题：Identity API 环比多少？ · 工作表：Service Metrics · 指标：Q2 uptime · 结果：当前 99.9%，上期 99.7%，差额 0.2 个百分点',
    );
  });

  it('describes exact PDF, workbook and section source locations in business language', () => {
    expect(
      knowledgeSourceLocatorLabel({
        pageStart: 8,
        pageEnd: 9,
        sheetName: null,
        headingPath: ['财务制度', '报销标准'],
      }),
    ).toBe('第 8–9 页');
    expect(
      knowledgeSourceLocatorLabel({
        pageStart: null,
        pageEnd: null,
        sheetName: 'Service Metrics',
        headingPath: [],
      }),
    ).toBe('工作表“Service Metrics”');
    expect(
      knowledgeSourceLocatorLabel({
        pageStart: null,
        pageEnd: null,
        sheetName: null,
        headingPath: ['安全规范', '账号管理'],
      }),
    ).toBe('章节“安全规范 / 账号管理”');
  });
});
