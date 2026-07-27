import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { ClamAvKnowledgeFileScanner } from './clamav-knowledge-file.scanner.js';

const source = Buffer.from('%PDF-1.7 enterprise malware scan fixture', 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('ClamAvKnowledgeFileScanner', () => {
  it('streams bounded INSTREAM frames and accepts a clean verdict', async () => {
    const observed: Buffer[] = [];
    const port = await serve((bytes) => {
      observed.push(bytes);
      return 'stream: OK\0';
    });
    const scanner = new ClamAvKnowledgeFileScanner({
      host: '127.0.0.1',
      port,
      chunkBytes: 1_024,
    });

    await expect(
      scanner.scan({
        bytes: source,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sha256,
      }),
    ).resolves.toMatchObject({ verdict: 'clean', scanner: 'clamav' });

    const request = Buffer.concat(observed);
    expect(request.subarray(0, 10).toString('ascii')).toBe('zINSTREAM\0');
    expect(request.readUInt32BE(10)).toBe(source.byteLength);
    expect(request.subarray(14, 14 + source.byteLength)).toEqual(source);
    expect(request.readUInt32BE(14 + source.byteLength)).toBe(0);
  });

  it('returns an infected verdict with a bounded signature', async () => {
    const port = await serve(() => 'stream: Eicar-Test-Signature FOUND\0');
    const scanner = new ClamAvKnowledgeFileScanner({ host: '127.0.0.1', port });

    await expect(
      scanner.scan({
        bytes: source,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sha256,
      }),
    ).resolves.toMatchObject({
      verdict: 'infected',
      scanner: 'clamav',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('fails closed on integrity mismatch and never contacts clamd', async () => {
    const scanner = new ClamAvKnowledgeFileScanner({
      host: '127.0.0.1',
      port: 65_534,
    });

    await expect(
      scanner.scan({
        bytes: source,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sha256: '0'.repeat(64),
      }),
    ).resolves.toEqual({
      verdict: 'error',
      scanner: 'clamav',
      code: 'CLAMAV_SOURCE_INTEGRITY_MISMATCH',
    });
  });

  it('maps malformed and unavailable scanner responses to safe error codes', async () => {
    const malformedPort = await serve(() => 'private upstream response\0');
    const malformed = new ClamAvKnowledgeFileScanner({
      host: '127.0.0.1',
      port: malformedPort,
    });
    await expect(
      malformed.scan({
        bytes: source,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sha256,
      }),
    ).resolves.toEqual({
      verdict: 'error',
      scanner: 'clamav',
      code: 'CLAMAV_INVALID_RESPONSE',
    });

    const unavailable = new ClamAvKnowledgeFileScanner({
      host: '127.0.0.1',
      port: 65_534,
      timeoutMs: 100,
    });
    await expect(
      unavailable.scan({
        bytes: source,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sha256,
      }),
    ).resolves.toEqual({
      verdict: 'error',
      scanner: 'clamav',
      code: 'CLAMAV_UNAVAILABLE',
    });
  });
});

async function serve(response: (request: Buffer) => string): Promise<number> {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const request = Buffer.concat(chunks);
      if (request.byteLength >= 15 && request.subarray(-4).equals(Buffer.alloc(4))) {
        socket.end(response(request), 'utf8');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server unavailable');
  return address.port;
}
