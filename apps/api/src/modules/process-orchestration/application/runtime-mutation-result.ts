export type RuntimeMutationRejection =
  'INVALID_TRANSITION' | 'INVALID_COMMAND' | 'INVARIANT_VIOLATION';

export type RuntimeMutationResult<T> =
  | { readonly kind: 'APPLIED'; readonly value: T }
  | { readonly kind: 'IDEMPOTENT_REPLAY'; readonly value: T }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STALE_REVISION'; readonly currentRevision: number }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | {
      readonly kind: 'REJECTED';
      readonly reason: RuntimeMutationRejection;
      readonly detail: string;
    };

export interface RuntimeCursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface RuntimeCursorRequest {
  readonly cursor: string | null;
  readonly limit: number;
}
