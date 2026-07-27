import { z } from 'zod';

export const apiErrorResponseSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  request_id: z.string().min(1),
  details: z.unknown().optional(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
