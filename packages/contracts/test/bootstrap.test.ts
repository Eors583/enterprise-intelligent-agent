import { describe, expect, it } from 'vitest';

import {
  bootstrapResponseSchema,
  employeePrimaryNavigationIdSchema,
  employeePrimaryNavigationIds,
  legacyEmployeeNavigationAliases,
} from '../src/index.js';

const validPayload = {
  tenant: { id: 'tenant-demo', name: '示例企业' },
  currentUser: { id: 'user-alice', name: '林知夏', title: '产品负责人' },
  navigation: [{ id: 'messages', label: '消息' }],
  departments: [{ id: 'dept-product', name: '产品中心', parentId: null, memberCount: 1 }],
  members: [
    {
      id: 'user-alice',
      name: '林知夏',
      title: '产品负责人',
      departmentIds: ['dept-product'],
      status: 'active',
      agent: {
        id: 'agent-alice',
        name: '林知夏的工作智能体',
        status: 'online',
        summary: '了解产品目标与当前项目上下文',
        operationalAvailability: {
          status: 'AVAILABLE',
          evidenceStatus: 'VERIFIED',
          reasonCodes: [],
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
      capabilities: { canContactHuman: true, canContactAgent: true },
    },
  ],
  departmentAgents: [],
} as const;

describe('bootstrapResponseSchema', () => {
  it('accepts the desktop bootstrap contract', () => {
    expect(bootstrapResponseSchema.parse(validPayload)).toEqual(validPayload);
  });

  it('rejects an agent entry without explicit contact capabilities', () => {
    const invalid = structuredClone(validPayload) as Record<string, unknown>;
    const members = invalid.members as Array<Record<string, unknown>>;
    delete members[0]?.capabilities;

    expect(bootstrapResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an online configuration without explicit operational evidence', () => {
    const invalid = structuredClone(validPayload) as Record<string, unknown>;
    const members = invalid.members as Array<Record<string, unknown>>;
    delete (members[0]?.agent as Record<string, unknown>).operationalAvailability;

    expect(bootstrapResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('exports the four canonical employee destinations and explicit legacy aliases', () => {
    expect(employeePrimaryNavigationIds).toEqual(['workbench', 'messages', 'contacts', 'profile']);
    expect(employeePrimaryNavigationIdSchema.safeParse('agents').success).toBe(false);
    expect(legacyEmployeeNavigationAliases).toEqual({
      home: 'workbench',
      agents: 'messages',
      roles: 'profile',
      growth: 'profile',
      memories: 'profile',
      'experience-usage': 'profile',
    });
  });
});
