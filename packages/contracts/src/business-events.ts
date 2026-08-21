import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const POSITIVE_INT = z.number().int().positive();
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const JSON_OBJECT = z.record(z.string(), z.unknown());

export const businessEventTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/);

export const eventDataLabelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/);

const uniqueUuidArray = z.array(UUID).max(500).refine(uniqueStrings, 'IDs must be unique.');
const uniqueDataLabels = z
  .array(eventDataLabelSchema)
  .max(100)
  .refine(uniqueStrings, 'Data labels must be unique.');

export const businessEventSubjectTypeSchema = z.enum([
  'EMPLOYEE',
  'ROLE_ASSIGNMENT',
  'VALUE',
  'STRATEGY',
  'OBJECTIVE',
  'TASK',
  'PROCESS_DEFINITION',
  'PROCESS_INSTANCE',
  'COLLABORATION',
  'CORRECTION',
  'CUSTOMER',
  'METRIC',
]);

export const businessEventSubjectSchema = z
  .object({
    type: businessEventSubjectTypeSchema,
    id: UUID,
    version: POSITIVE_INT.nullable().default(null),
  })
  .strict();

export const businessEventOrganizationScopeSchema = z
  .object({
    orgUnitIds: uniqueUuidArray.default([]),
    projectIds: uniqueUuidArray.default([]),
    customerIds: uniqueUuidArray.default([]),
    dataLabels: uniqueDataLabels.default([]),
  })
  .strict();

export const businessEventSensitivitySchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'SENSITIVE',
  'CONFIDENTIAL',
]);

export const businessEventRetentionSchema = z
  .object({
    retainUntil: TIMESTAMP,
    action: z.enum(['DELETE', 'ANONYMIZE', 'ARCHIVE']),
    legalHold: z.boolean().default(false),
  })
  .strict();

export const businessEventSourceSchema = z
  .object({
    system: z.string().trim().min(1).max(100),
    recordId: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(200),
    producer: z.string().trim().min(1).max(160),
  })
  .strict();

export const businessEvidenceReferenceSchema = z
  .object({
    evidenceId: UUID,
    version: POSITIVE_INT,
    contentHash: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
  })
  .strict();

export const businessEventEnvelopeSchema = z
  .object({
    eventId: UUID,
    tenantId: UUID,
    eventType: businessEventTypeSchema,
    schemaVersion: POSITIVE_INT,
    aggregate: businessEventSubjectSchema,
    subject: businessEventSubjectSchema,
    occurredAt: TIMESTAMP,
    producedAt: TIMESTAMP,
    organizationScope: businessEventOrganizationScopeSchema,
    payload: JSON_OBJECT.refine((value) => Object.keys(value).length > 0, {
      message: 'Business event payload must not be empty.',
    }),
    correlationId: UUID,
    causationId: UUID.nullable(),
    idempotencyKey: z.string().trim().min(1).max(200),
    sensitivity: businessEventSensitivitySchema,
    retention: businessEventRetentionSchema,
    source: businessEventSourceSchema,
    evidenceRefs: z
      .array(businessEvidenceReferenceSchema)
      .max(500)
      .refine(
        (items) => uniqueStrings(items.map((item) => `${item.evidenceId}:${item.version}`)),
        'Evidence references must be unique.',
      ),
  })
  .strict()
  .refine((event) => Date.parse(event.producedAt) >= Date.parse(event.occurredAt), {
    message: 'producedAt cannot precede occurredAt.',
    path: ['producedAt'],
  })
  .refine((event) => event.causationId !== event.eventId, {
    message: 'An event cannot cause itself.',
    path: ['causationId'],
  })
  .refine((event) => Date.parse(event.retention.retainUntil) > Date.parse(event.producedAt), {
    message: 'retainUntil must be later than producedAt.',
    path: ['retention', 'retainUntil'],
  });

export const collaborationStatusSchema = z.enum([
  'REQUESTED',
  'COMMITTED',
  'DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'ESCALATED',
  'CANCELLED',
]);

