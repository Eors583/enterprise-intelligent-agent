import type {
  ConfirmCompetencyAssessmentRequest,
  TriangleHealthSnapshot,
  TriangleHealthSnapshotRequest,
} from '@enterprise/contracts';

export class PeopleOrganizationPolicyError extends Error {}

export interface AssessmentConfirmationState {
  readonly status:
    'CANDIDATE' | 'UNDER_REVIEW' | 'EFFECTIVE' | 'REJECTED' | 'DISPUTED' | 'SUPERSEDED';
  readonly revision: number;
  readonly subjectUserId: string;
  readonly createdByUserId: string;
  readonly requiredConfirmationRoles: readonly ('EMPLOYEE' | 'MANAGER' | 'HR')[];
  readonly confirmations: ReadonlyArray<{
    readonly role: 'EMPLOYEE' | 'MANAGER' | 'HR';
    readonly decision: 'CONFIRM' | 'REJECT' | 'REQUEST_MORE_EVIDENCE';
    readonly actorUserId: string;
  }>;
}

export interface AssessmentActor {
  readonly userId: string;
  readonly isHrAdministrator: boolean;
  readonly managesSubject: boolean;
}

export function decideAssessmentConfirmation(
  state: AssessmentConfirmationState,
  request: ConfirmCompetencyAssessmentRequest,
  actor: AssessmentActor,
): {
  readonly nextStatus: AssessmentConfirmationState['status'];
  readonly effective: boolean;
} {
  if (state.revision !== request.expectedRevision) {
    throw new PeopleOrganizationPolicyError(
      'Assessment changed. Refresh before recording a confirmation.',
    );
  }
  if (
    state.status === 'EFFECTIVE' ||
    state.status === 'REJECTED' ||
    state.status === 'SUPERSEDED'
  ) {
    throw new PeopleOrganizationPolicyError('A concluded assessment cannot be confirmed again.');
  }
  if (state.createdByUserId === actor.userId) {
    throw new PeopleOrganizationPolicyError(
      'Maker-checker requires a human reviewer independent from the candidate creator.',
    );
  }
  if (request.role === 'EMPLOYEE' && actor.userId !== state.subjectUserId) {
    throw new PeopleOrganizationPolicyError(
      'Only the assessed employee can provide the employee confirmation.',
    );
  }
  if (request.role === 'MANAGER' && !actor.managesSubject) {
    throw new PeopleOrganizationPolicyError(
      'Only the effective manager can provide the manager confirmation.',
    );
  }
  if (request.role === 'HR' && !actor.isHrAdministrator) {
    throw new PeopleOrganizationPolicyError(
      'Only an authorized HR administrator can provide the HR confirmation.',
    );
  }
  if (!state.requiredConfirmationRoles.includes(request.role)) {
    throw new PeopleOrganizationPolicyError(
      'The claimed confirmation role is not required by this assessment policy.',
    );
  }
  if (state.confirmations.some((item) => item.role === request.role)) {
    throw new PeopleOrganizationPolicyError(
      'This human confirmation role has already made its decision.',
    );
  }
  if (request.decision === 'REJECT') {
    return { nextStatus: 'REJECTED', effective: false };
  }
  if (request.decision === 'REQUEST_MORE_EVIDENCE') {
    return { nextStatus: 'DISPUTED', effective: false };
  }
  const confirmed = new Set([
    ...state.confirmations.filter((item) => item.decision === 'CONFIRM').map((item) => item.role),
    request.role,
  ]);
  const effective = state.requiredConfirmationRoles.every((role) => confirmed.has(role));
  return { nextStatus: effective ? 'EFFECTIVE' : 'UNDER_REVIEW', effective };
}

const LOWER_IS_BETTER = new Set(['TASK_RESPONSE_LATENCY', 'PROCESS_RETURN_RATE'] as const);

