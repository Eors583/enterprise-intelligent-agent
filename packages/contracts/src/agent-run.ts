import { z } from 'zod';

export const AGENT_RUN_STREAM_MAX_DELTA_SEQUENCE = 9_999;
export const AGENT_RUN_STREAM_MAX_CURSOR = 10_001;

export const principalRefSchema = z.object({
  type: z.enum(['user', 'agent', 'service']),
  id: z.string().min(1),
});

export const agentRunBudgetSchema = z.object({
  maxInputTokens: z.number().int().positive().max(1_000_000),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  maxToolCalls: z.number().int().nonnegative().max(100),
  timeoutSeconds: z.number().int().positive().max(3_600),
});

export const createAgentRunRequestSchema = z.object({
  tenantId: z.string().min(1),
  principal: principalRefSchema,
  agentVersionId: z.string().min(1),
  input: z.object({
    text: z.string().min(1).max(100_000),
    conversationId: z.string().min(1).optional(),
  }),
  budget: agentRunBudgetSchema,
  idempotencyKey: z.string().min(8).max(200),
});

export const agentRunStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'cancelled',
  'budget_exceeded',
]);

export const agentRunResponseSchema = z.object({
  runId: z.string().min(1),
  status: agentRunStatusSchema,
});

export const agentRunStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      eventId: z.string().regex(/^[0-9a-f-]{36}:[1-9][0-9]{0,4}$/i),
      sequence: z.number().int().min(1).max(AGENT_RUN_STREAM_MAX_DELTA_SEQUENCE),
      type: z.literal('delta'),
      delta: z.string().min(1).max(16_384),
      deltaHash: z.string().regex(/^[a-f0-9]{64}$/),
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().regex(/^[0-9a-f-]{36}:[1-9][0-9]{0,4}$/i),
      sequence: z.number().int().min(1).max(AGENT_RUN_STREAM_MAX_CURSOR),
      type: z.enum(['terminal', 'terminal_only']),
      status: z.enum(['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED']),
      createdAt: z.iso.datetime(),
    })
    .strict(),
]);

export const agentRunStreamPageSchema = z
  .object({
    items: z.array(agentRunStreamEventSchema).max(256),
    nextCursor: z.number().int().min(0).max(AGENT_RUN_STREAM_MAX_CURSOR),
    terminal: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    let previous = 0;
    for (const [index, event] of page.items.entries()) {
      if (event.sequence <= previous || event.sequence > page.nextCursor) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'sequence'],
          message: 'Stream event sequences must be strictly increasing and covered by nextCursor.',
        });
      }
      previous = event.sequence;
    }
    const terminalEvents = page.items.filter((event) => event.type !== 'delta');
    const reconciledPair =
      terminalEvents.length === 2 &&
      terminalEvents[0]?.status === 'UNKNOWN' &&
      terminalEvents[1]?.status !== 'UNKNOWN';
    if (
      terminalEvents.length > 2 ||
      (terminalEvents.length === 2 && !reconciledPair) ||
      (terminalEvents.length === 1 && terminalEvents[0]?.status !== 'UNKNOWN' && !page.terminal) ||
      (reconciledPair && !page.terminal)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['terminal'],
        message:
          'Terminal events must be one durable terminal or an UNKNOWN-to-final reconciliation.',
      });
    }
  });

export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentRunStreamEvent = z.infer<typeof agentRunStreamEventSchema>;
export type AgentRunStreamPage = z.infer<typeof agentRunStreamPageSchema>;
