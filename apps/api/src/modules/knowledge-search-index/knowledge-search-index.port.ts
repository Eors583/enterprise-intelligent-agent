export interface KnowledgeSearchIndexChunk {
  readonly chunkId: string;
  readonly tenantId: string;
  readonly knowledgeBaseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly content: string;
  readonly contentHash: string;
  readonly classification: string;
  readonly governanceHash: string;
  readonly updatedAt: string;
  readonly vector?: readonly number[];
}

export interface KnowledgeSearchIndexProfile {
  readonly indexVersionId: string;
  readonly compatibleIndexVersionIds?: readonly string[];
  /** Null keeps legacy indexes on the deployment's configured base collection. */
  readonly collectionName: string | null;
  readonly dimensions: number;
  readonly distance: 'COSINE';
}

export interface KnowledgeSearchIndexQuery {
  readonly profile: KnowledgeSearchIndexProfile;
  readonly tenantId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly previewDocumentVersionIds?: readonly string[];
  readonly query: string;
  readonly vector?: readonly number[];
  readonly limit: number;
}

export interface KnowledgeSearchIndexHit {
  readonly chunkId: string;
  readonly score: number;
}

export interface KnowledgeSearchIndexStatus {
  readonly driver: 'postgres' | 'qdrant';
  readonly ready: boolean;
  readonly collection: string | null;
  readonly dimensions: number | null;
}

export abstract class KnowledgeSearchIndex {
  abstract readonly driver: 'postgres' | 'qdrant';

  abstract replaceDocumentVersion(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentVersionId: string;
    readonly active: boolean;
    readonly chunks: readonly KnowledgeSearchIndexChunk[];
  }): Promise<void>;

  abstract publishDocumentVersion(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<void>;

  abstract archiveDocument(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentId: string;
  }): Promise<void>;

  abstract query(input: KnowledgeSearchIndexQuery): Promise<readonly KnowledgeSearchIndexHit[]>;

  abstract status(profile?: KnowledgeSearchIndexProfile): Promise<KnowledgeSearchIndexStatus>;
}
