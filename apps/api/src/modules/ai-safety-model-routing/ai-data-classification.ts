import type { AiDataClassification } from '@enterprise/contracts';

const CLASSIFICATION_ORDER: readonly AiDataClassification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
];

export type KnowledgeDataClassification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'CONFIDENTIAL';

export function aiDataClassificationRank(value: AiDataClassification): number {
  return CLASSIFICATION_ORDER.indexOf(value);
}

export function maximumAiDataClassification(
  ...values: readonly AiDataClassification[]
): AiDataClassification {
  return values.reduce<AiDataClassification>(
    (maximum, value) =>
      aiDataClassificationRank(value) > aiDataClassificationRank(maximum) ? value : maximum,
    'PUBLIC',
  );
}

export function isAiDataClassificationAtMost(
  value: AiDataClassification,
  maximum: AiDataClassification,
): boolean {
  return aiDataClassificationRank(value) <= aiDataClassificationRank(maximum);
}

/**
 * Knowledge governance deliberately has no direct RESTRICTED label. SENSITIVE
 * knowledge is confidential model input, while CONFIDENTIAL knowledge is
 * restricted model input. Unknown values fail closed.
 */
export function knowledgeClassificationToAi(value: unknown): AiDataClassification {
  switch (value) {
    case 'PUBLIC':
      return 'PUBLIC';
    case 'INTERNAL':
      return 'INTERNAL';
    case 'SENSITIVE':
      return 'CONFIDENTIAL';
    case 'CONFIDENTIAL':
      return 'RESTRICTED';
    default:
      return 'RESTRICTED';
  }
}

/**
 * Until a tenant-scoped, classification-approved knowledge provider route is
 * persisted, only PUBLIC and INTERNAL content may leave the API process.
 */
export function isExternalKnowledgeAiApproved(classification: AiDataClassification): boolean {
  return isAiDataClassificationAtMost(classification, 'INTERNAL');
}
