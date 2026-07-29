import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { DocumentParserAdapter, DocumentParsingError } from './document-parser.adapter.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('DocumentParserAdapter', () => {
  it('decodes and normalizes UTF-8 plain text', async () => {
    const parser = new DocumentParserAdapter();

    const result = await parser.parse({
      bytes: Buffer.from('\uFEFFFirst line  \r\nSecond\u00a0line\r\n', 'utf8'),
      mimeType: 'text/plain',
      fileName: 'notes.txt',
    });

    expect(result).toEqual({
      text: 'First line\nSecond line',
      metadata: {
        mimeType: 'text/plain',
        sourceType: 'TEXT',
        byteLength: 31,
        characterCount: 22,
      },
    });
  });

  it('marks Markdown for heading-aware downstream chunking', async () => {
    const result = await new DocumentParserAdapter().parse({
      bytes: Buffer.from('# Policy\n\nContent', 'utf8'),
      mimeType: 'text/markdown',
    });

    expect(result.metadata.sourceType).toBe('MARKDOWN');
    expect(result.text).toBe('# Policy\n\nContent');
  });

  it('extracts visible main HTML text while dropping active and navigation content', async () => {
    const result = await new DocumentParserAdapter().parse({
      bytes: Buffer.from(
        '<html><head><style>.secret{}</style><script>token()</script></head>' +
          '<body><nav>Menu</nav><main><h1>Security policy</h1><p>Use MFA.</p></main>' +
          '<footer>Legal</footer></body></html>',
        'utf8',
      ),
      mimeType: 'text/html',
    });

    expect(result.text).toContain('Security policy');
    expect(result.text).toContain('Use MFA.');
    expect(result.text).not.toContain('token');
    expect(result.text).not.toContain('Menu');
    expect(result.metadata).toMatchObject({
      mimeType: 'text/html',
      sourceType: 'TEXT',
      parser: 'linkedom-v0.18',
    });
  });

  it('extracts text and page metadata from a PDF', async () => {
    const result = await new DocumentParserAdapter().parse({
      bytes: createPdf('Hello PDF'),
      mimeType: 'application/pdf',
    });

    expect(result.text).toContain('Hello PDF');
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'Hello PDF' }]);
    expect(result.metadata.pageCount).toBe(1);
    expect(result.metadata.sourceType).toBe('TEXT');
  });

  it('preserves normalized PDF pages in source order while retaining empty page numbers', async () => {
    const result = await new DocumentParserAdapter().parse({
      bytes: createPdf(['First page', '', 'Third page']),
      mimeType: 'application/pdf',
    });

    expect(result.text).toBe('First page\n\nThird page');
    expect(result.pages).toEqual([
      { pageNumber: 1, text: 'First page' },
      { pageNumber: 2, text: '' },
      { pageNumber: 3, text: 'Third page' },
    ]);
    expect(result.metadata).toMatchObject({
      pageCount: 3,
      characterCount: 22,
    });
  });

  it('extracts text from a DOCX document', async () => {
    const result = await new DocumentParserAdapter().parse({
      bytes: await createDocx('Hello DOCX'),
      mimeType: DOCX_MIME,
    });

    expect(result.text).toBe('Hello DOCX');
    expect(result.metadata.mimeType).toBe(DOCX_MIME);
  });

  it('extracts bounded sheet and cell content from an XLSX workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const employees = workbook.addWorksheet('员工');
    employees.addRow(['姓名', '部门', '目标']);
    employees.addRow(['林晓', '研发中心', '企业知识检索']);
    const metrics = workbook.addWorksheet('指标');
    metrics.addRow(['指标', '值']);
    metrics.addRow(['引用完整率', '100%']);

    const result = await new DocumentParserAdapter().parse({
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
      mimeType: XLSX_MIME,
      fileName: 'enterprise.xlsx',
    });

    expect(result.text).toContain('# 工作表：员工');
    expect(result.text).toContain('林晓\t研发中心\t企业知识检索');
    expect(result.text).toContain('# 工作表：指标');
    expect(result.text).toContain('引用完整率\t100%');
    expect(result.metadata).toMatchObject({
      mimeType: XLSX_MIME,
      sourceType: 'TEXT',
      parser: 'exceljs-v4',
    });
  });

  it.each([
    ['application/octet-stream', 'UNSUPPORTED_MIME_TYPE'],
    ['text/plain; charset=utf-8', 'UNSUPPORTED_MIME_TYPE'],
  ])('strictly rejects unsupported MIME %s', async (mimeType, code) => {
    await expect(
      new DocumentParserAdapter().parse({ bytes: Buffer.from('text'), mimeType }),
    ).rejects.toEqual(new DocumentParsingError(code as 'UNSUPPORTED_MIME_TYPE'));
  });

  it('rejects an empty or oversized source before invoking a parser', async () => {
    const parser = new DocumentParserAdapter({ maximumBytes: 4 });

    await expect(parser.parse({ bytes: Buffer.alloc(0), mimeType: 'text/plain' })).rejects.toEqual(
      new DocumentParsingError('DOCUMENT_EMPTY'),
    );
    await expect(
      parser.parse({ bytes: Buffer.from('12345'), mimeType: 'text/plain' }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_TOO_LARGE'));
  });

  it('rejects invalid UTF-8 and binary control characters', async () => {
    const parser = new DocumentParserAdapter();

    await expect(
      parser.parse({ bytes: Buffer.from([0xc3, 0x28]), mimeType: 'text/plain' }),
    ).rejects.toEqual(new DocumentParsingError('INVALID_TEXT_ENCODING'));
    await expect(
      parser.parse({ bytes: Buffer.from('text\u0000binary'), mimeType: 'text/plain' }),
    ).rejects.toEqual(new DocumentParsingError('INVALID_TEXT_ENCODING'));
  });

  it('uses safe error codes for forged and corrupt binary documents', async () => {
    const parser = new DocumentParserAdapter();

    await expect(
      parser.parse({ bytes: Buffer.from('not a pdf'), mimeType: 'application/pdf' }),
    ).rejects.toEqual(new DocumentParsingError('INVALID_FILE_SIGNATURE'));
    await expect(
      parser.parse({
        bytes: Buffer.from('PK\u0003\u0004not a docx', 'binary'),
        mimeType: DOCX_MIME,
        fileName: 'private-customer-name.docx',
      }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_PARSE_FAILED'));
    await expect(
      parser.parse({
        bytes: Buffer.from('PK\u0003\u0004not an xlsx', 'binary'),
        mimeType: XLSX_MIME,
      }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_PARSE_FAILED'));
  });

  it('does not retain parser details or source text in errors', async () => {
    const secret = 'confidential-source-value';

    let thrown: unknown;
    try {
      await new DocumentParserAdapter().parse({
        bytes: Buffer.from(`PK\u0003\u0004${secret}`, 'binary'),
        mimeType: DOCX_MIME,
        fileName: `${secret}.docx`,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentParsingError);
    expect(String(thrown)).toBe('DocumentParsingError: DOCUMENT_PARSE_FAILED');
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('rejects documents that contain no extractable text', async () => {
    await expect(
      new DocumentParserAdapter().parse({
        bytes: Buffer.from(' \r\n\t'),
        mimeType: 'text/plain',
      }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_TEXT_EMPTY'));
  });
});

async function createDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body>` +
      '</w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function createPdf(input: string | readonly string[]): Buffer {
  const pages = typeof input === 'string' ? [input] : [...input];
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pages.length;
  const fontObject = firstContentObject + pages.length;
  const pageReferences = pages.map((_, index) => `${firstPageObject + index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pages.length} >>`,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`,
    ),
    ...pages.map((text) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${escapePdf(text)}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapePdf(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}
