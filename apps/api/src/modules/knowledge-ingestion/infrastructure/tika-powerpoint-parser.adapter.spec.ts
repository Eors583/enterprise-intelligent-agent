import { describe, expect, it, vi } from 'vitest';

import { DocumentParsingError } from './document-parser.adapter.js';
import { TikaPowerPointParserAdapter } from './tika-powerpoint-parser.adapter.js';

const PPT = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('enterprise legacy powerpoint fixture'),
]);

describe('TikaPowerPointParserAdapter', () => {
  it('extracts normalized text from a genuine OLE2 PowerPoint request', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response('年度战略\r\n\r\n\r\n目标一  \r\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const parser = new TikaPowerPointParserAdapter({
      baseUrl: 'http://127.0.0.1:9998',
      fetchImplementation,
    });

    const result = await parser.parse({
      bytes: PPT,
      mimeType: 'application/vnd.ms-powerpoint',
      fileName: '../年度战略.ppt',
    });

    expect(result.text).toBe('年度战略\n\n目标一');
    expect(result.metadata).toMatchObject({
      mimeType: 'application/vnd.ms-powerpoint',
      sourceType: 'TEXT',
      parser: 'apache-tika-v3',
      byteLength: PPT.byteLength,
    });
    expect(result.structuredContent).toMatchObject({
      kind: 'legacy-powerpoint',
      parser: 'apache-tika-v3',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:9998/tika'),
      expect.objectContaining({
        method: 'PUT',
        redirect: 'error',
        headers: expect.objectContaining({ 'Content-Type': 'application/vnd.ms-powerpoint' }),
      }),
    );
  });

  it('rejects unsupported MIME types and forged OLE2 signatures before dispatch', async () => {
    const fetchImplementation = vi.fn();
    const parser = new TikaPowerPointParserAdapter({
      baseUrl: 'https://tika.example',
      fetchImplementation,
    });

    await expect(parser.parse({ bytes: PPT, mimeType: 'application/pdf' })).rejects.toEqual(
      new DocumentParsingError('UNSUPPORTED_MIME_TYPE'),
    );
    await expect(
      parser.parse({
        bytes: Buffer.from('not a powerpoint'),
        mimeType: 'application/vnd.ms-powerpoint',
      }),
    ).rejects.toEqual(new DocumentParsingError('INVALID_FILE_SIGNATURE'));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('maps unavailable and oversized parser responses to safe error codes', async () => {
    const unavailable = new TikaPowerPointParserAdapter({
      baseUrl: 'https://tika.example',
      fetchImplementation: vi.fn().mockResolvedValue(new Response('private', { status: 503 })),
    });
    await expect(
      unavailable.parse({ bytes: PPT, mimeType: 'application/vnd.ms-powerpoint' }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_PARSER_UNAVAILABLE'));

    const oversized = new TikaPowerPointParserAdapter({
      baseUrl: 'https://tika.example',
      maximumResponseBytes: 1_024,
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response('x'.repeat(1_025), {
          status: 200,
          headers: { 'content-length': '1025' },
        }),
      ),
    });
    await expect(
      oversized.parse({ bytes: PPT, mimeType: 'application/vnd.ms-powerpoint' }),
    ).rejects.toEqual(new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE'));
  });
});