export const collaborationSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    correlationId: UUID,
    objectiveId: UUID,
    taskId: UUID,
    requesterRoleAssignmentId: UUID,
    recipientRoleAssignmentIds: uniqueUuidArray.min(1),
    status: collaborationStatusSchema,
    revision: POSITIVE_INT,
    commonGoal: LONG_TEXT,
    requestedInput: LONG_TEXT,
    expectedOutputSchema: JSON_OBJECT.refine((value) => Object.keys(value).length > 0, {
      message: 'Expected output JSON Schema must not be empty.',
    }),
    dueAt: TIMESTAMP,
    permissionLabels: uniqueDataLabels,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (collaboration) =>
      !collaboration.recipientRoleAssignmentIds.includes(collaboration.requesterRoleAssignmentId),
    {
      message: 'A collaboration requester cannot also be a recipient.',
      path: ['recipientRoleAssignmentIds'],
    },
  )
  .refine(
    (collaboration) => Date.parse(collaboration.updatedAt) >= Date.parse(collaboration.createdAt),
    {
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    },
  )
  .refine(
    (collaboration) => Date.parse(collaboration.dueAt) > Date.parse(collaboration.createdAt),
    {
      message: 'dueAt must be later than createdAt.',
      path: ['dueAt'],
    },
  );

const collaborationMessageBaseShape = {
  id: UUID,
  tenantId: UUID,
  collaborationId: UUID,
  schemaVersion: POSITIVE_INT,
  revision: POSITIVE_INT,
  correlationId: UUID,
  causationId: UUID.nullable(),
  senderRoleAssignmentId: UUID,
  recipientRoleAssignmentIds: uniqueUuidArray.min(1),
  objectiveId: UUID,
  taskId: UUID,
  permissionLabels: uniqueDataLabels,
  occurredAt: TIMESTAMP,
  idempotencyKey: z.string().trim().min(1).max(200),
} as const;

const collaborationRequestMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('REQUEST'),
    payload: z
      .object({
        background: LONG_TEXT,
        commonGoal: LONG_TEXT,
        requestedInput: LONG_TEXT,
        dueAt: TIMESTAMP,
        expectedOutputSchema: JSON_OBJECT.refine((value) => Object.keys(value).length > 0, {
          message: 'Expected output JSON Schema must not be empty.',
        }),
        contextRefs: z.array(businessEventSubjectSchema).max(500),
      })
      .strict(),
  })
  .strict();

const collaborationCommitMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('COMMIT'),
    payload: z
      .object({
        committedDueAt: TIMESTAMP,
        outputSchema: JSON_OBJECT.refine((value) => Object.keys(value).length > 0, {
          message: 'Committed output JSON Schema must not be empty.',
        }),
        conditions: z.array(SHORT_TEXT).max(100),
      })
      .strict(),
  })
  .strict();

const collaborationDeliverMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('DELIVER'),
    payload: z
      .object({
        deliverableId: UUID,
        deliverableVersion: POSITIVE_INT,
        evidenceRefs: z.array(businessEvidenceReferenceSchema).min(1).max(500),
        summary: LONG_TEXT,
      })
      .strict(),
  })
  .strict();

const collaborationAcceptMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('ACCEPT'),
    payload: z
      .object({
        acceptanceId: UUID,
        acceptanceVersion: POSITIVE_INT,
        comment: LONG_TEXT,
      })
      .strict(),
  })
  .strict();

const collaborationRejectMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('REJECT'),
    payload: z
      .object({
        acceptanceId: UUID.nullable(),
        acceptanceVersion: POSITIVE_INT.nullable(),
        nonConformities: z.array(LONG_TEXT).min(1).max(100),
        requiredChanges: z.array(LONG_TEXT).min(1).max(100),
      })
      .strict()
      .refine(
        (payload) => (payload.acceptanceId === null) === (payload.acceptanceVersion === null),
        {
          message: 'Acceptance ID and version must be supplied together.',
          path: ['acceptanceVersion'],
        },
      ),
  })
  .strict();

const collaborationEscalateMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('ESCALATE'),
    payload: z
      .object({
        decisionRoleAssignmentId: UUID,
        reason: z.enum(['CONFLICT', 'TIMEOUT', 'PERMISSION', 'RESOURCE', 'QUALITY', 'OTHER']),
        impact: LONG_TEXT,
        requestedDecision: LONG_TEXT,
        evidenceRefs: z.array(businessEvidenceReferenceSchema).min(1).max(500),
      })
      .strict(),
  })
  .strict();

const collaborationCancelMessageSchema = z
  .object({
    ...collaborationMessageBaseShape,
    type: z.literal('CANCEL'),
    payload: z
      .object({
        reason: LONG_TEXT,
        impact: LONG_TEXT,
        compensationActions: z.array(LONG_TEXT).max(100),
      })
      .strict(),
  })
  .strict();

export const collaborationMessageSchema = z
  .discriminatedUnion('type', [
    collaborationRequestMessageSchema,
    collaborationCommitMessageSchema,
    collaborationDeliverMessageSchema,
    collaborationAcceptMessageSchema,
    collaborationRejectMessageSchema,
    collaborationEscalateMessageSchema,
    collaborationCancelMessageSchema,
  ])
  .superRefine((message, context) => {
    if (message.causationId === message.id) {
      context.addIssue({
        code: 'custom',
        message: 'A collaboration message cannot cause itself.',
        path: ['causationId'],
      });
    }
    if (message.recipientRoleAssignmentIds.includes(message.senderRoleAssignmentId)) {
      context.addIssue({
        code: 'custom',
        message: 'The sender cannot also be a recipient.',
        path: ['recipientRoleAssignmentIds'],
      });
    }
  });

export const collaborationCandidateSchema = z
  .object({
    roleAssignmentId: UUID,
    userId: UUID,
    userName: z.string().trim().min(1).max(200),
    roleName: z.string().trim().min(1).max(200),
    orgUnitName: z.string().trim().min(1).max(200),
    canActAsRequester: z.boolean(),
  })
  .strict();

export const collaborationCandidateListSchema = z
  .object({
    items: z.array(collaborationCandidateSchema).max(500),
  })
  .strict();

export const createCollaborationRequestSchema = z
  .object({
    actingRoleAssignmentId: UUID.optional(),
    recipientRoleAssignmentIds: uniqueUuidArray.min(1),
    background: LONG_TEXT,
    commonGoal: LONG_TEXT,
    requestedInput: LONG_TEXT,
    expectedOutputSchema: JSON_OBJECT.refine((value) => Object.keys(value).length > 0, {
      message: 'Expected output JSON Schema must not be empty.',
    }),
    dueAt: TIMESTAMP,
    contextRefs: z.array(businessEventSubjectSchema).max(500),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    (request) =>
      request.actingRoleAssignmentId === undefined ||
      !request.recipientRoleAssignmentIds.includes(request.actingRoleAssignmentId),
    {
      message: 'The acting Role Assignment cannot also be a recipient.',
      path: ['recipientRoleAssignmentIds'],
    },
  );

const collaborationCommandBaseShape = {
  expectedRevision: POSITIVE_INT,
  idempotencyKey: z.string().trim().min(1).max(200),
} as const;

export const collaborationCommandRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('COMMIT'),
      payload: collaborationCommitMessageSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('DELIVER'),
      payload: collaborationDeliverMessageSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('ACCEPT'),
      payload: collaborationAcceptMessageSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('REJECT'),
      payload: collaborationRejectMessageSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('ESCALATE'),
      payload: collaborationEscalateMessageSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      ...collaborationCommandBaseShape,
      type: z.literal('CANCEL'),
      payload: collaborationCancelMessageSchema.shape.payload,
    })
    .strict(),
]);

export const correctionSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const correctionStatusSchema = z.enum([
  'OPEN',
  'ACKNOWLEDGED',
  'ACCEPTED',
  'REJECTED',
  'EXPLAINED',
  'ESCALATED',
  'RESOLVED',
  'CANCELLED',
]);

