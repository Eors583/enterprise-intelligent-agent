import { z } from 'zod';

const UUID = z.string().uuid();
const CODE = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const NAME = z.string().trim().min(1).max(200);
const TEXT = z.string().trim().min(1).max(10_000);
const REVISION = z.number().int().positive();
const ISO_DATE_TIME = z.string().datetime({ offset: true });
const IDEMPOTENCY_KEY = z.string().trim().min(8).max(200);

export const competencyCategorySchema = z.enum([
  'KNOWLEDGE',
  'SKILL',
  'EXPERIENCE',
  'BEHAVIOR',
  'TOOL',
]);
export const competencyDefinitionStatusSchema = z.enum(['ACTIVE', 'RETIRED']);
export const competencyVersionStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);
export const competencyAssessmentStatusSchema = z.enum([
  'CANDIDATE',
  'UNDER_REVIEW',
  'EFFECTIVE',
  'REJECTED',
  'DISPUTED',
  'SUPERSEDED',
]);
export const competencyConfirmationRoleSchema = z.enum(['EMPLOYEE', 'MANAGER', 'HR']);
export const competencyConfirmationDecisionSchema = z.enum([
  'CONFIRM',
  'REJECT',
  'REQUEST_MORE_EVIDENCE',
]);
export const competencyAttributionFactorSchema = z.enum([
  'GOAL_REASONABLENESS',
  'RESOURCE',
  'PERMISSION',
  'PROCESS',
  'UPSTREAM_DOWNSTREAM',
  'MARKET_CHANGE',
  'CAPABILITY',
]);
export const competencyAppealStatusSchema = z.enum([
  'OPEN',
  'UNDER_REVIEW',
  'UPHELD',
  'OVERTURNED',
  'CLOSED',
]);
export const developmentPlanStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']);
export const developmentActionTypeSchema = z.enum([
  'PRACTICE_TASK',
  'COURSE',
  'MENTORING',
  'SHADOWING',
  'ASSESSMENT',
]);

export const competencyBehaviorAnchorSchema = z.object({
  id: UUID,
  ordinal: z.number().int().nonnegative(),
  statement: TEXT,
});

export const competencyLevelSchema = z.object({
  id: UUID,
  level: z.number().int().min(1).max(10),
  name: NAME,
  taskComplexity: TEXT,
  evidenceRequirements: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  behaviorAnchors: z.array(competencyBehaviorAnchorSchema).min(1).max(100),
});

export const roleCompetencyRequirementSchema = z.object({
  id: UUID,
  roleTemplateId: UUID,
  roleVersionId: UUID,
  requiredLevel: z.number().int().min(1).max(10),
  context: z.string().trim().max(4000),
});

export const competencyDefinitionSchema = z.object({
  id: UUID,
  code: CODE,
  name: NAME,
  category: competencyCategorySchema,
  description: TEXT,
  status: competencyDefinitionStatusSchema,
  revision: REVISION,
  currentVersionId: UUID.nullable(),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const competencyVersionSchema = z.object({
  id: UUID,
  competencyDefinitionId: UUID,
  version: z.number().int().positive(),
  status: competencyVersionStatusSchema,
  changeSummary: TEXT,
  revision: REVISION,
  createdByUserId: UUID,
  activatedByUserId: UUID.nullable(),
  activatedAt: ISO_DATE_TIME.nullable(),
  levels: z.array(competencyLevelSchema),
  roleRequirements: z.array(roleCompetencyRequirementSchema),
  createdAt: ISO_DATE_TIME,
});

export const createCompetencyDefinitionRequestSchema = z.object({
  code: CODE.optional(),
  name: NAME,
  category: competencyCategorySchema,
  description: TEXT,
  idempotencyKey: IDEMPOTENCY_KEY,
});

const createCompetencyLevelSchema = z.object({
  level: z.number().int().min(1).max(10),
  name: NAME,
  taskComplexity: TEXT,
  evidenceRequirements: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  behaviorAnchors: z.array(TEXT).min(1).max(100),
});

export const createCompetencyVersionRequestSchema = z
  .object({
    expectedDefinitionRevision: REVISION,
    changeSummary: TEXT,
    levels: z.array(createCompetencyLevelSchema).min(1).max(10),
    roleRequirements: z
      .array(
        z.object({
          roleTemplateId: UUID,
          roleVersionId: UUID,
          requiredLevel: z.number().int().min(1).max(10),
          context: z.string().trim().max(4000).default(''),
        }),
      )
      .min(1)
      .max(500),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((value, context) => {
    const levels = value.levels.map((item) => item.level);
    if (new Set(levels).size !== levels.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['levels'],
        message: 'Competency levels must be unique within a version.',
      });
    }
    const configured = new Set(levels);
    value.roleRequirements.forEach((item, index) => {
      if (!configured.has(item.requiredLevel)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roleRequirements', index, 'requiredLevel'],
          message: 'Role requirement must reference a level defined in this version.',
        });
      }
    });
  });

