import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { KnowledgeFileScannerModule } from './knowledge-file-scanner.module.js';
import { KNOWLEDGE_OBJECT_STORE, KnowledgeObjectStore } from './knowledge-object.store.js';
import { LocalKnowledgeObjectStore } from './local-knowledge-object.store.js';
import {
  S3KnowledgeObjectStore,
  type S3KnowledgeObjectStoreOptions,
} from './s3-knowledge-object.store.js';

@Module({
  imports: [KnowledgeFileScannerModule],
  providers: [
    {
      provide: KNOWLEDGE_OBJECT_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): KnowledgeObjectStore =>
        createKnowledgeObjectStore(config),
    },
    { provide: KnowledgeObjectStore, useExisting: KNOWLEDGE_OBJECT_STORE },
    // Compatibility token for KnowledgeIngestionService until it migrates to
    // the storage port. In production this token resolves to the S3 adapter.
    { provide: LocalKnowledgeObjectStore, useExisting: KNOWLEDGE_OBJECT_STORE },
  ],
  exports: [
    KNOWLEDGE_OBJECT_STORE,
    KnowledgeObjectStore,
    LocalKnowledgeObjectStore,
    KnowledgeFileScannerModule,
  ],
})
export class KnowledgeObjectStoreModule {}

export function createKnowledgeObjectStore(
  config: ConfigService<EnvironmentVariables, true>,
): KnowledgeObjectStore {
  const maxBytes = config.get('KNOWLEDGE_OBJECT_STORE_MAX_BYTES', { infer: true });
  if (config.get('KNOWLEDGE_OBJECT_STORE_DRIVER', { infer: true }) === 'local') {
    const root = config.get('KNOWLEDGE_OBJECT_STORE_LOCAL_ROOT', { infer: true });
    return new LocalKnowledgeObjectStore({
      maxBytes,
      ...(root === undefined ? {} : { root }),
    });
  }

  const endpoint = config.get('KNOWLEDGE_OBJECT_STORE_S3_ENDPOINT', { infer: true });
  const credentialMode = config.get('KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE', {
    infer: true,
  });
  const options: S3KnowledgeObjectStoreOptions = {
    ...(endpoint === undefined ? {} : { endpoint }),
    region: config.get('KNOWLEDGE_OBJECT_STORE_S3_REGION', { infer: true }),
    bucket: required(config, 'KNOWLEDGE_OBJECT_STORE_S3_BUCKET'),
    ...(credentialMode === 'default_chain'
      ? {}
      : {
          credentials: {
            accessKeyId: required(config, 'KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID'),
            secretAccessKey: required(config, 'KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY'),
          },
        }),
    forcePathStyle: config.get('KNOWLEDGE_OBJECT_STORE_S3_FORCE_PATH_STYLE', {
      infer: true,
    }),
    prefix: config.get('KNOWLEDGE_OBJECT_STORE_S3_PREFIX', { infer: true }),
    maxBytes,
  };
  return new S3KnowledgeObjectStore(options);
}

function required<
  Key extends
    | 'KNOWLEDGE_OBJECT_STORE_S3_BUCKET'
    | 'KNOWLEDGE_OBJECT_STORE_S3_ACCESS_KEY_ID'
    | 'KNOWLEDGE_OBJECT_STORE_S3_SECRET_ACCESS_KEY',
>(config: ConfigService<EnvironmentVariables, true>, key: Key): string {
  const value = config.get(key, { infer: true });
  if (value === undefined) {
    throw new Error(`${key} is required for the S3 knowledge object store.`);
  }
  return value;
}
