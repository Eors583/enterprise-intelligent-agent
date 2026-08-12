import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

import {
  KnowledgeFileScanner,
  type KnowledgeFileScanResult,
  type ScanKnowledgeFileInput,
} from './knowledge-file-scanner.js';

export interface ClamAvKnowledgeFileScannerOptions {
  readonly host: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly maximumBytes?: number;
  readonly chunkBytes?: number;
}

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_BYTES = 2_147_483_647;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAXIMUM_RESPONSE_BYTES = 4_096;

/**
 * ClamAV clamd INSTREAM adapter.
 *
 * The source file never touches a shell or temporary path. clamd receives
 * bounded binary frames over its private service port and the response is
 * projected to a small, non-sensitive verdict.
 */
export class ClamAvKnowledgeFileScanner extends KnowledgeFileScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private readonly chunkBytes: number;

  constructor(options: ClamAvKnowledgeFileScannerOptions) {
    super();
    this.host = validateHost(options.host);
    this.port = boundedInteger(options.port, DEFAULT_PORT, 1, 65_535, 'ClamAV port');
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      100,
      300_000,
      'ClamAV timeout',
    );
    this.maximumBytes = boundedInteger(
      options.maximumBytes,
      DEFAULT_MAXIMUM_BYTES,
      1,
      2_147_483_647,
      'ClamAV source limit',
    );
    this.chunkBytes = boundedInteger(
      options.chunkBytes,
      DEFAULT_CHUNK_BYTES,
      1_024,
      1024 * 1024,
      'ClamAV stream chunk size',
    );
  }

  async scan(input: ScanKnowledgeFileInput): Promise<KnowledgeFileScanResult> {
    if (input.bytes.byteLength > this.maximumBytes) {
      return {
        verdict: 'error',
        scanner: 'clamav',
        code: 'CLAMAV_SOURCE_TOO_LARGE',
      };
    }
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    if (digest !== input.sha256.toLowerCase()) {
      return {
        verdict: 'error',
        scanner: 'clamav',
        code: 'CLAMAV_SOURCE_INTEGRITY_MISMATCH',
      };
    }
    try {
      const response = await this.exchange(input.bytes);
      return parseClamAvResponse(response);
    } catch (error) {
      return {
        verdict: 'error',
        scanner: 'clamav',
        code: error instanceof ClamAvProtocolError ? error.code : 'CLAMAV_UNAVAILABLE',
      };
    }
  }

  private exchange(bytes: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const response: Buffer[] = [];
      let responseBytes = 0;
      let settled = false;

      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(value ?? '');
      };

      socket.setTimeout(this.timeoutMs, () => finish(new ClamAvProtocolError('CLAMAV_TIMEOUT')));
      socket.once('error', () => finish(new ClamAvProtocolError('CLAMAV_UNAVAILABLE')));
      socket.on('data', (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAXIMUM_RESPONSE_BYTES) {
          finish(new ClamAvProtocolError('CLAMAV_INVALID_RESPONSE'));
          return;
        }
        response.push(chunk);
        const combined = Buffer.concat(response, responseBytes);
        const terminator = combined.indexOf(0);
        if (terminator >= 0) {
          finish(undefined, combined.subarray(0, terminator).toString('utf8'));
        }
      });
      socket.once('close', () => {
        if (!settled) finish(new ClamAvProtocolError('CLAMAV_RESPONSE_INCOMPLETE'));
      });
      socket.connect(this.port, this.host, () => {
        void (async () => {
          try {
            await write(socket, Buffer.from('zINSTREAM\0', 'ascii'));
            for (let offset = 0; offset < bytes.byteLength; offset += this.chunkBytes) {
              const chunk = bytes.subarray(
                offset,
                Math.min(bytes.byteLength, offset + this.chunkBytes),
              );
              const length = Buffer.allocUnsafe(4);
              length.writeUInt32BE(chunk.byteLength);
              await write(socket, length);
              await write(socket, chunk);
            }
            await write(socket, Buffer.alloc(4));
          } catch {
            finish(new ClamAvProtocolError('CLAMAV_UNAVAILABLE'));
          }
        })();
      });
    });
  }
}

class ClamAvProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ClamAvProtocolError';
  }
}

function parseClamAvResponse(value: string): KnowledgeFileScanResult {
  const normalized = value.trim();
  const scannedAt = new Date().toISOString();
  if (/^(?:stream|INSTREAM): OK$/u.test(normalized)) {
    return { verdict: 'clean', scanner: 'clamav', scannedAt };
  }
  const infected = /^(?:stream|INSTREAM): (.+) FOUND$/u.exec(normalized);
  if (infected?.[1] !== undefined) {
    const signature = infected[1].replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200);
    return {
      verdict: 'infected',
      scanner: 'clamav',
      scannedAt,
      ...(signature.length === 0 ? {} : { signature }),
    };
  }
  return {
    verdict: 'error',
    scanner: 'clamav',
    code: normalized.endsWith(' ERROR') ? 'CLAMAV_SCAN_ERROR' : 'CLAMAV_INVALID_RESPONSE',
  };
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    });
  });
}

function validateHost(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    /[\s/\\@?#\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new TypeError('ClamAV host is invalid.');
  }
  return normalized;
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