export const activateCompetencyVersionRequestSchema = z.object({
  expectedRevision: REVISION,
  comment: z.string().trim().min(3).max(1000),
});

export const competencyEvidenceSchema = z.object({
  id: UUID,
  subjectUserId: UUID,
  competencyVersionId: UUID,
  demonstratedLevel: z.number().int().min(1).max(10),
  evidenceId: UUID,
  evidenceVersion: z.number().int().positive(),
  taskId: UUID.nullable(),
  taskVersion: z.number().int().positive().nullable(),
  deliverableId: UUID.nullable(),
  deliverableVersion: z.number().int().positive().nullable(),
  metricObservationId: UUID.nullable(),
  metricObservationVersion: z.number().int().positive().nullable(),
  reviewReference: z.string().nullable(),
  validFrom: ISO_DATE_TIME,
  validUntil: ISO_DATE_TIME.nullable(),
  createdAt: ISO_DATE_TIME,
});

export const createCompetencyEvidenceRequestSchema = z
  .object({
    subjectUserId: UUID,
    competencyVersionId: UUID,
    demonstratedLevel: z.number().int().min(1).max(10),
    evidenceId: UUID,
    evidenceVersion: z.number().int().positive(),
    taskId: UUID.nullable().default(null),
    taskVersion: z.number().int().positive().nullable().default(null),
    deliverableId: UUID.nullable().default(null),
    deliverableVersion: z.number().int().positive().nullable().default(null),
    metricObservationId: UUID.nullable().default(null),
    metricObservationVersion: z.number().int().positive().nullable().default(null),
    reviewReference: z.string().trim().min(1).max(500).nullable().default(null),
    validFrom: ISO_DATE_TIME,
    validUntil: ISO_DATE_TIME.nullable().default(null),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((value, context) => {
    const paired = [
      [value.taskId, value.taskVersion, 'taskVersion'],
      [value.deliverableId, value.deliverableVersion, 'deliverableVersion'],
      [value.metricObservationId, value.metricObservationVersion, 'metricObservationVersion'],
    ] as const;
    for (const [id, version, path] of paired) {
      if ((id === null) !== (version === null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: 'Governed object identity and version must be supplied together.',
        });
      }
    }
    if (
      value.taskId === null &&
      value.deliverableId === null &&
      value.metricObservationId === null &&
      value.reviewReference === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceId'],
        message: 'Competency Evidence must be traceable to a task, output, metric or review.',
      });
    }
    if (value.validUntil !== null && new Date(value.validUntil) <= new Date(value.validFrom)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'Evidence expiry must be later than its validity start.',
      });
    }
  });

export const competencyAssessmentAttributionSchema = z.object({
  factor: competencyAttributionFactorSchema,
  contribution: z.number().min(0).max(1),
  statement: TEXT,
  evidenceIds: z.array(UUID).min(1).max(100),
});

