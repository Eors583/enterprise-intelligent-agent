import { describe, expect, it } from 'vitest';

import { auditGovernanceViewTestSupport } from './AuditGovernancePage';
import { eventSummary, shortAuditHash } from './audit-view';

describe('audit governance view', () => {
  it('only sends non-empty filters and normalizes local dates', () => {
    const query = auditGovernanceViewTestSupport.toQuery({
      action: '  admin.audit.exported ',
      resourceType: '',
      occurredFrom: '2026-07-28T10:00',
      occurredTo: '2026-07-28T11:00',
    });
    expect(query.action).toBe('admin.audit.exported');
    expect(query.resourceType).toBeUndefined();
    expect(query.limit).toBe(50);
    expect(query.occurredFrom).toMatch(/^2026-07-28T/);
  });

  it('keeps audit hashes readable without hiding the full value from the title', () => {
    const hash = 'a'.repeat(64);
    expect(shortAuditHash(hash)).toBe('aaaaaaaaaa…aaaaaaaa');
    expect(shortAuditHash(null)).toBe('创世记录');
  });

  it('summarizes action and resource type without using untrusted metadata', () => {
    expect(
      eventSummary({
        id: '00000000-0000-7000-8000-000000000001',
        tenantId: '00000000-0000-7000-8000-000000000002',
        actorType: 'SERVICE',
        actorId: '00000000-0000-7000-8000-000000000003',
        action: 'agent.run.completed',
        resourceType: 'agent_run',
        resourceId: '00000000-0000-7000-8000-000000000004',
        metadata: { unsafe: '<script>' },
        occurredAt: '2026-07-28T10:00:00.000Z',
        chainSequence: '2',
        previousHash: 'a'.repeat(64),
        eventHash: 'b'.repeat(64),
      }),
    ).toBe('agent.run.completed · agent_run');
  });
});
