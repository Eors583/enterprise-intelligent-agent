import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000501';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000401';
const FEEDBACK_ID = '00000000-0000-7000-8000-000000000601';

describe('AnswerFeedbackService', () => {
  it('upserts one current-user feedback record and writes a metadata-only audit event', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.upsert(MESSAGE_ID, {
        rating: 'NOT_HELPFUL',
        reason: 'MISSING_KNOWLEDGE',
        comment: '缺少今年的新制度。',
      }),
    ).resolves.toEqual({
      id: FEEDBACK_ID,
      messageId: MESSAGE_ID,
      rating: 'NOT_HELPFUL',
      reason: 'MISSING_KNOWLEDGE',
      comment: '缺少今年的新制度。',
      createdAt: '2026-07-20T03:00:00.000Z',
      updatedAt: '2026-07-20T03:01:00.000Z',
    });

    expect(fixture.transaction.message.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        id: MESSAGE_ID,
        senderType: 'AGENT',
        senderAgentId: { not: null },
        conversation: {
          participants: {
            some: {
              tenantId: TENANT_ID,
              type: 'USER',
              userId: USER_ID,
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
            tenantId: TENANT_ID,
            outputMessageId: MESSAGE_ID,
            requesterUserId: USER_ID,
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
    expect(fixture.transaction.answerFeedback.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_messageId_userId: {
            tenantId: TENANT_ID,
            messageId: MESSAGE_ID,
            userId: USER_ID,
          },
        },
      }),
    );
    expect(fixture.transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        actorId: USER_ID,
        action: 'agent.answer_feedback.upsert',
        resourceId: FEEDBACK_ID,
        metadata: {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          rating: 'NOT_HELPFUL',
          reason: 'MISSING_KNOWLEDGE',
        },
      }),
    });
    expect(JSON.stringify(fixture.transaction.auditEvent.create.mock.calls)).not.toContain(
      '缺少今年的新制度',
    );
  });

  it('returns the current feedback for an eligible answer', async () => {
    const fixture = createFixture();

    await expect(fixture.service.getCurrent(MESSAGE_ID)).resolves.toMatchObject({
      feedback: { id: FEEDBACK_ID, rating: 'NOT_HELPFUL' },
    });
  });

  it.each([
    'a human-authored message',
    'an Agent answer without a succeeded output Run',
    'a conversation the current user has left',
    'a message in another tenant',
  ])('returns not found for %s without exposing its existence', async () => {
    const fixture = createFixture({ eligibleMessage: null });

    await expect(fixture.service.getCurrent(MESSAGE_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.transaction.answerFeedback.findUnique).not.toHaveBeenCalled();
  });
});

function createFixture(
  options: {
    eligibleMessage?: {
      id: string;
      conversationId: string;
      outputAgentRuns: Array<{
        tenantId: string;
        conversationId: string;
        outputMessageId: string;
        requesterUserId: string;
        status: 'SUCCEEDED';
      }>;
    } | null;
  } = {},
) {
  const row = {
    id: FEEDBACK_ID,
    tenantId: TENANT_ID,
    messageId: MESSAGE_ID,
    userId: USER_ID,
    rating: 'NOT_HELPFUL' as const,
    reason: 'MISSING_KNOWLEDGE' as const,
    comment: '缺少今年的新制度。',
    createdAt: new Date('2026-07-20T03:00:00.000Z'),
    updatedAt: new Date('2026-07-20T03:01:00.000Z'),
  };
  const transaction = {
    message: {
      findFirst: vi.fn().mockResolvedValue(
        options.eligibleMessage === undefined
          ? {
              id: MESSAGE_ID,
              conversationId: CONVERSATION_ID,
              outputAgentRuns: [
                {
                  tenantId: TENANT_ID,
                  conversationId: CONVERSATION_ID,
                  outputMessageId: MESSAGE_ID,
                  requesterUserId: USER_ID,
                  status: 'SUCCEEDED',
                },
              ],
            }
          : options.eligibleMessage,
      ),
    },
    answerFeedback: {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn().mockResolvedValue(row),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: vi.fn(
      async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  } as unknown as PrismaService;
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      tenant: { id: TENANT_ID, name: '企业', status: 'active' },
      user: { id: USER_ID, tenantId: TENANT_ID, name: '员工', status: 'active' },
    }),
  } as unknown as IdentityService;
  return { service: new AnswerFeedbackService(identity, prisma), transaction };
}
