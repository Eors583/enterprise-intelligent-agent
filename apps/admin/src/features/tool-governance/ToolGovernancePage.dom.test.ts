import type { ToolDefinition, ToolDefinitionDetail, ToolVersion } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  createToolDefinition: vi.fn(),
  createToolVersion: vi.fn(),
  getToolDefinition: vi.fn(),
  listToolDefinitions: vi.fn(),
  transitionToolVersion: vi.fn(),
}));

vi.mock('@/api/admin-api', () => apiMocks);

import { ToolGovernancePage } from './ToolGovernancePage';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listToolDefinitions.mockResolvedValue({ items: [], nextCursor: null });
});

describe('ToolGovernancePage guided configuration', () => {
  it('lets administrators register a definition without inventing a technical key', async () => {
    const dom = await renderInTestDom(createElement(ToolGovernancePage));
    try {
      await dom.flush();
      const button = [...dom.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === '注册工具',
      );
      expect(button).not.toBeUndefined();
      if (button) await dom.click(button);

      expect(dom.container.textContent).toContain('系统会根据名称生成租户内稳定 Key');
      expect(dom.container.textContent).not.toContain('唯一 Key');
      expect(dom.container.querySelector('[aria-label="工具权限标签"]')).not.toBeNull();
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps connector details and raw schemas advanced and selects a published compensator', async () => {
    const definition = publishedDefinition();
    apiMocks.listToolDefinitions.mockResolvedValue({ items: [definition], nextCursor: null });
    apiMocks.getToolDefinition.mockResolvedValue({
      definition,
      versions: [publishedVersion(definition)],
    } satisfies ToolDefinitionDetail);

    const dom = await renderInTestDom(createElement(ToolGovernancePage));
    try {
      await dom.flush();
      await dom.flush();
      const button = [...dom.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === '新建版本',
      );
      expect(button).not.toBeUndefined();
      if (button) await dom.click(button);

      const wizard = [...dom.container.querySelectorAll('details')].find((candidate) =>
        candidate.textContent?.includes('高级连接向导'),
      );
      expect(wizard?.hasAttribute('open')).toBe(false);
      expect(wizard?.textContent).toContain('当前未接入连接器目录');
      expect(wizard?.textContent).not.toContain('Input JSON Schema');
      expect(dom.container.querySelector('input[type="password"]')).toBeNull();

      const compensationLabel = [...dom.container.querySelectorAll('label')].find((candidate) =>
        candidate.textContent?.includes('失败补偿版本'),
      );
      expect(compensationLabel?.textContent).toContain('客户查询 · v3');
      expect(compensationLabel?.querySelector('input')).toBeNull();
      expect(compensationLabel?.querySelector('select')).not.toBeNull();
    } finally {
      await dom.cleanup();
    }
  });
});

function publishedDefinition(): ToolDefinition {
  return {
    id: '00000000-0000-7000-8000-000000000101',
    tenantId: '00000000-0000-7000-8000-000000000102',
    key: 'crm.customer.read',
    name: '客户查询',
    description: '读取客户资料',
    ownerUserId: '00000000-0000-7000-8000-000000000103',
    status: 'PUBLISHED',
    currentVersionId: '00000000-0000-7000-8000-000000000104',
    currentVersion: 3,
    revision: 3,
    permissionLabels: ['crm.read'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

function publishedVersion(definition: ToolDefinition): ToolVersion {
  return {
    id: definition.currentVersionId!,
    tenantId: definition.tenantId,
    toolId: definition.id,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    ownerUserId: definition.ownerUserId,
    version: definition.currentVersion!,
    status: 'PUBLISHED',
    adapter: 'HTTP',
    endpointRef: 'crm.customer.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
    riskClass: 'READ_ONLY',
    dataClassification: 'INTERNAL',
    timeoutMs: 10_000,
    maxAttempts: 2,
    idempotencyMode: 'PROVIDER_SUPPORTED',
    dryRunMode: 'VALIDATE_ONLY',
    allowedHttpMethods: ['GET'],
    allowedHostPatterns: ['api.example.com'],
    compensationToolVersionId: null,
    configurationHash: 'a'.repeat(64),
    effectiveFrom: '2026-07-29T00:00:00.000Z',
    effectiveTo: null,
    publishedAt: '2026-07-29T00:00:00.000Z',
    retiredAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}
