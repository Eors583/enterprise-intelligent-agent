import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const POSITIVE_INT = z.number().int().positive();
const REVISION = POSITIVE_INT;
const VERSION = POSITIVE_INT;
const WEIGHT = z.number().finite().gt(0).lte(1);
const DESCRIPTION = z.string().trim().min(1).max(5_000);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);

export const businessCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(100)
  .regex(/^[A-Z0-9]+(?:[._:-][A-Z0-9]+)*$/);

export const businessPermissionLabelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/);

export const businessPermissionLabelsSchema = z
  .array(businessPermissionLabelSchema)
  .max(50)
  .refine(uniqueStrings, 'Permission labels must be unique.');

const permissionLabelsInputSchema = businessPermissionLabelsSchema.default([]);

export const businessOwnerTypeSchema = z.enum([
  'USER',
  'ROLE_ASSIGNMENT',
  'ROLE_BLUEPRINT',
  'ORG_UNIT',
]);

export const businessOwnerSchema = z
  .object({
    type: businessOwnerTypeSchema,
    id: UUID,
  })
  .strict();

export const businessEffectivePeriodSchema = z
  .object({
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const valueTypeSchema = z.enum(['CUSTOMER', 'ENTERPRISE', 'ROLE']);
export const valueVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']);
export const valueConstraintTypeSchema = z.enum([
  'REGULATORY',
  'POLICY',
  'RISK',
  'ETHICAL',
  'FINANCIAL',
  'BEHAVIORAL',
]);
export const valueConstraintSeveritySchema = z.enum(['HARD', 'SOFT']);

export const metricTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('AT_LEAST'),
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('AT_MOST'),
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('EXACT'),
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('BETWEEN'),
      minimum: z.number().finite(),
      maximum: z.number().finite(),
    })
    .strict()
    .refine((value) => value.maximum > value.minimum, {
      message: 'maximum must be greater than minimum.',
      path: ['maximum'],
    }),
]);

const storedBusinessEntityShape = {
  id: UUID,
  tenantId: UUID,
  code: businessCodeSchema,
  owner: businessOwnerSchema,
  version: VERSION,
  revision: REVISION,
  permissionLabels: businessPermissionLabelsSchema,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
} as const;

const effectivePeriodShape = {
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
} as const;

const createBusinessEntityShape = {
  code: businessCodeSchema,
  owner: businessOwnerSchema,
  permissionLabels: permissionLabelsInputSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable().default(null),
} as const;

export const valueDefinitionSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    type: valueTypeSchema,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION.nullable(),
    currentVersionId: UUID.nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const valueMetricSchema = z
  .object({
    ...storedBusinessEntityShape,
    valueVersionId: UUID,
    metricDefinitionId: UUID,
    name: z.string().trim().min(1).max(200),
    weight: WEIGHT,
    target: metricTargetSchema,
  })
  .strict();

export const valueConstraintSchema = z
  .object({
    ...storedBusinessEntityShape,
    valueVersionId: UUID,
    type: valueConstraintTypeSchema,
    severity: valueConstraintSeveritySchema,
    statement: LONG_TEXT,
    requiredEvidenceTypes: z
      .array(businessCodeSchema)
      .max(30)
      .refine(uniqueStrings, 'Required evidence types must be unique.'),
  })
  .strict();

export const valueVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    valueDefinitionId: UUID,
    version: VERSION,
    revision: REVISION,
    status: valueVersionStatusSchema,
    statement: LONG_TEXT,
    ...effectivePeriodShape,
    owner: businessOwnerSchema,
    permissionLabels: businessPermissionLabelsSchema,
    positiveBehaviors: z
      .array(SHORT_TEXT)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Positive behaviors must be unique.'),
    negativeBehaviors: z
      .array(SHORT_TEXT)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Negative behaviors must be unique.'),
    metrics: z.array(valueMetricSchema).min(1).max(100),
    constraints: z.array(valueConstraintSchema).max(100),
    changeSummary: SHORT_TEXT,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => hasWeightTotalOfOne(value.metrics), {
    message: 'Value metric weights must total 1.',
    path: ['metrics'],
  })
  .refine((value) => uniqueCodes(value.metrics), {
    message: 'Value metric codes must be unique within a version.',
    path: ['metrics'],
  })
  .refine((value) => uniqueCodes(value.constraints), {
    message: 'Value constraint codes must be unique within a version.',
    path: ['constraints'],
  })
  .refine(
    (value) =>
      value.metrics.every(
        (metric) => metric.tenantId === value.tenantId && metric.valueVersionId === value.id,
      ) &&
      value.constraints.every(
        (constraint) =>
          constraint.tenantId === value.tenantId && constraint.valueVersionId === value.id,
      ),
    {
      message: 'Value metrics and constraints must belong to the enclosing value version.',
      path: ['metrics'],
    },
  )
  .refine(
    (value) => {
      const positive = new Set(value.positiveBehaviors.map(normalizedText));
      return value.negativeBehaviors.every((behavior) => !positive.has(normalizedText(behavior)));
    },
    {
      message: 'A behavior cannot be both positive and negative.',
      path: ['negativeBehaviors'],
    },
  );

