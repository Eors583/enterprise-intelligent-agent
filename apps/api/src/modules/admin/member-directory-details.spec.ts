import { describe, expect, it, vi } from 'vitest';

import { createMemberDirectoryDetails } from './member-directory-details.js';

describe('createMemberDirectoryDetails', () => {
  it('persists direct and dotted-line managers without writing a personal manual', async () => {
    const transaction = {
      employment: {
        findMany: vi.fn().mockResolvedValue([
          { id: '00000000-0000-7000-8000-000000000101', userId: 'manager-direct' },
          { id: '00000000-0000-7000-8000-000000000102', userId: 'manager-dotted' },
        ]),
      },
      managerRelation: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };

    await createMemberDirectoryDetails(transaction as never, {
      tenantId: '00000000-0000-7000-8000-000000000001',
      organizationId: '00000000-0000-7000-8000-000000000002',
      employmentId: '00000000-0000-7000-8000-000000000004',
      directManagerUserId: 'manager-direct',
      dottedLineManagerUserId: 'manager-dotted',
    });

    expect(transaction.managerRelation.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          managerEmploymentId: '00000000-0000-7000-8000-000000000101',
          relationType: 'DIRECT',
        }),
        expect.objectContaining({
          managerEmploymentId: '00000000-0000-7000-8000-000000000102',
          relationType: 'DOTTED_LINE',
        }),
      ],
    });
    expect(transaction).not.toHaveProperty('memberProfile');
  });

  it('fails closed when the selected manager has no active employment', async () => {
    const transaction = {
      employment: { findMany: vi.fn().mockResolvedValue([]) },
      managerRelation: { createMany: vi.fn() },
    };

    await expect(
      createMemberDirectoryDetails(transaction as never, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        organizationId: '00000000-0000-7000-8000-000000000002',
        employmentId: '00000000-0000-7000-8000-000000000004',
        directManagerUserId: 'missing-manager',
      }),
    ).rejects.toThrow('selected manager has no active employment');
    expect(transaction.managerRelation.createMany).not.toHaveBeenCalled();
  });
});
