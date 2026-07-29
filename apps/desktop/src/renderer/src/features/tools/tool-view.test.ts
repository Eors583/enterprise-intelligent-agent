import { describe, expect, it } from 'vitest';

import {
  initialToolInput,
  parseToolInput,
  requesterActionsFor,
  toolInvocationStatusLabel,
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
