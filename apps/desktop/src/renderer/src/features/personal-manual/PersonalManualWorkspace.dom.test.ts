import type { PersonalManualSelfProfile } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  getMyPersonalManual: vi.fn(),
  updateMyPersonalManual: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { PersonalManualWorkspace } from './PersonalManualWorkspace';

beforeEach(() => {
  apiMocks.getMyPersonalManual.mockReset();
  apiMocks.updateMyPersonalManual.mockReset();
});

describe('PersonalManualWorkspace DOM acceptance', () => {
  it('shows official identity information and all six editable sections', async () => {
    apiMocks.getMyPersonalManual.mockResolvedValue(profileFixture());

    const dom = await renderInTestDom(createElement(PersonalManualWorkspace));
    try {
      await dom.flush();

      expect(dom.container.textContent).toContain('个人使用说明书');
      expect(dom.container.textContent).toContain('林晓');
      expect(dom.container.textContent).toContain('产品中心');
      expect(dom.container.textContent).toContain('产品负责人');
      expect(dom.container.textContent).toContain('我是谁？');
      expect(dom.container.textContent).toContain('我的岗位职责是什么？');
      expect(dom.container.textContent).toContain('怎样与我高效协同？');
      expect(dom.container.textContent).toContain('如何用好我？我还能提供哪些资源？');
      expect(dom.container.textContent).toContain('我有哪些兴趣爱好？');
      expect(dom.container.textContent).toContain('您可能会问这些问题');
      expect(dom.container.textContent).toContain('填写完成度17%');
    } finally {
      await dom.cleanup();
    }
  });

  it('edits content, manages question rows, and saves a versioned replacement', async () => {
    const profile = profileFixture();
    apiMocks.getMyPersonalManual.mockResolvedValue(profile);
    apiMocks.updateMyPersonalManual.mockImplementation(async (request) => ({
      ...profile,
      manual: request.manual,
      updatedAt: '2026-08-11T02:00:00.000Z',
    }));

    const dom = await renderInTestDom(createElement(PersonalManualWorkspace));
    try {
      await dom.flush();

      const responsibilities = controlForLabel(dom.container, '岗位职责');
      await dom.change(responsibilities, '负责产品规划、跨部门协同和版本验收。');

      const addQuestion = buttonWithText(dom.container, '+ 添加一个问题');
      await dom.click(addQuestion);
      expect(dom.container.textContent).toContain('Q1');
      const removeQuestion = buttonWithText(dom.container, '删除');
      await dom.click(removeQuestion);
      expect(dom.container.textContent).toContain('还没有常见问题');

      const form = dom.container.querySelector('form');
      if (!form) throw new Error('Personal manual form not found.');
      await dom.submit(form as HTMLFormElement);
      await dom.flush();

      expect(apiMocks.updateMyPersonalManual).toHaveBeenCalledWith({
        expectedUpdatedAt: profile.updatedAt,
        manual: expect.objectContaining({
          jobResponsibilities: '负责产品规划、跨部门协同和版本验收。',
          faqs: [],
        }),
      });
      expect(dom.container.textContent).toContain('个人使用说明书已保存。');
      expect(dom.container.textContent).toContain('当前内容已保存');
    } finally {
      await dom.cleanup();
    }
  });
});

function controlForLabel(
  container: HTMLElement,
  labelText: string,
): HTMLInputElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll('label')].find((item) =>
    item.querySelector(':scope > span')?.textContent?.includes(labelText),
  );
  const control = label?.querySelector('input, textarea');
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) {
    throw new Error(`Control for label ${labelText} not found.`);
  }
  return control;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!(button instanceof HTMLElement)) throw new Error(`Button ${text} not found.`);
  return button as HTMLButtonElement;
}

function profileFixture(): PersonalManualSelfProfile {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
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
    manual: {
      personalSummary: '负责企业协作产品。',
      educationBackground: null,
      careerOverview: null,
      jobResponsibilities: null,
      communicationPreference: null,
      collaborationHabits: null,
      routineSchedule: null,
      contactInformation: null,
      coreSkills: null,
      availableResources: null,
      hobbies: null,
      clubs: null,
      faqs: [],
    },
    updatedAt: '2026-08-11T01:00:00.000Z',
  };
}
