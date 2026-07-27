import {
  DocumentParsingError,
  type DocumentParserOptions,
  type DocumentParsingInput,
  type ParsedKnowledgeDocument,
  type ParsedKnowledgeDocumentPage,
  type SupportedDocumentMimeType,
} from './document-parser.adapter.js';
import type { KnowledgeDocumentParser } from '../application/knowledge-document-parser.port.js';

export const DOCLING_PAGE_BREAK = '<!-- enterprise-agent-page-break -->';
export const DOCLING_PARSER_NAME = 'docling-serve-v1';

export interface DoclingDocumentParserOptions extends DocumentParserOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAXIMUM_SOURCE_BYTES = 20 * 1024 * 1024;
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;

/**
 * Remote complex-document conversion boundary.
 *
 * Docling is intentionally treated as an untrusted parser: the API owns source
 * size limits, response size limits, timeouts and schema validation, and only
 * the normalized text/page projection is allowed into the knowledge ledger.
 */
export class DoclingDocumentParserAdapter implements KnowledgeDocumentParser {
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumSourceBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: DoclingDocumentParserOptions) {
    this.endpoint = doclingEndpoint(options.baseUrl);
    this.apiKey = optionalSecret(options.apiKey);
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1_000,
      900_000,
      'Docling timeout',
    );
    this.maximumResponseBytes = boundedInteger(
      options.maximumResponseBytes,
      DEFAULT_MAXIMUM_RESPONSE_BYTES,
      1_024,
      128 * 1024 * 1024,
      'Docling response limit',
    );
    this.maximumSourceBytes = boundedInteger(
      options.maximumBytes,
      DEFAULT_MAXIMUM_SOURCE_BYTES,
      1,
      100 * 1024 * 1024,
      'Docling source limit',
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async parse(input: DocumentParsingInput): Promise<ParsedKnowledgeDocument> {
    const mimeType = requireDoclingMimeType(input.mimeType);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0) {
      throw new DocumentParsingError('DOCUMENT_EMPTY');
    }
    if (input.bytes.byteLength > this.maximumSourceBytes) {
      throw new DocumentParsingError('DOCUMENT_TOO_LARGE');
    }
    requireSourceSignature(input.bytes, mimeType);

    const form = new FormData();
    form.append(
      'files',
      new Blob([new Uint8Array(input.bytes)], { type: mimeType }),
      safeFileName(input.fileName, mimeType),
    );
    form.append('from_formats', doclingFormat(mimeType));
    form.append('to_formats', 'md');
    form.append('do_ocr', 'true');
    form.append('table_mode', 'accurate');
    form.append('image_export_mode', 'placeholder');
    form.append('abort_on_error', 'true');
    // Docling Serve exposes the Markdown exporter option with this exact
    // multipart field name. Keeping page boundaries lets citations retain
    // page-level provenance instead of collapsing the whole file to one blob.
    form.append('md_page_break_placeholder', `\n${DOCLING_PAGE_BREAK}\n`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...(this.apiKey === undefined ? {} : { 'X-Api-Key': this.apiKey }),
        },
        body: form,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DocumentParsingError(
          response.status === 408 || response.status === 429 || response.status >= 500
            ? 'DOCUMENT_PARSER_UNAVAILABLE'
            : 'DOCUMENT_PARSE_FAILED',
        );
      }
      const body = await readBoundedResponse(response, this.maximumResponseBytes);
      return parseDoclingResponse(body, mimeType, input.bytes.byteLength);
    } catch (error) {
      if (error instanceof DocumentParsingError) throw error;
      if (controller.signal.aborted) {
        throw new DocumentParsingError('DOCUMENT_PARSER_TIMEOUT');
      }
      throw new DocumentParsingError('DOCUMENT_PARSER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  if (response.body === null) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
    }
    chunks.push(result.value);
  }
  if (totalBytes === 0) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
}

function parseDoclingResponse(
  body: string,
  mimeType: SupportedDocumentMimeType,
  sourceByteLength: number,
): ParsedKnowledgeDocument {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  if (value.status !== 'success') {
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }
  if (!isRecord(value.document)) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  const markdown = value.document.md_content;
  if (typeof markdown !== 'string') {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }

  const rawPages = markdown.split(DOCLING_PAGE_BREAK);
  const normalizedPages = rawPages.map(normalizeExtractedText);
  const text = normalizedPages.filter((page) => page.length > 0).join('\n\n');
  if (text.length === 0) throw new DocumentParsingError('DOCUMENT_TEXT_EMPTY');
  const hasPageEvidence = rawPages.length > 1;
  const pages: ParsedKnowledgeDocumentPage[] | undefined = hasPageEvidence
    ? normalizedPages.map((page, index) => ({ pageNumber: index + 1, text: page }))
    : undefined;

  return {
    text,
    metadata: {
      mimeType,
      sourceType: 'MARKDOWN',
      parser: DOCLING_PARSER_NAME,
      byteLength: sourceByteLength,
      characterCount: Array.from(text).length,
      ...(pages === undefined ? {} : { pageCount: pages.length }),
    },
    ...(pages === undefined ? {} : { pages }),
  };
}

function doclingEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Docling base URL is invalid.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Docling base URL is invalid.');
  }
  return new URL('/v1/convert/file', url);
}

function requireDoclingMimeType(mimeType: string): SupportedDocumentMimeType {
  if (
    mimeType !== 'application/pdf' &&
    mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    throw new DocumentParsingError('UNSUPPORTED_MIME_TYPE');
  }
  return mimeType;
}

function doclingFormat(mimeType: SupportedDocumentMimeType): 'pdf' | 'docx' {
  return mimeType === 'application/pdf' ? 'pdf' : 'docx';
}

function requireSourceSignature(bytes: Buffer, mimeType: SupportedDocumentMimeType): void {
  const signature =
    mimeType === 'application/pdf'
      ? Buffer.from('%PDF-', 'ascii')
      : Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  if (
    bytes.byteLength < signature.byteLength ||
    !bytes.subarray(0, signature.byteLength).equals(signature)
  ) {
    throw new DocumentParsingError('INVALID_FILE_SIGNATURE');
  }
}

function safeFileName(fileName: string | undefined, mimeType: SupportedDocumentMimeType): string {
  const fallback = mimeType === 'application/pdf' ? 'document.pdf' : 'document.docx';
  if (fileName === undefined) return fallback;
  const normalized = fileName.trim().replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (
    normalized.length < 1 ||
    normalized.length > 300 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

function normalizeExtractedText(value: string): string {
  const normalized = value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (UNSAFE_TEXT_CONTROL_CHARACTERS.test(normalized)) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  return normalized;
}

function optionalSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} is outside the supported range.`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
