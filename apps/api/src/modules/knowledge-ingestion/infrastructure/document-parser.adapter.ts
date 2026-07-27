import { Inject, Injectable, Optional } from '@nestjs/common';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

import type { KnowledgeDocumentParser } from '../application/knowledge-document-parser.port.js';

export const DOCUMENT_PARSER_OPTIONS = Symbol('DOCUMENT_PARSER_OPTIONS');

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

const DEFAULT_MAXIMUM_BYTES = 20 * 1024 * 1024;
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;
/** Stable provenance label. Change it only when PDF extraction semantics change. */
export const PDF_PARSER_NAME = 'pdf-parse-v2';

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
    const mimeType = requireSupportedMimeType(input.mimeType);
    validateSourceSize(input.bytes, this.maximumBytes);

    let parsed: {
      text: string;
      pageCount?: number;
      pages?: readonly ParsedKnowledgeDocumentPage[];
    };
    switch (mimeType) {
      case 'text/plain':
      case 'text/markdown':
        parsed = { text: decodeUtf8Text(input.bytes) };
        break;
      case 'application/pdf':
        parsed = await parsePdf(input.bytes);
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        parsed = { text: await parseDocx(input.bytes) };
        break;
    }

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
        sourceType: mimeType === 'text/markdown' ? 'MARKDOWN' : 'TEXT',
        ...(mimeType === 'application/pdf' ? { parser: PDF_PARSER_NAME } : {}),
        byteLength: input.bytes.byteLength,
        characterCount: Array.from(text).length,
        ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
      },
      ...(pages === undefined ? {} : { pages }),
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
