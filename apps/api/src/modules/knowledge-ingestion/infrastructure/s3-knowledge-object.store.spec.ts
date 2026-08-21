import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { S3KmsKeyReference } from '../../../config/environment.js';
import {
  KnowledgeObjectConflictError,
  KnowledgeObjectIntegrityError,
} from './knowledge-object.store.js';
import {
  S3KnowledgeObjectStore,
  type S3KnowledgeObjectStoreOptions,
} from './s3-knowledge-object.store.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000002';
const VERSION_ID = '00000000-0000-7000-8000-000000000003';
const OBJECT_KEY = `${TENANT_ID}/${DOCUMENT_ID}/${VERSION_ID}.bin`;
const PHYSICAL_KEY = `knowledge/v1/${OBJECT_KEY}`;
const KMS_KEY_ARN =
  'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012' as S3KmsKeyReference;

describe('S3KnowledgeObjectStore', () => {
  it('uses an immutable conditional write with size and checksum metadata', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStore(send);
    const bytes = Buffer.from('enterprise source');

    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: bytes,
      }),
    ).resolves.toEqual({
      objectKey: OBJECT_KEY,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      created: true,
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'enterprise-knowledge',
      Key: PHYSICAL_KEY,
      Body: bytes,
      ContentLength: bytes.byteLength,
      IfNoneMatch: '*',
      ChecksumSHA256: Buffer.from(sha256(bytes), 'hex').toString('base64'),
      Metadata: {
        sha256: sha256(bytes),
        logicalkey: OBJECT_KEY,
      },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN,
    });
  });

  it('keeps development S3-compatible stores usable when KMS is not configured', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStore(send, {}, false);

    await store.putObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      body: Buffer.from('local development'),
    });

    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command.input).not.toHaveProperty('ServerSideEncryption');
    expect(command.input).not.toHaveProperty('SSEKMSKeyId');
  });

  it('accepts a pre-existing object only when its immutable metadata matches', async () => {
    const bytes = Buffer.from('same source');
    const send = vi
      .fn()
      .mockRejectedValueOnce({
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
      .mockResolvedValueOnce({
        ContentLength: bytes.byteLength,
        Metadata: { sha256: sha256(bytes) },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const store = createStore(send);

    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: bytes,
      }),
    ).resolves.toMatchObject({ objectKey: OBJECT_KEY, created: false });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('rejects a conditional-write collision with different content', async () => {
    const bytes = Buffer.from('requested source');
    const send = vi
      .fn()
      .mockRejectedValueOnce({
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
      .mockResolvedValueOnce({
        ContentLength: bytes.byteLength,
        Metadata: { sha256: sha256(Buffer.from('different source')) },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const store = createStore(send);

    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: bytes,
      }),
    ).rejects.toBeInstanceOf(KnowledgeObjectConflictError);
  });

  it('requests provider checksums and verifies every downloaded byte', async () => {
    const bytes = Buffer.from('verified download');
    const digest = sha256(bytes);
    const send = vi.fn().mockResolvedValue({
      ContentLength: bytes.byteLength,
      Metadata: { sha256: digest },
      ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
      Body: Readable.from([bytes]),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN,
    });
    const store = createStore(send);

    await expect(store.read(OBJECT_KEY)).resolves.toEqual(bytes);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toMatchObject({
      Bucket: 'enterprise-knowledge',
      Key: PHYSICAL_KEY,
      ChecksumMode: 'ENABLED',
    });
  });

  it('fails closed when metadata is absent or downloaded content is tampered', async () => {
    const bytes = Buffer.from('expected bytes');
    const missingMetadataStore = createStore(
      vi.fn().mockResolvedValue({
        ContentLength: bytes.byteLength,
        Body: Readable.from([bytes]),
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      }),
    );
    await expect(missingMetadataStore.read(OBJECT_KEY)).rejects.toBeInstanceOf(
      KnowledgeObjectIntegrityError,
    );

    const tamperedStore = createStore(
      vi.fn().mockResolvedValue({
        ContentLength: bytes.byteLength,
        Metadata: { sha256: sha256(bytes) },
        Body: Readable.from([Buffer.from('tampered bytes')]),
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      }),
    );
    await expect(tamperedStore.read(OBJECT_KEY)).rejects.toBeInstanceOf(
      KnowledgeObjectIntegrityError,
    );
  });

  it('fails closed when GetObject encryption metadata is absent or names another KMS key', async () => {
    const bytes = Buffer.from('encrypted source');
    const digest = sha256(bytes);
    const response = {
      ContentLength: bytes.byteLength,
      Metadata: { sha256: digest },
      Body: Readable.from([bytes]),
    };
    await expect(
      createStore(vi.fn().mockResolvedValue(response)).read(OBJECT_KEY),
    ).rejects.toBeInstanceOf(KnowledgeObjectIntegrityError);
    await expect(
      createStore(
        vi.fn().mockResolvedValue({
          ...response,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId:
            'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        }),
      ).read(OBJECT_KEY),
    ).rejects.toBeInstanceOf(KnowledgeObjectIntegrityError);
  });

  it('fails closed when a pre-existing object does not carry the configured KMS metadata', async () => {
    const bytes = Buffer.from('existing source');
    const send = vi
      .fn()
      .mockRejectedValueOnce({
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
      .mockResolvedValueOnce({
        ContentLength: bytes.byteLength,
        Metadata: { sha256: sha256(bytes) },
        ServerSideEncryption: 'AES256',
      });

    await expect(
      createStore(send).putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: bytes,
      }),
    ).rejects.toBeInstanceOf(KnowledgeObjectIntegrityError);
  });

  it('deletes only the validated, prefixed object key', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStore(send);

    await store.deleteObject(OBJECT_KEY);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect((command as DeleteObjectCommand).input).toEqual({
      Bucket: 'enterprise-knowledge',
      Key: PHYSICAL_KEY,
    });
  });
});

function createStore(
  send: ReturnType<typeof vi.fn>,
  overrides: Partial<S3KnowledgeObjectStoreOptions> = {},
  withKms = true,
): S3KnowledgeObjectStore {
  const options: S3KnowledgeObjectStoreOptions = {
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    bucket: 'enterprise-knowledge',
    credentials: {
      accessKeyId: 'minio-access',
      secretAccessKey: 'minio-secret',
    },
    forcePathStyle: true,
    prefix: 'knowledge/v1',
    maxBytes: 1024,
    ...(withKms ? { kmsKeyId: KMS_KEY_ARN } : {}),
    ...overrides,
  };
  return new S3KnowledgeObjectStore(options, { send } as unknown as Pick<S3Client, 'send'>);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
