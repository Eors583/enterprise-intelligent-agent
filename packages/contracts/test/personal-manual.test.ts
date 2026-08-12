import { describe, expect, it } from 'vitest';

import {
  personalManualSelfProfileSchema,
  updatePersonalManualRequestSchema,
} from '../src/personal-manual.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';

describe('personal collaboration manual contracts', () => {
  it('accepts a complete self-service profile with common questions', () => {
    const parsed = personalManualSelfProfileSchema.parse({
      user: {
        id: USER_ID,
        displayName: '林晓',
        email: 'lin.xiao@example.com',
        phone: null,
        avatarUrl: null,
      },
      employment: {
        departmentName: '产品中心',
        title: '产品负责人',
        employeeNumber: 'P-001',
        employmentType: 'REGULAR',
      },
      manual: completeManual(),
      updatedAt: '2026-08-11T01:00:00.000Z',
    });

    expect(parsed.manual.faqs[0]?.question).toBe('什么事情适合直接找我？');
  });

  it('supports clearing optional text while rejecting half-filled FAQs', () => {
    expect(
      updatePersonalManualRequestSchema.parse({
        expectedUpdatedAt: null,
        manual: completeManual({ personalSummary: null, faqs: [] }),
      }).manual.personalSummary,
    ).toBeNull();

    expect(() =>
      updatePersonalManualRequestSchema.parse({
        expectedUpdatedAt: null,
        manual: completeManual({ faqs: [{ question: '只有问题', answer: '' }] }),
      }),
    ).toThrow();
  });
});

function completeManual(
  overrides: Partial<ReturnType<typeof completeManualBase>> = {},
): ReturnType<typeof completeManualBase> {
  return { ...completeManualBase(), ...overrides };
}

function completeManualBase() {
  return {
    personalSummary: '负责企业协作产品。',
    educationBackground: null,
    careerOverview: null,
    jobResponsibilities: '负责产品目标与交付。',
    communicationPreference: '紧急事项用即时消息。',
    collaborationHabits: '会议请提前一天预约。',
    routineSchedule: null,
    contactInformation: null,
    coreSkills: '产品设计、需求分析',
    availableResources: null,
    hobbies: '阅读、徒步',
    clubs: null,
    faqs: [{ question: '什么事情适合直接找我？', answer: '产品优先级和跨部门协作。' }],
  };
}