export const valueMetricInputSchema = z
  .object({
    code: businessCodeSchema,
    metricDefinitionId: UUID,
    name: z.string().trim().min(1).max(200),
    weight: WEIGHT,
    target: metricTargetSchema,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict();

export const valueConstraintInputSchema = z
  .object({
    code: businessCodeSchema,
    type: valueConstraintTypeSchema,
    severity: valueConstraintSeveritySchema,
    statement: LONG_TEXT,
    requiredEvidenceTypes: z
      .array(businessCodeSchema)
      .max(30)
      .refine(uniqueStrings, 'Required evidence types must be unique.')
      .default([]),
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict();

export const createValueMetricRequestSchema = z
  .object({
    valueVersionId: UUID,
    expectedValueVersionRevision: REVISION,
    code: valueMetricInputSchema.shape.code,
    metricDefinitionId: valueMetricInputSchema.shape.metricDefinitionId,
    name: valueMetricInputSchema.shape.name,
    weight: valueMetricInputSchema.shape.weight,
    target: valueMetricInputSchema.shape.target,
    owner: businessOwnerSchema,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict();

export const updateValueMetricRequestSchema = z
  .object({
    expectedRevision: REVISION,
    expectedValueVersionRevision: REVISION,
    code: valueMetricInputSchema.shape.code.optional(),
    metricDefinitionId: valueMetricInputSchema.shape.metricDefinitionId.optional(),
    name: valueMetricInputSchema.shape.name.optional(),
    weight: valueMetricInputSchema.shape.weight.optional(),
    target: valueMetricInputSchema.shape.target.optional(),
    owner: businessOwnerSchema.optional(),
    permissionLabels: businessPermissionLabelsSchema.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Value Metric field must change.',
  });

export const createValueConstraintRequestSchema = z
  .object({
    valueVersionId: UUID,
    expectedValueVersionRevision: REVISION,
    code: valueConstraintInputSchema.shape.code,
    type: valueConstraintInputSchema.shape.type,
    severity: valueConstraintInputSchema.shape.severity,
    statement: valueConstraintInputSchema.shape.statement,
    requiredEvidenceTypes: valueConstraintInputSchema.shape.requiredEvidenceTypes,
    owner: businessOwnerSchema,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict();

export const updateValueConstraintRequestSchema = z
  .object({
    expectedRevision: REVISION,
    expectedValueVersionRevision: REVISION,
    code: valueConstraintInputSchema.shape.code.optional(),
    type: valueConstraintInputSchema.shape.type.optional(),
    severity: valueConstraintInputSchema.shape.severity.optional(),
    statement: valueConstraintInputSchema.shape.statement.optional(),
    requiredEvidenceTypes: valueConstraintInputSchema.shape.requiredEvidenceTypes.optional(),
    owner: businessOwnerSchema.optional(),
    permissionLabels: businessPermissionLabelsSchema.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Value Constraint field must change.',
  });

const valueVersionMutableShape = {
  statement: LONG_TEXT,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  owner: businessOwnerSchema,
  permissionLabels: businessPermissionLabelsSchema,
  positiveBehaviors: z
    .array(SHORT_TEXT)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Positive behaviors must be unique.'),
  negativeBehaviors: z
    .array(SHORT_TEXT)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Negative behaviors must be unique.'),
  metrics: z.array(valueMetricInputSchema).min(1).max(100),
  constraints: z.array(valueConstraintInputSchema).max(100),
  changeSummary: SHORT_TEXT,
} as const;

export const createValueDefinitionRequestSchema = z
  .object({
    ...createBusinessEntityShape,
    type: valueTypeSchema,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION.nullable().default(null),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const updateValueDefinitionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    type: valueTypeSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: DESCRIPTION.nullable().optional(),
    owner: businessOwnerSchema.optional(),
    effectiveFrom: TIMESTAMP.optional(),
    effectiveTo: TIMESTAMP.nullable().optional(),
    permissionLabels: businessPermissionLabelsSchema.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Value Definition field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const createValueVersionRequestSchema = z
  .object({
    valueDefinitionId: UUID,
    expectedDefinitionRevision: REVISION,
    ...valueVersionMutableShape,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => hasWeightTotalOfOne(value.metrics), {
    message: 'Value metric weights must total 1.',
    path: ['metrics'],
  })
  .refine((value) => uniqueCodes(value.metrics), {
    message: 'Value metric codes must be unique within a version.',
    path: ['metrics'],
  })
  .refine((value) => uniqueCodes(value.constraints), {
    message: 'Value constraint codes must be unique within a version.',
    path: ['constraints'],
  })
  .refine(hasDisjointBehaviorSets, {
    message: 'A behavior cannot be both positive and negative.',
    path: ['negativeBehaviors'],
  });

export const updateValueVersionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    statement: valueVersionMutableShape.statement.optional(),
    effectiveFrom: valueVersionMutableShape.effectiveFrom.optional(),
    effectiveTo: valueVersionMutableShape.effectiveTo.optional(),
    owner: valueVersionMutableShape.owner.optional(),
    permissionLabels: valueVersionMutableShape.permissionLabels.optional(),
    positiveBehaviors: valueVersionMutableShape.positiveBehaviors.optional(),
    negativeBehaviors: valueVersionMutableShape.negativeBehaviors.optional(),
    metrics: valueVersionMutableShape.metrics.optional(),
    constraints: valueVersionMutableShape.constraints.optional(),
    changeSummary: valueVersionMutableShape.changeSummary.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Value Version field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.metrics === undefined || hasWeightTotalOfOne(value.metrics), {
    message: 'Value metric weights must total 1.',
    path: ['metrics'],
  })
  .refine((value) => value.metrics === undefined || uniqueCodes(value.metrics), {
    message: 'Value metric codes must be unique within a version.',
    path: ['metrics'],
  })
  .refine((value) => value.constraints === undefined || uniqueCodes(value.constraints), {
    message: 'Value constraint codes must be unique within a version.',
    path: ['constraints'],
  })
  .refine(
    (value) =>
      value.positiveBehaviors === undefined ||
      value.negativeBehaviors === undefined ||
      hasDisjointBehaviorSets({
        positiveBehaviors: value.positiveBehaviors,
        negativeBehaviors: value.negativeBehaviors,
      }),
    {
      message: 'A behavior cannot be both positive and negative.',
      path: ['negativeBehaviors'],
    },
  );

export const transitionValueVersionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['PUBLISH', 'RETIRE']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const strategyStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED']);
export const objectiveStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'AT_RISK',
  'ACHIEVED',
  'CANCELLED',
]);
export const bscPerspectiveSchema = z.enum([
  'FINANCIAL',
  'CUSTOMER',
  'INTERNAL_PROCESS',
  'LEARNING_GROWTH',
]);
export const indicatorTypeSchema = z.enum(['LEADING', 'LAGGING']);

export const budgetSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
  })
  .strict();

export const strategySchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION,
    status: strategyStatusSchema,
    valueVersionIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Strategy value version IDs must be unique.'),
    budget: budgetSchema.nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const objectiveSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    strategyId: UUID,
    parentObjectiveId: UUID.nullable(),
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION,
    status: objectiveStatusSchema,
    bscPerspective: bscPerspectiveSchema,
    indicatorType: indicatorTypeSchema,
    weight: WEIGHT,
    valueVersionIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Objective value version IDs must be unique.'),
    metricDefinitionIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Objective metric definition IDs must be unique.'),
    responsibleRoleAssignmentIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Responsible Role Assignment IDs must be unique.'),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.parentObjectiveId !== value.id, {
    message: 'An Objective cannot be its own parent.',
    path: ['parentObjectiveId'],
  });

export const objectiveRelationTypeSchema = z.enum(['PARENT_CHILD', 'CAUSES', 'SUPPORTS']);
export const objectiveRelationStatusSchema = z.enum(['ACTIVE', 'RETIRED']);

export const objectiveRelationSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    sourceObjectiveId: UUID,
    targetObjectiveId: UUID,
    type: objectiveRelationTypeSchema,
    status: objectiveRelationStatusSchema,
    weight: WEIGHT,
    lagDays: z.number().int().min(0).max(36_500),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.sourceObjectiveId !== value.targetObjectiveId, {
    message: 'An Objective relation cannot point to itself.',
    path: ['targetObjectiveId'],
  })
  .refine((value) => value.type !== 'PARENT_CHILD' || value.lagDays === 0, {
    message: 'PARENT_CHILD relations cannot declare a lag.',
    path: ['lagDays'],
  });

const strategyMutableShape = {
  name: z.string().trim().min(1).max(200),
  description: DESCRIPTION,
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
  valueVersionIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Strategy value version IDs must be unique.'),
  budget: budgetSchema.nullable(),
} as const;

export const createStrategyRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...strategyMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const updateStrategyRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    name: strategyMutableShape.name.optional(),
    description: strategyMutableShape.description.optional(),
    owner: strategyMutableShape.owner.optional(),
    effectiveFrom: strategyMutableShape.effectiveFrom.optional(),
    effectiveTo: strategyMutableShape.effectiveTo.optional(),
    permissionLabels: strategyMutableShape.permissionLabels.optional(),
    valueVersionIds: strategyMutableShape.valueVersionIds.optional(),
    budget: strategyMutableShape.budget.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Strategy field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const transitionStrategyRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['ACTIVATE', 'CLOSE', 'CANCEL']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

const objectiveMutableShape = {
  strategyId: UUID,
  parentObjectiveId: UUID.nullable(),
  name: z.string().trim().min(1).max(200),
  description: DESCRIPTION,
  owner: businessOwnerSchema,
  bscPerspective: bscPerspectiveSchema,
  indicatorType: indicatorTypeSchema,
  weight: WEIGHT,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
  valueVersionIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Objective value version IDs must be unique.'),
  metricDefinitionIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Objective metric definition IDs must be unique.'),
  responsibleRoleAssignmentIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Responsible Role Assignment IDs must be unique.'),
} as const;

export const createObjectiveRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...objectiveMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const updateObjectiveRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    strategyId: objectiveMutableShape.strategyId.optional(),
    parentObjectiveId: objectiveMutableShape.parentObjectiveId.optional(),
    name: objectiveMutableShape.name.optional(),
    description: objectiveMutableShape.description.optional(),
    owner: objectiveMutableShape.owner.optional(),
    bscPerspective: objectiveMutableShape.bscPerspective.optional(),
    indicatorType: objectiveMutableShape.indicatorType.optional(),
    weight: objectiveMutableShape.weight.optional(),
    effectiveFrom: objectiveMutableShape.effectiveFrom.optional(),
    effectiveTo: objectiveMutableShape.effectiveTo.optional(),
    permissionLabels: objectiveMutableShape.permissionLabels.optional(),
    valueVersionIds: objectiveMutableShape.valueVersionIds.optional(),
    metricDefinitionIds: objectiveMutableShape.metricDefinitionIds.optional(),
    responsibleRoleAssignmentIds: objectiveMutableShape.responsibleRoleAssignmentIds.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Objective field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const transitionObjectiveRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['ACTIVATE', 'MARK_AT_RISK', 'RESTORE', 'ACHIEVE', 'CANCEL']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

const objectiveRelationMutableShape = {
  sourceObjectiveId: UUID,
  targetObjectiveId: UUID,
  type: objectiveRelationTypeSchema,
  weight: WEIGHT,
  lagDays: z.number().int().min(0).max(36_500),
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createObjectiveRelationRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...objectiveRelationMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.sourceObjectiveId !== value.targetObjectiveId, {
    message: 'An Objective relation cannot point to itself.',
    path: ['targetObjectiveId'],
  })
  .refine((value) => value.type !== 'PARENT_CHILD' || value.lagDays === 0, {
    message: 'PARENT_CHILD relations cannot declare a lag.',
    path: ['lagDays'],
  });

export const updateObjectiveRelationRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    sourceObjectiveId: objectiveRelationMutableShape.sourceObjectiveId.optional(),
    targetObjectiveId: objectiveRelationMutableShape.targetObjectiveId.optional(),
    type: objectiveRelationMutableShape.type.optional(),
    weight: objectiveRelationMutableShape.weight.optional(),
    lagDays: objectiveRelationMutableShape.lagDays.optional(),
    owner: objectiveRelationMutableShape.owner.optional(),
    effectiveFrom: objectiveRelationMutableShape.effectiveFrom.optional(),
    effectiveTo: objectiveRelationMutableShape.effectiveTo.optional(),
    permissionLabels: objectiveRelationMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Objective relation field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) =>
      value.sourceObjectiveId === undefined ||
      value.targetObjectiveId === undefined ||
      value.sourceObjectiveId !== value.targetObjectiveId,
    {
      message: 'An Objective relation cannot point to itself.',
      path: ['targetObjectiveId'],
    },
  )
  .refine(
    (value) =>
      value.type === undefined ||
      value.lagDays === undefined ||
      value.type !== 'PARENT_CHILD' ||
      value.lagDays === 0,
    {
      message: 'PARENT_CHILD relations cannot declare a lag.',
      path: ['lagDays'],
    },
  );

export const transitionObjectiveRelationRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.literal('RETIRE'),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const metricValueTypeSchema = z.enum([
  'NUMBER',
  'PERCENTAGE',
  'CURRENCY',
  'DURATION',
  'COUNT',
  'BOOLEAN',
]);
export const metricAggregationSchema = z.enum([
  'SUM',
  'AVERAGE',
  'MINIMUM',
  'MAXIMUM',
  'LATEST',
  'COUNT',
]);
export const metricDirectionSchema = z.enum(['INCREASE', 'DECREASE', 'MAINTAIN', 'RANGE']);
export const metricDefinitionStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);

export const metricDefinitionSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION,
    status: metricDefinitionStatusSchema,
    valueType: metricValueTypeSchema,
    unit: z.string().trim().min(1).max(50),
    aggregation: metricAggregationSchema,
    direction: metricDirectionSchema,
    bscPerspective: bscPerspectiveSchema,
    indicatorType: indicatorTypeSchema,
    validRange: z
      .object({
        minimum: z.number().finite(),
        maximum: z.number().finite(),
      })
      .strict()
      .refine((range) => range.maximum > range.minimum, {
        message: 'Metric maximum must be greater than minimum.',
        path: ['maximum'],
      })
      .nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.direction !== 'RANGE' || value.validRange !== null, {
    message: 'RANGE metrics require a valid range.',
    path: ['validRange'],
  });

export const metricSubjectTypeSchema = z.enum([
  'VALUE_VERSION',
  'STRATEGY',
  'OBJECTIVE',
  'TASK',
  'DELIVERABLE',
]);

export const metricSubjectSchema = z
  .object({
    type: metricSubjectTypeSchema,
    id: UUID,
    version: VERSION,
  })
  .strict();

export const metricObservationSchema = z
  .object({
    ...storedBusinessEntityShape,
    metricDefinitionId: UUID,
    subject: metricSubjectSchema,
    value: z.number().finite(),
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    observedAt: TIMESTAMP,
    evidenceIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Metric observation evidence IDs must be unique.'),
    supersedesObservationId: UUID.nullable(),
  })
  .strict()
  .refine(hasValidObservationPeriod, {
    message: 'periodEnd must be later than periodStart.',
    path: ['periodEnd'],
  })
  .refine((value) => timestamp(value.observedAt) >= timestamp(value.periodEnd), {
    message: 'observedAt cannot precede periodEnd.',
    path: ['observedAt'],
  });

