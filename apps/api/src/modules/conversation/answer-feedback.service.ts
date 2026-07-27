import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AnswerFeedback,
  CurrentAnswerFeedbackResponse,
  UpsertAnswerFeedbackRequest,
} from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import { IdentityService } from '../identity/application/identity.service.js';

@Injectable()
export class AnswerFeedbackService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async getCurrent(messageId: string): Promise<CurrentAnswerFeedbackResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    return this.prisma.withTenant(user.tenantId, async (transaction) => {
      await this.requireEligibleMessage(transaction, user.tenantId, user.id, messageId);
      const feedback = await transaction.answerFeedback.findUnique({
        where: {
          tenantId_messageId_userId: {
            tenantId: user.tenantId,
            messageId,
            userId: user.id,
          },
        },
      });
      return { feedback: feedback === null ? null : mapFeedback(feedback) };
    });
  }

  async upsert(messageId: string, request: UpsertAnswerFeedbackRequest): Promise<AnswerFeedback> {
    const { user } = await this.identity.getCurrentIdentity();
    return this.prisma.withTenant(user.tenantId, async (transaction) => {
      const message = await this.requireEligibleMessage(
        transaction,
        user.tenantId,
        user.id,
        messageId,
      );
      const feedback = await transaction.answerFeedback.upsert({
        where: {
          tenantId_messageId_userId: {
            tenantId: user.tenantId,
            messageId,
            userId: user.id,
          },
        },
        create: {
          tenantId: user.tenantId,
          messageId,
          userId: user.id,
          rating: request.rating,
          reason: request.reason,
          comment: request.comment,
        },
        update: {
          rating: request.rating,
          reason: request.reason,
          comment: request.comment,
        },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorType: 'USER',
          actorId: user.id,
          action: 'agent.answer_feedback.upsert',
          resourceType: 'answer_feedback',
          resourceId: feedback.id,
          metadata: {
            conversationId: message.conversationId,
            messageId,
            rating: request.rating,
            reason: request.reason,
          },
        },
      });
      return mapFeedback(feedback);
    });
  }

  private async requireEligibleMessage(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    messageId: string,
  ): Promise<{ readonly id: string; readonly conversationId: string }> {
    const message = await transaction.message.findFirst({
      where: {
        tenantId,
        id: messageId,
        senderType: 'AGENT',
        senderAgentId: { not: null },
        conversation: {
          participants: {
            some: {
              tenantId,
              type: 'USER',
              userId,
              leftAt: null,
              user: { status: 'ACTIVE' },
            },
          },
        },
      },
      select: {
        id: true,
        conversationId: true,
        outputAgentRuns: {
          where: {
            tenantId,
            outputMessageId: messageId,
            requesterUserId: userId,
            status: 'SUCCEEDED',
          },
          select: {
            tenantId: true,
            conversationId: true,
            outputMessageId: true,
            requesterUserId: true,
            status: true,
          },
        },
      },
    });
    const run = message?.outputAgentRuns[0];
    if (
      message === null ||
      run === undefined ||
      run.tenantId !== tenantId ||
      run.conversationId !== message.conversationId ||
      run.outputMessageId !== message.id ||
      run.requesterUserId !== userId ||
      run.status !== 'SUCCEEDED'
    ) {
      throw new NotFoundException('The Agent answer was not found or cannot be rated.');
    }
    return { id: message.id, conversationId: message.conversationId };
  }
}

function mapFeedback(feedback: {
  readonly id: string;
  readonly messageId: string;
  readonly rating: 'HELPFUL' | 'NOT_HELPFUL';
  readonly reason:
    'INCORRECT' | 'IRRELEVANT_CITATION' | 'OUTDATED' | 'MISSING_KNOWLEDGE' | 'OTHER' | null;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AnswerFeedback {
  return {
    id: feedback.id,
    messageId: feedback.messageId,
    rating: feedback.rating,
    reason: feedback.reason,
    comment: feedback.comment,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
  };
}
