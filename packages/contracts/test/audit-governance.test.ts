import { describe, expect, it } from 'vitest';

import {
  auditActorTypeSchema,
  auditEventListQuerySchema,
  auditEventRecordSchema,
} from '../src/audit-governance';

const event = {
  id: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  actorId: '00000000-0000-7000-8000-000000000003',
  action: 'agent.run.completed',
  resourceType: 'agent_run',
  resourceId: '00000000-0000-7000-8000-000000000004',
  metadata: {},
  occurredAt: '2026-07-29T10:00:00.000Z',
  chainSequence: '1',
  previousHash: null,
  eventHash: 'a'.repeat(64),
};

describe('audit governance contracts', () => {
  it('uses SERVICE as the canonical persisted audit actor', () => {
    expect(auditActorTypeSchema.options).toEqual(['USER', 'AGENT', 'SERVICE']);
    expect(auditEventRecordSchema.parse({ ...event, actorType: 'SERVICE' }).actorType).toBe(
      'SERVICE',
    );
    expect(auditEventRecordSchema.safeParse({ ...event, actorType: 'SYSTEM' }).success).toBe(false);
  });

  it('normalizes the legacy SYSTEM query alias to SERVICE', () => {
    expect(auditEventListQuerySchema.parse({ actorType: 'SYSTEM' })).toMatchObject({
      actorType: 'SERVICE',
      limit: 50,
    });
    expect(auditEventListQuerySchema.parse({ actorType: 'SERVICE' }).actorType).toBe('SERVICE');
  });
});