const metricDefinitionMutableShape = {
  name: z.string().trim().min(1).max(200),
  description: DESCRIPTION,
  owner: businessOwnerSchema,
  valueType: metricValueTypeSchema,
  unit: z.string().trim().min(1).max(50),
  aggregation: metricAggregationSchema,
  direction: metricDirectionSchema,
  bscPerspective: bscPerspectiveSchema,
  indicatorType: indicatorTypeSchema,
  validRange: metricDefinitionSchema.shape.validRange,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createMetricDefinitionRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...metricDefinitionMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.direction !== 'RANGE' || value.validRange !== null, {
    message: 'RANGE metrics require a valid range.',
    path: ['validRange'],
  });

export const updateMetricDefinitionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    name: metricDefinitionMutableShape.name.optional(),
    description: metricDefinitionMutableShape.description.optional(),
    owner: metricDefinitionMutableShape.owner.optional(),
    valueType: metricDefinitionMutableShape.valueType.optional(),
    unit: metricDefinitionMutableShape.unit.optional(),
    aggregation: metricDefinitionMutableShape.aggregation.optional(),
    direction: metricDefinitionMutableShape.direction.optional(),
    bscPerspective: metricDefinitionMutableShape.bscPerspective.optional(),
    indicatorType: metricDefinitionMutableShape.indicatorType.optional(),
    validRange: metricDefinitionMutableShape.validRange.optional(),
    effectiveFrom: metricDefinitionMutableShape.effectiveFrom.optional(),
    effectiveTo: metricDefinitionMutableShape.effectiveTo.optional(),
    permissionLabels: metricDefinitionMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Metric Definition field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) =>
      value.direction === undefined || value.direction !== 'RANGE' || value.validRange !== null,
    {
      message: 'RANGE metrics cannot explicitly remove their valid range.',
      path: ['validRange'],
    },
  );

export const transitionMetricDefinitionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['ACTIVATE', 'RETIRE']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

const metricObservationMutableShape = {
  metricDefinitionId: UUID,
  subject: metricSubjectSchema,
  value: z.number().finite(),
  periodStart: TIMESTAMP,
  periodEnd: TIMESTAMP,
  observedAt: TIMESTAMP,
  evidenceIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Metric observation evidence IDs must be unique.'),
  owner: businessOwnerSchema,
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createMetricObservationRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...metricObservationMutableShape,
    permissionLabels: permissionLabelsInputSchema,
    supersedesObservationId: UUID.nullable().default(null),
  })
  .strict()
  .refine(hasValidObservationPeriod, {
    message: 'periodEnd must be later than periodStart.',
    path: ['periodEnd'],
  })
  .refine((value) => timestamp(value.observedAt) >= timestamp(value.periodEnd), {
    message: 'observedAt cannot precede periodEnd.',
    path: ['observedAt'],
  });

export const updateMetricObservationRequestSchema = z
  .object({
    expectedRevision: REVISION,
    value: metricObservationMutableShape.value.optional(),
    observedAt: metricObservationMutableShape.observedAt.optional(),
    evidenceIds: metricObservationMutableShape.evidenceIds.optional(),
    owner: metricObservationMutableShape.owner.optional(),
    permissionLabels: metricObservationMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Metric Observation field must change.',
  });

export const taskStatusSchema = z.enum([
  'PLANNED',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
]);
export const taskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const processDefinitionStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);
export const processVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']);
export const processNodeTypeSchema = z.enum([
  'START',
  'ACTIVITY',
  'DECISION',
  'MILESTONE',
  'END',
  'HUMAN_APPROVAL',
  'AGENT_EXECUTION',
  'CONDITION',
  'TIMER',
  'COMPENSATION',
]);

export const processNodeSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    processDefinitionId: UUID,
    processVersionId: UUID,
    processVersion: VERSION,
    code: businessCodeSchema,
    name: z.string().trim().min(1).max(200),
    type: processNodeTypeSchema,
    ordinal: z.number().int().nonnegative().max(100_000),
    configuration: z.record(z.string(), z.unknown()),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const processVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    processDefinitionId: UUID,
    version: VERSION,
    revision: REVISION,
    status: processVersionStatusSchema,
    changeSummary: SHORT_TEXT,
    owner: businessOwnerSchema,
    permissionLabels: businessPermissionLabelsSchema,
    ...effectivePeriodShape,
    nodes: z.array(processNodeSchema).min(1).max(5_000),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(
    (version) =>
      version.nodes.every(
        (node) =>
          node.tenantId === version.tenantId &&
          node.processDefinitionId === version.processDefinitionId &&
          node.processVersionId === version.id &&
          node.processVersion === version.version,
      ),
    {
      message: 'Process nodes must belong to the enclosing Process Version.',
      path: ['nodes'],
    },
  )
  .refine(
    (version) =>
      uniqueStrings(version.nodes.map((node) => node.id)) &&
      uniqueStrings(version.nodes.map((node) => node.code)),
    {
      message: 'Process node IDs and codes must be unique within a Process Version.',
      path: ['nodes'],
    },
  )
  .refine(hasValidProcessNodeInputs, {
    message: 'Published Process data requires at least one START and END node.',
    path: ['nodes'],
  });

export const processDefinitionSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION,
    status: processDefinitionStatusSchema,
    currentVersionId: UUID.nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const processNodeInputSchema = z
  .object({
    code: businessCodeSchema,
    name: z.string().trim().min(1).max(200),
    type: processNodeTypeSchema,
    ordinal: z.number().int().nonnegative().max(100_000),
    configuration: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const createProcessDefinitionRequestSchema = z
  .object({
    ...createBusinessEntityShape,
    name: z.string().trim().min(1).max(200),
    description: DESCRIPTION,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const updateProcessDefinitionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: DESCRIPTION.optional(),
    owner: businessOwnerSchema.optional(),
    effectiveFrom: TIMESTAMP.optional(),
    effectiveTo: TIMESTAMP.nullable().optional(),
    permissionLabels: businessPermissionLabelsSchema.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Process Definition field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const createProcessVersionRequestSchema = z
  .object({
    processDefinitionId: UUID,
    expectedDefinitionRevision: REVISION,
    changeSummary: SHORT_TEXT,
    owner: businessOwnerSchema,
    permissionLabels: permissionLabelsInputSchema,
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable().default(null),
    nodes: z.array(processNodeInputSchema).min(2).max(5_000),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasValidProcessNodeInputs, {
    message: 'Process Version nodes require unique codes and at least one START and END.',
    path: ['nodes'],
  });

export const updateProcessVersionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    changeSummary: SHORT_TEXT.optional(),
    owner: businessOwnerSchema.optional(),
    permissionLabels: businessPermissionLabelsSchema.optional(),
    effectiveFrom: TIMESTAMP.optional(),
    effectiveTo: TIMESTAMP.nullable().optional(),
    nodes: z.array(processNodeInputSchema).min(2).max(5_000).optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Process Version field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) => value.nodes === undefined || hasValidProcessNodeInputs({ nodes: value.nodes }),
    {
      message: 'Process Version nodes require unique codes and at least one START and END.',
      path: ['nodes'],
    },
  );

export const transitionProcessVersionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['PUBLISH', 'RETIRE']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const processTraceReferenceSchema = z
  .object({
    definitionId: UUID,
    definitionCode: businessCodeSchema,
    versionId: UUID,
    version: VERSION,
    nodeId: UUID,
    nodeCode: businessCodeSchema,
    instanceId: UUID.nullable(),
  })
  .strict();

export const taskSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    objectiveId: UUID,
    valueDefinitionId: UUID,
    valueVersionId: UUID,
    processRef: processTraceReferenceSchema,
    title: z.string().trim().min(1).max(300),
    description: DESCRIPTION,
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    dueAt: TIMESTAMP,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasDueDateWithinEffectivePeriod, {
    message: 'dueAt must fall within the Task effective period.',
    path: ['dueAt'],
  });

export const taskDependencyTypeSchema = z.enum([
  'FINISH_TO_START',
  'START_TO_START',
  'FINISH_TO_FINISH',
  'START_TO_FINISH',
]);
export const taskDependencyStatusSchema = z.enum(['ACTIVE', 'REMOVED']);

export const taskDependencySchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    predecessorTaskId: UUID,
    successorTaskId: UUID,
    type: taskDependencyTypeSchema,
    status: taskDependencyStatusSchema,
    lagMinutes: z.number().int().min(-525_600).max(5_256_000),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.predecessorTaskId !== value.successorTaskId, {
    message: 'A Task cannot depend on itself.',
    path: ['successorTaskId'],
  });

const taskMutableShape = {
  objectiveId: UUID,
  valueDefinitionId: UUID,
  valueVersionId: UUID,
  processRef: processTraceReferenceSchema,
  title: z.string().trim().min(1).max(300),
  description: DESCRIPTION,
  owner: businessOwnerSchema,
  priority: taskPrioritySchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  dueAt: TIMESTAMP,
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createTaskRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...taskMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasDueDateWithinEffectivePeriod, {
    message: 'dueAt must fall within the Task effective period.',
    path: ['dueAt'],
  });

export const updateTaskRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    objectiveId: taskMutableShape.objectiveId.optional(),
    valueDefinitionId: taskMutableShape.valueDefinitionId.optional(),
    valueVersionId: taskMutableShape.valueVersionId.optional(),
    processRef: taskMutableShape.processRef.optional(),
    title: taskMutableShape.title.optional(),
    description: taskMutableShape.description.optional(),
    owner: taskMutableShape.owner.optional(),
    priority: taskMutableShape.priority.optional(),
    effectiveFrom: taskMutableShape.effectiveFrom.optional(),
    effectiveTo: taskMutableShape.effectiveTo.optional(),
    dueAt: taskMutableShape.dueAt.optional(),
    permissionLabels: taskMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Task field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) =>
      value.dueAt === undefined ||
      value.effectiveFrom === undefined ||
      timestamp(value.dueAt) >= timestamp(value.effectiveFrom),
    {
      message: 'dueAt cannot precede effectiveFrom.',
      path: ['dueAt'],
    },
  )
  .refine(
    (value) =>
      value.dueAt === undefined ||
      value.effectiveTo === undefined ||
      value.effectiveTo === null ||
      timestamp(value.dueAt) <= timestamp(value.effectiveTo),
    {
      message: 'dueAt cannot be later than effectiveTo.',
      path: ['dueAt'],
    },
  );