export const competencyAssessmentSchema = z.object({
  id: UUID,
  subjectUserId: UUID,
  competencyVersionId: UUID,
  proposedLevel: z.number().int().min(1).max(10),
  effectiveLevel: z.number().int().min(1).max(10).nullable(),
  confidence: z.number().min(0).max(1),
  status: competencyAssessmentStatusSchema,
  agentRunId: UUID,
  supersedesAssessmentId: UUID.nullable(),
  summary: TEXT,
  attribution: z.array(competencyAssessmentAttributionSchema).min(1),
  requiredConfirmationRoles: z.array(competencyConfirmationRoleSchema).min(1),
  confirmedRoles: z.array(competencyConfirmationRoleSchema),
  revision: REVISION,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const createCompetencyAssessmentRequestSchema = z
  .object({
    subjectUserId: UUID,
    competencyVersionId: UUID,
    proposedLevel: z.number().int().min(1).max(10),
    confidence: z.number().min(0).max(1),
    agentRunId: UUID,
    supersedesAssessmentId: UUID.nullable().default(null),
    expectedSupersededRevision: REVISION.nullable().default(null),
    summary: TEXT,
    attribution: z.array(competencyAssessmentAttributionSchema).min(1).max(20),
    requiredConfirmationRoles: z
      .array(competencyConfirmationRoleSchema)
      .min(1)
      .default(['EMPLOYEE', 'MANAGER', 'HR']),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((value, context) => {
    if ((value.supersedesAssessmentId === null) !== (value.expectedSupersededRevision === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedSupersededRevision'],
        message: 'Reassessment identity and expected revision must be supplied together.',
      });
    }
    if (new Set(value.requiredConfirmationRoles).size !== value.requiredConfirmationRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredConfirmationRoles'],
        message: 'Required human confirmation roles must be unique.',
      });
    }
    if (!value.attribution.some((item) => item.factor === 'CAPABILITY')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribution'],
        message: 'The AI candidate must state the capability contribution separately.',
      });
    }
    const contextual = value.attribution.filter((item) => item.factor !== 'CAPABILITY');
    if (contextual.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribution'],
        message: 'Resource, process or other contextual attribution must be assessed first.',
      });
    }
  });

export const confirmCompetencyAssessmentRequestSchema = z.object({
  role: competencyConfirmationRoleSchema,
  decision: competencyConfirmationDecisionSchema,
  expectedRevision: REVISION,
  comment: z.string().trim().min(3).max(2000),
  idempotencyKey: IDEMPOTENCY_KEY,
});

export const createCompetencyAppealRequestSchema = z.object({
  expectedAssessmentRevision: REVISION,
  reason: TEXT,
  supplementalEvidenceIds: z.array(UUID).max(100).default([]),
  idempotencyKey: IDEMPOTENCY_KEY,
});

