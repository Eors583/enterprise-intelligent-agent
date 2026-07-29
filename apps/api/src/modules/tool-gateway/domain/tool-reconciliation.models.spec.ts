import { describe, expect, it } from 'vitest';

import { parseToolReconciliationEvent } from './tool-reconciliation.models.js';

describe('Tool reconciliation Outbox contract', () => {
  it('binds the payload invocation to the aggregate and expected revision', () => {
    const invocationId = '00000000-0000-7000-8000-000000000101';
    expect(
      parseToolReconciliationEvent({
        aggregateId: invocationId,
        payload: {
          invocationId,
          expectedRevision: 4,
          idempotencyKey: 'reconcile-4',
        },
      }),
    ).toEqual({ invocationId, expectedRevision: 4, idempotencyKey: 'reconcile-4' });
  });

  it('rejects cross-aggregate and malformed reconciliation requests', () => {
    expect(() =>
      parseToolReconciliationEvent({
        aggregateId: '00000000-0000-7000-8000-000000000102',
        payload: {
          invocationId: '00000000-0000-7000-8000-000000000101',
          expectedRevision: 4,
          idempotencyKey: 'reconcile-4',
        },
      }),
    ).toThrow('TOOL_RECONCILIATION_EVENT_MALFORMED');
  });
});
