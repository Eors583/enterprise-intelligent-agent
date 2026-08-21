import { Inject, Injectable, Optional } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parseHTML } from 'linkedom';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

import type { KnowledgeDocumentParser } from '../application/knowledge-document-parser.port.js';

export const DOCUMENT_PARSER_OPTIONS = Symbol('DOCUMENT_PARSER_OPTIONS');

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/xhtml+xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp',
  'image/webp',
] as const;

export type SupportedDocumentMimeType = (typeof SUPPORTED_DOCUMENT_MIME_TYPES)[number];

export type DocumentParsingErrorCode =
  | 'UNSUPPORTED_MIME_TYPE'
  | 'DOCUMENT_EMPTY'
  | 'DOCUMENT_TOO_LARGE'
  | 'INVALID_FILE_SIGNATURE'
  | 'INVALID_TEXT_ENCODING'
  | 'DOCUMENT_PARSE_FAILED'
  | 'DOCUMENT_TEXT_EMPTY'
  | 'DOCUMENT_PARSER_TIMEOUT'
  | 'DOCUMENT_PARSER_UNAVAILABLE'
  | 'DOCUMENT_PARSER_INVALID_RESPONSE';

export interface DocumentParserOptions {
  /** Maximum compressed/source file size. Defaults to 20 MiB. */
  readonly maximumBytes?: number;
}

export interface DocumentParsingInput {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly signal?: AbortSignal;
}

export interface ParsedKnowledgeDocumentMetadata {
  readonly mimeType: SupportedDocumentMimeType;
  readonly sourceType: 'TEXT' | 'MARKDOWN';
  readonly parser?: string;
  readonly byteLength: number;
  readonly characterCount: number;
  readonly pageCount?: number;
}

export interface ParsedKnowledgeDocumentPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface ParsedKnowledgeDocument {
  readonly text: string;
  readonly metadata: ParsedKnowledgeDocumentMetadata;
  readonly pages?: readonly ParsedKnowledgeDocumentPage[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/**
 * A deliberately safe boundary error. Its message is always the stable code and
 * it never retains parser exceptions, filenames, or document content.
 */
export class DocumentParsingError extends Error {
  constructor(readonly code: DocumentParsingErrorCode) {
    super(code);
    this.name = 'DocumentParsingError';
  }
}

const DEFAULT_MAXIMUM_BYTES = 2_147_483_647;
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;
/** Stable provenance label. Change it only when PDF extraction semantics change. */
export const PDF_PARSER_NAME = 'pdf-parse-v2';
/** Stable provenance label. Change it only when spreadsheet extraction semantics change. */
export const XLSX_PARSER_NAME = 'exceljs-v4';

@Injectable()
export class DocumentParserAdapter implements KnowledgeDocumentParser {
  private readonly maximumBytes: number;

  constructor(
    @Optional()
    @Inject(DOCUMENT_PARSER_OPTIONS)
    options?: DocumentParserOptions,
  ) {
    const maximumBytes = options?.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError('Document parser maximumBytes must be a positive safe integer.');
    }
    this.maximumBytes = maximumBytes;
  }

  async parse(input: DocumentParsingInput): Promise<ParsedKnowledgeDocument> {
    input.signal?.throwIfAborted();
    const mimeType = requireSupportedMimeType(input.mimeType);
    validateSourceSize(input.bytes, this.maximumBytes);

    let parsed: {
      text: string;
      pageCount?: number;
      pages?: readonly ParsedKnowledgeDocumentPage[];
      structuredContent?: Readonly<Record<string, unknown>>;
    };
    switch (mimeType) {
      case 'text/plain':
      case 'text/markdown':
        parsed = { text: decodeUtf8Text(input.bytes) };
        break;
      case 'text/html':
      case 'application/xhtml+xml':
        parsed = { text: parseHtml(input.bytes) };
        break;
      case 'application/pdf':
        parsed = await parsePdf(input.bytes);
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        parsed = { text: await parseDocx(input.bytes) };
        break;
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        parsed = await parseXlsx(input.bytes);
        break;
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      case 'application/vnd.ms-powerpoint':
      case 'image/png':
      case 'image/jpeg':
      case 'image/tiff':
      case 'image/bmp':
      case 'image/webp':
        throw new DocumentParsingError('UNSUPPORTED_MIME_TYPE');
    }
    input.signal?.throwIfAborted();

    const pages =
      parsed.pages === undefined
        ? undefined
        : normalizePdfPages(parsed.pages, parsed.pageCount ?? parsed.pages.length);
    const text =
      pages === undefined
        ? normalizeExtractedText(parsed.text)
        : pages
            .map((page) => page.text)
            .filter((pageText) => pageText.length > 0)
            .join('\n\n');
    if (text.length === 0) throw new DocumentParsingError('DOCUMENT_TEXT_EMPTY');

    return {
      text,
      metadata: {
        mimeType,
        sourceType:
          mimeType === 'text/markdown' ||
          mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ? 'MARKDOWN'
            : 'TEXT',
        ...(mimeType === 'application/pdf'
          ? { parser: PDF_PARSER_NAME }
          : mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ? { parser: XLSX_PARSER_NAME }
            : mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
              ? { parser: 'linkedom-v0.18' }
              : {}),
        byteLength: input.bytes.byteLength,
        characterCount: Array.from(text).length,
        ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
      },
      ...(pages === undefined ? {} : { pages }),
      structuredContent:
        parsed.structuredContent ??
        buildLocalStructuredContent({
          mimeType,
          text,
          ...(pages === undefined ? {} : { pages }),
        }),
    };
  }
}

function requireSupportedMimeType(mimeType: string): SupportedDocumentMimeType {
  if (
    !SUPPORTED_DOCUMENT_MIME_TYPES.some(
      (supported): supported is SupportedDocumentMimeType => supported === mimeType,
    )
  ) {
    throw new DocumentParsingError('UNSUPPORTED_MIME_TYPE');
  }
  return mimeType as SupportedDocumentMimeType;
}

function validateSourceSize(bytes: Buffer, maximumBytes: number): void {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    throw new DocumentParsingError('DOCUMENT_EMPTY');
  }
  if (bytes.byteLength > maximumBytes) {
    throw new DocumentParsingError('DOCUMENT_TOO_LARGE');
  }
}

