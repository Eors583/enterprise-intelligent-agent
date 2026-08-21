import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import type { RuntimeMutationResult } from './runtime-mutation-result.js';

export function unwrapRuntimeMutation<T>(result: RuntimeMutationResult<T>, resource: string): T {
  switch (result.kind) {
    case 'APPLIED':
    case 'IDEMPOTENT_REPLAY':
      return result.value;
    case 'NOT_FOUND':
      throw new NotFoundException(`${resource} was not found.`);
    case 'STALE_REVISION':
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `${resource} revision is stale.`,
        currentRevision: result.currentRevision,
      });
    case 'IDEMPOTENCY_CONFLICT':
      throw new ConflictException(
        `${resource} idempotency key was already used for a different command.`,
      );
    case 'REJECTED':
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: result.detail,
        reasonCode: result.reason,
      });
  }
}

export function normalizeRuntimeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const normalized = cursor.trim();
  if (normalized.length === 0 || normalized.length > 2_000) {
    throw new UnprocessableEntityException(
      'The runtime cursor must contain between 1 and 2000 characters.',
    );
  }
  return normalized;
}
