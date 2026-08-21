import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AgentControlModule } from '../agent-control/agent-control.module.js';
import { AgentRunModule } from '../agent-run/agent-run.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AnswerFeedbackController } from './answer-feedback.controller.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';
import { AnswerFeedbackEvaluationRepository } from './domain/answer-feedback-evaluation.repository.js';
import { ConversationController } from './conversation.controller.js';
import { ConversationService } from './conversation.service.js';
import { ConversationRepository } from './domain/conversation.repository.js';
import { DevConversationRepository } from './infrastructure/dev/dev-conversation.repository.js';
import { PrismaConversationRepository } from './infrastructure/prisma/prisma-conversation.repository.js';
import { PrismaAnswerFeedbackEvaluationRepository } from './infrastructure/prisma/prisma-answer-feedback-evaluation.repository.js';

@Module({
  imports: [IdentityModule, AgentControlModule, AgentRunModule, AuthorizationModule],
  controllers: [AnswerFeedbackController, ConversationController],
  providers: [
    AnswerFeedbackService,
    PrismaAnswerFeedbackEvaluationRepository,
    ConversationService,
    DevConversationRepository,
    PrismaConversationRepository,
    {
      provide: AnswerFeedbackEvaluationRepository,
      useExisting: PrismaAnswerFeedbackEvaluationRepository,
    },
    {
      provide: ConversationRepository,
      inject: [ConfigService, DevConversationRepository, PrismaConversationRepository],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        memory: DevConversationRepository,
        prisma: PrismaConversationRepository,
      ): ConversationRepository =>
        config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma' ? prisma : memory,
    },
  ],
  exports: [ConversationService, ConversationRepository],
})
export class ConversationModule {}
