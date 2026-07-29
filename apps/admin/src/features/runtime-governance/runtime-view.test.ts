import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client';

import {
  availableProcessStepCommands,
  isCapabilityUnavailable,
  isRevisionConflict,
  processCommandsFor,
  processStepCommandsFor,
  runtimeErrorMessage,
} from './runtime-view';
import { processStepFixture } from './test-fixtures';

describe('runtime governance view policy', () => {
  it('disables commands for terminal process and step states', () => {
    expect(processCommandsFor('COMPLETED')).toEqual([]);
    expect(processCommandsFor('CANCELLED')).toEqual([]);
    expect(processCommandsFor('COMPENSATED')).toEqual([]);
    expect(processStepCommandsFor('CANCELLED')).toEqual([]);
    expect(processStepCommandsFor('SKIPPED')).toEqual([]);
    expect(processStepCommandsFor('COMPENSATED')).toEqual([]);
  });

  it('keeps only explicit commands for mutable states', () => {
    expect(processCommandsFor('RUNNING')).toEqual(['PAUSE', 'COMPLETE', 'FAIL', 'CANCEL']);
    expect(processStepCommandsFor('FAILED')).toEqual(['RETRY', 'BEGIN_COMPENSATION', 'CANCEL']);
    expect(
      availableProcessStepCommands(processStepFixture({ resolvedRoleAssignmentId: null })),
    ).toEqual(['TIMEOUT', 'CANCEL']);
  });

  it('separates unimplemented capability and revision conflict errors', () => {
    const unavailable = new ApiError('Not implemented', { status: 501 });
    const conflict = new ApiError('Conflict', { status: 409 });

    expect(isCapabilityUnavailable(unavailable)).toBe(true);
    expect(isRevisionConflict(conflict)).toBe(true);
    expect(runtimeErrorMessage(unavailable)).toContain('不会使用模拟数据');
    expect(runtimeErrorMessage(conflict)).toContain('修订冲突');
  });
});
