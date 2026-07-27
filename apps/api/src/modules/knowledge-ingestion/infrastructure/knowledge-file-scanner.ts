import { Injectable } from '@nestjs/common';

export const KNOWLEDGE_FILE_SCANNER = Symbol('KNOWLEDGE_FILE_SCANNER');

export interface ScanKnowledgeFileInput {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sha256: string;
}

export type KnowledgeFileScanResult =
  | {
      readonly verdict: 'clean';
      readonly scanner: string;
      readonly scannedAt: string;
    }
  | {
      readonly verdict: 'infected';
      readonly scanner: string;
      readonly scannedAt: string;
      readonly signature?: string;
    }
  | {
      readonly verdict: 'not_scanned';
      readonly reason: 'disabled';
    }
  | {
      readonly verdict: 'error';
      readonly scanner: string;
      readonly code: string;
    };

export abstract class KnowledgeFileScanner {
  abstract scan(input: ScanKnowledgeFileInput): Promise<KnowledgeFileScanResult>;
}

/**
 * Development-only scanner. It deliberately returns not_scanned rather than
 * clean so callers cannot accidentally promote an unchecked upload to trusted
 * knowledge.
 */
@Injectable()
export class DisabledKnowledgeFileScanner extends KnowledgeFileScanner {
  scan(_input: ScanKnowledgeFileInput): Promise<KnowledgeFileScanResult> {
    return Promise.resolve({ verdict: 'not_scanned', reason: 'disabled' });
  }
}

/**
 * Fail-closed placeholder used until the configured scanner adapter (for
 * example ClamAV) is registered. It never claims an upload is clean.
 */
@Injectable()
export class UnavailableKnowledgeFileScanner extends KnowledgeFileScanner {
  scan(_input: ScanKnowledgeFileInput): Promise<KnowledgeFileScanResult> {
    return Promise.resolve({
      verdict: 'error',
      scanner: 'unavailable',
      code: 'SCANNER_ADAPTER_NOT_REGISTERED',
    });
  }
}

export function assertKnowledgeFileScanPassed(
  result: KnowledgeFileScanResult,
): asserts result is Extract<KnowledgeFileScanResult, { readonly verdict: 'clean' }> {
  if (result.verdict !== 'clean') {
    throw new KnowledgeFileScanRejectedError(result.verdict);
  }
}

export class KnowledgeFileScanRejectedError extends Error {
  constructor(readonly verdict: Exclude<KnowledgeFileScanResult['verdict'], 'clean'>) {
    super(`Knowledge file cannot be promoted because its scan verdict is ${verdict}.`);
    this.name = 'KnowledgeFileScanRejectedError';
  }
}
