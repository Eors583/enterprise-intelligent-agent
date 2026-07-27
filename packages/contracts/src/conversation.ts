import { z } from 'zod';

export const conversationTypeSchema = z.literal('direct');

export const conversationTargetSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('human'),
        userId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        type: z.literal('agent'),
        agentId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        type: z.literal('agent_pair'),
        agentIds: z.tuple([z.string().uuid(), z.string().uuid()]),
        turnLimit: z.number().int().min(2).max(8).default(4),
      })
      .strict(),
  ])
  .superRefine((target, context) => {
    if (target.type === 'agent_pair' && target.agentIds[0] === target.agentIds[1]) {
      context.addIssue({
        code: 'custom',
        path: ['agentIds', 1],
        message: 'agentIds must contain two different agents.',
      });
    }
  });

export const conversationParticipantSchema = z.object({
  type: z.enum(['user', 'agent']),
  id: z.string().uuid(),
  name: z.string().min(1),
});

export const conversationSchema = z.object({
  id: z.string().uuid(),
  type: conversationTypeSchema,
  title: z.string().min(1).nullable(),
  participants: z.array(conversationParticipantSchema).min(2),
  lastMessageAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createConversationRequestSchema = z
  .object({
    type: conversationTypeSchema,
    target: conversationTargetSchema,
  })
  .strict();

export const conversationListResponseSchema = z.object({
  items: z.array(conversationSchema),
});

export const messageSenderSchema = z.object({
  type: z.enum(['user', 'agent']),
  id: z.string().uuid(),
  name: z.string().min(1),
});

const knowledgeCitationCoreShape = {
  documentId: z.string().uuid(),
  knowledgeBaseId: z.string().uuid(),
  title: z.string().min(1),
  excerpt: z.string().min(1).max(500),
} as const;

const verifiedKnowledgeCitationInputSchema = z
  .object({
    ...knowledgeCitationCoreShape,
    documentVersionId: z.string().uuid(),
    chunkId: z.string().uuid(),
    knowledgeBaseName: z.string().min(1),
    documentVersion: z.number().int().positive(),
    headingPath: z.array(z.string()),
    sourceType: z.enum(['TEXT', 'MARKDOWN', 'FILE']),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const legacyKnowledgeCitationInputSchema = z.object(knowledgeCitationCoreShape).strict();

const normalizedKnowledgeCitationSchema = z.discriminatedUnion('verificationStatus', [
  verifiedKnowledgeCitationInputSchema.extend({
    verificationStatus: z.literal('VERIFIED'),
  }),
  z
    .object({
      ...knowledgeCitationCoreShape,
      documentVersionId: z.null(),
      chunkId: z.null(),
      knowledgeBaseName: z.null(),
      documentVersion: z.null(),
      headingPath: z.tuple([]),
      sourceType: z.null(),
      updatedAt: z.null(),
      verificationStatus: z.literal('LEGACY'),
    })
    .strict(),
]);

export const knowledgeCitationSchema = z.preprocess((value) => {
  const verified = verifiedKnowledgeCitationInputSchema.safeParse(value);
  if (verified.success) {
    return { ...verified.data, verificationStatus: 'VERIFIED' };
  }
  const legacy = legacyKnowledgeCitationInputSchema.safeParse(value);
  if (legacy.success) {
    return {
      ...legacy.data,
      documentVersionId: null,
      chunkId: null,
      knowledgeBaseName: null,
      documentVersion: null,
      headingPath: [],
      sourceType: null,
      updatedAt: null,
      verificationStatus: 'LEGACY',
    };
  }
  // Already-normalized API payloads and invalid values are both handled by the strict
  // output schema below. This keeps the wire contract idempotent without accepting a
  // partially populated lineage as a legacy citation.
  return value;
}, normalizedKnowledgeCitationSchema);

export const knowledgeCitationDetailSchema = z
  .object({
    knowledgeBaseId: z.string().uuid(),
    knowledgeBaseName: z.string().min(1),
    documentId: z.string().uuid(),
    documentTitle: z.string().min(1),
    documentVersionId: z.string().uuid(),
    documentVersion: z.number().int().positive(),
    chunkId: z.string().uuid(),
    headingPath: z.array(z.string()),
    sourceType: z.enum(['TEXT', 'MARKDOWN', 'FILE']),
    content: z.string().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const answerFeedbackRatingSchema = z.enum(['HELPFUL', 'NOT_HELPFUL']);
export const answerFeedbackReasonSchema = z.enum([
  'INCORRECT',
  'IRRELEVANT_CITATION',
  'OUTDATED',
  'MISSING_KNOWLEDGE',
  'OTHER',
]);

export const upsertAnswerFeedbackRequestSchema = z
  .object({
    rating: answerFeedbackRatingSchema,
    reason: answerFeedbackReasonSchema.nullable().optional(),
    comment: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .superRefine((feedback, context) => {
    if (feedback.rating === 'NOT_HELPFUL' && feedback.reason == null) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is required when rating is NOT_HELPFUL.',
      });
    }
    if (feedback.rating === 'HELPFUL' && feedback.reason != null) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is only available when rating is NOT_HELPFUL.',
      });
    }
  })
  .transform((feedback) => ({
    rating: feedback.rating,
    reason: feedback.reason ?? null,
    comment: feedback.comment?.trim() || null,
  }));

export const answerFeedbackSchema = z
  .object({
    id: z.string().uuid(),
    messageId: z.string().uuid(),
    rating: answerFeedbackRatingSchema,
    reason: answerFeedbackReasonSchema.nullable(),
    comment: z.string().max(500).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const currentAnswerFeedbackResponseSchema = z
  .object({ feedback: answerFeedbackSchema.nullable() })
  .strict();

export const textMessageContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(20_000),
    citations: z.array(knowledgeCitationSchema).max(12).optional(),
  })
  .strict();

export const createTextMessageContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  sender: messageSenderSchema,
  clientMessageId: z.string().min(8).max(200),
  content: textMessageContentSchema,
  createdAt: z.iso.datetime(),
});

