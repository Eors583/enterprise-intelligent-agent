import { describe, expect, it } from 'vitest';
import { RunActionGate } from './run-action-gate';

describe('RunActionGate', () => {
  it('synchronously rejects a second Run action until the first finishes', () => {
    const gate = new RunActionGate();

    expect(gate.tryStart('conversation-a:run-a')).toBe(true);
    expect(gate.isBusy).toBe(true);
    expect(gate.tryStart('conversation-a:run-a')).toBe(false);
    expect(gate.tryStart('conversation-a:run-b')).toBe(false);

    gate.finish('conversation-a:run-a');
    expect(gate.isBusy).toBe(false);
    expect(gate.tryStart('conversation-a:run-b')).toBe(true);
  });

  it('does not let a stale completion unlock a newer action after reset', () => {
    const gate = new RunActionGate();
    expect(gate.tryStart('conversation-a:run-a')).toBe(true);

    gate.reset();
    expect(gate.tryStart('conversation-b:run-b')).toBe(true);
    gate.finish('conversation-a:run-a');

    expect(gate.isBusy).toBe(true);
    expect(gate.tryStart('conversation-b:run-c')).toBe(false);
  });
});
