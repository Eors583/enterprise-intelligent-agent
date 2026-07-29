import {
  isCorrectionTransitionAllowed,
  type CorrectionCase,
  type CorrectionFeedbackRequest,
} from '@enterprise/contracts';

export type CorrectionActorType = 'USER' | 'AGENT' | 'SYSTEM';

export interface TrustedCorrectionRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly orgUnitStatus: 'ACTIVE' | 'ARCHIVED';
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedCorrectionActor {
  readonly type: CorrectionActorType;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly roleAssignment: TrustedCorrectionRoleAssignment | null;
}

export interface TrustedCorrectionEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly active: boolean;
  readonly sealed: boolean;
  readonly visibleToActor: boolean;
  readonly linkedToCorrection: boolean;
}

export interface CorrectionFeedbackContext {
  readonly actor: TrustedCorrectionActor;
  readonly subjectRoleAssignment: Pick<
    TrustedCorrectionRoleAssignment,
    'id' | 'tenantId' | 'userId'
  >;
  readonly evidence: readonly TrustedCorrectionEvidence[];
  readonly now: Date;
}

export interface CorrectionTransitionDecision {
  readonly allowed: boolean;
  readonly nextStatus: CorrectionCase['status'] | null;
  readonly reason:
    | 'ALLOW'
    | 'STALE_REVISION'
    | 'ILLEGAL_TRANSITION'
    | 'ROLE_ASSIGNMENT_REQUIRED'
    | 'ACTOR_IDENTITY_INVALID'
    | 'ACTOR_ASSIGNMENT_INACTIVE'
    | 'SUBJECT_IDENTITY_INVALID'
    | 'SUBJECT_ROLE_REQUIRED'
    | 'REVIEW_ROLE_REQUIRED'
    | 'INDEPENDENT_REVIEW_REQUIRED'
    | 'HUMAN_REVIEW_REQUIRED'
    | 'EVIDENCE_REQUIRED'
    | 'EVIDENCE_INVALID'
    | 'INVALID_EFFECTIVE_TIME';
}

/**
 * Applies human-accountability rules to correction feedback. Model output can
 * propose a correction but can never accept or resolve a high-impact case.
 */
export function evaluateCorrectionFeedback(
  correction: CorrectionCase,
  feedback: CorrectionFeedbackRequest,
  context: CorrectionFeedbackContext,
): CorrectionTransitionDecision {
  if (feedback.expectedRevision !== correction.revision) {
    return deny('STALE_REVISION');
  }

  const nextStatus = correctionStatusForAction(feedback.action);
  if (!isCorrectionTransitionAllowed(correction.status, nextStatus)) {
    return deny('ILLEGAL_TRANSITION');
  }
  if (
    !Number.isFinite(context.now.getTime()) ||
    Date.parse(feedback.effectiveAt) < Date.parse(correction.updatedAt)
  ) {
    return deny('INVALID_EFFECTIVE_TIME');
  }
  const actor = context.actor;
  const actorAssignment = actor.roleAssignment;
  if (actor.tenantId !== correction.tenantId) {
    return deny('ACTOR_IDENTITY_INVALID');
  }
  if (actorAssignment === null) {
    return deny('ROLE_ASSIGNMENT_REQUIRED');
  }
  if (
    actorAssignment.tenantId !== correction.tenantId ||
    actor.userId === null ||
    actorAssignment.userId !== actor.userId
  ) {
    return deny('ACTOR_IDENTITY_INVALID');
  }
  if (!isUsableAssignment(actorAssignment, context.now)) {
    return deny('ACTOR_ASSIGNMENT_INACTIVE');
  }
  if (
    context.subjectRoleAssignment.id !== correction.roleAssignmentId ||
    context.subjectRoleAssignment.tenantId !== correction.tenantId
  ) {
    return deny('SUBJECT_IDENTITY_INVALID');
  }

  const isSubject = actorAssignment.id === correction.roleAssignmentId;
  const isReviewer = correction.requiredRoleAssignmentIds.includes(actorAssignment.id);
  switch (feedback.action) {
    case 'ACKNOWLEDGE':
    case 'EXPLAIN':
    case 'REJECT':
      if (!isSubject && !isReviewer) return deny('SUBJECT_ROLE_REQUIRED');
      break;
    case 'ACCEPT':
    case 'RESOLVE':
    case 'CANCEL':
      if (!isReviewer) return deny('REVIEW_ROLE_REQUIRED');
      break;
    case 'ESCALATE':
      if (!isSubject && !isReviewer) return deny('SUBJECT_ROLE_REQUIRED');
      break;
  }

  const highImpact =
    correction.category === 'CAPABILITY_RISK' ||
    correction.severity === 'HIGH' ||
    correction.severity === 'CRITICAL';
  if (
    feedback.evidenceIds.length > 0 &&
    !evidenceIsTrusted(correction, feedback.evidenceIds, context.evidence)
  ) {
    return deny('EVIDENCE_INVALID');
  }
  if (highImpact && ['ACCEPT', 'RESOLVE', 'CANCEL'].includes(feedback.action)) {
    if (actor.type !== 'USER') return deny('HUMAN_REVIEW_REQUIRED');
    if (isSubject || actor.userId === context.subjectRoleAssignment.userId) {
      return deny('INDEPENDENT_REVIEW_REQUIRED');
    }
    if (feedback.evidenceIds.length === 0) return deny('EVIDENCE_REQUIRED');
  }

  return { allowed: true, nextStatus, reason: 'ALLOW' };
}

function isUsableAssignment(assignment: TrustedCorrectionRoleAssignment, now: Date): boolean {
  const effectiveFrom = time(assignment.effectiveFrom);
  const effectiveTo = time(assignment.effectiveTo);
  return (
    assignment.status === 'ACTIVE' &&
    assignment.employmentStatus === 'ACTIVE' &&
    assignment.orgUnitStatus === 'ACTIVE' &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    effectiveFrom !== null &&
    effectiveFrom <= now.getTime() &&
    (assignment.effectiveTo === null || (effectiveTo !== null && effectiveTo > now.getTime()))
  );
}

function evidenceIsTrusted(
  correction: CorrectionCase,
  evidenceIds: readonly string[],
  evidence: readonly TrustedCorrectionEvidence[],
): boolean {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return evidenceIds.every((id) => {
    const item = byId.get(id);
    return (
      item !== undefined &&
      item.tenantId === correction.tenantId &&
      item.active &&
      item.sealed &&
      item.visibleToActor &&
      item.linkedToCorrection
    );
  });
}

function time(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function correctionStatusForAction(
  action: CorrectionFeedbackRequest['action'],
): CorrectionCase['status'] {
  switch (action) {
    case 'ACKNOWLEDGE':
      return 'ACKNOWLEDGED';
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'REJECT':
      return 'REJECTED';
    case 'EXPLAIN':
      return 'EXPLAINED';
    case 'ESCALATE':
      return 'ESCALATED';
    case 'RESOLVE':
      return 'RESOLVED';
    case 'CANCEL':
      return 'CANCELLED';
  }
}

function deny(
  reason: Exclude<CorrectionTransitionDecision['reason'], 'ALLOW'>,
): CorrectionTransitionDecision {
  return { allowed: false, nextStatus: null, reason };
}
