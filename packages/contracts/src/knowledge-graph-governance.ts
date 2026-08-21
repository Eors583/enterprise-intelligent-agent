import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const REVISION = z.number().int().positive();
const IDEMPOTENCY_KEY = z.string().trim().min(8).max(200);
const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const CODE = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(120)
  .regex(/^[A-Z0-9]+(?:[._:-][A-Z0-9]+)*$/u);

export const knowledgeOntologyVersionStatusSchema = z.enum([
  'DRAFT',
  'IN_REVIEW',
  'PUBLISHED',
  'RETIRED',
]);

export const knowledgeGraphCorrectionStatusSchema = z.enum([
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'APPLIED',
]);

export const knowledgeGraphCorrectionActionSchema = z.enum([
  'MERGE_ENTITY',
  'ADD_ALIAS',
  'UPSERT_RELATION_VALIDITY',
  'RESOLVE_CONFLICT',
]);

export const knowledgeGraphConflictStatusSchema = z.enum([
  'OPEN',
  'IN_REVIEW',
  'RESOLVED',
  'REJECTED',
]);

export const knowledgeGraphConflictTargetTypeSchema = z.enum(['ENTITY', 'RELATION']);

export const knowledgeGraphProjectionStatusSchema = z.enum(['CANDIDATE', 'ACTIVE', 'OBSOLETE']);

export const knowledgeOntologyEntityTypeInputSchema = z
  .object({
    key: CODE,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).nullable().default(null),
    attributesSchema: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const knowledgeOntologyPredicateInputSchema = z
  .object({
    key: CODE,
    predicate: CODE,
    label: z.string().trim().min(1).max(200),
    domainTypeKey: CODE,
    rangeTypeKey: CODE,
    inversePredicateKey: CODE.nullable().default(null),
    symmetric: z.boolean().default(false),
    functional: z.boolean().default(false),
    allowSelfLoop: z.boolean().default(false),
    temporal: z.boolean().default(false),
    attributesSchema: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.symmetric && value.inversePredicateKey !== null) {
      context.addIssue({
        code: 'custom',
        path: ['inversePredicateKey'],
        message: 'A symmetric predicate cannot declare a separate inverse predicate.',
      });
    }
  });

const ontologyVersionDefinitionShape = {
  changeSummary: z.string().trim().min(1).max(500),
  entityTypes: z
    .array(knowledgeOntologyEntityTypeInputSchema)
    .min(1)
    .max(200)
    .refine(uniqueByKey, 'Entity type keys must be unique.'),
  predicates: z
    .array(knowledgeOntologyPredicateInputSchema)
    .max(500)
    .refine(uniqueByKey, 'Predicate keys must be unique.'),
  idempotencyKey: IDEMPOTENCY_KEY,
} as const;

export const createKnowledgeOntologyRequestSchema = z
  .object({
    code: CODE,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000).nullable().default(null),
    ...ontologyVersionDefinitionShape,
  })
  .strict()
  .superRefine(validateOntologyDefinition);

export const createKnowledgeOntologyVersionRequestSchema = z
  .object({
    expectedOntologyRevision: REVISION,
    ...ontologyVersionDefinitionShape,
  })
  .strict()
  .superRefine(validateOntologyDefinition);

export const transitionKnowledgeOntologyVersionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['SUBMIT', 'REQUEST_CHANGES', 'PUBLISH', 'RETIRE']),
    comment: z.string().trim().min(1).max(1_000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const knowledgeOntologyEntityTypeSchema = knowledgeOntologyEntityTypeInputSchema.extend({
  id: UUID,
});

export const knowledgeOntologyPredicateSchema = knowledgeOntologyPredicateInputSchema.extend({
  id: UUID,
});

export const knowledgeOntologyVersionSchema = z
  .object({
    id: UUID,
    ontologyId: UUID,
    versionNumber: z.number().int().positive(),
    revision: REVISION,
    status: knowledgeOntologyVersionStatusSchema,
    changeSummary: z.string().min(1).max(500),
    schemaHash: HASH,
    createdByUserId: UUID,
    submittedByUserId: UUID.nullable(),
    reviewedByUserId: UUID.nullable(),
    reviewComment: z.string().max(1_000).nullable(),
    submittedAt: TIMESTAMP.nullable(),
    reviewedAt: TIMESTAMP.nullable(),
    publishedAt: TIMESTAMP.nullable(),
    retiredAt: TIMESTAMP.nullable(),
    systemBootstrap: z.boolean(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    entityTypes: z.array(knowledgeOntologyEntityTypeSchema),
    predicates: z.array(knowledgeOntologyPredicateSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'PUBLISHED' &&
      !value.systemBootstrap &&
      (value.reviewedByUserId === null ||
        value.reviewedByUserId === value.createdByUserId ||
        value.publishedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedByUserId'],
        message: 'Published ontology versions require an independent checker.',
      });
    }
  });

export const knowledgeOntologySchema = z
  .object({
    id: UUID,
    knowledgeBaseId: UUID,
    code: CODE,
    name: z.string().min(1).max(200),
    description: z.string().max(4_000).nullable(),
    revision: REVISION,
    createdByUserId: UUID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    versions: z.array(knowledgeOntologyVersionSchema),
  })
  .strict();

export const knowledgeGraphConflictSchema = z
  .object({
    id: UUID,
    knowledgeBaseId: UUID,
    projectionId: UUID.nullable(),
    documentVersionId: UUID.nullable(),
    projectionStatus: knowledgeGraphProjectionStatusSchema.nullable(),
    targetType: knowledgeGraphConflictTargetTypeSchema,
    targetId: UUID,
    conflictKey: z.string().min(1).max(200),
    conflictType: CODE,
    schemaPredicate: z.string().min(1).max(200).nullable(),
    schemaSubjectType: z.string().min(1).max(100).nullable(),
    schemaObjectType: z.string().min(1).max(100).nullable(),
    occurrenceCount: z.number().int().positive(),
    details: z.record(z.string(), z.unknown()),
    evidence: z.array(z.record(z.string(), z.unknown())).max(100),
    status: knowledgeGraphConflictStatusSchema,
    revision: REVISION,
    detectedByUserId: UUID,
    reviewedByUserId: UUID.nullable(),
    resolutionCorrectionId: UUID.nullable(),
    reviewComment: z.string().max(1_000).nullable(),
    resolvedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const createKnowledgeGraphConflictRequestSchema = z
  .object({
    targetType: knowledgeGraphConflictTargetTypeSchema,
    targetId: UUID,
    conflictKey: z.string().trim().min(3).max(200),
    conflictType: CODE,
    details: z.record(z.string(), z.unknown()),
    evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const mergeEntityCorrectionPatchSchema = z
  .object({
    sourceEntityId: UUID,
    targetEntityId: UUID,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .refine((value) => value.sourceEntityId !== value.targetEntityId, {
    path: ['targetEntityId'],
    message: 'An entity cannot be merged into itself.',
  });

export const addEntityAliasCorrectionPatchSchema = z
  .object({
    entityId: UUID,
    alias: z.string().trim().min(1).max(500),
    sourceEvidence: z.record(z.string(), z.unknown()),
  })
  .strict();

export const relationValidityCorrectionPatchSchema = z
  .object({
    relationId: UUID,
    ontologyVersionId: UUID,
    predicateDefinitionId: UUID,
    validFrom: TIMESTAMP,
    validTo: TIMESTAMP.nullable(),
  })
  .strict()
  .refine(
    (value) => value.validTo === null || Date.parse(value.validTo) > Date.parse(value.validFrom),
    {
      path: ['validTo'],
      message: 'validTo must be later than validFrom.',
    },
  );

export const resolveGraphConflictCorrectionPatchSchema = z
  .object({
    conflictId: UUID,
    resolution: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const createKnowledgeGraphCorrectionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('MERGE_ENTITY'),
      patch: mergeEntityCorrectionPatchSchema,
      evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('ADD_ALIAS'),
      patch: addEntityAliasCorrectionPatchSchema,
      evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('UPSERT_RELATION_VALIDITY'),
      patch: relationValidityCorrectionPatchSchema,
      evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('RESOLVE_CONFLICT'),
      patch: resolveGraphConflictCorrectionPatchSchema,
      evidence: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
]);

export const transitionKnowledgeGraphCorrectionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'APPLY']),
    comment: z.string().trim().min(1).max(1_000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const transitionKnowledgeGraphCorrectionBatchRequestSchema = z
  .object({
    ontologyVersionId: UUID,
    action: z.enum(['APPROVE', 'APPLY']),
    comment: z.string().trim().min(1).max(1_000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const knowledgeGraphCorrectionBatchResultSchema = z
  .object({
    ontologyVersionId: UUID,
    action: z.enum(['APPROVE', 'APPLY']),
    matchedCount: z.number().int().nonnegative(),
    transitionedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

export const knowledgeGraphCorrectionSchema = z
  .object({
    id: UUID,
    knowledgeBaseId: UUID,
    action: knowledgeGraphCorrectionActionSchema,
    patch: z.record(z.string(), z.unknown()),
    evidence: z.array(z.record(z.string(), z.unknown())),
    evidenceHash: HASH,
    status: knowledgeGraphCorrectionStatusSchema,
    revision: REVISION,
    proposedByUserId: UUID,
    reviewedByUserId: UUID.nullable(),
    reviewComment: z.string().max(1_000).nullable(),
    reviewedAt: TIMESTAMP.nullable(),
    appliedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const knowledgeEntityMergeSchema = z.object({
  id: UUID,
  sourceEntityId: UUID,
  targetEntityId: UUID,
  correctionId: UUID,
  reason: z.string().min(1).max(1_000),
  evidenceHash: HASH,
  approvedByUserId: UUID,
  createdAt: TIMESTAMP,
});

export const knowledgeEntityAliasSchema = z.object({
  id: UUID,
  entityId: UUID,
  alias: z.string().min(1).max(500),
  normalizedAlias: z.string().min(1).max(500),
  active: z.boolean(),
  correctionId: UUID.nullable(),
  createdAt: TIMESTAMP,
  retiredAt: TIMESTAMP.nullable(),
});

export const knowledgeGraphGovernanceOverviewSchema = z
  .object({
    knowledgeBaseId: UUID,
    suggestedOntology: z
      .object({
        entityTypes: z.array(knowledgeOntologyEntityTypeInputSchema).max(200),
        predicates: z.array(knowledgeOntologyPredicateInputSchema).max(500),
        sourceEntityCount: z.number().int().nonnegative(),
        sourceRelationCount: z.number().int().nonnegative(),
        ungovernedRelationCount: z.number().int().nonnegative(),
      })
      .strict(),
    ontologies: z.array(knowledgeOntologySchema),
    conflicts: z.array(knowledgeGraphConflictSchema),
    corrections: z.array(knowledgeGraphCorrectionSchema),
    merges: z.array(knowledgeEntityMergeSchema),
    aliases: z.array(knowledgeEntityAliasSchema),
    retrieval: z.object({
      eligibleRelationCount: z.number().int().nonnegative(),
      excludedConflictCount: z.number().int().nonnegative(),
      mergedEntityCount: z.number().int().nonnegative(),
      publishedOntologyVersionCount: z.number().int().nonnegative(),
      ungovernedRelationCount: z.number().int().nonnegative(),
      pendingReviewRelationCount: z.number().int().nonnegative(),
      approvedRelationCount: z.number().int().nonnegative(),
    }),
  })
  .strict();

function uniqueByKey(values: readonly { readonly key: string }[]): boolean {
  return new Set(values.map((value) => value.key)).size === values.length;
}

function validateOntologyDefinition(
  value: {
    readonly entityTypes: readonly z.infer<typeof knowledgeOntologyEntityTypeInputSchema>[];
    readonly predicates: readonly z.infer<typeof knowledgeOntologyPredicateInputSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const entityTypes = new Set(value.entityTypes.map((item) => item.key));
  const predicates = new Map(value.predicates.map((item) => [item.key, item]));
  for (const [index, predicate] of value.predicates.entries()) {
    if (!entityTypes.has(predicate.domainTypeKey)) {
      context.addIssue({
        code: 'custom',
        path: ['predicates', index, 'domainTypeKey'],
        message: 'Predicate domainTypeKey must reference an entity type in the same version.',
      });
    }
    if (!entityTypes.has(predicate.rangeTypeKey)) {
      context.addIssue({
        code: 'custom',
        path: ['predicates', index, 'rangeTypeKey'],
        message: 'Predicate rangeTypeKey must reference an entity type in the same version.',
      });
    }
    if (predicate.inversePredicateKey !== null) {
      const inverse = predicates.get(predicate.inversePredicateKey);
      if (
        inverse === undefined ||
        inverse.inversePredicateKey !== predicate.key ||
        inverse.domainTypeKey !== predicate.rangeTypeKey ||
        inverse.rangeTypeKey !== predicate.domainTypeKey
      ) {
        context.addIssue({
          code: 'custom',
          path: ['predicates', index, 'inversePredicateKey'],
          message: 'Inverse predicates must be reciprocal and swap domain/range types.',
        });
      }
    }
  }
}

export type KnowledgeOntologyVersionStatus = z.infer<typeof knowledgeOntologyVersionStatusSchema>;
export type KnowledgeGraphCorrectionStatus = z.infer<typeof knowledgeGraphCorrectionStatusSchema>;
export type KnowledgeGraphCorrectionAction = z.infer<typeof knowledgeGraphCorrectionActionSchema>;
export type KnowledgeOntologyEntityTypeInput = z.infer<
  typeof knowledgeOntologyEntityTypeInputSchema
>;
export type KnowledgeOntologyPredicateInput = z.infer<typeof knowledgeOntologyPredicateInputSchema>;
export type CreateKnowledgeOntologyRequest = z.infer<typeof createKnowledgeOntologyRequestSchema>;
export type CreateKnowledgeOntologyVersionRequest = z.infer<
  typeof createKnowledgeOntologyVersionRequestSchema
>;
export type TransitionKnowledgeOntologyVersionRequest = z.infer<
  typeof transitionKnowledgeOntologyVersionRequestSchema
>;
export type KnowledgeOntology = z.infer<typeof knowledgeOntologySchema>;
export type KnowledgeOntologyVersion = z.infer<typeof knowledgeOntologyVersionSchema>;
export type KnowledgeGraphConflict = z.infer<typeof knowledgeGraphConflictSchema>;
export type CreateKnowledgeGraphConflictRequest = z.infer<
  typeof createKnowledgeGraphConflictRequestSchema
>;
export type CreateKnowledgeGraphCorrectionRequest = z.infer<
  typeof createKnowledgeGraphCorrectionRequestSchema
>;
export type TransitionKnowledgeGraphCorrectionRequest = z.infer<
  typeof transitionKnowledgeGraphCorrectionRequestSchema
>;
export type TransitionKnowledgeGraphCorrectionBatchRequest = z.infer<
  typeof transitionKnowledgeGraphCorrectionBatchRequestSchema
>;
export type KnowledgeGraphCorrectionBatchResult = z.infer<
  typeof knowledgeGraphCorrectionBatchResultSchema
>;
export type KnowledgeGraphCorrection = z.infer<typeof knowledgeGraphCorrectionSchema>;
export type KnowledgeEntityMerge = z.infer<typeof knowledgeEntityMergeSchema>;
export type KnowledgeEntityAlias = z.infer<typeof knowledgeEntityAliasSchema>;
export type KnowledgeGraphGovernanceOverview = z.infer<
  typeof knowledgeGraphGovernanceOverviewSchema
>;
