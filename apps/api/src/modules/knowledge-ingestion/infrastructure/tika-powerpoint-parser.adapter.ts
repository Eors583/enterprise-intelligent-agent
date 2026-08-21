import type { KnowledgeDocumentParser } from '../application/knowledge-document-parser.port.js';
import {
  DocumentParsingError,
  type DocumentParserOptions,
  type DocumentParsingInput,
  type ParsedKnowledgeDocument,
  type SupportedDocumentMimeType,
} from './document-parser.adapter.js';

export const TIKA_POWERPOINT_PARSER_NAME = 'apache-tika-v3';

export interface TikaPowerPointParserOptions extends DocumentParserOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

const POWERPOINT_MIME_TYPE = 'application/vnd.ms-powerpoint';
const POWERPOINT_OPEN_XML_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAXIMUM_SOURCE_BYTES = 2_147_483_647;
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;

/**
 * Legacy PowerPoint extraction boundary. Old `.ppt` files use the OLE2 binary
 * container and are intentionally routed to Apache Tika/POI instead of being
 * mislabeled as OOXML or converted by the browser.
 */
export class TikaPowerPointParserAdapter implements KnowledgeDocumentParser {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumSourceBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: TikaPowerPointParserOptions) {
    this.endpoint = tikaEndpoint(options.baseUrl);
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 900_000);
    this.maximumResponseBytes = boundedInteger(
      options.maximumResponseBytes,
      DEFAULT_MAXIMUM_RESPONSE_BYTES,
      1_024,
      128 * 1024 * 1024,
    );
    this.maximumSourceBytes = boundedInteger(
      options.maximumBytes,
      DEFAULT_MAXIMUM_SOURCE_BYTES,
      1,
      2_147_483_647,
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async parse(input: DocumentParsingInput): Promise<ParsedKnowledgeDocument> {
    if (![POWERPOINT_MIME_TYPE, POWERPOINT_OPEN_XML_MIME_TYPE].includes(input.mimeType)) {
      throw new DocumentParsingError('UNSUPPORTED_MIME_TYPE');
    }
    const mimeType = input.mimeType as SupportedDocumentMimeType;
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0) {
      throw new DocumentParsingError('DOCUMENT_EMPTY');
    }
    if (input.bytes.byteLength > this.maximumSourceBytes) {
      throw new DocumentParsingError('DOCUMENT_TOO_LARGE');
    }
    const signature = mimeType === POWERPOINT_MIME_TYPE ? OLE2_SIGNATURE : ZIP_SIGNATURE;
    if (
      input.bytes.byteLength < signature.byteLength ||
      !input.bytes.subarray(0, signature.byteLength).equals(signature)
    ) {
      throw new DocumentParsingError('INVALID_FILE_SIGNATURE');
    }

    input.signal?.throwIfAborted();
    const controller = new AbortController();
    const abortFromLease = (): void => controller.abort();
    input.signal?.addEventListener('abort', abortFromLease, { once: true });
    if (input.signal?.aborted === true) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'PUT',
        headers: {
          Accept: 'text/plain; charset=utf-8',
          'Content-Type': mimeType,
        },
        body: new Uint8Array(input.bytes),
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
      const text = normalizeExtractedText(
        await readBoundedText(response, this.maximumResponseBytes),
      );
      if (text.length === 0) throw new DocumentParsingError('DOCUMENT_TEXT_EMPTY');
      return {
        text,
        metadata: {
          mimeType,
          sourceType: 'TEXT',
          parser: TIKA_POWERPOINT_PARSER_NAME,
          byteLength: input.bytes.byteLength,
          characterCount: Array.from(text).length,
        },
        structuredContent: {
          schemaVersion: 'enterprise-knowledge-document/v1',
          kind: 'legacy-powerpoint',
          mimeType,
          parser: TIKA_POWERPOINT_PARSER_NAME,
          text,
        },
      };
    } catch (error) {
      if (error instanceof DocumentParsingError) throw error;
      if (controller.signal.aborted) {
        throw new DocumentParsingError('DOCUMENT_PARSER_TIMEOUT');
      }
      throw new DocumentParsingError('DOCUMENT_PARSER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortFromLease);
    }
  }
}

function tikaEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Tika base URL is invalid.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Tika base URL is invalid.');
  }
  return new URL('/tika', url);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  if (response.body === null) throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
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
  if (totalBytes === 0) throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError('Tika parser option is outside the supported range.');
  }
  return resolved;
}
