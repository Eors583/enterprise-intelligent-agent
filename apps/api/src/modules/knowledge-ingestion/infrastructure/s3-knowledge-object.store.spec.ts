import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

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
    });
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
      }),
    );
    await expect(tamperedStore.read(OBJECT_KEY)).rejects.toBeInstanceOf(
      KnowledgeObjectIntegrityError,
    );
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

function createStore(send: ReturnType<typeof vi.fn>): S3KnowledgeObjectStore {
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
  };
  return new S3KnowledgeObjectStore(options, { send } as unknown as Pick<S3Client, 'send'>);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
