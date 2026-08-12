import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { KnowledgeSearchIndex } from './knowledge-search-index.port.js';
import { PostgresKnowledgeSearchIndex } from './postgres-knowledge-search-index.js';
import { QdrantKnowledgeSearchIndex } from './qdrant-knowledge-search-index.js';

@Module({
  providers: [
    PostgresKnowledgeSearchIndex,
    {
      provide: KnowledgeSearchIndex,
      inject: [ConfigService, PostgresKnowledgeSearchIndex],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        postgres: PostgresKnowledgeSearchIndex,
      ): KnowledgeSearchIndex => {
        if (config.get('KNOWLEDGE_SEARCH_INDEX_DRIVER', { infer: true }) === 'postgres') {
          return postgres;
        }
        const baseUrl = config.get('KNOWLEDGE_QDRANT_URL', { infer: true });
        if (baseUrl === undefined) throw new Error('KNOWLEDGE_QDRANT_URL is required.');
        return new QdrantKnowledgeSearchIndex({
          baseUrl,
          apiKey: config.get('KNOWLEDGE_QDRANT_API_KEY', { infer: true }),
          collection: config.get('KNOWLEDGE_QDRANT_COLLECTION', { infer: true }),
          dimensions: config.get('KNOWLEDGE_EMBEDDING_DIMENSIONS', { infer: true }),
          timeoutMs: config.get('KNOWLEDGE_QDRANT_TIMEOUT_MS', { infer: true }),
        });
      },
    },
  ],
  exports: [KnowledgeSearchIndex],
})
export class KnowledgeSearchIndexModule {}
