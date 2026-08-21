import { Injectable } from '@nestjs/common';

import {
  KnowledgeSearchIndex,
  type KnowledgeSearchIndexHit,
  type KnowledgeSearchIndexQuery,
  type KnowledgeSearchIndexStatus,
} from './knowledge-search-index.port.js';

/**
 * Compatibility adapter. PostgreSQL indexing is performed by the existing
 * ingestion transaction, so this port deliberately has no external side effects.
 */
@Injectable()
export class PostgresKnowledgeSearchIndex extends KnowledgeSearchIndex {
  readonly driver = 'postgres' as const;

  async replaceDocumentVersion(): Promise<void> {}

  async publishDocumentVersion(): Promise<void> {}

  async archiveDocument(): Promise<void> {}

  async query(_input: KnowledgeSearchIndexQuery): Promise<readonly KnowledgeSearchIndexHit[]> {
    return [];
  }

  async status(): Promise<KnowledgeSearchIndexStatus> {
    return { driver: this.driver, ready: true, collection: null, dimensions: null };
  }
}
