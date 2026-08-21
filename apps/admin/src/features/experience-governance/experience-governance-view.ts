import type { ExperienceCandidate, ExperienceStatus } from '@enterprise/contracts';

export type ExperienceAction =
  'SANITIZE' | 'STRUCTURE' | 'APPROVE' | 'REJECT' | 'VALIDATE' | 'PUBLISH' | 'MONITOR' | 'RETIRE';

export const EXPERIENCE_STAGES: readonly ExperienceStatus[] = [
  'CANDIDATE',
  'SANITIZED',
  'STRUCTURED',
  'APPROVED',
  'VALIDATED',
  'PUBLISHED',
  'MONITORED',
  'RETIRED',
];

export function availableExperienceActions(status: ExperienceStatus): readonly ExperienceAction[] {
  const actions: Readonly<Record<ExperienceStatus, readonly ExperienceAction[]>> = {
    CANDIDATE: ['SANITIZE'],
    SANITIZED: ['STRUCTURE'],
    STRUCTURED: ['APPROVE', 'REJECT'],
    APPROVED: ['VALIDATE'],
    REJECTED: [],
    VALIDATED: ['PUBLISH', 'RETIRE'],
    PUBLISHED: ['MONITOR', 'RETIRE'],
    MONITORED: ['MONITOR', 'RETIRE'],
    RETIRED: [],
  };
  return actions[status];
}

export function experienceStatusLabel(status: ExperienceStatus): string {
  return (
    {
      CANDIDATE: '候选',
      SANITIZED: '已脱敏',
      STRUCTURED: '已结构化',
      APPROVED: '审核通过',
      REJECTED: '审核驳回',
      VALIDATED: '验证通过',
      PUBLISHED: '已发布',
      MONITORED: '运营观察',
      RETIRED: '已下架',
    } satisfies Record<ExperienceStatus, string>
  )[status];
}

export function experienceActionLabel(action: ExperienceAction): string {
  return (
    {
      SANITIZE: '提交脱敏结果',
      STRUCTURE: '提交结构化经验',
      APPROVE: '专家审核通过',
      REJECT: '专家审核驳回',
      VALIDATE: '登记验证结果',
      PUBLISH: '发布到知识库',
      MONITOR: '更新运营效果',
      RETIRE: '下架或回滚',
    } satisfies Record<ExperienceAction, string>
  )[action];
}

export function experienceProgress(candidate: ExperienceCandidate): number {
  if (candidate.status === 'REJECTED') return 3;
  return Math.max(0, EXPERIENCE_STAGES.indexOf(candidate.status));
}

export function transitionPayloadTemplate(
  action: ExperienceAction,
  candidate: ExperienceCandidate,
): Record<string, unknown> {
  const sourceEvidenceIds = candidate.sourceEvidenceIds;
  switch (action) {
    case 'SANITIZE':
      return {
        sanitizedContent: candidate.candidateSummary,
        sanitizedHash: candidate.rawInputHash,
        piiRemoved: true,
        secretsRemoved: true,
        customerIdentifiersRemoved: true,
        findings: [],
      };
    case 'STRUCTURE':
      return {
        structuredContent: {
          scenario: '',
          problem: '',
          steps: [''],
          preconditions: [],
          counterexamples: [],
          risks: [],
          outcomes: [''],
          applicabilityBoundaries: [''],
        },
        structuredHash: candidate.sanitization?.sanitizedHash ?? candidate.rawInputHash,
      };
    case 'APPROVE':
    case 'REJECT':
      return {
        evidenceIds: sourceEvidenceIds,
      };
    case 'VALIDATE':
      return {
        validationRunId: '',
        datasetVersionId: '',
        passed: true,
        score: 0.8,
        threshold: 0.8,
        sideEffects: [],
      };
    case 'PUBLISH':
      return {
        knowledgeBaseId: '',
        documentId: '',
        documentVersionId: '',
        documentVersion: 1,
        targetRoleTemplateIds: [],
        targetOrgUnitIds: [],
        publicationHash: candidate.structuredHash ?? candidate.rawInputHash,
      };
    case 'MONITOR':
      return {
        useCount: candidate.monitoredUseCount,
        adoptionCount: candidate.monitoredAdoptionCount,
        complaintCount: candidate.monitoredComplaintCount,
      };
    case 'RETIRE':
      return {
        replacementExperienceId: null,
        rollbackDocumentVersionId: null,
      };
  }
}

export function splitIdentifiers(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function experienceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '经验治理服务暂时不可用，请稍后重试。';
}

export function formatExperienceDate(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}
