import { Module } from '@nestjs/common';

import { AiEvaluationController } from './ai-evaluation.controller.js';
import { AiEvaluationRepository } from './ai-evaluation.repository.js';
import { AiEvaluationRunnerClient } from './ai-evaluation-runner.client.js';
import { AiEvaluationService } from './ai-evaluation.service.js';
import { HttpAiEvaluationRunnerClient } from './infrastructure/http-ai-evaluation-runner.client.js';
import { PrismaAiEvaluationRepository } from './infrastructure/prisma-ai-evaluation.repository.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [AiEvaluationController],
  providers: [
    AiEvaluationService,
    PrismaAiEvaluationRepository,
    HttpAiEvaluationRunnerClient,
    {
      provide: AiEvaluationRepository,
      useExisting: PrismaAiEvaluationRepository,
    },
    {
      provide: AiEvaluationRunnerClient,
      useExisting: HttpAiEvaluationRunnerClient,
    },
  ],
  exports: [AiEvaluationService],
})
export class AiEvaluationModule {}
