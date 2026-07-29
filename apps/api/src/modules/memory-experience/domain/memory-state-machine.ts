import type { MemoryStatus, MemoryTransitionRequest } from '@enterprise/contracts';

export type MemoryTransitionAction = MemoryTransitionRequest['action'];

const TRANSITIONS: Readonly<
  Record<MemoryStatus, Partial<Record<MemoryTransitionAction, MemoryStatus>>>
> = {
  CANDIDATE: { ACTIVATE: 'ACTIVE', DELETE: 'DELETED' },
  ACTIVE: { ARCHIVE: 'ARCHIVED', SEAL: 'SEALED', DELETE: 'DELETED' },
  ARCHIVED: { ACTIVATE: 'ACTIVE', SEAL: 'SEALED', DELETE: 'DELETED' },
  SEALED: { ARCHIVE: 'ARCHIVED', DELETE: 'DELETED' },
  DELETED: {},
};

export class InvalidMemoryTransitionError extends Error {
  constructor(
    readonly currentStatus: MemoryStatus,
    readonly action: MemoryTransitionAction,
  ) {
    super(`Memory ${action} is not allowed from ${currentStatus}.`);
    this.name = 'InvalidMemoryTransitionError';
  }
}

export function transitionMemory(
  currentStatus: MemoryStatus,
  action: MemoryTransitionAction,
): MemoryStatus {
  const next = TRANSITIONS[currentStatus][action];
  if (next === undefined) {
    throw new InvalidMemoryTransitionError(currentStatus, action);
  }
  return next;
}
