import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  DEFAULT_KNOWLEDGE_OBJECT_MAX_BYTES,
  KnowledgeObjectConflictError,
  KnowledgeObjectIntegrityError,
  KnowledgeObjectStore,
  KnowledgeObjectTooLargeError,
  KnowledgeObjectValidationError,
  assertKnowledgeObjectKey,
  buildKnowledgeObjectKey,
  prepareKnowledgeObjectBody,
  verifyReadable,
  type PutKnowledgeObjectInput,
  type ReadKnowledgeObject,
  type StoredKnowledgeObject,
} from './knowledge-object.store.js';

export interface LocalKnowledgeObjectStoreOptions {
  readonly root?: string;
  readonly maxBytes?: number;
}

@Injectable()
export class LocalKnowledgeObjectStore extends KnowledgeObjectStore {
  protected readonly maxBytes: number;
  private readonly root: string;

  constructor(options: LocalKnowledgeObjectStoreOptions = {}) {
    super();
    this.maxBytes = validateMaximumBytes(options.maxBytes ?? DEFAULT_KNOWLEDGE_OBJECT_MAX_BYTES);
    this.root = resolve(options.root ?? resolve(findWorkspaceRoot(), '.data', 'knowledge-objects'));
  }

  async putObject(input: PutKnowledgeObjectInput): Promise<StoredKnowledgeObject> {
    const objectKey = buildKnowledgeObjectKey(input);
    const prepared = prepareKnowledgeObjectBody(input, this.maxBytes);
    const path = this.pathFor(objectKey);
    await mkdir(dirname(path), { recursive: true });

    const existing = await this.inspectExisting(path, objectKey);
    if (existing !== undefined) {
      destroyPreparedStream(prepared.body);
      return assertIdempotent(existing, prepared);
    }

    const temporaryPath = `${path}.upload-${randomUUID()}`;
    try {
      if (Buffer.isBuffer(prepared.body)) {
        await writeFile(temporaryPath, prepared.body, { flag: 'wx' });
      } else {
        await pipeline(prepared.body, createWriteStream(temporaryPath, { flags: 'wx' }));
      }

      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        const raced = await this.inspectExisting(path, objectKey);
        if (raced === undefined) {
          throw new KnowledgeObjectIntegrityError(
            'Knowledge object disappeared during a conditional write.',
          );
        }
        return assertIdempotent(raced, prepared);
      }

      try {
        await writeFile(
          this.metadataPathFor(path),
          JSON.stringify({
            version: 1,
            size: prepared.size,
            sha256: prepared.sha256,
          }),
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }

      return {
        objectKey,
        size: prepared.size,
        sha256: prepared.sha256,
        created: true,
      };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async readObject(objectKey: string): Promise<ReadKnowledgeObject> {
    const normalizedKey = assertKnowledgeObjectKey(objectKey);
    const path = this.pathFor(normalizedKey);
    const existing = await this.inspectExisting(path, normalizedKey);
    if (existing === undefined) {
      throw new KnowledgeObjectIntegrityError('Local knowledge object does not exist.');
    }
    return {
      objectKey: normalizedKey,
      size: existing.size,
      sha256: existing.sha256,
      body: verifyReadable(createReadStream(path), this.maxBytes, existing.size, existing.sha256),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const path = this.pathFor(assertKnowledgeObjectKey(objectKey));
    await Promise.all([rm(path, { force: true }), rm(this.metadataPathFor(path), { force: true })]);
  }

  private async inspectExisting(
    path: string,
    objectKey: string,
  ): Promise<StoredKnowledgeObject | undefined> {
    let file;
    try {
      file = await stat(path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (!file.isFile()) {
      throw new KnowledgeObjectConflictError(objectKey);
    }
    if (file.size > this.maxBytes) throw new KnowledgeObjectTooLargeError(this.maxBytes);

    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      if (!Buffer.isBuffer(chunk)) {
        throw new KnowledgeObjectIntegrityError('Local knowledge object yielded a non-byte chunk.');
      }
      size += chunk.byteLength;
      if (size > this.maxBytes) throw new KnowledgeObjectTooLargeError(this.maxBytes);
      hash.update(chunk);
    }
    if (size !== file.size) {
      throw new KnowledgeObjectIntegrityError(
        `Local knowledge object changed while it was being inspected (${file.size} -> ${size}).`,
      );
    }
    const sha256 = hash.digest('hex');
    const metadata = await this.readMetadata(path);
    if (metadata !== undefined && (metadata.size !== size || metadata.sha256 !== sha256)) {
      throw new KnowledgeObjectIntegrityError(
        'Local knowledge object does not match its stored integrity metadata.',
      );
    }
    return {
      objectKey,
      size,
      sha256,
      created: false,
    };
  }

  private async readMetadata(
    path: string,
  ): Promise<{ readonly size: number; readonly sha256: string } | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.metadataPathFor(path), 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as {
        readonly version?: unknown;
        readonly size?: unknown;
        readonly sha256?: unknown;
      };
      if (
        parsed.version !== 1 ||
        typeof parsed.size !== 'number' ||
        typeof parsed.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(parsed.sha256)
      ) {
        throw new Error('invalid metadata');
      }
      return { size: parsed.size, sha256: parsed.sha256 };
    } catch {
      throw new KnowledgeObjectIntegrityError(
        'Local knowledge object integrity metadata is invalid.',
      );
    }
  }

  private pathFor(objectKey: string): string {
    const normalizedKey = assertKnowledgeObjectKey(objectKey);
    const path = resolve(this.root, ...normalizedKey.split('/'));
    const pathFromRoot = relative(this.root, path);
    if (
      pathFromRoot.length === 0 ||
      pathFromRoot.startsWith('..') ||
      resolve(this.root, pathFromRoot) !== path
    ) {
      throw new KnowledgeObjectValidationError('Knowledge object path escaped its storage root.');
    }
    return path;
  }

  private metadataPathFor(path: string): string {
    return `${path}.metadata.json`;
  }
}

function assertIdempotent(
  existing: StoredKnowledgeObject,
  requested: {
    readonly size: number;
    readonly sha256: string;
  },
): StoredKnowledgeObject {
  if (existing.size !== requested.size || existing.sha256 !== requested.sha256) {
    throw new KnowledgeObjectConflictError(existing.objectKey);
  }
  return { ...existing, created: false };
}

function destroyPreparedStream(body: Buffer | NodeJS.ReadableStream): void {
  if (!Buffer.isBuffer(body) && 'destroy' in body && typeof body.destroy === 'function') {
    body.destroy();
  }
}

function validateMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new KnowledgeObjectValidationError(
      'Knowledge object maximum size must be a positive safe integer.',
    );
  }
  return value;
}

function findWorkspaceRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    if (current.endsWith('enterprise-intelligent-agent')) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