export const transitionTaskRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum([
      'MAKE_READY',
      'START',
      'BLOCK',
      'UNBLOCK',
      'DELIVER',
      'ACCEPT',
      'REJECT',
      'CANCEL',
    ]),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const workbenchObjectiveListResponseSchema = z
  .object({
    items: z.array(objectiveSchema).max(2_000),
  })
  .strict();

export const workbenchTaskListResponseSchema = z
  .object({
    items: z.array(taskSchema).max(5_000),
  })
  .strict();

const taskDependencyMutableShape = {
  predecessorTaskId: UUID,
  successorTaskId: UUID,
  type: taskDependencyTypeSchema,
  lagMinutes: z.number().int().min(-525_600).max(5_256_000),
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createTaskDependencyRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...taskDependencyMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine((value) => value.predecessorTaskId !== value.successorTaskId, {
    message: 'A Task cannot depend on itself.',
    path: ['successorTaskId'],
  });

export const updateTaskDependencyRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    predecessorTaskId: taskDependencyMutableShape.predecessorTaskId.optional(),
    successorTaskId: taskDependencyMutableShape.successorTaskId.optional(),
    type: taskDependencyMutableShape.type.optional(),
    lagMinutes: taskDependencyMutableShape.lagMinutes.optional(),
    owner: taskDependencyMutableShape.owner.optional(),
    effectiveFrom: taskDependencyMutableShape.effectiveFrom.optional(),
    effectiveTo: taskDependencyMutableShape.effectiveTo.optional(),
    permissionLabels: taskDependencyMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Task dependency field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) =>
      value.predecessorTaskId === undefined ||
      value.successorTaskId === undefined ||
      value.predecessorTaskId !== value.successorTaskId,
    {
      message: 'A Task cannot depend on itself.',
      path: ['successorTaskId'],
    },
  );

export const transitionTaskDependencyRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.literal('REMOVE'),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const deliverableStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
]);

export const deliverableSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    taskId: UUID,
    title: z.string().trim().min(1).max(300),
    description: DESCRIPTION,
    status: deliverableStatusSchema,
    dueAt: TIMESTAMP,
    submittedAt: TIMESTAMP.nullable(),
    artifactUri: z.url().nullable(),
    contentHash: z
      .string()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasDueDateWithinEffectivePeriod, {
    message: 'dueAt must fall within the Deliverable effective period.',
    path: ['dueAt'],
  })
  .refine(hasValidDeliverableSubmissionState, {
    message: 'Submitted Deliverables require submittedAt, artifactUri, and contentHash.',
    path: ['submittedAt'],
  })
  .refine(
    (value) => value.submittedAt === null || timestampWithinPeriod(value.submittedAt, value),
    {
      message: 'submittedAt must fall within the Deliverable effective period.',
      path: ['submittedAt'],
    },
  );

export const acceptanceDecisionSchema = z.enum(['ACCEPTED', 'REJECTED', 'CHANGES_REQUESTED']);
export const acceptanceStatusSchema = z.enum(['ACTIVE', 'VOID']);

export const acceptanceCriterionResultSchema = z
  .object({
    code: businessCodeSchema,
    description: SHORT_TEXT,
    mandatory: z.boolean(),
    passed: z.boolean(),
    weight: WEIGHT,
    comment: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

export const acceptanceSchema = z
  .object({
    ...storedBusinessEntityShape,
    deliverableId: UUID,
    status: acceptanceStatusSchema,
    decision: acceptanceDecisionSchema,
    decidedBy: businessOwnerSchema,
    decidedAt: TIMESTAMP,
    criteria: z.array(acceptanceCriterionResultSchema).min(1).max(100),
    evidenceIds: z
      .array(UUID)
      .min(1)
      .max(100)
      .refine(uniqueStrings, 'Acceptance evidence IDs must be unique.'),
    comment: LONG_TEXT,
  })
  .strict()
  .refine((value) => uniqueCodes(value.criteria), {
    message: 'Acceptance criterion codes must be unique.',
    path: ['criteria'],
  })
  .refine((value) => hasWeightTotalOfOne(value.criteria), {
    message: 'Acceptance criterion weights must total 1.',
    path: ['criteria'],
  })
  .refine(hasDecisionConsistentWithCriteria, {
    message: 'Acceptance decision conflicts with criterion results.',
    path: ['decision'],
  });

const deliverableMutableShape = {
  taskId: UUID,
  title: z.string().trim().min(1).max(300),
  description: DESCRIPTION,
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  dueAt: TIMESTAMP,
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createDeliverableRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...deliverableMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasDueDateWithinEffectivePeriod, {
    message: 'dueAt must fall within the Deliverable effective period.',
    path: ['dueAt'],
  });

export const updateDeliverableRequestSchema = z
  .object({
    expectedRevision: REVISION,
    code: businessCodeSchema.optional(),
    title: deliverableMutableShape.title.optional(),
    description: deliverableMutableShape.description.optional(),
    owner: deliverableMutableShape.owner.optional(),
    effectiveFrom: deliverableMutableShape.effectiveFrom.optional(),
    effectiveTo: deliverableMutableShape.effectiveTo.optional(),
    dueAt: deliverableMutableShape.dueAt.optional(),
    permissionLabels: deliverableMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Deliverable field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const transitionDeliverableRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      expectedRevision: REVISION,
      action: z.literal('SUBMIT'),
      submittedAt: TIMESTAMP,
      artifactUri: z.url(),
      contentHash: z
        .string()
        .toLowerCase()
        .regex(/^[a-f0-9]{64}$/),
      evidenceIds: z
        .array(UUID)
        .min(1)
        .max(100)
        .refine(uniqueStrings, 'Submission evidence IDs must be unique.'),
    })
    .strict(),
  z
    .object({
      expectedRevision: REVISION,
      action: z.literal('WITHDRAW'),
      reason: SHORT_TEXT,
      effectiveAt: TIMESTAMP,
    })
    .strict(),
]);

const acceptanceMutableShape = {
  deliverableId: UUID,
  decision: acceptanceDecisionSchema,
  decidedBy: businessOwnerSchema,
  decidedAt: TIMESTAMP,
  criteria: z.array(acceptanceCriterionResultSchema).min(1).max(100),
  evidenceIds: z
    .array(UUID)
    .min(1)
    .max(100)
    .refine(uniqueStrings, 'Acceptance evidence IDs must be unique.'),
  comment: LONG_TEXT,
  owner: businessOwnerSchema,
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createAcceptanceRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...acceptanceMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine((value) => uniqueCodes(value.criteria), {
    message: 'Acceptance criterion codes must be unique.',
    path: ['criteria'],
  })
  .refine((value) => hasWeightTotalOfOne(value.criteria), {
    message: 'Acceptance criterion weights must total 1.',
    path: ['criteria'],
  })
  .refine(hasDecisionConsistentWithCriteria, {
    message: 'Acceptance decision conflicts with criterion results.',
    path: ['decision'],
  });

export const updateAcceptanceRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: acceptanceMutableShape.decision.optional(),
    decidedBy: acceptanceMutableShape.decidedBy.optional(),
    decidedAt: acceptanceMutableShape.decidedAt.optional(),
    criteria: acceptanceMutableShape.criteria.optional(),
    evidenceIds: acceptanceMutableShape.evidenceIds.optional(),
    comment: acceptanceMutableShape.comment.optional(),
    owner: acceptanceMutableShape.owner.optional(),
    permissionLabels: acceptanceMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Acceptance field must change.',
  })
  .refine((value) => value.criteria === undefined || uniqueCodes(value.criteria), {
    message: 'Acceptance criterion codes must be unique.',
    path: ['criteria'],
  })
  .refine((value) => value.criteria === undefined || hasWeightTotalOfOne(value.criteria), {
    message: 'Acceptance criterion weights must total 1.',
    path: ['criteria'],
  })
  .refine(
    (value) =>
      value.decision === undefined ||
      value.criteria === undefined ||
      hasDecisionConsistentWithCriteria({
        decision: value.decision,
        criteria: value.criteria,
      }),
    {
      message: 'Acceptance decision conflicts with criterion results.',
      path: ['decision'],
    },
  );

export const transitionAcceptanceRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.literal('VOID'),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const evidenceSourceTypeSchema = z.enum([
  'BUSINESS_SYSTEM',
  'DOCUMENT',
  'HUMAN_ATTESTATION',
  'AGENT_RUN',
  'METRIC',
  'PROCESS_EVENT',
]);
export const evidenceTrustLevelSchema = z.enum(['VERIFIED', 'HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED']);
export const evidenceStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'REVOKED']);

export const evidenceSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    status: evidenceStatusSchema,
    sourceType: evidenceSourceTypeSchema,
    sourceSystem: businessCodeSchema,
    sourceRecordId: z.string().trim().min(1).max(500),
    sourceVersion: z.string().trim().min(1).max(200),
    sourceUri: z.url().nullable(),
    observedAt: TIMESTAMP,
    contentHashAlgorithm: z.literal('SHA256'),
    contentHash: z
      .string()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/),
    trustLevel: evidenceTrustLevelSchema,
    confidence: z.number().finite().min(0).max(1),
    summary: LONG_TEXT,
    verifiedBy: businessOwnerSchema.nullable(),
    verifiedAt: TIMESTAMP.nullable(),
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasConsistentVerification, {
    message: 'verifiedBy and verifiedAt must both be present or both be absent.',
    path: ['verifiedAt'],
  })
  .refine(
    (value) =>
      value.trustLevel !== 'VERIFIED' || (value.verifiedBy !== null && value.verifiedAt !== null),
    {
      message: 'VERIFIED evidence requires verifier identity and time.',
      path: ['verifiedAt'],
    },
  )
  .refine((value) => timestampWithinPeriod(value.observedAt, value), {
    message: 'observedAt must fall within the Evidence effective period.',
    path: ['observedAt'],
  })
  .refine(
    (value) =>
      value.verifiedAt === null || timestamp(value.verifiedAt) >= timestamp(value.observedAt),
    {
      message: 'verifiedAt cannot precede observedAt.',
      path: ['verifiedAt'],
    },
  );

