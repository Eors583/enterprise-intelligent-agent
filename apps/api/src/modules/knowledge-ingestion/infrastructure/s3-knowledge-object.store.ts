import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

import type { S3KmsKeyReference } from '../../../config/environment.js';
import {
  KnowledgeObjectConflictError,
  KnowledgeObjectIntegrityError,
  KnowledgeObjectStore,
  KnowledgeObjectValidationError,
  assertKnowledgeObjectKey,
  assertKnowledgeObjectSize,
  buildKnowledgeObjectKey,
  normalizeSha256,
  prepareKnowledgeObjectBody,
  verifyReadable,
  type PutKnowledgeObjectInput,
  type ReadKnowledgeObject,
  type StoredKnowledgeObject,
} from './knowledge-object.store.js';

export interface S3KnowledgeObjectStoreOptions {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly forcePathStyle: boolean;
  readonly prefix: string;
  readonly maxBytes: number;
  readonly kmsKeyId?: S3KmsKeyReference;
}

type S3CommandSender = Pick<S3Client, 'send'>;

export class S3KnowledgeObjectStore extends KnowledgeObjectStore {
  protected readonly maxBytes: number;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3CommandSender;
  private readonly kmsKeyId: S3KmsKeyReference | undefined;

  constructor(options: S3KnowledgeObjectStoreOptions, client?: S3CommandSender) {
    super();
    this.maxBytes = validateMaximumBytes(options.maxBytes);
    this.bucket = validateBucket(options.bucket);
    this.prefix = normalizePrefix(options.prefix);
    this.kmsKeyId = options.kmsKeyId;
    this.client =
      client ??
      new S3Client({
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        region: options.region,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        forcePathStyle: options.forcePathStyle,
        maxAttempts: 1,
      });
  }

  async putObject(input: PutKnowledgeObjectInput): Promise<StoredKnowledgeObject> {
    const objectKey = buildKnowledgeObjectKey(input);
    const prepared = prepareKnowledgeObjectBody(input, this.maxBytes);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.physicalKey(objectKey),
          Body: prepared.body,
          ContentLength: prepared.size,
          ContentType: input.contentType ?? 'application/octet-stream',
          ChecksumSHA256: Buffer.from(prepared.sha256, 'hex').toString('base64'),
          IfNoneMatch: '*',
          Metadata: {
            sha256: prepared.sha256,
            logicalkey: objectKey,
          },
          ...(this.kmsKeyId === undefined
            ? {}
            : {
                ServerSideEncryption: 'aws:kms',
                SSEKMSKeyId: this.kmsKeyId,
              }),
        }),
      );
      return {
        objectKey,
        size: prepared.size,
        sha256: prepared.sha256,
        created: true,
      };
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const existing = await this.headExisting(objectKey);
      if (existing.size !== prepared.size || existing.sha256 !== prepared.sha256) {
        throw new KnowledgeObjectConflictError(objectKey);
      }
      return { ...existing, created: false };
    }
  }

  async readObject(objectKey: string): Promise<ReadKnowledgeObject> {
    const normalizedKey = assertKnowledgeObjectKey(objectKey);
    const response = (await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(normalizedKey),
        ChecksumMode: 'ENABLED',
      }),
    )) as GetObjectCommandOutput;
    assertExpectedKmsEncryption(response, this.kmsKeyId);
    if (response.ContentLength === undefined) {
      throw new KnowledgeObjectIntegrityError(
        'S3 knowledge object response did not include Content-Length.',
      );
    }
    const size = assertKnowledgeObjectSize(response.ContentLength, this.maxBytes);
    if (response.Body === undefined) {
      throw new KnowledgeObjectIntegrityError(
        'S3 knowledge object response did not include a body.',
      );
    }
    if (response.Metadata?.sha256 === undefined) {
      throw new KnowledgeObjectIntegrityError(
        'S3 knowledge object response did not include SHA-256 metadata.',
      );
    }
    const sha256 = normalizeSha256(response.Metadata.sha256);
    if (
      response.ChecksumSHA256 !== undefined &&
      response.ChecksumSHA256 !== Buffer.from(sha256, 'hex').toString('base64')
    ) {
      throw new KnowledgeObjectIntegrityError(
        'S3 provider checksum does not match knowledge object SHA-256 metadata.',
      );
    }
    const body = await toNodeReadable(response.Body);
    return {
      objectKey: normalizedKey,
      size,
      sha256,
      body: verifyReadable(body, this.maxBytes, size, sha256),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const normalizedKey = assertKnowledgeObjectKey(objectKey);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(normalizedKey),
      }),
    );
  }

  private async headExisting(objectKey: string): Promise<StoredKnowledgeObject> {
    const response = (await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(objectKey),
      }),
    )) as HeadObjectCommandOutput;
    assertExpectedKmsEncryption(response, this.kmsKeyId);
    if (response.ContentLength === undefined || response.Metadata?.sha256 === undefined) {
      throw new KnowledgeObjectIntegrityError(
        'Existing S3 knowledge object is missing size or SHA-256 metadata.',
      );
    }
    return {
      objectKey,
      size: assertKnowledgeObjectSize(response.ContentLength, this.maxBytes),
      sha256: normalizeSha256(response.Metadata.sha256),
      created: false,
    };
  }

  private physicalKey(objectKey: string): string {
    const normalizedKey = assertKnowledgeObjectKey(objectKey);
    return this.prefix.length === 0 ? normalizedKey : `${this.prefix}/${normalizedKey}`;
  }
}

async function toNodeReadable(
  body: NonNullable<GetObjectCommandOutput['Body']>,
): Promise<Readable> {
  if (body instanceof Readable) return body;
  if (Symbol.asyncIterator in Object(body)) {
    return Readable.from(body as AsyncIterable<Uint8Array>, { objectMode: false });
  }
  if ('transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
    return Readable.from([Buffer.from(await body.transformToByteArray())], {
      objectMode: false,
    });
  }
  throw new KnowledgeObjectIntegrityError('S3 returned an unsupported response body type.');
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly Code?: unknown;
    readonly code?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.$metadata?.httpStatusCode === 412 ||
    candidate.name === 'PreconditionFailed' ||
    candidate.Code === 'PreconditionFailed' ||
    candidate.code === 'PreconditionFailed'
  );
}

function normalizePrefix(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (
    normalized.length > 200 ||
    normalized.split('/').some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new KnowledgeObjectValidationError(
      'S3 knowledge object prefix contains an unsafe path segment.',
    );
  }
  return normalized;
}

function validateBucket(value: string): string {
  if (value.length < 3 || value.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    throw new KnowledgeObjectValidationError('S3 knowledge object bucket name is invalid.');
  }
  return value;
}

function validateMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new KnowledgeObjectValidationError(
      'Knowledge object maximum size must be a positive safe integer.',
    );
  }
  return value;
}

function assertExpectedKmsEncryption(
  response: Pick<
    GetObjectCommandOutput | HeadObjectCommandOutput,
    'ServerSideEncryption' | 'SSEKMSKeyId'
  >,
  expectedKmsKeyId: S3KmsKeyReference | undefined,
): void {
  if (expectedKmsKeyId === undefined) return;
  if (response.ServerSideEncryption !== 'aws:kms' || response.SSEKMSKeyId !== expectedKmsKeyId) {
    throw new KnowledgeObjectIntegrityError(
      'S3 knowledge object encryption metadata does not match the configured customer-managed KMS key.',
    );
  }
}
