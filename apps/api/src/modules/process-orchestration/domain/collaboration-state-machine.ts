import {
  isCollaborationTransitionAllowed,
  type Collaboration,
  type CollaborationMessage,
  type CollaborationStatus,
} from '@enterprise/contracts';

export interface CollaborationMessageValidation {
  readonly valid: boolean;
  readonly nextStatus: CollaborationStatus | null;
  readonly errors: readonly string[];
}

export interface TrustedCollaborationRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly orgUnitStatus: 'ACTIVE' | 'ARCHIVED';
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedCollaborationActor {
  readonly type: 'USER' | 'AGENT';
  readonly tenantId: string;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly roleAssignment: TrustedCollaborationRoleAssignment | null;
}

export interface TrustedCollaborationEvidence {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly contentHash: string;
  readonly active: boolean;
  readonly sealed: boolean;
  readonly visibleToActor: boolean;
}

export interface TrustedCollaborationDeliverable {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly taskId: string;
  readonly status: 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';
  readonly evidenceSealed: boolean;
  readonly evidenceRefs: readonly {
    readonly evidenceId: string;
    readonly version: number;
  }[];
}

export interface TrustedCollaborationAcceptance {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly taskId: string;
  readonly deliverableId: string;
  readonly deliverableVersion: number;
  readonly status: 'ACTIVE' | 'VOID';
  readonly decision: 'ACCEPTED' | 'REJECTED' | 'CHANGES_REQUESTED';
  readonly evidenceSealed: boolean;
  readonly evidenceRefs: readonly {
    readonly evidenceId: string;
    readonly version: number;
  }[];
}

export interface CollaborationMessageContext {
  readonly actor: TrustedCollaborationActor;
  readonly expectedCausationId: string | null;
  readonly resolvedDecisionRoleAssignmentIds: readonly string[];
  readonly currentDeliveredReference: {
    readonly deliverableId: string;
    readonly deliverableVersion: number;
  } | null;
  readonly deliverable: TrustedCollaborationDeliverable | null;
  readonly acceptance: TrustedCollaborationAcceptance | null;
  readonly evidence: readonly TrustedCollaborationEvidence[];
  readonly now: Date;
}

/**
 * Validates a protocol message against the authoritative collaboration row.
 * Identity, revision, trace and actor checks are deliberately separate from
 * the Zod wire schema so a structurally valid message cannot advance a
 * different tenant, task or collaboration.
 */
export function validateCollaborationMessage(
  collaboration: Collaboration,
  message: CollaborationMessage,
  context: CollaborationMessageContext,
): CollaborationMessageValidation {
  const errors: string[] = [];
  const nextStatus = nextStatusForMessage(message.type);

  if (message.tenantId !== collaboration.tenantId) {
    errors.push('The collaboration message tenant does not match.');
  }
  if (message.collaborationId !== collaboration.id) {
    errors.push('The collaboration message targets a different collaboration.');
  }
  if (message.correlationId !== collaboration.correlationId) {
    errors.push('The collaboration correlation ID does not match.');
  }
  if (
    message.objectiveId !== collaboration.objectiveId ||
    message.taskId !== collaboration.taskId
  ) {
    errors.push('The collaboration Objective and Task trace does not match.');
  }
  if (message.revision !== collaboration.revision + 1) {
    errors.push('The collaboration message revision is stale or out of sequence.');
  }
  if (
    !Number.isFinite(context.now.getTime()) ||
    Date.parse(message.occurredAt) < Date.parse(collaboration.updatedAt) ||
    Date.parse(message.occurredAt) > context.now.getTime()
  ) {
    errors.push('The collaboration message time is outside the authoritative timeline.');
  }
  if (message.causationId !== context.expectedCausationId) {
    errors.push('The collaboration message causation link is stale or incomplete.');
  }
  if (!sameStrings(message.permissionLabels, collaboration.permissionLabels)) {
    errors.push('The collaboration message permission labels do not match.');
  }

  if (message.type === 'REQUEST') {
    errors.push('REQUEST creates a collaboration and cannot mutate an existing collaboration.');
  } else if (!isCollaborationTransitionAllowed(collaboration.status, nextStatus)) {
    errors.push(`Message ${message.type} is not allowed from ${collaboration.status}.`);
  }

  validateActor(collaboration, message, context, errors);
  validateRecipients(collaboration, message, context, errors);
  validateReferences(collaboration, message, context, errors);

  return {
    valid: errors.length === 0,
    nextStatus: errors.length === 0 ? nextStatus : null,
    errors,
  };
}