export const evidenceTargetTypeSchema = z.enum([
  'VALUE_VERSION',
  'STRATEGY',
  'OBJECTIVE',
  'METRIC_OBSERVATION',
  'TASK',
  'DELIVERABLE',
  'ACCEPTANCE',
]);
export const evidenceLinkTypeSchema = z.enum(['SUPPORTS', 'REFUTES', 'QUALIFIES', 'DERIVED_FROM']);
export const evidenceLinkStatusSchema = z.enum(['ACTIVE', 'REMOVED']);

export const evidenceLinkSchema = z
  .object({
    ...storedBusinessEntityShape,
    ...effectivePeriodShape,
    evidenceId: UUID,
    targetType: evidenceTargetTypeSchema,
    targetId: UUID,
    targetVersion: VERSION,
    status: evidenceLinkStatusSchema,
    type: evidenceLinkTypeSchema,
    relevance: WEIGHT,
    statement: SHORT_TEXT,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

const evidenceMutableShape = {
  sourceType: evidenceSourceTypeSchema,
  sourceSystem: businessCodeSchema,
  sourceRecordId: z.string().trim().min(1).max(500),
  sourceVersion: z.string().trim().min(1).max(200),
  sourceUri: z.url().nullable(),
  observedAt: TIMESTAMP,
  contentHashAlgorithm: z.literal('SHA256'),
  contentHash: z
    .string()
    .toLowerCase()
    .regex(/^[a-f0-9]{64}$/),
  trustLevel: evidenceTrustLevelSchema,
  confidence: z.number().finite().min(0).max(1),
  summary: LONG_TEXT,
  verifiedBy: businessOwnerSchema.nullable(),
  verifiedAt: TIMESTAMP.nullable(),
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createEvidenceRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...evidenceMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  })
  .refine(hasConsistentVerification, {
    message: 'verifiedBy and verifiedAt must both be present or both be absent.',
    path: ['verifiedAt'],
  })
  .refine(
    (value) =>
      value.trustLevel !== 'VERIFIED' || (value.verifiedBy !== null && value.verifiedAt !== null),
    {
      message: 'VERIFIED evidence requires verifier identity and time.',
      path: ['verifiedAt'],
    },
  )
  .refine((value) => timestampWithinPeriod(value.observedAt, value), {
    message: 'observedAt must fall within the Evidence effective period.',
    path: ['observedAt'],
  })
  .refine(
    (value) =>
      value.verifiedAt === null || timestamp(value.verifiedAt) >= timestamp(value.observedAt),
    {
      message: 'verifiedAt cannot precede observedAt.',
      path: ['verifiedAt'],
    },
  );

export const updateEvidenceRequestSchema = z
  .object({
    expectedRevision: REVISION,
    trustLevel: evidenceMutableShape.trustLevel.optional(),
    confidence: evidenceMutableShape.confidence.optional(),
    summary: evidenceMutableShape.summary.optional(),
    verifiedBy: evidenceMutableShape.verifiedBy.optional(),
    verifiedAt: evidenceMutableShape.verifiedAt.optional(),
    owner: evidenceMutableShape.owner.optional(),
    effectiveFrom: evidenceMutableShape.effectiveFrom.optional(),
    effectiveTo: evidenceMutableShape.effectiveTo.optional(),
    permissionLabels: evidenceMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Evidence field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  })
  .refine(hasConsistentPartialVerification, {
    message: 'verifiedBy and verifiedAt must be changed together.',
    path: ['verifiedAt'],
  })
  .refine(
    (value) =>
      value.trustLevel !== 'VERIFIED' ||
      (value.verifiedBy !== undefined &&
        value.verifiedBy !== null &&
        value.verifiedAt !== undefined &&
        value.verifiedAt !== null),
    {
      message: 'Changing trustLevel to VERIFIED requires verifier identity and time.',
      path: ['verifiedAt'],
    },
  );

export const transitionEvidenceRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['VERIFY', 'REVOKE']),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

const evidenceLinkMutableShape = {
  evidenceId: UUID,
  targetType: evidenceTargetTypeSchema,
  targetId: UUID,
  targetVersion: VERSION,
  type: evidenceLinkTypeSchema,
  relevance: WEIGHT,
  statement: SHORT_TEXT,
  owner: businessOwnerSchema,
  effectiveFrom: TIMESTAMP,
  effectiveTo: TIMESTAMP.nullable(),
  permissionLabels: businessPermissionLabelsSchema,
} as const;

export const createEvidenceLinkRequestSchema = z
  .object({
    code: businessCodeSchema,
    ...evidenceLinkMutableShape,
    permissionLabels: permissionLabelsInputSchema,
  })
  .strict()
  .refine(hasValidEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom.',
    path: ['effectiveTo'],
  });

export const updateEvidenceLinkRequestSchema = z
  .object({
    expectedRevision: REVISION,
    type: evidenceLinkMutableShape.type.optional(),
    relevance: evidenceLinkMutableShape.relevance.optional(),
    statement: evidenceLinkMutableShape.statement.optional(),
    owner: evidenceLinkMutableShape.owner.optional(),
    effectiveFrom: evidenceLinkMutableShape.effectiveFrom.optional(),
    effectiveTo: evidenceLinkMutableShape.effectiveTo.optional(),
    permissionLabels: evidenceLinkMutableShape.permissionLabels.optional(),
  })
  .strict()
  .refine(hasMutationBeyondExpectedRevision, {
    message: 'At least one Evidence Link field must change.',
  })
  .refine(hasValidPartialEffectivePeriod, {
    message: 'effectiveTo must be later than effectiveFrom when both are supplied.',
    path: ['effectiveTo'],
  });

