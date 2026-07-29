import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';
import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';
import {
  KNOWLEDGE_DOCUMENT_PARSER,
  type KnowledgeDocumentParser,
} from './application/knowledge-document-parser.port.js';
import { KnowledgeIngestionAvailabilityService } from './application/knowledge-ingestion-availability.service.js';
import {
  KnowledgeIngestionProcessor,
  KnowledgeIngestionService,
} from './application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from './application/knowledge-ingestion.worker.js';
import { KnowledgeIngestionJobRepository } from './domain/knowledge-ingestion-job.repository.js';
import { DoclingDocumentParserAdapter } from './infrastructure/docling-document-parser.adapter.js';
import { ControlledKnowledgeWebFetcher } from './infrastructure/controlled-knowledge-web-fetcher.js';
import { DocumentParserAdapter } from './infrastructure/document-parser.adapter.js';
import { KnowledgeObjectStoreModule } from './infrastructure/knowledge-object-store.module.js';
import { PrismaKnowledgeIngestionJobRepository } from './infrastructure/prisma-knowledge-ingestion-job.repository.js';

@Module({
  imports: [AdminAccessModule, KnowledgeSemanticModule, KnowledgeObjectStoreModule],
  providers: [
    DocumentParserAdapter,
    ControlledKnowledgeWebFetcher,
    {
      provide: KNOWLEDGE_DOCUMENT_PARSER,
      inject: [ConfigService, DocumentParserAdapter],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        localParser: DocumentParserAdapter,
      ): KnowledgeDocumentParser => {
        if (config.get('KNOWLEDGE_DOCUMENT_PARSER_DRIVER', { infer: true }) === 'local') {
          return localParser;
        }
        const baseUrl = config.get('KNOWLEDGE_DOCLING_BASE_URL', { infer: true });
        if (baseUrl === undefined) {
          throw new Error('KNOWLEDGE_DOCLING_BASE_URL is required when Docling is enabled.');
        }
        const doclingParser = new DoclingDocumentParserAdapter({
          baseUrl,
          apiKey: config.get('KNOWLEDGE_DOCLING_API_KEY', { infer: true }),
          timeoutMs: config.get('KNOWLEDGE_DOCLING_TIMEOUT_MS', { infer: true }),
          maximumResponseBytes: config.get('KNOWLEDGE_DOCLING_MAX_RESPONSE_BYTES', {
            infer: true,
          }),
        });
        return {
          parse: (input) =>
            input.mimeType === 'text/plain' ||
            input.mimeType === 'text/markdown' ||
            input.mimeType === 'text/html' ||
            input.mimeType === 'application/xhtml+xml'
              ? localParser.parse(input)
              : doclingParser.parse(input),
        };
      },
    },
    KnowledgeIngestionAvailabilityService,
    KnowledgeIngestionProcessor,
    KnowledgeIngestionService,
    KnowledgeIngestionWorker,
    PrismaKnowledgeIngestionJobRepository,
    {
      provide: KnowledgeIngestionJobRepository,
      useExisting: PrismaKnowledgeIngestionJobRepository,
    },
  ],
  exports: [
    KnowledgeIngestionProcessor,
    KnowledgeIngestionService,
    KnowledgeIngestionWorker,
    KnowledgeIngestionAvailabilityService,
    ControlledKnowledgeWebFetcher,
  ],
})
export class KnowledgeIngestionModule {}
