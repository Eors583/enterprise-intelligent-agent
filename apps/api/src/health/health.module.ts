import { Module } from '@nestjs/common';

import { KnowledgeIngestionModule } from '../modules/knowledge-ingestion/knowledge-ingestion.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [KnowledgeIngestionModule],
  controllers: [HealthController],
})
export class HealthModule {}
