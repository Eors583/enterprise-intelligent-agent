import { describe, expect, it } from 'vitest';

import { InvalidMemoryTransitionError, transitionMemory } from './memory-state-machine.js';

describe('memory state machine', () => {
  it('requires candidate activation before normal retention transitions', () => {
    expect(transitionMemory('CANDIDATE', 'ACTIVATE')).toBe('ACTIVE');
    expect(transitionMemory('ACTIVE', 'ARCHIVE')).toBe('ARCHIVED');
    expect(transitionMemory('ARCHIVED', 'SEAL')).toBe('SEALED');
    expect(transitionMemory('SEALED', 'DELETE')).toBe('DELETED');
  });

  it('rejects shortcuts and transitions from deleted state', () => {
    expect(() => transitionMemory('CANDIDATE', 'SEAL')).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory('DELETED', 'ACTIVATE')).toThrow(InvalidMemoryTransitionError);
  });
});