function decodeUtf8Text(bytes: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (UNSAFE_TEXT_CONTROL_CHARACTERS.test(text)) {
      throw new DocumentParsingError('INVALID_TEXT_ENCODING');
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentParsingError) throw error;
    throw new DocumentParsingError('INVALID_TEXT_ENCODING');
  }
}

function parseHtml(bytes: Buffer): string {
  const html = decodeUtf8Text(bytes);
  try {
    const { document } = parseHTML(html);
    for (const element of document.querySelectorAll(
      'script,style,noscript,template,svg,canvas,iframe,object,embed,form,nav,footer',
    )) {
      element.remove();
    }
    const content =
      document.querySelector('main') ??
      document.querySelector('article') ??
      document.querySelector('[role="main"]') ??
      document.body;
    return content?.textContent ?? '';
  } catch {
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }
}

async function parsePdf(bytes: Buffer): Promise<{
  text: string;
  pageCount: number;
  pages: readonly ParsedKnowledgeDocumentPage[];
}> {
  requireSignature(bytes, PDF_SIGNATURE);
  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      stopAtErrors: true,
      useWasm: false,
    });
    const result = await parser.getText({ pageJoiner: '' });
    return {
      text: result.text,
      pageCount: result.total,
      pages: result.pages.map((page) => ({
        pageNumber: page.num,
        text: page.text,
      })),
    };
  } catch {
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  } finally {
    if (parser !== undefined) {
      try {
        await parser.destroy();
      } catch {
        // Cleanup errors must not replace the parse result or leak library details.
      }
    }
  }
}

function normalizePdfPages(
  pages: readonly ParsedKnowledgeDocumentPage[],
  pageCount: number,
): ParsedKnowledgeDocumentPage[] {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0 || pages.length !== pageCount) {
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }

  let previousPageNumber = 0;
  return pages.map((page) => {
    if (
      !Number.isSafeInteger(page.pageNumber) ||
      page.pageNumber <= previousPageNumber ||
      page.pageNumber > pageCount
    ) {
      throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
    }
    previousPageNumber = page.pageNumber;
    return {
      pageNumber: page.pageNumber,
      text: normalizeExtractedText(page.text),
    };
  });
}