export function calculateTriangleHealth(
  teamId: string,
  teamRevision: number,
  request: TriangleHealthSnapshotRequest,
  thresholds: TriangleHealthSnapshotRequest['observations'],
  weights: Record<keyof TriangleHealthSnapshotRequest['observations'], number>,
  now = new Date(),
): Omit<TriangleHealthSnapshot, 'id'> {
  if (request.expectedTeamRevision !== teamRevision) {
    throw new PeopleOrganizationPolicyError(
      'Triangle Team changed. Refresh before calculating health.',
    );
  }
  const dimensions = Object.keys(request.observations) as Array<
    keyof TriangleHealthSnapshotRequest['observations']
  >;
  const weightTotal = dimensions.reduce((sum, dimension) => sum + weights[dimension], 0);
  if (Math.abs(weightTotal - 1) > 0.000001) {
    throw new PeopleOrganizationPolicyError('Triangle health policy weights must add up to 1.');
  }
  const components = dimensions.map((dimension) => {
    const observedValue = request.observations[dimension];
    const threshold = thresholds[dimension];
    const normalizedScore = normalizeHealthComponent(
      observedValue,
      threshold,
      LOWER_IS_BETTER.has(dimension as 'TASK_RESPONSE_LATENCY' | 'PROCESS_RETURN_RATE'),
    );
    const weight = weights[dimension];
    return {
      dimension,
      observedValue,
      normalizedScore,
      weight,
      weightedScore: normalizedScore * weight,
    };
  });
  const score = components.reduce((sum, component) => sum + component.weightedScore, 0);
  return {
    teamId,
    teamRevision,
    policyVersion: request.policyVersion,
    score,
    rating: score >= 80 ? 'HEALTHY' : score >= 60 ? 'WATCH' : 'AT_RISK',
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    components,
    createdAt: now.toISOString(),
  };
}

function normalizeHealthComponent(
  observed: number,
  threshold: number,
  lowerIsBetter: boolean,
): number {
  if (!Number.isFinite(observed) || !Number.isFinite(threshold) || threshold < 0) {
    throw new PeopleOrganizationPolicyError(
      'Triangle health observations and thresholds must be finite and non-negative.',
    );
  }
  if (lowerIsBetter) {
    if (observed <= threshold) return 100;
    if (observed === 0) return 100;
    return Math.max(0, Math.min(100, (threshold / observed) * 100));
  }
  if (threshold === 0) return observed >= 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (observed / threshold) * 100));
}

export interface OrganizationChangeState {
  readonly status: 'PROPOSED' | 'ANALYZED' | 'CONFIRMED' | 'APPLIED' | 'REJECTED';
  readonly revision: number;
  readonly proposedByUserId: string;
  readonly confirmedByUserId: string | null;
  readonly coveredImpactAreas: ReadonlySet<string>;
  readonly hasCriticalImpact: boolean;
}

export function confirmOrganizationChange(
  state: OrganizationChangeState,
  actorUserId: string,
  expectedRevision: number,
): void {
  if (state.revision !== expectedRevision) {
    throw new PeopleOrganizationPolicyError(
      'Organization change changed. Refresh before confirming.',
    );
  }
  if (state.status !== 'ANALYZED') {
    throw new PeopleOrganizationPolicyError(
      'Organization change must have a complete impact report before confirmation.',
    );
  }
  if (state.proposedByUserId === actorUserId) {
    throw new PeopleOrganizationPolicyError(
      'Maker-checker requires a confirmer independent from the proposer.',
    );
  }
  const required = ['OBJECTIVE', 'PROCESS', 'PERMISSION', 'TASK', 'AGENT_ASSIGNMENT'];
  if (!required.every((area) => state.coveredImpactAreas.has(area))) {
    throw new PeopleOrganizationPolicyError(
      'Organization impact analysis must cover objectives, processes, permissions, tasks and Agent Assignments.',
    );
  }
}

export function assertOrganizationChangeCanApply(
  state: OrganizationChangeState,
  actorUserId: string,
  expectedRevision: number,
): void {
  if (state.revision !== expectedRevision || state.status !== 'CONFIRMED') {
    throw new PeopleOrganizationPolicyError(
      'Only the current confirmed organization change can be applied.',
    );
  }
  if (state.confirmedByUserId === null || state.confirmedByUserId === state.proposedByUserId) {
    throw new PeopleOrganizationPolicyError(
      'Organization change requires an independent recorded human confirmation.',
    );
  }
  if (state.hasCriticalImpact && actorUserId === state.confirmedByUserId) {
    throw new PeopleOrganizationPolicyError(
      'Critical organization changes require an applier independent from the confirmer.',
    );
  }
}
