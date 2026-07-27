import { Module } from '@nestjs/common';

import { KnowledgeAiRuntimeClient } from './knowledge-ai-runtime.client.js';

@Module({
  providers: [KnowledgeAiRuntimeClient],
  exports: [KnowledgeAiRuntimeClient],
})
export class KnowledgeSemanticModule {}