function nextStatusForMessage(type: CollaborationMessage['type']): CollaborationStatus {
  switch (type) {
    case 'REQUEST':
      return 'REQUESTED';
    case 'COMMIT':
      return 'COMMITTED';
    case 'DELIVER':
      return 'DELIVERED';
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'REJECT':
      return 'REJECTED';
    case 'ESCALATE':
      return 'ESCALATED';
    case 'CANCEL':
      return 'CANCELLED';
  }
}

function validateActor(
  collaboration: Collaboration,
  message: CollaborationMessage,
  context: CollaborationMessageContext,
  errors: string[],
): void {
  const actor = context.actor;
  const assignment = actor.roleAssignment;
  if (
    assignment === null ||
    actor.tenantId !== collaboration.tenantId ||
    assignment.tenantId !== collaboration.tenantId ||
    assignment.id !== message.senderRoleAssignmentId ||
    !actorOwnsAssignment(actor, assignment) ||
    !assignmentIsUsable(assignment, context.now)
  ) {
    errors.push('The authenticated actor cannot use the claimed sender Role Assignment.');
    return;
  }
  const senderIsRequester =
    message.senderRoleAssignmentId === collaboration.requesterRoleAssignmentId;
  const senderIsRecipient = collaboration.recipientRoleAssignmentIds.includes(
    message.senderRoleAssignmentId,
  );

  switch (message.type) {
    case 'REQUEST':
    case 'CANCEL':
    case 'ACCEPT':
      if (!senderIsRequester) errors.push(`${message.type} must be sent by the requester.`);
      return;
    case 'COMMIT':
    case 'DELIVER':
      if (!senderIsRecipient) errors.push(`${message.type} must be sent by a recipient.`);
      return;
    case 'REJECT':
      if (
        (collaboration.status === 'REQUESTED' && !senderIsRecipient) ||
        (collaboration.status === 'DELIVERED' && !senderIsRequester) ||
        !['REQUESTED', 'DELIVERED'].includes(collaboration.status)
      ) {
        errors.push(
          'REJECT must be sent by a recipient for a request or by the requester for a delivery.',
        );
      }
      return;
    case 'ESCALATE':
      if (!senderIsRequester && !senderIsRecipient) {
        errors.push('ESCALATE must be sent by a collaboration participant.');
      }
  }
}

function validateRecipients(
  collaboration: Collaboration,
  message: CollaborationMessage,
  context: CollaborationMessageContext,
  errors: string[],
): void {
  const recipientSet = new Set(message.recipientRoleAssignmentIds);
  const participantSet = new Set([
    collaboration.requesterRoleAssignmentId,
    ...collaboration.recipientRoleAssignmentIds,
  ]);

  if (message.type === 'ESCALATE') {
    const resolvedRecipients = uniqueStrings(context.resolvedDecisionRoleAssignmentIds);
    if (
      resolvedRecipients.length === 0 ||
      !sameStrings([...recipientSet], resolvedRecipients) ||
      !resolvedRecipients.includes(message.payload.decisionRoleAssignmentId)
    ) {
      errors.push('ESCALATE recipients must exactly match the trusted decision-role resolution.');
    }
    if (resolvedRecipients.some((recipientId) => participantSet.has(recipientId))) {
      errors.push('ESCALATE decision roles must be independent of the collaboration participants.');
    }
    return;
  }

  if ([...recipientSet].some((recipientId) => !participantSet.has(recipientId))) {
    errors.push('A non-escalation message may address only collaboration participants.');
  }

  const senderIsRequester =
    message.senderRoleAssignmentId === collaboration.requesterRoleAssignmentId;
  if (
    senderIsRequester &&
    !collaboration.recipientRoleAssignmentIds.some((recipientId) => recipientSet.has(recipientId))
  ) {
    errors.push('A requester message must address at least one collaboration recipient.');
  }
  if (!senderIsRequester && !recipientSet.has(collaboration.requesterRoleAssignmentId)) {
    errors.push('A recipient message must address the collaboration requester.');
  }
}

