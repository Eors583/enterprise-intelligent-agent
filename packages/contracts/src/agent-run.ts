import { z } from 'zod';

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

export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