export const createMessageRequestSchema = z
  .object({
    clientMessageId: z.string().min(8).max(200),
    content: createTextMessageContentSchema,
  })
  .strict();

export const conversationAgentRunSchema = z.object({
  id: z.string().uuid(),
  inputMessageId: z.string().uuid(),
  outputMessageId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  agentName: z.string().min(1),
  status: z.enum([
    'QUEUED',
    'DISPATCHING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'UNKNOWN',
    'CANCELLED',
  ]),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export const messageListResponseSchema = z.object({
  items: z.array(messageSchema),
  runs: z.array(conversationAgentRunSchema).default([]),
});

export type ConversationType = z.infer<typeof conversationTypeSchema>;
export type ConversationTarget = z.infer<typeof conversationTargetSchema>;
export type ConversationParticipant = z.infer<typeof conversationParticipantSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type MessageSender = z.infer<typeof messageSenderSchema>;
export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;
export type KnowledgeCitationDetail = z.infer<typeof knowledgeCitationDetailSchema>;
export type AnswerFeedbackRating = z.infer<typeof answerFeedbackRatingSchema>;
export type AnswerFeedbackReason = z.infer<typeof answerFeedbackReasonSchema>;
export type UpsertAnswerFeedbackRequest = z.infer<typeof upsertAnswerFeedbackRequestSchema>;
export type AnswerFeedback = z.infer<typeof answerFeedbackSchema>;
export type CurrentAnswerFeedbackResponse = z.infer<typeof currentAnswerFeedbackResponseSchema>;
export type TextMessageContent = z.infer<typeof textMessageContentSchema>;
export type CreateTextMessageContent = z.infer<typeof createTextMessageContentSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ConversationAgentRun = z.infer<typeof conversationAgentRunSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
