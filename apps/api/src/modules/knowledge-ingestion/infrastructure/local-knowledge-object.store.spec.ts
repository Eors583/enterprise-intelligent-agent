import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  KnowledgeObjectConflictError,
  KnowledgeObjectIntegrityError,
  KnowledgeObjectTooLargeError,
  KnowledgeObjectValidationError,
} from './knowledge-object.store.js';
import { LocalKnowledgeObjectStore } from './local-knowledge-object.store.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000002';
const VERSION_ID = '00000000-0000-7000-8000-000000000003';
const OBJECT_KEY = `${TENANT_ID}/${DOCUMENT_ID}/${VERSION_ID}.bin`;

describe('LocalKnowledgeObjectStore', () => {
  let root: string;
  let store: LocalKnowledgeObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-object-store-'));
    store = new LocalKnowledgeObjectStore({ root, maxBytes: 1024 });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('stores a bounded object and returns stable integrity metadata', async () => {
    const bytes = Buffer.from('trusted enterprise knowledge');
    const stored = await store.putObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      body: bytes,
    });

    expect(stored).toEqual({
      objectKey: OBJECT_KEY,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      created: true,
    });
    await expect(store.read(OBJECT_KEY)).resolves.toEqual(bytes);
  });

  it('treats the same conditional write as idempotent and rejects different bytes', async () => {
    const bytes = Buffer.from('same upload');
    await store.putObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      body: bytes,
    });

    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: bytes,
      }),
    ).resolves.toMatchObject({ created: false, sha256: sha256(bytes) });

    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: Buffer.from('different upload'),
      }),
    ).rejects.toBeInstanceOf(KnowledgeObjectConflictError);
  });

  it('supports declared streaming writes and verifies their digest', async () => {
    const bytes = Buffer.from('streamed upload');
    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: Readable.from([bytes]),
        size: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    ).resolves.toMatchObject({ created: true, size: bytes.byteLength });

    await expect(store.read(OBJECT_KEY)).resolves.toEqual(bytes);
  });

  it('rejects unbounded streams, oversized objects, and unsafe keys', async () => {
    await expect(
      store.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: Readable.from([Buffer.from('missing declarations')]),
      }),
    ).rejects.toBeInstanceOf(KnowledgeObjectValidationError);

    const smallStore = new LocalKnowledgeObjectStore({ root, maxBytes: 4 });
    await expect(
      smallStore.putObject({
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        body: Buffer.from('12345'),
      }),
    ).rejects.toBeInstanceOf(KnowledgeObjectTooLargeError);

    await expect(store.read(`../${OBJECT_KEY}`)).rejects.toBeInstanceOf(
      KnowledgeObjectValidationError,
    );
  });

  it('detects at-rest corruption against the local integrity sidecar', async () => {
    const bytes = Buffer.from('original bytes');
    await store.putObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      body: bytes,
    });
    await writeFile(join(root, ...OBJECT_KEY.split('/')), Buffer.from('tampered bytes'));

    await expect(store.read(OBJECT_KEY)).rejects.toBeInstanceOf(KnowledgeObjectIntegrityError);
  });

  it('deletes both the object and its integrity metadata idempotently', async () => {
    await store.putObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      body: Buffer.from('delete me'),
    });

    await store.deleteObject(OBJECT_KEY);
    await store.deleteObject(OBJECT_KEY);
    await expect(store.read(OBJECT_KEY)).rejects.toBeInstanceOf(KnowledgeObjectIntegrityError);
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