export const correctionCaseSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    correlationId: UUID,
    subject: businessEventSubjectSchema,
    roleAssignmentId: UUID,
    objectiveId: UUID,
    taskId: UUID,
    processInstanceId: UUID.nullable(),
    trigger: LONG_TEXT,
    category: z.enum([
      'HARD_CONSTRAINT',
      'THRESHOLD_ANOMALY',
      'OBJECTIVE_DEVIATION',
      'VALUE_CONFLICT',
      'COLLABORATION_RISK',
      'CAPABILITY_RISK',
    ]),
    severity: correctionSeveritySchema,
    confidence: z.number().finite().min(0).max(1),
    ruleFindings: z.array(LONG_TEXT).min(1).max(200),
    modelFinding: LONG_TEXT.nullable(),
    evidenceRefs: z.array(businessEvidenceReferenceSchema).min(1).max(500),
    impact: LONG_TEXT,
    suggestedActions: z.array(LONG_TEXT).min(1).max(100),
    requiredRoleAssignmentIds: uniqueUuidArray,
    status: correctionStatusSchema,
    revision: POSITIVE_INT,
    permissionLabels: uniqueDataLabels,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .refine((correction) => Date.parse(correction.updatedAt) >= Date.parse(correction.createdAt), {
    message: 'updatedAt cannot precede createdAt.',
    path: ['updatedAt'],
  });

const collaborationTransitions = {
  REQUESTED: new Set(['COMMITTED', 'REJECTED', 'ESCALATED', 'CANCELLED']),
  COMMITTED: new Set(['DELIVERED', 'ESCALATED', 'CANCELLED']),
  DELIVERED: new Set(['ACCEPTED', 'REJECTED', 'ESCALATED', 'CANCELLED']),
  REJECTED: new Set(['COMMITTED', 'DELIVERED', 'ESCALATED', 'CANCELLED']),
  ACCEPTED: new Set<string>(),
  ESCALATED: new Set<string>(),
  CANCELLED: new Set<string>(),
} satisfies Record<z.infer<typeof collaborationStatusSchema>, ReadonlySet<string>>;

const correctionTransitions = {
  OPEN: new Set(['ACKNOWLEDGED', 'ACCEPTED', 'REJECTED', 'EXPLAINED', 'ESCALATED', 'CANCELLED']),
  ACKNOWLEDGED: new Set([
    'ACCEPTED',
    'REJECTED',
    'EXPLAINED',
    'ESCALATED',
    'RESOLVED',
    'CANCELLED',
  ]),
  ACCEPTED: new Set(['RESOLVED', 'ESCALATED']),
  REJECTED: new Set(['ESCALATED', 'CANCELLED']),
  EXPLAINED: new Set(['ACCEPTED', 'REJECTED', 'ESCALATED', 'RESOLVED']),
  ESCALATED: new Set(['ACCEPTED', 'REJECTED', 'RESOLVED', 'CANCELLED']),
  RESOLVED: new Set<string>(),
  CANCELLED: new Set<string>(),
} satisfies Record<z.infer<typeof correctionStatusSchema>, ReadonlySet<string>>;

export function isCollaborationTransitionAllowed(
  from: z.infer<typeof collaborationStatusSchema>,
  to: z.infer<typeof collaborationStatusSchema>,
): boolean {
  return collaborationTransitions[from].has(to);
}

export function isCorrectionTransitionAllowed(
  from: z.infer<typeof correctionStatusSchema>,
  to: z.infer<typeof correctionStatusSchema>,
): boolean {
  return correctionTransitions[from].has(to);
}

export type BusinessEventEnvelope = z.infer<typeof businessEventEnvelopeSchema>;
export type BusinessEventSubject = z.infer<typeof businessEventSubjectSchema>;
export type BusinessEventOrganizationScope = z.infer<typeof businessEventOrganizationScopeSchema>;
export type Collaboration = z.infer<typeof collaborationSchema>;
export type CollaborationStatus = z.infer<typeof collaborationStatusSchema>;
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;
export type CollaborationCandidate = z.infer<typeof collaborationCandidateSchema>;
export type CollaborationCandidateList = z.infer<typeof collaborationCandidateListSchema>;
export type CreateCollaborationRequest = z.infer<typeof createCollaborationRequestSchema>;
export type CollaborationCommandRequest = z.infer<typeof collaborationCommandRequestSchema>;
export type CorrectionCase = z.infer<typeof correctionCaseSchema>;

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
