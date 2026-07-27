import { ConfigService } from '@nestjs/config';

import { validateEnvironment, type EnvironmentVariables } from '../../../config/environment.js';
import { createKnowledgeObjectStore } from './knowledge-object-store.module.js';
import { LocalKnowledgeObjectStore } from './local-knowledge-object.store.js';
import { S3KnowledgeObjectStore } from './s3-knowledge-object.store.js';

describe('createKnowledgeObjectStore', () => {
  it('keeps the local adapter as the development default', () => {
    expect(createKnowledgeObjectStore(config({ NODE_ENV: 'test' }))).toBeInstanceOf(
      LocalKnowledgeObjectStore,
    );
  });

  it('constructs the S3 adapter without static credentials for workload identity', () => {
    expect(
      createKnowledgeObjectStore(
        config({
          NODE_ENV: 'test',
          KNOWLEDGE_OBJECT_STORE_DRIVER: 's3',
          KNOWLEDGE_OBJECT_STORE_S3_REGION: 'ap-southeast-1',
          KNOWLEDGE_OBJECT_STORE_S3_BUCKET: 'enterprise-knowledge',
          KNOWLEDGE_OBJECT_STORE_S3_CREDENTIAL_MODE: 'default_chain',
        }),
      ),
    ).toBeInstanceOf(S3KnowledgeObjectStore);
  });
});

function config(source: Record<string, unknown>): ConfigService<EnvironmentVariables, true> {
  return new ConfigService<EnvironmentVariables, true>(validateEnvironment(source));
}
