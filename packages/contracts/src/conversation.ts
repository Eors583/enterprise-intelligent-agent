import { z } from 'zod';

export const conversationTypeSchema = z.enum(['direct', 'group']);

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
  role: z.enum(['owner', 'admin', 'member']).optional(),
});

export const conversationSchema = z.object({
  id: z.string().uuid(),
  type: conversationTypeSchema,
  title: z.string().min(1).nullable(),
  participants: z.array(conversationParticipantSchema).min(2),
  lastMessageAt: z.iso.datetime().nullable(),
  unreadCount: z.number().int().nonnegative().optional(),
  pinnedAt: z.iso.datetime().nullable().optional(),
  archivedAt: z.iso.datetime().nullable().optional(),
  mutedUntil: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createConversationRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('direct'), target: conversationTargetSchema }).strict(),
  z
    .object({
      type: z.literal('group'),
      title: z.string().trim().min(1).max(200),
      memberUserIds: z.array(z.string().uuid()).max(199).default([]),
      agentIds: z.array(z.string().uuid()).max(2).default([]),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.memberUserIds.length + request.agentIds.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['memberUserIds'],
          message: 'A group requires at least one employee or Agent participant.',
        });
      }
      for (const [field, values] of [
        ['memberUserIds', request.memberUserIds],
        ['agentIds', request.agentIds],
      ] as const) {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} must not contain duplicates.`,
          });
        }
      }
    }),
]);

export const conversationListQuerySchema = z
  .object({
    query: z.string().trim().max(100).optional(),
    includeArchived: z.coerce.boolean().default(false),
  })
  .strict();

export const updateConversationStateRequestSchema = z
  .object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    mutedUntil: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, 'At least one state field is required.');

export const markConversationReadRequestSchema = z
  .object({ lastMessageId: z.string().uuid().optional() })
  .strict();

export const updateGroupRequestSchema = z
  .object({ title: z.string().trim().min(1).max(200) })
  .strict();

export const updateGroupMembersRequestSchema = z
  .object({
    addUserIds: z.array(z.string().uuid()).max(100).default([]),
    removeUserIds: z.array(z.string().uuid()).max(100).default([]),
    addAgentIds: z.array(z.string().uuid()).max(20).default([]),
    removeAgentIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict()
  .superRefine((request, context) => {
    const groups = [
      ['addUserIds', request.addUserIds],
      ['removeUserIds', request.removeUserIds],
      ['addAgentIds', request.addAgentIds],
      ['removeAgentIds', request.removeAgentIds],
    ] as const;
    if (groups.every(([, values]) => values.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one member change is required.',
      });
    }
    for (const [field, values] of groups) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} has duplicates.` });
      }
    }
    for (const [addField, removeField] of [
      ['addUserIds', 'removeUserIds'],
      ['addAgentIds', 'removeAgentIds'],
    ] as const) {
      const removed = new Set(request[removeField]);
      if (request[addField].some((id) => removed.has(id))) {
        context.addIssue({
          code: 'custom',
          path: [addField],
          message: 'The same member cannot be added and removed in one request.',
        });
      }
    }
  });

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
    sourceType: z.enum(['TEXT', 'MARKDOWN', 'FILE', 'WEB']),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const legacyKnowledgeCitationInputSchema = z.object(knowledgeCitationCoreShape).strict();

