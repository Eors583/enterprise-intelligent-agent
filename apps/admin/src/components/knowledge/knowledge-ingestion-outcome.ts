import type {
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';

export function latestKnowledgeVersion(
  document: Pick<KnowledgeDocumentSummary, 'versions'>,
): KnowledgeDocumentVersionSummary | null {
  return (
    [...document.versions].sort((left, right) => right.versionNumber - left.versionNumber)[0] ??
    null
  );
}

export function currentPublishedKnowledgeVersion(
  document: Pick<KnowledgeDocumentSummary, 'currentVersionId' | 'versions'>,
): KnowledgeDocumentVersionSummary | null {
  if (document.currentVersionId === null) return null;
  return document.versions.find((version) => version.id === document.currentVersionId) ?? null;
}

export function latestEditableDraft(
  document: Pick<KnowledgeDocumentSummary, 'currentVersionId' | 'versions'>,
): KnowledgeDocumentVersionSummary | null {
  const publishedVersionNumber = currentPublishedKnowledgeVersion(document)?.versionNumber ?? 0;
  return (
    document.versions
      .filter(
        (version) => version.status === 'DRAFT' && version.versionNumber > publishedVersionNumber,
      )
      .sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null
  );
}

export function knowledgeVersionFailure(
  version: KnowledgeDocumentVersionSummary | null | undefined,
): string | null {
  const job = version?.ingestionJob ?? null;
  if (version?.status !== 'FAILED' && job?.status !== 'FAILED') return null;
  const detail = job?.errorMessage ?? '文档处理未完成，请检查文件后重新上传。';
  return job?.errorCode ? `处理失败（${job.errorCode}）：${detail}` : `处理失败：${detail}`;
}

export type KnowledgeVersionAction = 'publish' | 'rollback' | null;

export function knowledgeVersionAction(
  document: Pick<KnowledgeDocumentSummary, 'currentVersionId' | 'versions'>,
  version: Pick<KnowledgeDocumentVersionSummary, 'id' | 'status' | 'versionNumber' | 'publishedAt'>,
): KnowledgeVersionAction {
  if (version.status === 'READY' && version.publishedAt === null) {
    const currentVersionNumber = currentPublishedKnowledgeVersion(document)?.versionNumber;
    return currentVersionNumber === undefined || version.versionNumber > currentVersionNumber
      ? 'publish'
      : null;
  }
  if (
    version.status === 'READY' &&
    version.publishedAt !== null &&
    document.currentVersionId !== null &&
    version.id !== document.currentVersionId
  ) {
    return 'rollback';
  }
  return null;
}