function validateReferences(
  collaboration: Collaboration,
  message: CollaborationMessage,
  context: CollaborationMessageContext,
  errors: string[],
): void {
  if (message.type === 'DELIVER') {
    const deliverable = context.deliverable;
    if (
      deliverable === null ||
      deliverable.id !== message.payload.deliverableId ||
      deliverable.version !== message.payload.deliverableVersion ||
      deliverable.tenantId !== collaboration.tenantId ||
      deliverable.taskId !== collaboration.taskId ||
      deliverable.status !== 'SUBMITTED' ||
      !deliverable.evidenceSealed ||
      !sameEvidenceIdentities(deliverable.evidenceRefs, message.payload.evidenceRefs) ||
      !evidenceReferencesAreTrusted(
        collaboration.tenantId,
        message.payload.evidenceRefs,
        context.evidence,
      )
    ) {
      errors.push('DELIVER must reference the trusted submitted Deliverable and sealed Evidence.');
    }
    return;
  }

  if (message.type === 'ACCEPT' || message.type === 'REJECT') {
    if (message.type === 'REJECT' && collaboration.status === 'REQUESTED') return;
    const acceptanceId = message.payload.acceptanceId;
    const acceptanceVersion = message.payload.acceptanceVersion;
    const acceptance = context.acceptance;
    const delivered = context.currentDeliveredReference;
    const expectedDecision = message.type === 'ACCEPT' ? 'ACCEPTED' : undefined;
    if (
      acceptanceId === null ||
      acceptanceVersion === null ||
      acceptance === null ||
      delivered === null ||
      acceptance.id !== acceptanceId ||
      acceptance.version !== acceptanceVersion ||
      acceptance.tenantId !== collaboration.tenantId ||
      acceptance.taskId !== collaboration.taskId ||
      acceptance.deliverableId !== delivered.deliverableId ||
      acceptance.deliverableVersion !== delivered.deliverableVersion ||
      acceptance.status !== 'ACTIVE' ||
      (expectedDecision === 'ACCEPTED'
        ? acceptance.decision !== expectedDecision
        : !['REJECTED', 'CHANGES_REQUESTED'].includes(acceptance.decision)) ||
      !acceptance.evidenceSealed ||
      acceptance.evidenceRefs.length === 0 ||
      !evidenceReferencesAreTrusted(
        collaboration.tenantId,
        acceptance.evidenceRefs.map((reference) => ({
          evidenceId: reference.evidenceId,
          version: reference.version,
          contentHash:
            context.evidence.find(
              (evidence) =>
                evidence.id === reference.evidenceId && evidence.version === reference.version,
            )?.contentHash ?? null,
        })),
        context.evidence,
      )
    ) {
      errors.push('The decision must reference the trusted Acceptance for the delivered artifact.');
    }
    return;
  }

  if (
    message.type === 'ESCALATE' &&
    !evidenceReferencesAreTrusted(
      collaboration.tenantId,
      message.payload.evidenceRefs,
      context.evidence,
    )
  ) {
    errors.push('ESCALATE must use visible, active, sealed Evidence references.');
  }
}

function actorOwnsAssignment(
  actor: TrustedCollaborationActor,
  assignment: TrustedCollaborationRoleAssignment,
): boolean {
  return actor.type === 'USER'
    ? actor.userId !== null && actor.userId === assignment.userId
    : actor.agentId !== null && actor.agentId === assignment.agentId;
}

function assignmentIsUsable(assignment: TrustedCollaborationRoleAssignment, now: Date): boolean {
  const start = time(assignment.effectiveFrom);
  const end = time(assignment.effectiveTo);
  return (
    assignment.status === 'ACTIVE' &&
    assignment.employmentStatus === 'ACTIVE' &&
    assignment.orgUnitStatus === 'ACTIVE' &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    start !== null &&
    start <= now.getTime() &&
    (assignment.effectiveTo === null || (end !== null && end > now.getTime()))
  );
}

function evidenceReferencesAreTrusted(
  tenantId: string,
  references: readonly {
    readonly evidenceId: string;
    readonly version: number;
    readonly contentHash: string | null;
  }[],
  evidence: readonly TrustedCollaborationEvidence[],
): boolean {
  if (references.length === 0) return false;
  return references.every((reference) => {
    const trusted = evidence.find(
      (candidate) =>
        candidate.id === reference.evidenceId && candidate.version === reference.version,
    );
    return (
      trusted !== undefined &&
      trusted.tenantId === tenantId &&
      trusted.active &&
      trusted.sealed &&
      trusted.visibleToActor &&
      reference.contentHash !== null &&
      reference.contentHash === trusted.contentHash
    );
  });
}

function sameEvidenceIdentities(
  left: readonly { readonly evidenceId: string; readonly version: number }[],
  right: readonly { readonly evidenceId: string; readonly version: number }[],
): boolean {
  const key = (value: { readonly evidenceId: string; readonly version: number }) =>
    `${value.evidenceId}:${value.version}`;
  return sameStrings(left.map(key), right.map(key));
}

function time(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}