const normalizedKnowledgeCitationSchema = z.discriminatedUnion('verificationStatus', [
  verifiedKnowledgeCitationInputSchema.extend({
    // This proves server-side Run/chunk/version lineage. It deliberately does
    // not claim that an entailment model has proven every generated statement.
    verificationStatus: z.literal('LINEAGE_VERIFIED'),
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
    return { ...verified.data, verificationStatus: 'LINEAGE_VERIFIED' };
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

export const collaborationCitationSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceType: z.enum(['PERSONAL_MANUAL', 'WORK_AVAILABILITY', 'TASK_FACT']),
    sourceVersion: z.number().int().positive(),
    title: z.string().min(1).max(300),
    excerpt: z.string().min(1).max(500),
    updatedAt: z.iso.datetime(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    verificationStatus: z
      .literal('COLLABORATION_POLICY_VERIFIED')
      .default('COLLABORATION_POLICY_VERIFIED'),
  })
  .strict();

export const messageCitationSchema = z.union([
  knowledgeCitationSchema,
  collaborationCitationSchema,
]);

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
    sourceType: z.enum(['TEXT', 'MARKDOWN', 'FILE', 'WEB']),
    sourceFileName: z.string().min(1).max(300).nullable(),
    sourceMimeType: z.string().min(1).max(160).nullable(),
    sourceUri: z.url().max(2_048).nullable(),
    sourceDownloadAvailable: z.boolean(),
    sourceLocator: z
      .object({
        kind: z.enum(['PAGE', 'SHEET', 'SECTION', 'DOCUMENT']),
        pageStart: z.number().int().positive().nullable(),
        pageEnd: z.number().int().positive().nullable(),
        sheetName: z.string().min(1).max(200).nullable(),
        headingPath: z.array(z.string()),
      })
      .strict(),
    structuralContext: z
      .object({
        parent: z
          .object({
            id: z.string().uuid(),
            headingPath: z.array(z.string()),
            excerpt: z.string(),
          })
          .strict(),
        previous: z.object({ id: z.string().uuid(), excerpt: z.string() }).strict().nullable(),
        next: z.object({ id: z.string().uuid(), excerpt: z.string() }).strict().nullable(),
      })
      .strict(),
    content: z.string().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const knowledgeCitationOriginalQuerySchema = z
  .object({
    messageId: z.string().uuid(),
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
    citations: z.array(messageCitationSchema).max(12).optional(),
  })
  .strict();

export const createTextMessageContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();

/**
 * Selects who should actively respond inside a shared member conversation.
 * Every active human participant can still read the message; this only
 * controls whether an Agent Run is created for the message.
 */
export const messageResponseTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), userId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('agent'), agentId: z.string().uuid() }).strict(),
]);

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  sender: messageSenderSchema,
  clientMessageId: z.string().min(8).max(200),
  content: textMessageContentSchema,
  // Older persisted messages predate explicit response routing.
  responseTarget: messageResponseTargetSchema.nullable().optional(),
  createdAt: z.iso.datetime(),
});

export const createMessageRequestSchema = z
  .object({
    clientMessageId: z.string().min(8).max(200),
    content: createTextMessageContentSchema,
    // Optional keeps older clients and legacy two-party conversations valid.
    responseTarget: messageResponseTargetSchema.optional(),
  })
  .strict();

export const conversationAgentRunSchema = z.object({
  id: z.string().uuid(),
  inputMessageId: z.string().uuid(),
  outputMessageId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  agentName: z.string().min(1),
  streamMode: z.enum(['live', 'terminal_only']).nullable(),
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
  supersededByRunId: z.string().uuid().nullable().optional(),
  retryable: z.boolean(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export const messageListResponseSchema = z.object({
  items: z.array(messageSchema),
  runs: z.array(conversationAgentRunSchema).default([]),
  nextCursor: z.string().uuid().nullable().optional(),
  hasMore: z.boolean().optional(),
});

export const messageListQuerySchema = z
  .object({
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const messageSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export const messageSearchResponseSchema = z.object({ items: z.array(messageSchema) });

export type ConversationType = z.infer<typeof conversationTypeSchema>;
export type ConversationTarget = z.infer<typeof conversationTargetSchema>;
export type ConversationParticipant = z.infer<typeof conversationParticipantSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type UpdateConversationStateRequest = z.infer<typeof updateConversationStateRequestSchema>;
export type MarkConversationReadRequest = z.infer<typeof markConversationReadRequestSchema>;
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;
export type UpdateGroupMembersRequest = z.infer<typeof updateGroupMembersRequestSchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type MessageSender = z.infer<typeof messageSenderSchema>;
export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;
export type CollaborationCitation = z.infer<typeof collaborationCitationSchema>;
export type MessageCitation = z.infer<typeof messageCitationSchema>;
export type KnowledgeCitationDetail = z.infer<typeof knowledgeCitationDetailSchema>;
export type KnowledgeCitationOriginalQuery = z.infer<typeof knowledgeCitationOriginalQuerySchema>;
export type AnswerFeedbackRating = z.infer<typeof answerFeedbackRatingSchema>;
export type AnswerFeedbackReason = z.infer<typeof answerFeedbackReasonSchema>;
export type UpsertAnswerFeedbackRequest = z.infer<typeof upsertAnswerFeedbackRequestSchema>;
export type AnswerFeedback = z.infer<typeof answerFeedbackSchema>;
export type CurrentAnswerFeedbackResponse = z.infer<typeof currentAnswerFeedbackResponseSchema>;
export type TextMessageContent = z.infer<typeof textMessageContentSchema>;
export type CreateTextMessageContent = z.infer<typeof createTextMessageContentSchema>;
export type MessageResponseTarget = z.infer<typeof messageResponseTargetSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ConversationAgentRun = z.infer<typeof conversationAgentRunSchema>;
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;
export type MessageSearchResponse = z.infer<typeof messageSearchResponseSchema>;
