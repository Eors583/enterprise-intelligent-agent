import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { memoryFixture } from './test-fixtures';

const { listMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
}));

vi.mock('./api', () => ({
  listMemories: listMock,
  createMemoryCandidate: vi.fn(),
  transitionMemory: vi.fn(),
}));

import { MemoryWorkspace } from './MemoryWorkspace';

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({
    items: [memoryFixture()],
    nextCursor: null,
  });
});

describe('five-layer memory workspace DOM acceptance', () => {
  it('shows all scopes and selects the exact Agent Run purpose for private memory', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const dom = await renderInTestDom(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryWorkspace, {
          assignments: [],
          tasks: [],
          conversations: [],
        }),
      ),
    );
    try {
      await dom.flush();
      const tabs = [...dom.container.querySelectorAll('[role="tab"]')];
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        '企企业记忆',
        '角角色记忆',
        '私员工私有',
        '任任务记忆',
        '聊会话记忆',
      ]);
      expect(dom.container.textContent).toContain('Delivery policy');
      expect(listMock).toHaveBeenCalledTimes(1);

      const privateTab = tabs.find((tab) => tab.textContent?.includes('员工私有'));
      expect(privateTab).toBeDefined();
      await dom.click(privateTab!);
      await dom.flush();
      expect(dom.container.textContent).toContain('AGENT_RUN_CONTEXT');
      expect(listMock).toHaveBeenCalledTimes(2);
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          scope: 'EMPLOYEE_PRIVATE',
          purpose: 'AGENT_RUN_CONTEXT',
        }),
        expect.any(AbortSignal),
      );

      const purposeInput = dom.container.querySelector(
        '.memory-purpose input',
      ) as HTMLInputElement | null;
      expect(purposeInput).not.toBeNull();
      expect(purposeInput?.getAttribute('placeholder')).toContain('授权用途');
      expect(purposeInput?.value).toBe('AGENT_RUN_CONTEXT');
    } finally {
      await dom.cleanup();
      client.clear();
    }
  });
});
