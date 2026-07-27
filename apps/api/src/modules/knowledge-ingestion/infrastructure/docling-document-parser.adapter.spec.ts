import { describe, expect, it, vi } from 'vitest';

import { DocumentParsingError } from './document-parser.adapter.js';
import {
  DOCLING_PAGE_BREAK,
  DoclingDocumentParserAdapter,
} from './docling-document-parser.adapter.js';

const PDF = Buffer.from('%PDF-1.7 enterprise test', 'utf8');

describe('DoclingDocumentParserAdapter', () => {
  it('converts an uploaded PDF into normalized Markdown pages', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'success',
        document: {
          md_content: `# Policy\n\nFirst page\n${DOCLING_PAGE_BREAK}\nSecond page`,
        },
      }),
    );
    const parser = new DoclingDocumentParserAdapter({
      baseUrl: 'http://127.0.0.1:5001',
      apiKey: 'docling-secret',
      fetchImplementation,
    });

    const result = await parser.parse({
      bytes: PDF,
      mimeType: 'application/pdf',
      fileName: '../policy.pdf',
    });

    expect(result.text).toBe('# Policy\n\nFirst page\n\nSecond page');
    expect(result.pages).toEqual([
      { pageNumber: 1, text: '# Policy\n\nFirst page' },
      { pageNumber: 2, text: 'Second page' },
    ]);
    expect(result.metadata).toMatchObject({
      mimeType: 'application/pdf',
      sourceType: 'MARKDOWN',
      parser: 'docling-serve-v1',
      byteLength: PDF.byteLength,
      pageCount: 2,
    });
    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(request.redirect).toBe('error');
    expect(request.headers).toMatchObject({ 'X-Api-Key': 'docling-secret' });
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get('from_formats')).toBe('pdf');
    expect(form.get('do_ocr')).toBe('true');
    expect(form.get('table_mode')).toBe('accurate');
    expect(form.get('md_page_break_placeholder')).toBe(`\n${DOCLING_PAGE_BREAK}\n`);
    expect(form.has('page_break_placeholder')).toBe(false);
    expect((form.get('files') as File).name).toBe('policy.pdf');
  });

  it('rejects unsupported input before contacting the parser service', async () => {
    const fetchImplementation = vi.fn();
    const parser = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      fetchImplementation,
    });

    await expect(
      parser.parse({ bytes: Buffer.from('text'), mimeType: 'text/plain' }),
    ).rejects.toEqual(new DocumentParsingError('UNSUPPORTED_MIME_TYPE'));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a forged file signature before sending bytes to Docling', async () => {
    const fetchImplementation = vi.fn();
    const parser = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      fetchImplementation,
    });

    await expect(
      parser.parse({
        bytes: Buffer.from('not a pdf'),
        mimeType: 'application/pdf',
        fileName: 'forged.pdf',
      }),
    ).rejects.toEqual(new DocumentParsingError('INVALID_FILE_SIGNATURE'));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('maps unavailable services and invalid payloads to stable safe codes', async () => {
    const unavailable = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      fetchImplementation: vi
        .fn()
        .mockResolvedValue(new Response('private detail', { status: 503 })),
    });
    await expect(unavailable.parse({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toEqual(
      new DocumentParsingError('DOCUMENT_PARSER_UNAVAILABLE'),
    );

    const invalid = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      fetchImplementation: vi.fn().mockResolvedValue(jsonResponse({ status: 'success' })),
    });
    await expect(invalid.parse({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toEqual(
      new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE'),
    );
  });

  it('bounds source and response sizes', async () => {
    const sourceBound = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      maximumBytes: 4,
      fetchImplementation: vi.fn(),
    });
    await expect(sourceBound.parse({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toEqual(
      new DocumentParsingError('DOCUMENT_TOO_LARGE'),
    );

    const responseBound = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      maximumResponseBytes: 1_024,
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response('x'.repeat(1_025), {
          status: 200,
          headers: { 'content-length': '1025' },
        }),
      ),
    });
    await expect(responseBound.parse({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toEqual(
      new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE'),
    );
  });

  it('reports a timeout without leaking transport details', async () => {
    const fetchImplementation = vi.fn(
      (_url: URL | RequestInfo, request?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () =>
            reject(new DOMException('private upstream detail', 'AbortError')),
          );
        }),
    );
    const parser = new DoclingDocumentParserAdapter({
      baseUrl: 'https://docling.example',
      timeoutMs: 1_000,
      fetchImplementation,
    });
    vi.useFakeTimers();
    try {
      const expectation = expect(
        parser.parse({ bytes: PDF, mimeType: 'application/pdf' }),
      ).rejects.toEqual(new DocumentParsingError('DOCUMENT_PARSER_TIMEOUT'));
      await vi.advanceTimersByTimeAsync(1_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