export const transitionEvidenceLinkRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.literal('REMOVE'),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const businessSemanticTraceResponseSchema = z
  .object({
    traceId: UUID,
    tenantId: UUID,
    rootTaskId: UUID,
    generatedAt: TIMESTAMP,
    valueDefinitions: z.array(valueDefinitionSchema).min(1).max(500),
    valueVersions: z.array(valueVersionSchema).min(1).max(500),
    strategies: z.array(strategySchema).min(1).max(500),
    objectives: z.array(objectiveSchema).min(1).max(2_000),
    objectiveRelations: z.array(objectiveRelationSchema).max(5_000),
    metricDefinitions: z.array(metricDefinitionSchema).min(1).max(2_000),
    metricObservations: z.array(metricObservationSchema).max(10_000),
    processDefinitions: z.array(processDefinitionSchema).min(1).max(500),
    processVersions: z.array(processVersionSchema).min(1).max(2_000),
    processNodes: z.array(processNodeSchema).min(1).max(10_000),
    tasks: z.array(taskSchema).min(1).max(5_000),
    taskDependencies: z.array(taskDependencySchema).max(10_000),
    deliverables: z.array(deliverableSchema).max(10_000),
    acceptances: z.array(acceptanceSchema).max(10_000),
    evidence: z.array(evidenceSchema).max(20_000),
    evidenceLinks: z.array(evidenceLinkSchema).max(50_000),
  })
  .strict()
  .superRefine((trace, context) => {
    const collections = [
      ['valueDefinitions', trace.valueDefinitions],
      ['strategies', trace.strategies],
      ['objectives', trace.objectives],
      ['objectiveRelations', trace.objectiveRelations],
      ['metricDefinitions', trace.metricDefinitions],
      ['metricObservations', trace.metricObservations],
      ['processDefinitions', trace.processDefinitions],
      ['tasks', trace.tasks],
      ['taskDependencies', trace.taskDependencies],
      ['deliverables', trace.deliverables],
      ['acceptances', trace.acceptances],
      ['evidence', trace.evidence],
      ['evidenceLinks', trace.evidenceLinks],
    ] as const;
    for (const [path, records] of collections) {
      addDuplicateIssues(context, path, records);
    }
    addDuplicateIdIssues(context, 'valueVersions', trace.valueVersions);
    addDuplicateIdIssues(context, 'processVersions', trace.processVersions);
    addDuplicateIdIssues(context, 'processNodes', trace.processNodes);

    const valueDefinitions = indexById(trace.valueDefinitions);
    const valueVersions = indexById(trace.valueVersions);
    const strategies = indexById(trace.strategies);
    const objectives = indexById(trace.objectives);
    const metricDefinitions = indexById(trace.metricDefinitions);
    const metricObservations = indexById(trace.metricObservations);
    const processDefinitions = indexById(trace.processDefinitions);
    const processVersions = indexById(trace.processVersions);
    const processNodes = indexById(trace.processNodes);
    const tasks = indexById(trace.tasks);
    const deliverables = indexById(trace.deliverables);
    const acceptances = indexById(trace.acceptances);
    const evidence = indexById(trace.evidence);

    if (
      hasDirectedCycle(
        trace.objectives.flatMap((objective) =>
          objective.parentObjectiveId === null
            ? []
            : [[objective.parentObjectiveId, objective.id] as const],
        ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Objective parent relationships must be acyclic.',
        path: ['objectives'],
      });
    }
    if (
      hasDirectedCycle(
        trace.taskDependencies
          .filter((dependency) => dependency.status === 'ACTIVE')
          .map((dependency) => [dependency.predecessorTaskId, dependency.successorTaskId] as const),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Active Task dependencies must be acyclic.',
        path: ['taskDependencies'],
      });
    }
    if (
      !uniqueStrings(
        trace.objectiveRelations.map(
          (relation) =>
            `${relation.sourceObjectiveId}:${relation.targetObjectiveId}:${relation.type}`,
        ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Objective relation endpoint/type tuples must be unique.',
        path: ['objectiveRelations'],
      });
    }
    if (
      !uniqueStrings(
        trace.taskDependencies.map(
          (dependency) =>
            `${dependency.predecessorTaskId}:${dependency.successorTaskId}:${dependency.type}`,
        ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Task dependency endpoint/type tuples must be unique.',
        path: ['taskDependencies'],
      });
    }

    const rootTask = tasks.get(trace.rootTaskId);
    if (rootTask === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'rootTaskId must reference a Task included in the trace.',
        path: ['rootTaskId'],
      });
    }

    for (const [index, definition] of trace.valueDefinitions.entries()) {
      requireSameTenant(context, trace.tenantId, definition, [
        'valueDefinitions',
        index,
        'tenantId',
      ]);
      if (
        definition.currentVersionId !== null &&
        valueVersions.get(definition.currentVersionId)?.valueDefinitionId !== definition.id
      ) {
        context.addIssue({
          code: 'custom',
          message: 'currentVersionId must reference a Value Version of this definition.',
          path: ['valueDefinitions', index, 'currentVersionId'],
        });
      }
    }

    for (const [index, version] of trace.valueVersions.entries()) {
      requireSameTenant(context, trace.tenantId, version, ['valueVersions', index, 'tenantId']);
      if (!valueDefinitions.has(version.valueDefinitionId)) {
        context.addIssue({
          code: 'custom',
          message: 'Value Version references a missing Value Definition.',
          path: ['valueVersions', index, 'valueDefinitionId'],
        });
      } else if (!periodContains(valueDefinitions.get(version.valueDefinitionId)!, version)) {
        context.addIssue({
          code: 'custom',
          message: 'Value Version effective period must fit within its Value Definition.',
          path: ['valueVersions', index, 'effectiveFrom'],
        });
      }
      for (const [metricIndex, metric] of version.metrics.entries()) {
        if (!metricDefinitions.has(metric.metricDefinitionId)) {
          context.addIssue({
            code: 'custom',
            message: 'Value Metric references a missing Metric Definition.',
            path: ['valueVersions', index, 'metrics', metricIndex, 'metricDefinitionId'],
          });
        }
      }
    }

    for (const [index, strategy] of trace.strategies.entries()) {
      requireSameTenant(context, trace.tenantId, strategy, ['strategies', index, 'tenantId']);
      for (const valueVersionId of strategy.valueVersionIds) {
        if (!valueVersions.has(valueVersionId)) {
          context.addIssue({
            code: 'custom',
            message: 'Strategy references a missing Value Version.',
            path: ['strategies', index, 'valueVersionIds'],
          });
        }
      }
    }

    for (const [index, objective] of trace.objectives.entries()) {
      requireSameTenant(context, trace.tenantId, objective, ['objectives', index, 'tenantId']);
      if (!strategies.has(objective.strategyId)) {
        context.addIssue({
          code: 'custom',
          message: 'Objective references a missing Strategy.',
          path: ['objectives', index, 'strategyId'],
        });
      } else if (!periodContains(strategies.get(objective.strategyId)!, objective)) {
        context.addIssue({
          code: 'custom',
          message: 'Objective effective period must fit within its Strategy.',
          path: ['objectives', index, 'effectiveFrom'],
        });
      }
      if (objective.parentObjectiveId !== null && !objectives.has(objective.parentObjectiveId)) {
        context.addIssue({
          code: 'custom',
          message: 'Objective references a missing parent Objective.',
          path: ['objectives', index, 'parentObjectiveId'],
        });
      } else if (
        objective.parentObjectiveId !== null &&
        objectives.get(objective.parentObjectiveId)?.strategyId !== objective.strategyId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Parent and child Objectives must belong to the same Strategy version.',
          path: ['objectives', index, 'parentObjectiveId'],
        });
      }
      for (const valueVersionId of objective.valueVersionIds) {
        if (!valueVersions.has(valueVersionId)) {
          context.addIssue({
            code: 'custom',
            message: 'Objective references a missing Value Version.',
            path: ['objectives', index, 'valueVersionIds'],
          });
        }
      }
      for (const metricDefinitionId of objective.metricDefinitionIds) {
        if (!metricDefinitions.has(metricDefinitionId)) {
          context.addIssue({
            code: 'custom',
            message: 'Objective references a missing Metric Definition.',
            path: ['objectives', index, 'metricDefinitionIds'],
          });
        }
      }
    }

    for (const [index, relation] of trace.objectiveRelations.entries()) {
      requireSameTenant(context, trace.tenantId, relation, [
        'objectiveRelations',
        index,
        'tenantId',
      ]);
      const source = objectives.get(relation.sourceObjectiveId);
      const target = objectives.get(relation.targetObjectiveId);
      if (source === undefined || target === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Objective relation endpoints must both be included.',
          path: ['objectiveRelations', index],
        });
        continue;
      }
      if (source.strategyId !== target.strategyId) {
        context.addIssue({
          code: 'custom',
          message: 'Objective relation endpoints must belong to the same Strategy version.',
          path: ['objectiveRelations', index],
        });
      }
      if (relation.type === 'PARENT_CHILD' && target.parentObjectiveId !== source.id) {
        context.addIssue({
          code: 'custom',
          message: 'PARENT_CHILD direction must run from parent to child.',
          path: ['objectiveRelations', index, 'type'],
        });
      }
      if (
        relation.type === 'CAUSES' &&
        (source.indicatorType !== 'LEADING' || target.indicatorType !== 'LAGGING')
      ) {
        context.addIssue({
          code: 'custom',
          message: 'CAUSES must connect a LEADING Objective to a LAGGING Objective.',
          path: ['objectiveRelations', index, 'type'],
        });
      }
    }

    for (const [index, metric] of trace.metricDefinitions.entries()) {
      requireSameTenant(context, trace.tenantId, metric, ['metricDefinitions', index, 'tenantId']);
    }

    for (const [index, observation] of trace.metricObservations.entries()) {
      requireSameTenant(context, trace.tenantId, observation, [
        'metricObservations',
        index,
        'tenantId',
      ]);
      if (!metricDefinitions.has(observation.metricDefinitionId)) {
        context.addIssue({
          code: 'custom',
          message: 'Metric Observation references a missing Metric Definition.',
          path: ['metricObservations', index, 'metricDefinitionId'],
        });
      } else {
        const definition = metricDefinitions.get(observation.metricDefinitionId)!;
        if (
          definition.validRange !== null &&
          (observation.value < definition.validRange.minimum ||
            observation.value > definition.validRange.maximum)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Metric Observation value falls outside the Metric valid range.',
            path: ['metricObservations', index, 'value'],
          });
        }
      }
      if (!traceSubjectExists(observation.subject, trace)) {
        context.addIssue({
          code: 'custom',
          message: 'Metric Observation subject is missing or has a different version.',
          path: ['metricObservations', index, 'subject'],
        });
      }
      if (observation.evidenceIds.some((id) => !evidence.has(id))) {
        context.addIssue({
          code: 'custom',
          message: 'Metric Observation references missing Evidence.',
          path: ['metricObservations', index, 'evidenceIds'],
        });
      }
    }

    if (
      !uniqueStrings(
        trace.processNodes.map(
          (node) => `${node.processDefinitionId}:${node.processVersionId}:${node.code}`,
        ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Process node codes must be unique within each Process Version.',
        path: ['processNodes'],
      });
    }

    for (const [index, definition] of trace.processDefinitions.entries()) {
      requireSameTenant(context, trace.tenantId, definition, [
        'processDefinitions',
        index,
        'tenantId',
      ]);
      if (definition.currentVersionId !== null) {
        const currentVersion = processVersions.get(definition.currentVersionId);
        if (currentVersion === undefined || currentVersion.processDefinitionId !== definition.id) {
          context.addIssue({
            code: 'custom',
            message: 'currentVersionId must reference a Process Version of this definition.',
            path: ['processDefinitions', index, 'currentVersionId'],
          });
        }
      }
    }

    for (const [index, version] of trace.processVersions.entries()) {
      requireSameTenant(context, trace.tenantId, version, ['processVersions', index, 'tenantId']);
      const definition = processDefinitions.get(version.processDefinitionId);
      if (definition === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Process Version references a missing Process Definition.',
          path: ['processVersions', index, 'processDefinitionId'],
        });
      } else if (!periodContains(definition, version)) {
        context.addIssue({
          code: 'custom',
          message: 'Process Version effective period must fit within its Process Definition.',
          path: ['processVersions', index, 'effectiveFrom'],
        });
      }
      for (const [nodeIndex, nestedNode] of version.nodes.entries()) {
        const traceNode = processNodes.get(nestedNode.id);
        if (
          traceNode === undefined ||
          traceNode.tenantId !== nestedNode.tenantId ||
          traceNode.processDefinitionId !== nestedNode.processDefinitionId ||
          traceNode.processVersionId !== nestedNode.processVersionId ||
          traceNode.processVersion !== nestedNode.processVersion ||
          traceNode.code !== nestedNode.code
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Process Version node is missing or has mismatched identity in the trace.',
            path: ['processVersions', index, 'nodes', nodeIndex],
          });
        }
      }
    }

    for (const [index, node] of trace.processNodes.entries()) {
      requireSameTenant(context, trace.tenantId, node, ['processNodes', index, 'tenantId']);
      const version = processVersions.get(node.processVersionId);
      if (
        version === undefined ||
        version.processDefinitionId !== node.processDefinitionId ||
        version.version !== node.processVersion
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Process Node references a missing or mismatched Process Version.',
          path: ['processNodes', index, 'processVersionId'],
        });
      }
    }

    for (const [index, task] of trace.tasks.entries()) {
      requireSameTenant(context, trace.tenantId, task, ['tasks', index, 'tenantId']);
      const objective = objectives.get(task.objectiveId);
      const valueDefinition = valueDefinitions.get(task.valueDefinitionId);
      const valueVersion = valueVersions.get(task.valueVersionId);
      if (objective === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Task references a missing Objective.',
          path: ['tasks', index, 'objectiveId'],
        });
      } else if (!periodContains(objective, task)) {
        context.addIssue({
          code: 'custom',
          message: 'Task effective period must fit within its Objective.',
          path: ['tasks', index, 'effectiveFrom'],
        });
      }
      if (valueDefinition === undefined || valueVersion === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Task must reference included Value Definition and Value Version.',
          path: ['tasks', index, 'valueVersionId'],
        });
      } else if (valueVersion.valueDefinitionId !== valueDefinition.id) {
        context.addIssue({
          code: 'custom',
          message: 'Task Value Version does not belong to its Value Definition.',
          path: ['tasks', index, 'valueVersionId'],
        });
      } else if (!periodContains(valueVersion, task)) {
        context.addIssue({
          code: 'custom',
          message: 'Task effective period must fit within its Value Version.',
          path: ['tasks', index, 'effectiveFrom'],
        });
      }
      if (objective !== undefined && !objective.valueVersionIds.includes(task.valueVersionId)) {
        context.addIssue({
          code: 'custom',
          message: 'Task Value Version must be linked by its Objective.',
          path: ['tasks', index, 'valueVersionId'],
        });
      }
      if (
        objective !== undefined &&
        strategies.get(objective.strategyId)?.valueVersionIds.includes(task.valueVersionId) !== true
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Task Value Version must be linked by its Strategy.',
          path: ['tasks', index, 'valueVersionId'],
        });
      }
      const processDefinition = processDefinitions.get(task.processRef.definitionId);
      const processVersion = processVersions.get(task.processRef.versionId);
      const processNode = processNodes.get(task.processRef.nodeId);
      if (
        processDefinition === undefined ||
        processDefinition.code !== task.processRef.definitionCode
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Task Process Definition is missing or has a different code.',
          path: ['tasks', index, 'processRef', 'definitionId'],
        });
      } else if (!periodContains(processDefinition, task)) {
        context.addIssue({
          code: 'custom',
          message: 'Task effective period must fit within its Process Definition.',
          path: ['tasks', index, 'effectiveFrom'],
        });
      }
      if (
        processVersion === undefined ||
        processVersion.processDefinitionId !== task.processRef.definitionId ||
        processVersion.version !== task.processRef.version
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Task Process Version is missing or has mismatched definition/version identity.',
          path: ['tasks', index, 'processRef', 'versionId'],
        });
      } else if (!periodContains(processVersion, task)) {
        context.addIssue({
          code: 'custom',
          message: 'Task effective period must fit within its Process Version.',
          path: ['tasks', index, 'effectiveFrom'],
        });
      }
      if (
        processNode === undefined ||
        processNode.processDefinitionId !== task.processRef.definitionId ||
        processNode.processVersionId !== task.processRef.versionId ||
        processNode.processVersion !== task.processRef.version ||
        processNode.code !== task.processRef.nodeCode
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Task Process Node is missing or has mismatched version/code identity.',
          path: ['tasks', index, 'processRef', 'nodeId'],
        });
      }
    }

    for (const [index, dependency] of trace.taskDependencies.entries()) {
      requireSameTenant(context, trace.tenantId, dependency, [
        'taskDependencies',
        index,
        'tenantId',
      ]);
      if (!tasks.has(dependency.predecessorTaskId) || !tasks.has(dependency.successorTaskId)) {
        context.addIssue({
          code: 'custom',
          message: 'Task dependency endpoints must both be included.',
          path: ['taskDependencies', index],
        });
      }
    }

    for (const [index, deliverable] of trace.deliverables.entries()) {
      requireSameTenant(context, trace.tenantId, deliverable, ['deliverables', index, 'tenantId']);
      if (!tasks.has(deliverable.taskId)) {
        context.addIssue({
          code: 'custom',
          message: 'Deliverable references a missing Task.',
          path: ['deliverables', index, 'taskId'],
        });
      } else if (!periodContains(tasks.get(deliverable.taskId)!, deliverable)) {
        context.addIssue({
          code: 'custom',
          message: 'Deliverable effective period must fit within its Task.',
          path: ['deliverables', index, 'effectiveFrom'],
        });
      }
    }

    for (const [index, acceptance] of trace.acceptances.entries()) {
      requireSameTenant(context, trace.tenantId, acceptance, ['acceptances', index, 'tenantId']);
      if (!deliverables.has(acceptance.deliverableId)) {
        context.addIssue({
          code: 'custom',
          message: 'Acceptance references a missing Deliverable.',
          path: ['acceptances', index, 'deliverableId'],
        });
      }
      if (acceptance.evidenceIds.some((id) => !evidence.has(id))) {
        context.addIssue({
          code: 'custom',
          message: 'Acceptance references missing Evidence.',
          path: ['acceptances', index, 'evidenceIds'],
        });
      }
    }

    for (const [index, item] of trace.evidence.entries()) {
      requireSameTenant(context, trace.tenantId, item, ['evidence', index, 'tenantId']);
    }

    const linkedEvidenceIds = new Set<string>();
    for (const [index, link] of trace.evidenceLinks.entries()) {
      requireSameTenant(context, trace.tenantId, link, ['evidenceLinks', index, 'tenantId']);
      if (!evidence.has(link.evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: 'Evidence Link references missing Evidence.',
          path: ['evidenceLinks', index, 'evidenceId'],
        });
      } else {
        linkedEvidenceIds.add(link.evidenceId);
      }
      if (!traceEvidenceTargetExists(link, trace)) {
        context.addIssue({
          code: 'custom',
          message: 'Evidence Link target is missing or has a different version.',
          path: ['evidenceLinks', index, 'targetId'],
        });
      }
    }
    for (const [index, item] of trace.evidence.entries()) {
      if (!linkedEvidenceIds.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Every Evidence record in a complete trace must have an Evidence Link.',
          path: ['evidence', index, 'id'],
        });
      }
    }

    if (rootTask !== undefined) {
      const rootDeliverables = trace.deliverables.filter(
        (deliverable) => deliverable.taskId === rootTask.id,
      );
      if (
        ['DELIVERED', 'ACCEPTED', 'REJECTED'].includes(rootTask.status) &&
        rootDeliverables.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A delivered or decided root Task requires a Deliverable.',
          path: ['deliverables'],
        });
      }
      for (const deliverable of rootDeliverables) {
        if (!['ACCEPTED', 'REJECTED'].includes(deliverable.status)) continue;
        const decisions = trace.acceptances.filter(
          (acceptance) =>
            acceptance.deliverableId === deliverable.id && acceptance.status === 'ACTIVE',
        );
        const statusMatched = decisions.some((acceptance) =>
          deliverable.status === 'ACCEPTED'
            ? acceptance.decision === 'ACCEPTED'
            : acceptance.decision !== 'ACCEPTED',
        );
        if (!statusMatched) {
          context.addIssue({
            code: 'custom',
            message: 'A decided root Deliverable requires a matching active Acceptance record.',
            path: ['acceptances'],
          });
        }
      }
    }
  });

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueCodes(values: readonly { readonly code: string }[]): boolean {
  return uniqueStrings(values.map((value) => value.code));
}

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function hasValidEffectivePeriod(value: {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}): boolean {
  return (
    value.effectiveTo === null || timestamp(value.effectiveTo) > timestamp(value.effectiveFrom)
  );
}

