import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import {
  correctionActionRequiresEvidence,
  correctionActionsFor,
  isCollaborationTerminal,
  isWorkbenchCapabilityUnavailable,
  isWorkbenchRevisionConflict,
  workbenchInteractionError,
} from './interaction-view';

describe('workbench collaboration and correction policy', () => {
  it('derives correction actions from the shared transition state machine', () => {
    expect(correctionActionsFor('OPEN')).toEqual([
      'ACKNOWLEDGE',
      'ACCEPT',
      'REJECT',
      'EXPLAIN',
      'ESCALATE',
      'CANCEL',
    ]);
    expect(correctionActionsFor('RESOLVED')).toEqual([]);
    expect(correctionActionsFor('CANCELLED')).toEqual([]);
  });

  it('requires evidence for consequential feedback and detects terminal collaboration', () => {
    expect(correctionActionRequiresEvidence('RESOLVE')).toBe(true);
    expect(correctionActionRequiresEvidence('ACKNOWLEDGE')).toBe(false);
    expect(isCollaborationTerminal('ACCEPTED')).toBe(true);
    expect(isCollaborationTerminal('REQUESTED')).toBe(false);
  });

  it('distinguishes unavailable capabilities and revision conflicts', () => {
    const unavailable = new ApiClientError('http', 'Not implemented', { status: 501 });
    const conflict = new ApiClientError('http', 'Revision mismatch', { status: 409 });

    expect(isWorkbenchCapabilityUnavailable(unavailable)).toBe(true);
    expect(isWorkbenchRevisionConflict(conflict)).toBe(true);
    expect(workbenchInteractionError(unavailable)).toContain('不会展示模拟');
    expect(workbenchInteractionError(conflict)).toContain('修订冲突');
  });
});
