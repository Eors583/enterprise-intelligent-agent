import type { ExperienceCandidate, ExperienceStatus } from '@enterprise/contracts';

export type ExperienceAction =
  'SANITIZE' | 'STRUCTURE' | 'APPROVE' | 'REJECT' | 'VALIDATE' | 'PUBLISH' | 'MONITOR' | 'RETIRE';

export interface TrustedExperienceActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly roleAssignmentId: string;
  readonly assignmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly permissions: readonly (
    | 'EXPERIENCE_SANITIZE'
    | 'EXPERIENCE_STRUCTURE'
    | 'EXPERIENCE_REVIEW'
    | 'EXPERIENCE_VALIDATE'
    | 'EXPERIENCE_PUBLISH'
    | 'EXPERIENCE_MONITOR'
    | 'EXPERIENCE_RETIRE'
  )[];
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export type ExperienceTransitionProof =
  | {
      readonly action: 'SANITIZE';
      readonly sanitizedHash: string;
      readonly piiRemoved: boolean;
      readonly secretsRemoved: boolean;
      readonly customerIdentifiersRemoved: boolean;
    }
  | {
      readonly action: 'STRUCTURE';
      readonly structuredHash: string;
      readonly scenarioPresent: boolean;
      readonly problemPresent: boolean;
      readonly stepsPresent: boolean;
      readonly outcomesPresent: boolean;
      readonly applicabilityBoundariesPresent: boolean;
    }
  | {
      readonly action: 'APPROVE' | 'REJECT';
      readonly reviewerUserId: string;
      readonly reviewerRoleAssignmentId: string;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly action: 'VALIDATE';
      readonly validationRunId: string;
      readonly datasetVersionId: string;
      readonly passed: boolean;
      readonly score: number;
      readonly threshold: number;
    }
  | {
      readonly action: 'PUBLISH';
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
      readonly targetRoleTemplateIds: readonly string[];
      readonly targetOrgUnitIds: readonly string[];
    }
  | {
      readonly action: 'MONITOR';
      readonly useCount: number;
      readonly adoptionCount: number;
      readonly complaintCount: number;
    }
  | {
      readonly action: 'RETIRE';
      readonly replacementExperienceId: string | null;
      readonly rollbackDocumentVersionId: string | null;
    };

export interface ExperienceTransitionContext {
  readonly tenantId: string;
  readonly contributorUserId: string;
  readonly contributorRoleAssignmentId: string;
  readonly actor: TrustedExperienceActor;
  readonly proof: ExperienceTransitionProof;
  readonly now: Date;
}

const TRANSITIONS: Readonly<
  Record<ExperienceStatus, Partial<Record<ExperienceAction, ExperienceStatus>>>
> = {
  CANDIDATE: { SANITIZE: 'SANITIZED' },
  SANITIZED: { STRUCTURE: 'STRUCTURED' },
  STRUCTURED: { APPROVE: 'APPROVED', REJECT: 'REJECTED' },
  APPROVED: { VALIDATE: 'VALIDATED' },
  REJECTED: {},
  VALIDATED: { PUBLISH: 'PUBLISHED' },
  PUBLISHED: { MONITOR: 'MONITORED', RETIRE: 'RETIRED' },
  MONITORED: { MONITOR: 'MONITORED', RETIRE: 'RETIRED' },
  RETIRED: {},
};

const REQUIRED_PERMISSION: Readonly<
  Record<ExperienceAction, TrustedExperienceActor['permissions'][number]>
> = {
  SANITIZE: 'EXPERIENCE_SANITIZE',
  STRUCTURE: 'EXPERIENCE_STRUCTURE',
  APPROVE: 'EXPERIENCE_REVIEW',
  REJECT: 'EXPERIENCE_REVIEW',
  VALIDATE: 'EXPERIENCE_VALIDATE',
  PUBLISH: 'EXPERIENCE_PUBLISH',
  MONITOR: 'EXPERIENCE_MONITOR',
  RETIRE: 'EXPERIENCE_RETIRE',
};

export class InvalidExperienceTransitionError extends Error {
  constructor(
    readonly currentStatus: ExperienceStatus,
    readonly action: ExperienceAction,
    readonly reason: string,
  ) {
    super(`Experience ${action} is not allowed from ${currentStatus}: ${reason}`);
    this.name = 'InvalidExperienceTransitionError';
  }
}