export const competencyAppealSchema = z.object({
  id: UUID,
  assessmentId: UUID,
  subjectUserId: UUID,
  status: competencyAppealStatusSchema,
  reason: TEXT,
  resolution: z.string().nullable(),
  revision: REVISION,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const transitionCompetencyAppealRequestSchema = z.object({
  action: z.enum(['START_REVIEW', 'UPHOLD', 'OVERTURN', 'CLOSE']),
  expectedRevision: REVISION,
  resolution: TEXT,
});

export const competencyGapSchema = z.object({
  id: UUID,
  assessmentId: UUID,
  roleRequirementId: UUID,
  requiredLevel: z.number().int().min(1).max(10),
  effectiveLevel: z.number().int().min(1).max(10),
  gap: z.number().int().min(0).max(9),
  attributionSummary: TEXT,
  version: z.number().int().positive(),
  createdAt: ISO_DATE_TIME,
});

export const developmentActionSchema = z.object({
  id: UUID,
  type: developmentActionTypeSchema,
  title: NAME,
  description: TEXT,
  linkedTaskId: UUID.nullable(),
  linkedTaskVersion: z.number().int().positive().nullable(),
  mentorUserId: UUID.nullable(),
  dueAt: ISO_DATE_TIME,
  verificationMethod: TEXT,
  verificationEvidenceId: UUID.nullable(),
  verificationEvidenceVersion: z.number().int().positive().nullable(),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']),
  revision: REVISION,
});

export const developmentPlanSchema = z.object({
  id: UUID,
  subjectUserId: UUID,
  assessmentId: UUID,
  gapId: UUID,
  status: developmentPlanStatusSchema,
  version: z.number().int().positive(),
  revision: REVISION,
  actions: z.array(developmentActionSchema),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const createDevelopmentPlanRequestSchema = z
  .object({
    assessmentId: UUID,
    gapId: UUID,
    expectedAssessmentRevision: REVISION,
    actions: z
      .array(
        z.object({
          type: developmentActionTypeSchema,
          title: NAME,
          description: TEXT,
          linkedTaskId: UUID.nullable().default(null),
          linkedTaskVersion: z.number().int().positive().nullable().default(null),
          mentorUserId: UUID.nullable().default(null),
          dueAt: ISO_DATE_TIME,
          verificationMethod: TEXT,
        }),
      )
      .min(1)
      .max(100),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((value, context) => {
    value.actions.forEach((action, index) => {
      if ((action.linkedTaskId === null) !== (action.linkedTaskVersion === null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'linkedTaskVersion'],
          message: 'Practice Task identity and version must be supplied together.',
        });
      }
    });
  });

export const transitionDevelopmentActionRequestSchema = z
  .object({
    action: z.enum(['START', 'COMPLETE', 'CANCEL']),
    expectedRevision: REVISION,
    verificationEvidenceId: UUID.nullable().default(null),
    verificationEvidenceVersion: z.number().int().positive().nullable().default(null),
    comment: z.string().trim().min(3).max(2000),
  })
  .superRefine((value, context) => {
    if ((value.verificationEvidenceId === null) !== (value.verificationEvidenceVersion === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationEvidenceVersion'],
        message: 'Verification Evidence id and version must be supplied together.',
      });
    }
    if (value.action === 'COMPLETE' && value.verificationEvidenceId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationEvidenceId'],
        message: 'Completing a development action requires governed verification Evidence.',
      });
    }
  });

export const triangleResponsibilitySchema = z.enum(['CUSTOMER', 'SOLUTION', 'DELIVERY']);
export const triangleTeamStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);
export const triangleHealthDimensionSchema = z.enum([
  'TASK_RESPONSE_LATENCY',
  'INPUT_OUTPUT_COMPLETENESS',
  'PROCESS_RETURN_RATE',
  'COMMITMENT_FULFILLMENT',
  'CUSTOMER_CLOSURE',
  'SHARED_OBJECTIVE_RESULT',
]);

