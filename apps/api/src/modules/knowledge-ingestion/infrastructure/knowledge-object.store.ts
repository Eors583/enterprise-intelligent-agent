import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

export const KNOWLEDGE_OBJECT_STORE = Symbol('KNOWLEDGE_OBJECT_STORE');
export const DEFAULT_KNOWLEDGE_OBJECT_MAX_BYTES = 50 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const OBJECT_KEY_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.bin$/i;

export type KnowledgeObjectBody = Buffer | Uint8Array | Readable | AsyncIterable<Uint8Array>;

export interface PutKnowledgeObjectInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly body: KnowledgeObjectBody;
  /**
   * Required for a streaming body. Buffers are measured and hashed by the
   * implementation before any persistent write starts.
   */
  readonly size?: number;
  /**
   * Required for a streaming body. S3-compatible stores also send this as the
   * provider-side checksum so a truncated stream cannot become a valid object.
   */
  readonly sha256?: string;
}

export interface StoredKnowledgeObject {
  readonly objectKey: string;
  readonly size: number;
  readonly sha256: string;
  readonly created: boolean;
}

export interface ReadKnowledgeObject {
  readonly objectKey: string;
  readonly body: Readable;
  readonly size: number;
  readonly sha256: string;
}

export interface PreparedKnowledgeObjectBody {
  readonly body: Buffer | Readable;
  readonly size: number;
  readonly sha256: string;
}

export abstract class KnowledgeObjectStore {
  protected abstract readonly maxBytes: number;

  abstract putObject(input: PutKnowledgeObjectInput): Promise<StoredKnowledgeObject>;

  abstract readObject(objectKey: string): Promise<ReadKnowledgeObject>;

  abstract deleteObject(objectKey: string): Promise<void>;

  /**
   * Compatibility boundary for the current ingestion service. New code should
   * use putObject() so it can persist and audit the returned digest and size.
   */
  async put(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly bytes: Buffer;
  }): Promise<string> {
    const stored = await this.putObject({
      tenantId: input.tenantId,
      documentId: input.documentId,
      versionId: input.versionId,
      body: input.bytes,
    });
    return stored.objectKey;
  }

  /**
   * Compatibility boundary for parsers which still consume a complete Buffer.
   * The collection remains bounded by the same store-level object limit.
   */
  async read(objectKey: string): Promise<Buffer> {
    const object = await this.readObject(objectKey);
    return collectReadable(object.body, this.maxBytes, object.size);
  }

  delete(objectKey: string): Promise<void> {
    return this.deleteObject(objectKey);
  }
}

export class KnowledgeObjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeObjectValidationError';
  }
}

export class KnowledgeObjectTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Knowledge object exceeds the configured ${maximumBytes}-byte limit.`);
    this.name = 'KnowledgeObjectTooLargeError';
  }
}

export class KnowledgeObjectConflictError extends Error {
  constructor(readonly objectKey: string) {
    super(`Knowledge object ${objectKey} already exists with different content.`);
    this.name = 'KnowledgeObjectConflictError';
  }
}

export class KnowledgeObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeObjectIntegrityError';
  }
}

export function buildKnowledgeObjectKey(input: {
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionId: string;
}): string {
  const tenantId = normalizeUuid(input.tenantId);
  const documentId = normalizeUuid(input.documentId);
  const versionId = normalizeUuid(input.versionId);
  return `${tenantId}/${documentId}/${versionId}.bin`;
}

export function assertKnowledgeObjectKey(objectKey: string): string {
  const normalized = objectKey.replaceAll('\\', '/');
  const match = OBJECT_KEY_PATTERN.exec(normalized);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new KnowledgeObjectValidationError('Invalid knowledge object key.');
  }
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}/${match[3].toLowerCase()}.bin`;
}

export function normalizeSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new KnowledgeObjectValidationError(
      'Knowledge object SHA-256 must contain 64 hex digits.',
    );
  }
  return value.toLowerCase();
}

