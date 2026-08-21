import { z } from 'zod';

export const imRealtimeUnavailableSchema = z
  .object({
    available: z.literal(false),
    provider: z.enum(['local', 'tencent']),
    reason: z.enum(['REALTIME_NOT_CONFIGURED', 'PROVIDER_HAS_NO_SELF_HOSTED_REALTIME_BRIDGE']),
  })
  .strict();

export const imRealtimeSessionSchema = z.discriminatedUnion('available', [
  imRealtimeUnavailableSchema,
  z
    .object({
      available: z.literal(true),
      provider: z.literal('wukong'),
      websocketUrl: z
        .string()
        .url()
        .refine((value) => {
          const protocol = new URL(value).protocol;
          return protocol === 'ws:' || protocol === 'wss:';
        }),
      uid: z
        .string()
        .min(3)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/),
      token: z.string().min(16).max(512),
      deviceFlag: z.literal(2),
    })
    .strict(),
]);

export type ImRealtimeSession = z.infer<typeof imRealtimeSessionSchema>;
