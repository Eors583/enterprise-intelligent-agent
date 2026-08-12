import { describe, expect, it } from 'vitest';

import {
  createKnowledgeBaseRequestSchema,
  createMemberRequestSchema,
  inviteMemberRequestSchema,
  resetMemberPasswordRequestSchema,
  updateOrganizationRequestSchema,
} from './admin.js';

const orgUnitId = '00000000-0000-7000-8000-000000000001';

describe('admin P1 compatibility contracts', () => {
  it('allows the server to allocate a knowledge-base key and preserves explicit legacy keys', () => {
    expect(
      createKnowledgeBaseRequestSchema.parse({
        name: '企业制度',
      }),
    ).toMatchObject({ name: '企业制度', status: 'ACTIVE', orgUnitIds: [] });
    expect(
      createKnowledgeBaseRequestSchema.parse({
        key: 'employee-handbook',
        name: 'Employee handbook',
      }).key,
    ).toBe('employee-handbook');
    expect(() =>
      createKnowledgeBaseRequestSchema.parse({
        key: 'Employee Handbook',
        name: 'Employee handbook',
      }),
    ).toThrow();
  });

  it('accepts valid IANA time zones, inherits when omitted, and rejects invalid values', () => {
    expect(
      updateOrganizationRequestSchema.parse({
        timezone: 'Asia/Shanghai',
        expectedVersion: 1,
      }).timezone,
    ).toBe('Asia/Shanghai');
    expect(
      updateOrganizationRequestSchema.parse({
        expectedVersion: 1,
      }),
    ).not.toHaveProperty('timezone');
    expect(() =>
      updateOrganizationRequestSchema.parse({
        timezone: 'Shanghai Local Time',
        expectedVersion: 1,
      }),
    ).toThrow('timezone must be a valid IANA time zone');
  });

  it('keeps invitation passwordless while preserving legacy create and reset payloads', () => {
    const invited = inviteMemberRequestSchema.parse({
      email: 'member@example.test',
      displayName: 'Member',
      role: 'MEMBER',
      orgUnitId,
    });
    expect(invited).not.toHaveProperty('password');
    expect(
      createMemberRequestSchema.safeParse({
        ...invited,
        password: 'LegacyPassword!2026',
      }).success,
    ).toBe(true);
    expect(
      resetMemberPasswordRequestSchema.safeParse({
        temporaryPassword: 'TemporaryPassword!2026',
      }).success,
    ).toBe(true);
  });

  it('accepts the five personnel types but never carries a personal manual in admin onboarding', () => {
    for (const employmentType of ['REGULAR', 'INTERN', 'OUTSOURCED', 'LABOR', 'CONSULTANT']) {
      const result = inviteMemberRequestSchema.parse({
        email: `${employmentType.toLowerCase()}@example.test`,
        displayName: employmentType,
        role: 'MEMBER',
        orgUnitId,
        phone: '+86 13800000000',
        employmentType,
        hireDate: '2026-08-10',
        countryOrRegion: '中国',
        city: '深圳',
        personalManual: {
          personalSummary: '负责企业协作产品。',
          jobResponsibilities: '负责需求分析与产品交付。',
          coreSkills: '产品设计、业务分析。',
          faqs: [{ question: '什么时候可以找我？', answer: '工作日可直接发消息。' }],
        },
      });
      expect(result.employmentType).toBe(employmentType);
      expect(result).not.toHaveProperty('personalManual');
      expect(result).not.toHaveProperty('password');
    }
  });
});
