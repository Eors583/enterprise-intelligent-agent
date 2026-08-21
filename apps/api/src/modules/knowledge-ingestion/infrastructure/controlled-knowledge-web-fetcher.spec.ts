import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchControlledKnowledgeWebPage,
  isPublicAddress,
  KnowledgeWebFetchError,
  validateKnowledgeWebUrl,
} from './controlled-knowledge-web-fetcher.js';

const POLICY = {
  allowedHosts: ['docs.example.com'],
  timeoutMs: 1_000,
  maximumBytes: 32,
} as const;

describe('controlled knowledge web fetcher', () => {
  it('rejects credentials, fragments, non-HTTPS URLs and non-allowlisted hosts', () => {
    for (const sourceUri of [
      'http://docs.example.com/policy',
      'https://user:secret@docs.example.com/policy',
      'https://docs.example.com/policy#internal',
      'https://other.example.com/policy',
      'https://docs.example.com:8443/policy',
    ]) {
      expect(() => validateKnowledgeWebUrl(sourceUri, POLICY.allowedHosts)).toThrow(
        KnowledgeWebFetchError,
      );
    }
  });

  it('fails closed for loopback, private, link-local, documentation and mapped addresses', () => {
    expect(isPublicAddress('127.0.0.1', 4)).toBe(false);
    expect(isPublicAddress('10.1.2.3', 4)).toBe(false);
    expect(isPublicAddress('169.254.169.254', 4)).toBe(false);
    expect(isPublicAddress('192.0.2.1', 4)).toBe(false);
    expect(isPublicAddress('::1', 6)).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8', 6)).toBe(false);
    expect(isPublicAddress('fec0::1', 6)).toBe(false);
    expect(isPublicAddress('8.8.8.8', 4)).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111', 6)).toBe(true);
  });

  it('rejects every redirect without following its Location header', async () => {
    await expect(
      fetchControlledKnowledgeWebPage(
        'https://docs.example.com/policy',
        POLICY,
        dependencies({
          statusCode: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data' },
          body: Buffer.from('redirect'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_WEB_REDIRECT_FORBIDDEN' });
  });

  it('rejects a response whose declared or streamed body exceeds the byte limit', async () => {
    await expect(
      fetchControlledKnowledgeWebPage(
        'https://docs.example.com/policy',
        POLICY,
        dependencies({
          statusCode: 200,
          headers: { 'content-type': 'text/html', 'content-length': '33' },
          body: Buffer.alloc(33, 65),
        }),
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_WEB_RESPONSE_TOO_LARGE' });

    await expect(
      fetchControlledKnowledgeWebPage(
        'https://docs.example.com/policy',
        POLICY,
        dependencies({
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.alloc(33, 65),
        }),
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_WEB_RESPONSE_TOO_LARGE' });
  });

  it('returns an allowed HTML response through the DNS-pinned request', async () => {
    const result = await fetchControlledKnowledgeWebPage(
      'https://docs.example.com/policy?q=security',
      POLICY,
      dependencies({
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from('<main>Policy</main>'),
      }),
    );

    expect(result).toEqual({
      sourceUri: 'https://docs.example.com/policy?q=security',
      mimeType: 'text/html',
      bytes: Buffer.from('<main>Policy</main>'),
    });
  });

  it('enforces a wall-clock deadline even if a server keeps the socket active', async () => {
    vi.useFakeTimers();
    try {
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        destroy: () => void;
        end: () => void;
      };
      request.setTimeout = () => undefined;
      request.destroy = () => undefined;
      request.end = () => undefined;
      const result = fetchControlledKnowledgeWebPage(
        'https://docs.example.com/policy',
        { ...POLICY, timeoutMs: 50 },
        {
          resolve: async () => [{ address: '8.8.8.8', family: 4 }],
          request: () => request,
        } as never,
      );
      const rejection = expect(result).rejects.toMatchObject({
        code: 'KNOWLEDGE_WEB_FETCH_TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(51);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

function dependencies(response: {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}) {
  return {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_options: unknown, onResponse: (value: PassThrough) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: (timeoutMs: number, callback: () => void) => void;
        destroy: () => void;
        end: () => void;
      };
      request.setTimeout = () => undefined;
      request.destroy = () => undefined;
      request.end = () => {
        const stream = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        stream.statusCode = response.statusCode;
        stream.headers = response.headers;
        onResponse(stream);
        stream.end(response.body);
      };
      return request;
    },
  } as never;
}