export function assertKnowledgeObjectSize(size: number, maxBytes: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new KnowledgeObjectValidationError(
      'Knowledge object size must be a non-negative safe integer.',
    );
  }
  if (size > maxBytes) throw new KnowledgeObjectTooLargeError(maxBytes);
  return size;
}

export function prepareKnowledgeObjectBody(
  input: Pick<PutKnowledgeObjectInput, 'body' | 'sha256' | 'size'>,
  maxBytes: number,
): PreparedKnowledgeObjectBody {
  if (Buffer.isBuffer(input.body) || input.body instanceof Uint8Array) {
    const body = Buffer.from(input.body);
    const size = assertKnowledgeObjectSize(body.byteLength, maxBytes);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (input.size !== undefined && input.size !== size) {
      throw new KnowledgeObjectIntegrityError(
        `Knowledge object declared ${input.size} bytes but contains ${size} bytes.`,
      );
    }
    if (input.sha256 !== undefined && normalizeSha256(input.sha256) !== sha256) {
      throw new KnowledgeObjectIntegrityError(
        'Knowledge object content does not match its declared SHA-256.',
      );
    }
    return { body, size, sha256 };
  }

  if (input.size === undefined || input.sha256 === undefined) {
    throw new KnowledgeObjectValidationError(
      'Streaming knowledge objects require declared size and SHA-256.',
    );
  }
  const size = assertKnowledgeObjectSize(input.size, maxBytes);
  const sha256 = normalizeSha256(input.sha256);
  const source =
    input.body instanceof Readable ? input.body : Readable.from(input.body, { objectMode: false });
  return {
    body: source.pipe(new IntegrityTransform(maxBytes, size, sha256)),
    size,
    sha256,
  };
}

export function verifyReadable(
  body: Readable,
  maxBytes: number,
  expectedSize: number,
  expectedSha256: string,
): Readable {
  return body.pipe(new IntegrityTransform(maxBytes, expectedSize, normalizeSha256(expectedSha256)));
}

export async function collectReadable(
  body: Readable,
  maxBytes: number,
  expectedSize?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = toBuffer(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new KnowledgeObjectTooLargeError(maxBytes);
    chunks.push(bytes);
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    throw new KnowledgeObjectIntegrityError(
      `Knowledge object declared ${expectedSize} bytes but yielded ${size} bytes.`,
    );
  }
  return Buffer.concat(chunks, size);
}

function normalizeUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new KnowledgeObjectValidationError('Knowledge object identity is not a canonical UUID.');
  }
  return value.toLowerCase();
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new KnowledgeObjectIntegrityError('Knowledge object streams must yield byte chunks.');
}

class IntegrityTransform extends Transform {
  private readonly hash = createHash('sha256');
  private received = 0;

  constructor(
    private readonly maximumBytes: number,
    private readonly expectedSize: number,
    private readonly expectedSha256: string,
  ) {
    super();
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    try {
      const bytes = toBuffer(chunk);
      this.received += bytes.byteLength;
      if (this.received > this.maximumBytes) {
        callback(new KnowledgeObjectTooLargeError(this.maximumBytes));
        return;
      }
      if (this.received > this.expectedSize) {
        callback(
          new KnowledgeObjectIntegrityError(
            `Knowledge object exceeded its declared ${this.expectedSize}-byte size.`,
          ),
        );
        return;
      }
      this.hash.update(bytes);
      callback(null, bytes);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.received !== this.expectedSize) {
      callback(
        new KnowledgeObjectIntegrityError(
          `Knowledge object declared ${this.expectedSize} bytes but yielded ${this.received} bytes.`,
        ),
      );
      return;
    }
    if (this.hash.digest('hex') !== this.expectedSha256) {
      callback(
        new KnowledgeObjectIntegrityError(
          'Knowledge object stream does not match its declared SHA-256.',
        ),
      );
      return;
    }
    callback();
  }
}
