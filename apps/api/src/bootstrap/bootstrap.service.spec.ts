import { describe, expect, it, vi } from 'vitest';

import { BootstrapService } from './bootstrap.service.js';

describe('BootstrapService employee navigation', () => {
  it('publishes only the four canonical employee business destinations', async () => {
    const service = new BootstrapService(
      { current: { tenantId: 'tenant', userId: 'user' } } as never,
      {
        getCurrentIdentity: vi.fn().mockResolvedValue({
          tenant: { id: 'tenant', name: 'Enterprise' },
          user: { id: 'user', name: 'Member' },
        }),
      } as never,
      {
        getDirectory: vi.fn().mockResolvedValue({ departments: [], members: [] }),
      } as never,
      {
        listMemberAgents: vi.fn().mockResolvedValue([]),
        listDepartmentAgents: vi.fn().mockResolvedValue([]),
      } as never,
      {
        assertTenantAccess: vi.fn(),
      } as never,
      {
        inspectAgents: vi.fn().mockResolvedValue(new Map()),
      } as never,
    );

    const response = await service.getBootstrap();

    expect(response.navigation).toEqual([
      { id: 'workbench', label: '工作台' },
      { id: 'messages', label: '消息' },
      { id: 'contacts', label: '通讯录' },
      { id: 'profile', label: '我的' },
    ]);
  });

  it('keeps an online Agent contactable while reporting unverified model availability', async () => {
    const service = new BootstrapService(
      { current: { tenantId: 'tenant', userId: 'user' } } as never,
      {
        getCurrentIdentity: vi.fn().mockResolvedValue({
          tenant: { id: 'tenant', name: 'Enterprise' },
          user: { id: 'user', name: 'Member' },
        }),
      } as never,
      {
        getDirectory: vi.fn().mockResolvedValue({
          departments: [],
          members: [
            {
              id: 'owner',
              name: 'Owner',
              title: 'Engineer',
              departmentIds: [],
              status: 'active',
            },
          ],
        }),
      } as never,
      {
        listMemberAgents: vi.fn().mockResolvedValue([
          {
            id: 'agent',
            ownerUserId: 'owner',
            name: 'Owner Agent',
            status: 'online',
            versionStatus: 'published',
          },
        ]),
        listDepartmentAgents: vi.fn().mockResolvedValue([]),
      } as never,
      {
        assertTenantAccess: vi.fn(),
      } as never,
      {
        inspectAgents: vi.fn().mockResolvedValue(
          new Map([
            [
              'agent',
              {
                status: 'NOT_READY',
                evidenceStatus: 'INSUFFICIENT_EVIDENCE',
                reasonCodes: ['NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE'],
                checkedAt: '2026-07-28T01:00:00.000Z',
              },
            ],
          ]),
        ),
      } as never,
    );

    const response = await service.getBootstrap();

    expect(response.members[0]?.agent?.status).toBe('online');
    expect(response.members[0]?.agent?.operationalAvailability.status).toBe('NOT_READY');
    expect(response.members[0]?.capabilities.canContactAgent).toBe(true);
  });
});
