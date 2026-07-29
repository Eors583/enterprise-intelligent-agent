import type {
  MarketingInsight,
  TransitionMarketingActionItemRequest,
  TransitionMarketingActionPlanRequest,
  TransitionMarketingInsightRequest,
  TransitionMarketingTargetRequest,
} from '@enterprise/contracts';

export class InvalidMarketingTransitionError extends Error {}

export interface MarketingInsightTransitionActor {
  readonly userId: string;
}

export interface MarketingInsightTransitionPatch {
  readonly status: MarketingInsight['status'];
  readonly reviewRequestedByUserId?: string;
  readonly reviewedByUserId?: string;
  readonly publishedByUserId?: string;
  readonly reviewComment: string;
  readonly reviewRequestedAt?: Date;
  readonly reviewedAt?: Date;
  readonly publishedAt?: Date;
  readonly retiredAt?: Date;
}

export function transitionMarketingInsight(
  current: Pick<MarketingInsight, 'status' | 'createdByUserId' | 'reviewedByUserId' | 'revision'>,
  request: TransitionMarketingInsightRequest,
  actor: MarketingInsightTransitionActor,
  now = new Date(),
): MarketingInsightTransitionPatch {
  if (current.revision !== request.expectedRevision) {
    throw new InvalidMarketingTransitionError(
      'Marketing insight changed. Refresh before applying the transition.',
    );
  }
  if (request.action === 'SUBMIT' && current.status === 'CANDIDATE') {
    return {
      status: 'UNDER_REVIEW',
      reviewRequestedByUserId: actor.userId,
      reviewRequestedAt: now,
      reviewComment: request.comment,
    };
  }
  if (
    (request.action === 'APPROVE' || request.action === 'REJECT') &&
    current.status === 'UNDER_REVIEW'
  ) {
    if (actor.userId === current.createdByUserId) {
      throw new InvalidMarketingTransitionError(
        'Maker-checker requires an independent human reviewer.',
      );
    }
    return {
      status: request.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewedByUserId: actor.userId,
      reviewedAt: now,
      reviewComment: request.comment,
    };
  }
  if (request.action === 'PUBLISH' && current.status === 'APPROVED') {
    if (
      actor.userId === current.createdByUserId ||
      current.reviewedByUserId === current.createdByUserId ||
      current.reviewedByUserId === null
    ) {
      throw new InvalidMarketingTransitionError(
        'Only a human checker independent from the maker can publish this insight.',
      );
    }
    return {
      status: 'PUBLISHED',
      publishedByUserId: actor.userId,
      publishedAt: now,
      reviewComment: request.comment,
    };
  }
  if (request.action === 'RETIRE' && current.status === 'PUBLISHED') {
    return {
      status: 'RETIRED',
      retiredAt: now,
      reviewComment: request.comment,
    };
  }
  throw new InvalidMarketingTransitionError(
    `Marketing insight cannot ${request.action} from ${current.status}.`,
  );
}

export function transitionMarketingTarget(
  current: { readonly status: string; readonly revision: number },
  request: TransitionMarketingTargetRequest,
  now = new Date(),
): {
  readonly status: 'ACTIVE' | 'CLOSED' | 'CANCELLED';
  readonly activatedAt?: Date;
  readonly closedAt?: Date;
  readonly cancelledAt?: Date;
} {
  if (current.revision !== request.expectedRevision) {
    throw new InvalidMarketingTransitionError(
      'Marketing target changed. Refresh before applying the transition.',
    );
  }
  if (request.action === 'ACTIVATE' && current.status === 'DRAFT') {
    return { status: 'ACTIVE', activatedAt: now };
  }
  if (request.action === 'CLOSE' && current.status === 'ACTIVE') {
    return { status: 'CLOSED', closedAt: now };
  }
  if (request.action === 'CANCEL' && (current.status === 'DRAFT' || current.status === 'ACTIVE')) {
    return { status: 'CANCELLED', cancelledAt: now };
  }
  throw new InvalidMarketingTransitionError(
    `Marketing target cannot ${request.action} from ${current.status}.`,
  );
}

export function transitionMarketingActionPlan(
  current: { readonly status: string; readonly revision: number },
  request: TransitionMarketingActionPlanRequest,
): 'ACTIVE' | 'COMPLETED' | 'CANCELLED' {
  if (current.revision !== request.expectedRevision) {
    throw new InvalidMarketingTransitionError(
      'Marketing action plan changed. Refresh before applying the transition.',
    );
  }
  if (request.action === 'ACTIVATE' && current.status === 'DRAFT') return 'ACTIVE';
  if (request.action === 'COMPLETE' && current.status === 'ACTIVE') return 'COMPLETED';
  if (request.action === 'CANCEL' && (current.status === 'DRAFT' || current.status === 'ACTIVE')) {
    return 'CANCELLED';
  }
  throw new InvalidMarketingTransitionError(
    `Marketing action plan cannot ${request.action} from ${current.status}.`,
  );
}

export function transitionMarketingActionItem(
  current: { readonly status: string; readonly revision: number },
  request: TransitionMarketingActionItemRequest,
): 'ACTIVE' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED' {
  if (current.revision !== request.expectedRevision) {
    throw new InvalidMarketingTransitionError(
      'Marketing action item changed. Refresh before applying the transition.',
    );
  }
  if (request.action === 'START' && current.status === 'PLANNED') return 'ACTIVE';
  if (request.action === 'BLOCK' && current.status === 'ACTIVE') return 'BLOCKED';
  if (request.action === 'UNBLOCK' && current.status === 'BLOCKED') return 'ACTIVE';
  if (
    request.action === 'COMPLETE' &&
    (current.status === 'ACTIVE' || current.status === 'BLOCKED')
  ) {
    if (request.acceptanceEvidenceId === null) {
      throw new InvalidMarketingTransitionError(
        'Completing an action item requires acceptance Evidence.',
      );
    }
    return 'COMPLETED';
  }
  if (
    request.action === 'CANCEL' &&
    (current.status === 'PLANNED' || current.status === 'ACTIVE' || current.status === 'BLOCKED')
  ) {
    return 'CANCELLED';
  }
  throw new InvalidMarketingTransitionError(
    `Marketing action item cannot ${request.action} from ${current.status}.`,
  );
}
