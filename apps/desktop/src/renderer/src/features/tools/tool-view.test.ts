import { describe, expect, it } from 'vitest';

import {
  initialToolInput,
  parseToolInput,
  requesterActionsFor,
  toolInputFields,
  toolInputValue,
  toolInvocationStatusLabel,
  updateToolInput,
} from './tool-view';
import { availableToolFixture, toolInvocationFixture } from './test-fixtures';

describe('employee Tool workbench view', () => {
  it('builds an editable JSON object from the governed input Schema', () => {
    expect(JSON.parse(initialToolInput(availableToolFixture()))).toEqual({ customerId: '' });
    expect(parseToolInput('{"customerId":"customer-1"}')).toEqual({
      customerId: 'customer-1',
    });
    expect(() => parseToolInput('[]')).toThrow('JSON 对象');
  });

  it('projects supported input schema properties into business form fields', () => {
    const tool = availableToolFixture({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          customerId: { type: 'string', title: '客户' },
          priority: { type: 'integer', title: '优先级' },
          notify: { type: 'boolean', title: '完成后通知' },
          format: { type: 'string', title: '结果格式', enum: ['摘要', '完整记录'] },
        },
        required: ['customerId'],
      },
    });
    expect(
      toolInputFields(tool).map(({ key, kind, required }) => ({ key, kind, required })),
    ).toEqual([
      { key: 'customerId', kind: 'string', required: true },
      { key: 'priority', kind: 'number', required: false },
      { key: 'notify', kind: 'boolean', required: false },
      { key: 'format', kind: 'string', required: false },
    ]);

    const updated = updateToolInput(initialToolInput(tool), 'customerId', 'customer-42');
    expect(toolInputValue(updated, 'customerId')).toBe('customer-42');
    expect(parseToolInput(updated)).toMatchObject({ customerId: 'customer-42' });
  });

  it('offers only requester-safe actions for each state', () => {
    expect(requesterActionsFor(toolInvocationFixture())).toEqual(['CONFIRM', 'CANCEL']);
    expect(
      requesterActionsFor(
        toolInvocationFixture({
          status: 'PENDING_APPROVAL',
          riskClass: 'HIGH_RISK_APPROVAL',
          confirmation: {
            confirmedByUserId: toolInvocationFixture().requesterUserId,
            confirmedAt: '2026-07-28T06:01:00.000Z',
            reason: 'Confirmed',
          },
          revision: 3,
          updatedAt: '2026-07-28T06:01:00.000Z',
        }),
      ),
    ).toEqual(['CANCEL']);
    expect(requesterActionsFor(toolInvocationFixture({ status: 'UNKNOWN' }))).toEqual([
      'RECONCILE',
    ]);
    expect(requesterActionsFor(toolInvocationFixture({ status: 'SUCCEEDED' }))).toEqual([
      'COMPENSATE',
    ]);
    expect(
      requesterActionsFor(
        toolInvocationFixture({
          status: 'SUCCEEDED',
          compensationForInvocationId: toolInvocationFixture().id,
        }),
      ),
    ).toEqual([]);
  });

  it('keeps uncertain provider outcomes visibly distinct', () => {
    expect(toolInvocationStatusLabel('UNKNOWN')).toBe('结果待核对');
    expect(toolInvocationStatusLabel('FAILED')).toBe('执行失败');
  });
});