function hasValidPartialEffectivePeriod(value: {
  readonly effectiveFrom?: string | undefined;
  readonly effectiveTo?: string | null | undefined;
}): boolean {
  return (
    value.effectiveFrom === undefined ||
    value.effectiveTo === undefined ||
    value.effectiveTo === null ||
    timestamp(value.effectiveTo) > timestamp(value.effectiveFrom)
  );
}

function hasMutationBeyondExpectedRevision(value: object): boolean {
  return Object.keys(value).some((key) => !key.startsWith('expected'));
}

function hasWeightTotalOfOne(values: readonly { readonly weight: number }[]): boolean {
  return Math.abs(values.reduce((sum, value) => sum + value.weight, 0) - 1) <= 1e-6;
}

function hasDisjointBehaviorSets(value: {
  readonly positiveBehaviors: readonly string[];
  readonly negativeBehaviors: readonly string[];
}): boolean {
  const positive = new Set(value.positiveBehaviors.map(normalizedText));
  return value.negativeBehaviors.every((behavior) => !positive.has(normalizedText(behavior)));
}

function hasValidProcessNodeInputs(value: {
  readonly nodes: readonly {
    readonly code: string;
    readonly type: z.infer<typeof processNodeTypeSchema>;
  }[];
}): boolean {
  return (
    uniqueStrings(value.nodes.map((node) => node.code)) &&
    value.nodes.some((node) => node.type === 'START') &&
    value.nodes.some((node) => node.type === 'END')
  );
}

function hasValidObservationPeriod(value: {
  readonly periodStart: string;
  readonly periodEnd: string;
}): boolean {
  return timestamp(value.periodEnd) > timestamp(value.periodStart);
}

function hasDueDateWithinEffectivePeriod(value: {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly dueAt: string;
}): boolean {
  const dueAt = timestamp(value.dueAt);
  return (
    dueAt >= timestamp(value.effectiveFrom) &&
    (value.effectiveTo === null || dueAt <= timestamp(value.effectiveTo))
  );
}

function timestampWithinPeriod(
  value: string,
  period: {
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  },
): boolean {
  const instant = timestamp(value);
  return (
    instant >= timestamp(period.effectiveFrom) &&
    (period.effectiveTo === null || instant <= timestamp(period.effectiveTo))
  );
}

function periodContains(
  outer: {
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  },
  inner: {
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  },
): boolean {
  return (
    timestamp(inner.effectiveFrom) >= timestamp(outer.effectiveFrom) &&
    (outer.effectiveTo === null ||
      (inner.effectiveTo !== null && timestamp(inner.effectiveTo) <= timestamp(outer.effectiveTo)))
  );
}

