import type { ToolDefinition } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildToolObjectSchema,
  nextToolLifecycleAction,
  parseToolList,
  publishedCompensationOptions,
  toolRiskLabel,
} from './tool-governance-view';

describe('tool governance view policy', () => {
  it('never skips the test lifecycle gate', () => {
    expect(nextToolLifecycleAction('DRAFT')).toBe('TEST');
    expect(nextToolLifecycleAction('TESTING')).toBe('PUBLISH');
    expect(nextToolLifecycleAction('PUBLISHED')).toBe('RETIRE');
    expect(nextToolLifecycleAction('RETIRED')).toBeNull();
  });

  it('explains all execution risk classes explicitly', () => {
    expect(toolRiskLabel('READ_ONLY')).toContain('只读');
    expect(toolRiskLabel('HIGH_RISK_APPROVAL')).toContain('独立审批');
    expect(toolRiskLabel('FORBIDDEN')).toContain('禁止');
  });

  it('deduplicates outbound allowlist values', () => {
    expect(parseToolList('api.example.com, api.example.com；files.example.com')).toEqual([
      'api.example.com',
      'files.example.com',
    ]);
  });

  it('builds a closed schema from controlled fields and rejects duplicate names', () => {
    const field = {
      id: 'field-1',
      name: 'customerId',
      type: 'string' as const,
      required: true,
      description: '客户标识',
    };
    expect(buildToolObjectSchema([field])).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { customerId: { type: 'string', description: '客户标识' } },
      required: ['customerId'],
    });
    expect(() => buildToolObjectSchema([field, { ...field, id: 'field-2' }])).toThrow(
      '字段“customerId”重复',
    );
  });

  it('offers only current published versions as compensation choices', () => {
    const published = toolDefinition({
      id: '00000000-0000-7000-8000-000000000001',
      status: 'PUBLISHED',
      currentVersionId: '00000000-0000-7000-8000-000000000002',
      currentVersion: 3,
    });
    const draft = toolDefinition({
      id: '00000000-0000-7000-8000-000000000003',
      status: 'DRAFT',
      currentVersionId: null,
      currentVersion: null,
    });

    expect(publishedCompensationOptions([draft, published])).toEqual([
      {
        id: '00000000-0000-7000-8000-000000000002',
        label: '客户查询 · v3（crm.customer.read）',
      },
    ]);
  });
});

function toolDefinition(
  patch: Partial<ToolDefinition> & Pick<ToolDefinition, 'id' | 'status'>,
): ToolDefinition {
  return {
    id: patch.id,
    tenantId: '00000000-0000-7000-8000-000000000010',
    key: 'crm.customer.read',
    name: '客户查询',
    description: '读取客户资料',
    ownerUserId: '00000000-0000-7000-8000-000000000011',
    status: patch.status,
    currentVersionId: patch.currentVersionId ?? null,
    currentVersion: patch.currentVersion ?? null,
    revision: 1,
    permissionLabels: [],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}