async function parseDocx(bytes: Buffer): Promise<string> {
  requireSignature(bytes, ZIP_LOCAL_FILE_SIGNATURE);
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    if (result.messages.some((message) => message.type === 'error')) {
      throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
    }
    return result.value;
  } catch (error) {
    if (error instanceof DocumentParsingError) throw error;
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }
}

async function parseXlsx(bytes: Buffer): Promise<{
  readonly text: string;
  readonly structuredContent: Readonly<Record<string, unknown>>;
}> {
  requireSignature(bytes, ZIP_LOCAL_FILE_SIGNATURE);
  try {
    const workbook = new ExcelJS.Workbook();
    const isolatedBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(isolatedBytes).set(bytes);
    const excelJsBuffer = Buffer.from(isolatedBytes) as unknown as Parameters<
      typeof workbook.xlsx.load
    >[0];
    await workbook.xlsx.load(excelJsBuffer);
    if (workbook.worksheets.length === 0 || workbook.worksheets.length > 200) {
      throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
    }

    const sections: string[] = [];
    const sheets: Array<Readonly<Record<string, unknown>>> = [];
    let totalRows = 0;
    let totalCells = 0;
    let totalCharacters = 0;
    for (const worksheet of workbook.worksheets) {
      totalRows += worksheet.actualRowCount;
      totalCells += worksheet.actualRowCount * worksheet.actualColumnCount;
      if (totalRows > 100_000 || totalCells > 1_000_000) {
        throw new DocumentParsingError('DOCUMENT_TOO_LARGE');
      }

      const rows: string[] = [];
      const structuredRows: Array<Readonly<Record<string, unknown>>> = [];
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        const values: string[] = [];
        const cells: Array<Readonly<Record<string, unknown>>> = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          const display = cell.text
            .normalize('NFC')
            .replace(/[\t\r\n]+/gu, ' ')
            .replace(/\s{2,}/gu, ' ')
            .trim();
          values.push(display);
          const formula = typeof cell.formula === 'string' ? cell.formula : undefined;
          cells.push({
            address: cell.address,
            column: cell.col,
            display,
            ...(formula === undefined ? {} : { formula }),
          });
        });
        while (values.at(-1) === '') values.pop();
        if (values.some((value) => value.length > 0)) {
          rows.push(values.join('\t'));
          structuredRows.push({ row: row.number, cells });
        }
      });
      if (rows.length === 0) continue;

      const sheetName = worksheet.name.replace(/[\t\r\n]+/gu, ' ').trim() || 'Sheet';
      const section = `# 工作表：${sheetName}\n${rows.join('\n')}`;
      totalCharacters += Array.from(section).length;
      if (totalCharacters > 5_000_000) {
        throw new DocumentParsingError('DOCUMENT_TOO_LARGE');
      }
      sections.push(section);
      sheets.push({
        name: sheetName,
        rowCount: worksheet.actualRowCount,
        columnCount: worksheet.actualColumnCount,
        rows: structuredRows,
      });
    }
    const text = sections.join('\n\n');
    return {
      text,
      structuredContent: {
        schemaVersion: 'enterprise-knowledge-document/v1',
        kind: 'workbook',
        sheets,
      },
    };
  } catch (error) {
    if (error instanceof DocumentParsingError) throw error;
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }
}

function buildLocalStructuredContent(input: {
  readonly mimeType: SupportedDocumentMimeType;
  readonly text: string;
  readonly pages?: readonly ParsedKnowledgeDocumentPage[];
}): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 'enterprise-knowledge-document/v1',
    kind: input.pages === undefined ? 'document' : 'paged-document',
    mimeType: input.mimeType,
    text: input.text,
    ...(input.pages === undefined ? {} : { pages: input.pages }),
  };
}

function requireSignature(bytes: Buffer, signature: Buffer): void {
  if (
    bytes.byteLength < signature.byteLength ||
    !bytes.subarray(0, signature.length).equals(signature)
  ) {
    throw new DocumentParsingError('INVALID_FILE_SIGNATURE');
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\f/gu, '\n\n')
    .replace(/\u00a0/gu, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/gu, ''))
    .join('\n')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
}
