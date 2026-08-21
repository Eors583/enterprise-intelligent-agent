import { describe, expect, it } from 'vitest';

import {
  availableMemoryActions,
  memoryIdentity,
  memoryExpiryIso,
  memoryScopeLabel,
  splitMemoryLabels,
} from './memory-view';

describe('five-layer memory view policy', () => {
  it('renders all five isolated scopes', () => {
    expect(
      ['ENTERPRISE', 'ROLE', 'EMPLOYEE_PRIVATE', 'TASK', 'CONVERSATION'].map((scope) =>
        memoryScopeLabel(scope as never),
      ),
    ).toEqual(['企业记忆', '角色记忆', '员工私有', '任务记忆', '会话记忆']);
  });

  it('does not expose transitions after deletion', () => {
    expect(availableMemoryActions('DELETED')).toEqual([]);
    expect(availableMemoryActions('CANDIDATE')).toEqual(['ACTIVATE', 'DELETE']);
  });

  it('shows the exact assignment identity for employee-private memory', () => {
    expect(
      memoryIdentity({
        scope: 'EMPLOYEE_PRIVATE',
        roleAssignmentId: '00000000-0000-7000-8000-000000000123',
      } as never),
    ).toContain('任命');
  });

  it('deduplicates permission labels', () => {
    expect(splitMemoryLabels('private, delivery；private')).toEqual(['private', 'delivery']);
  });

  it('converts datetime-local input to the ISO contract and rejects an empty TTL', () => {
    const local = '2026-07-29T12:30';
    const iso = memoryExpiryIso(local);
    expect(iso.endsWith('Z')).toBe(true);
    expect(new Date(iso).getTime()).toBe(new Date(local).getTime());
    expect(() => memoryExpiryIso('')).toThrow('到期时间');
  });
});