export function transitionExperience(
  currentStatus: ExperienceStatus,
  action: ExperienceAction,
  context: ExperienceTransitionContext,
): ExperienceStatus {
  const next = TRANSITIONS[currentStatus][action];
  if (next === undefined) {
    throw invalid(currentStatus, action, 'invalid state transition');
  }
  if (
    context.tenantId.length === 0 ||
    context.actor.tenantId !== context.tenantId ||
    !Number.isFinite(context.now.getTime()) ||
    !actorUsable(context.actor, context.now)
  ) {
    throw invalid(currentStatus, action, 'actor context is not active and trusted');
  }
  if (!context.actor.permissions.includes(REQUIRED_PERMISSION[action])) {
    throw invalid(currentStatus, action, 'actor lacks the required governed permission');
  }
  if (context.proof.action !== action) {
    throw invalid(currentStatus, action, 'transition proof is bound to another action');
  }
  validateProof(currentStatus, action, context);
  return next;
}

function validateProof(
  currentStatus: ExperienceStatus,
  action: ExperienceAction,
  context: ExperienceTransitionContext,
): void {
  const proof = context.proof;
  switch (proof.action) {
    case 'SANITIZE':
      if (
        !isSha256(proof.sanitizedHash) ||
        !proof.piiRemoved ||
        !proof.secretsRemoved ||
        !proof.customerIdentifiersRemoved
      ) {
        throw invalid(currentStatus, action, 'sanitization proof is incomplete');
      }
      return;
    case 'STRUCTURE':
      if (
        !isSha256(proof.structuredHash) ||
        !proof.scenarioPresent ||
        !proof.problemPresent ||
        !proof.stepsPresent ||
        !proof.outcomesPresent ||
        !proof.applicabilityBoundariesPresent
      ) {
        throw invalid(currentStatus, action, 'structured experience fields are incomplete');
      }
      return;
    case 'APPROVE':
    case 'REJECT':
      if (
        proof.reviewerUserId !== context.actor.userId ||
        proof.reviewerRoleAssignmentId !== context.actor.roleAssignmentId ||
        proof.reviewerUserId === context.contributorUserId ||
        proof.reviewerRoleAssignmentId === context.contributorRoleAssignmentId ||
        proof.evidenceIds.length === 0 ||
        new Set(proof.evidenceIds).size !== proof.evidenceIds.length
      ) {
        throw invalid(currentStatus, action, 'expert review is not independent and evidenced');
      }
      return;
    case 'VALIDATE':
      if (
        proof.validationRunId.length === 0 ||
        proof.datasetVersionId.length === 0 ||
        !Number.isFinite(proof.score) ||
        !Number.isFinite(proof.threshold) ||
        proof.score < 0 ||
        proof.score > 1 ||
        proof.threshold < 0 ||
        proof.threshold > 1 ||
        proof.passed !== proof.score >= proof.threshold ||
        !proof.passed ||
        context.actor.userId === context.contributorUserId
      ) {
        throw invalid(currentStatus, action, 'validation did not pass independently');
      }
      return;
    case 'PUBLISH':
      if (
        proof.knowledgeBaseId.length === 0 ||
        proof.documentId.length === 0 ||
        proof.documentVersionId.length === 0 ||
        (proof.targetRoleTemplateIds.length === 0 && proof.targetOrgUnitIds.length === 0)
      ) {
        throw invalid(
          currentStatus,
          action,
          'publication target and immutable version are required',
        );
      }
      return;
    case 'MONITOR':
      if (
        !nonNegativeInteger(proof.useCount) ||
        !nonNegativeInteger(proof.adoptionCount) ||
        !nonNegativeInteger(proof.complaintCount) ||
        proof.adoptionCount > proof.useCount ||
        proof.complaintCount > proof.useCount
      ) {
        throw invalid(currentStatus, action, 'monitoring counters are inconsistent');
      }
      return;
    case 'RETIRE':
      if (proof.replacementExperienceId !== null && proof.rollbackDocumentVersionId !== null) {
        throw invalid(currentStatus, action, 'retirement must choose replacement or rollback');
      }
  }
}

function actorUsable(actor: TrustedExperienceActor, now: Date): boolean {
  const start = timestamp(actor.effectiveFrom);
  const end = timestamp(actor.effectiveTo);
  return (
    actor.userId.length > 0 &&
    actor.roleAssignmentId.length > 0 &&
    actor.assignmentStatus === 'ACTIVE' &&
    actor.employmentStatus === 'ACTIVE' &&
    start !== null &&
    start <= now.getTime() &&
    (actor.effectiveTo === null || (end !== null && end > now.getTime()))
  );
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function invalid(
  currentStatus: ExperienceStatus,
  action: ExperienceAction,
  reason: string,
): InvalidExperienceTransitionError {
  return new InvalidExperienceTransitionError(currentStatus, action, reason);
}

export type ExperienceCandidateForGovernance = Pick<
  ExperienceCandidate,
  'id' | 'tenantId' | 'status' | 'revision' | 'contributorUserId' | 'contributorRoleAssignmentId'
>;