export const triangleTeamSchema = z.object({
  id: UUID,
  code: CODE,
  name: NAME,
  status: triangleTeamStatusSchema,
  objectiveId: UUID,
  objectiveVersion: z.number().int().positive(),
  customerRoleAssignmentId: UUID,
  solutionRoleAssignmentId: UUID,
  deliveryRoleAssignmentId: UUID,
  arbiterRoleAssignmentId: UUID,
  metricDefinitionIds: z.array(UUID).min(1),
  healthPolicyVersion: z.number().int().positive(),
  revision: REVISION,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const createTriangleTeamRequestSchema = z
  .object({
    code: CODE.optional(),
    name: NAME,
    objectiveId: UUID,
    objectiveVersion: z.number().int().positive(),
    customerRoleAssignmentId: UUID,
    solutionRoleAssignmentId: UUID,
    deliveryRoleAssignmentId: UUID,
    arbiterRoleAssignmentId: UUID,
    metricDefinitionIds: z.array(UUID).min(1).max(100),
    healthPolicy: z.object({
      thresholds: z.record(triangleHealthDimensionSchema, z.number().finite()),
      weights: z.record(triangleHealthDimensionSchema, z.number().min(0).max(1)),
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((value, context) => {
    const responsibilities = [
      value.customerRoleAssignmentId,
      value.solutionRoleAssignmentId,
      value.deliveryRoleAssignmentId,
    ];
    if (new Set(responsibilities).size !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerRoleAssignmentId'],
        message:
          'Customer, solution and delivery responsibilities must be held by distinct assignments.',
      });
    }
    const weight = Object.values(value.healthPolicy.weights).reduce((sum, item) => sum + item, 0);
    if (Math.abs(weight - 1) > 0.000001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['healthPolicy', 'weights'],
        message: 'Triangle health weights must add up to 1.',
      });
    }
  });

export const triangleHealthSnapshotRequestSchema = z.object({
  expectedTeamRevision: REVISION,
  policyVersion: z.number().int().positive(),
  periodStart: ISO_DATE_TIME,
  periodEnd: ISO_DATE_TIME,
  observations: z.record(triangleHealthDimensionSchema, z.number().finite()),
  sourceEvidenceIds: z.array(UUID).min(1).max(500),
  idempotencyKey: IDEMPOTENCY_KEY,
});

export const triangleHealthSnapshotSchema = z.object({
  id: UUID,
  teamId: UUID,
  teamRevision: REVISION,
  policyVersion: z.number().int().positive(),
  score: z.number().min(0).max(100),
  rating: z.enum(['HEALTHY', 'WATCH', 'AT_RISK']),
  periodStart: ISO_DATE_TIME,
  periodEnd: ISO_DATE_TIME,
  components: z.array(
    z.object({
      dimension: triangleHealthDimensionSchema,
      observedValue: z.number(),
      normalizedScore: z.number().min(0).max(100),
      weight: z.number().min(0).max(1),
      weightedScore: z.number().min(0).max(100),
    }),
  ),
  createdAt: ISO_DATE_TIME,
});

export const organizationChangeTypeSchema = z.enum([
  'ORG_UNIT_MOVE',
  'ROLE_REASSIGNMENT',
  'REPORTING_LINE',
  'TEAM_RECONFIGURATION',
  'EMPLOYEE_OFFBOARDING',
]);
export const organizationImpactAreaSchema = z.enum([
  'OBJECTIVE',
  'PROCESS',
  'PERMISSION',
  'TASK',
  'AGENT_ASSIGNMENT',
]);
export const organizationChangeStatusSchema = z.enum([
  'PROPOSED',
  'ANALYZED',
  'CONFIRMED',
  'APPLIED',
  'REJECTED',
]);

export const createOrganizationChangeRequestSchema = z.object({
  type: organizationChangeTypeSchema,
  subjectId: UUID,
  effectiveAt: ISO_DATE_TIME,
  reason: TEXT,
  proposedChange: z.record(z.string(), z.unknown()),
  idempotencyKey: IDEMPOTENCY_KEY,
});

export const organizationImpactItemSchema = z.object({
  id: UUID,
  area: organizationImpactAreaSchema,
  resourceType: z.string().min(1).max(100),
  resourceId: UUID,
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  currentState: z.record(z.string(), z.unknown()),
  proposedState: z.record(z.string(), z.unknown()),
  mitigation: TEXT,
});

export const organizationChangeSchema = z.object({
  id: UUID,
  type: organizationChangeTypeSchema,
  subjectId: UUID,
  status: organizationChangeStatusSchema,
  effectiveAt: ISO_DATE_TIME,
  reason: TEXT,
  proposedChange: z.record(z.string(), z.unknown()),
  impacts: z.array(organizationImpactItemSchema),
  proposedByUserId: UUID,
  confirmedByUserId: UUID.nullable(),
  appliedByUserId: UUID.nullable(),
  revision: REVISION,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const analyzeOrganizationChangeRequestSchema = z.object({
  expectedRevision: REVISION,
  impacts: z
    .array(organizationImpactItemSchema.omit({ id: true }))
    .min(5)
    .max(1000)
    .superRefine((items, context) => {
      const areas = new Set(items.map((item) => item.area));
      for (const required of organizationImpactAreaSchema.options) {
        if (!areas.has(required)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Impact analysis must cover ${required}.`,
          });
        }
      }
    }),
});

export const decideOrganizationChangeRequestSchema = z.object({
  action: z.enum(['CONFIRM', 'REJECT']),
  expectedRevision: REVISION,
  comment: z.string().trim().min(3).max(2000),
});

export const applyOrganizationChangeRequestSchema = z.object({
  expectedRevision: REVISION,
  confirmationPhrase: z.literal('APPLY ORGANIZATION CHANGE'),
});

export const peopleOrganizationOverviewSchema = z.object({
  competencyDefinitions: z.number().int().nonnegative(),
  activeCompetencyVersions: z.number().int().nonnegative(),
  assessmentsAwaitingConfirmation: z.number().int().nonnegative(),
  openAppeals: z.number().int().nonnegative(),
  activeTriangleTeams: z.number().int().nonnegative(),
  organizationChangesAwaitingConfirmation: z.number().int().nonnegative(),
});

export const employeePeopleProfileSchema = z.object({
  userId: UUID,
  evidence: z.array(competencyEvidenceSchema),
  assessments: z.array(competencyAssessmentSchema),
  appeals: z.array(competencyAppealSchema),
  gaps: z.array(competencyGapSchema),
  developmentPlans: z.array(developmentPlanSchema),
});

export type CompetencyDefinition = z.infer<typeof competencyDefinitionSchema>;
export type CompetencyCategory = z.infer<typeof competencyCategorySchema>;
export type CompetencyVersion = z.infer<typeof competencyVersionSchema>;
export type CreateCompetencyDefinitionRequest = z.infer<
  typeof createCompetencyDefinitionRequestSchema
>;
export type CreateCompetencyVersionRequest = z.infer<typeof createCompetencyVersionRequestSchema>;
export type ActivateCompetencyVersionRequest = z.infer<
  typeof activateCompetencyVersionRequestSchema
>;
export type CompetencyEvidence = z.infer<typeof competencyEvidenceSchema>;
export type CreateCompetencyEvidenceRequest = z.infer<typeof createCompetencyEvidenceRequestSchema>;
export type CompetencyAssessment = z.infer<typeof competencyAssessmentSchema>;
export type CreateCompetencyAssessmentRequest = z.infer<
  typeof createCompetencyAssessmentRequestSchema
>;
export type ConfirmCompetencyAssessmentRequest = z.infer<
  typeof confirmCompetencyAssessmentRequestSchema
>;
export type CreateCompetencyAppealRequest = z.infer<typeof createCompetencyAppealRequestSchema>;
export type CompetencyAppeal = z.infer<typeof competencyAppealSchema>;
export type TransitionCompetencyAppealRequest = z.infer<
  typeof transitionCompetencyAppealRequestSchema
>;
export type CompetencyGap = z.infer<typeof competencyGapSchema>;
export type DevelopmentPlan = z.infer<typeof developmentPlanSchema>;
export type CreateDevelopmentPlanRequest = z.infer<typeof createDevelopmentPlanRequestSchema>;
export type TransitionDevelopmentActionRequest = z.infer<
  typeof transitionDevelopmentActionRequestSchema
>;
export type TriangleTeam = z.infer<typeof triangleTeamSchema>;
export type CreateTriangleTeamRequest = z.infer<typeof createTriangleTeamRequestSchema>;
export type TriangleHealthSnapshotRequest = z.infer<typeof triangleHealthSnapshotRequestSchema>;
export type TriangleHealthSnapshot = z.infer<typeof triangleHealthSnapshotSchema>;
export type CreateOrganizationChangeRequest = z.infer<typeof createOrganizationChangeRequestSchema>;
export type AnalyzeOrganizationChangeRequest = z.infer<
  typeof analyzeOrganizationChangeRequestSchema
>;
export type DecideOrganizationChangeRequest = z.infer<typeof decideOrganizationChangeRequestSchema>;
export type ApplyOrganizationChangeRequest = z.infer<typeof applyOrganizationChangeRequestSchema>;
export type OrganizationChange = z.infer<typeof organizationChangeSchema>;
export type PeopleOrganizationOverview = z.infer<typeof peopleOrganizationOverviewSchema>;
export type EmployeePeopleProfile = z.infer<typeof employeePeopleProfileSchema>;