function hasDirectedCycle(edges: readonly (readonly [source: string, target: string])[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const [source, target] of edges) {
    const targets = outgoing.get(source) ?? [];
    targets.push(target);
    outgoing.set(source, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of outgoing.get(node) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...outgoing.keys()].some(visit);
}

function hasValidDeliverableSubmissionState(value: {
  readonly status: z.infer<typeof deliverableStatusSchema>;
  readonly submittedAt: string | null;
  readonly artifactUri: string | null;
  readonly contentHash: string | null;
}): boolean {
  const isEmpty =
    value.submittedAt === null && value.artifactUri === null && value.contentHash === null;
  const isSubmitted =
    value.submittedAt !== null && value.artifactUri !== null && value.contentHash !== null;
  if (value.status === 'DRAFT') return isEmpty;
  if (value.status === 'WITHDRAWN') return isEmpty || isSubmitted;
  return isSubmitted;
}

function hasDecisionConsistentWithCriteria(value: {
  readonly decision: z.infer<typeof acceptanceDecisionSchema>;
  readonly criteria: readonly {
    readonly mandatory: boolean;
    readonly passed: boolean;
  }[];
}): boolean {
  const mandatoryFailed = value.criteria.some(
    (criterion) => criterion.mandatory && !criterion.passed,
  );
  const anyFailed = value.criteria.some((criterion) => !criterion.passed);
  return value.decision === 'ACCEPTED' ? !mandatoryFailed : anyFailed;
}

function hasConsistentVerification(value: {
  readonly verifiedBy: unknown | null;
  readonly verifiedAt: string | null;
}): boolean {
  return (value.verifiedBy === null) === (value.verifiedAt === null);
}

function hasConsistentPartialVerification(value: {
  readonly verifiedBy?: unknown | null | undefined;
  readonly verifiedAt?: string | null | undefined;
}): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, 'verifiedBy') ===
    Object.prototype.hasOwnProperty.call(value, 'verifiedAt')
  );
}

function indexById<T extends { readonly id: string }>(
  records: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

function addDuplicateIssues(
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void;
  },
  path: string,
  records: readonly { readonly id: string; readonly code: string }[],
): void {
  addDuplicateIdIssues(context, path, records);
  const seenCodes = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (seenCodes.has(record.code)) {
      context.addIssue({
        code: 'custom',
        message: `${path} codes must be unique.`,
        path: [path, index, 'code'],
      });
    }
    seenCodes.add(record.code);
  }
}

function addDuplicateIdIssues(
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void;
  },
  path: string,
  records: readonly { readonly id: string }[],
): void {
  const seenIds = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (seenIds.has(record.id)) {
      context.addIssue({
        code: 'custom',
        message: `${path} IDs must be unique.`,
        path: [path, index, 'id'],
      });
    }
    seenIds.add(record.id);
  }
}

function requireSameTenant(
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void;
  },
  tenantId: string,
  record: { readonly tenantId: string },
  path: (string | number)[],
): void {
  if (record.tenantId !== tenantId) {
    context.addIssue({
      code: 'custom',
      message: 'All trace records must belong to the trace tenant.',
      path,
    });
  }
}

function traceSubjectExists(
  subject: z.infer<typeof metricSubjectSchema>,
  trace: z.input<typeof businessSemanticTraceResponseSchema>,
): boolean {
  const collections: Record<
    z.infer<typeof metricSubjectTypeSchema>,
    readonly { readonly id: string; readonly version: number }[]
  > = {
    VALUE_VERSION: trace.valueVersions,
    STRATEGY: trace.strategies,
    OBJECTIVE: trace.objectives,
    TASK: trace.tasks,
    DELIVERABLE: trace.deliverables,
  };
  return collections[subject.type].some(
    (record) => record.id === subject.id && record.version === subject.version,
  );
}

function traceEvidenceTargetExists(
  link: z.infer<typeof evidenceLinkSchema>,
  trace: z.input<typeof businessSemanticTraceResponseSchema>,
): boolean {
  const collections: Record<
    z.infer<typeof evidenceTargetTypeSchema>,
    readonly { readonly id: string; readonly version: number }[]
  > = {
    VALUE_VERSION: trace.valueVersions,
    STRATEGY: trace.strategies,
    OBJECTIVE: trace.objectives,
    METRIC_OBSERVATION: trace.metricObservations,
    TASK: trace.tasks,
    DELIVERABLE: trace.deliverables,
    ACCEPTANCE: trace.acceptances,
  };
  return collections[link.targetType].some(
    (record) => record.id === link.targetId && record.version === link.targetVersion,
  );
}

export type BusinessOwnerType = z.infer<typeof businessOwnerTypeSchema>;
export type BusinessOwner = z.infer<typeof businessOwnerSchema>;
export type BusinessEffectivePeriod = z.infer<typeof businessEffectivePeriodSchema>;
export type ValueType = z.infer<typeof valueTypeSchema>;
export type ValueDefinition = z.infer<typeof valueDefinitionSchema>;
export type ValueVersion = z.infer<typeof valueVersionSchema>;
export type ValueMetric = z.infer<typeof valueMetricSchema>;
export type ValueConstraint = z.infer<typeof valueConstraintSchema>;
export type ValueVersionStatus = z.infer<typeof valueVersionStatusSchema>;
export type Strategy = z.infer<typeof strategySchema>;
export type Objective = z.infer<typeof objectiveSchema>;
export type ObjectiveRelation = z.infer<typeof objectiveRelationSchema>;
export type BscPerspective = z.infer<typeof bscPerspectiveSchema>;
export type IndicatorType = z.infer<typeof indicatorTypeSchema>;
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricObservation = z.infer<typeof metricObservationSchema>;
export type ProcessDefinition = z.infer<typeof processDefinitionSchema>;
export type ProcessVersion = z.infer<typeof processVersionSchema>;
export type ProcessNode = z.infer<typeof processNodeSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskDependency = z.infer<typeof taskDependencySchema>;
export type Deliverable = z.infer<typeof deliverableSchema>;
export type Acceptance = z.infer<typeof acceptanceSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export type BusinessSemanticTraceResponse = z.infer<typeof businessSemanticTraceResponseSchema>;
export type WorkbenchObjectiveListResponse = z.infer<typeof workbenchObjectiveListResponseSchema>;
export type WorkbenchTaskListResponse = z.infer<typeof workbenchTaskListResponseSchema>;
export type CreateValueDefinitionRequest = z.infer<typeof createValueDefinitionRequestSchema>;
export type UpdateValueDefinitionRequest = z.infer<typeof updateValueDefinitionRequestSchema>;
export type CreateValueMetricRequest = z.infer<typeof createValueMetricRequestSchema>;
export type UpdateValueMetricRequest = z.infer<typeof updateValueMetricRequestSchema>;
export type CreateValueConstraintRequest = z.infer<typeof createValueConstraintRequestSchema>;
export type UpdateValueConstraintRequest = z.infer<typeof updateValueConstraintRequestSchema>;
export type CreateValueVersionRequest = z.infer<typeof createValueVersionRequestSchema>;
export type UpdateValueVersionRequest = z.infer<typeof updateValueVersionRequestSchema>;
export type TransitionValueVersionRequest = z.infer<typeof transitionValueVersionRequestSchema>;
export type CreateStrategyRequest = z.infer<typeof createStrategyRequestSchema>;
export type UpdateStrategyRequest = z.infer<typeof updateStrategyRequestSchema>;
export type TransitionStrategyRequest = z.infer<typeof transitionStrategyRequestSchema>;
export type CreateObjectiveRequest = z.infer<typeof createObjectiveRequestSchema>;
export type UpdateObjectiveRequest = z.infer<typeof updateObjectiveRequestSchema>;
export type TransitionObjectiveRequest = z.infer<typeof transitionObjectiveRequestSchema>;
export type CreateObjectiveRelationRequest = z.infer<typeof createObjectiveRelationRequestSchema>;
export type UpdateObjectiveRelationRequest = z.infer<typeof updateObjectiveRelationRequestSchema>;
export type TransitionObjectiveRelationRequest = z.infer<
  typeof transitionObjectiveRelationRequestSchema
>;
export type CreateMetricDefinitionRequest = z.infer<typeof createMetricDefinitionRequestSchema>;
export type UpdateMetricDefinitionRequest = z.infer<typeof updateMetricDefinitionRequestSchema>;
export type TransitionMetricDefinitionRequest = z.infer<
  typeof transitionMetricDefinitionRequestSchema
>;
export type CreateMetricObservationRequest = z.infer<typeof createMetricObservationRequestSchema>;
export type UpdateMetricObservationRequest = z.infer<typeof updateMetricObservationRequestSchema>;
export type CreateProcessDefinitionRequest = z.infer<typeof createProcessDefinitionRequestSchema>;
export type UpdateProcessDefinitionRequest = z.infer<typeof updateProcessDefinitionRequestSchema>;
export type CreateProcessVersionRequest = z.infer<typeof createProcessVersionRequestSchema>;
export type UpdateProcessVersionRequest = z.infer<typeof updateProcessVersionRequestSchema>;
export type TransitionProcessVersionRequest = z.infer<typeof transitionProcessVersionRequestSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type TransitionTaskRequest = z.infer<typeof transitionTaskRequestSchema>;
export type CreateTaskDependencyRequest = z.infer<typeof createTaskDependencyRequestSchema>;
export type UpdateTaskDependencyRequest = z.infer<typeof updateTaskDependencyRequestSchema>;
export type TransitionTaskDependencyRequest = z.infer<typeof transitionTaskDependencyRequestSchema>;
export type CreateDeliverableRequest = z.infer<typeof createDeliverableRequestSchema>;
export type UpdateDeliverableRequest = z.infer<typeof updateDeliverableRequestSchema>;
export type TransitionDeliverableRequest = z.infer<typeof transitionDeliverableRequestSchema>;
export type CreateAcceptanceRequest = z.infer<typeof createAcceptanceRequestSchema>;
export type UpdateAcceptanceRequest = z.infer<typeof updateAcceptanceRequestSchema>;
export type TransitionAcceptanceRequest = z.infer<typeof transitionAcceptanceRequestSchema>;
export type CreateEvidenceRequest = z.infer<typeof createEvidenceRequestSchema>;
export type UpdateEvidenceRequest = z.infer<typeof updateEvidenceRequestSchema>;
export type TransitionEvidenceRequest = z.infer<typeof transitionEvidenceRequestSchema>;
export type CreateEvidenceLinkRequest = z.infer<typeof createEvidenceLinkRequestSchema>;
export type UpdateEvidenceLinkRequest = z.infer<typeof updateEvidenceLinkRequestSchema>;
export type TransitionEvidenceLinkRequest = z.infer<typeof transitionEvidenceLinkRequestSchema>;
