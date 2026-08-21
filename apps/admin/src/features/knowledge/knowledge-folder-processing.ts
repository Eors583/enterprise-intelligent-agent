import type { KnowledgeDocumentSummary, KnowledgeFolder } from '@enterprise/contracts';

export interface KnowledgeFolderProcessingSummary {
  readonly totalDocuments: number;
  readonly completedDocuments: number;
  readonly processingDocuments: number;
  readonly failedDocuments: number;
  readonly waitingDocuments: number;
  readonly chunkCount: number;
  readonly progress: number;
  readonly state: 'EMPTY' | 'PROCESSING' | 'FAILED' | 'READY';
}

export function knowledgeFolderProcessingSummary(
  folder: KnowledgeFolder,
  documents: readonly KnowledgeDocumentSummary[],
): KnowledgeFolderProcessingSummary {
  const descendants = documents.filter(
    (document) =>
      document.status !== 'ARCHIVED' &&
      document.folderPath !== null &&
      (document.folderPath === folder.path || document.folderPath.startsWith(`${folder.path}/`)),
  );

  let completedDocuments = 0;
  let processingDocuments = 0;
  let failedDocuments = 0;
  let waitingDocuments = 0;
  let chunkCount = 0;
  let accumulatedProgress = 0;

  for (const document of descendants) {
    const latest = [...document.versions].sort(
      (left, right) => right.versionNumber - left.versionNumber,
    )[0];
    if (latest === undefined) {
      waitingDocuments += 1;
      continue;
    }
    const job = latest.ingestionJob;
    const failed = latest.status === 'FAILED' || job?.status === 'FAILED';
    const processing =
      latest.status === 'PROCESSING' || job?.status === 'PENDING' || job?.status === 'RUNNING';

    if (failed) {
      failedDocuments += 1;
      continue;
    }
    if (latest.status === 'READY') {
      completedDocuments += 1;
      chunkCount += latest.chunkCount;
      accumulatedProgress += 100;
      continue;
    }
    if (processing) {
      processingDocuments += 1;
      accumulatedProgress += boundedProgress(job?.progress ?? 0);
      continue;
    }
    waitingDocuments += 1;
  }

  const totalDocuments = descendants.length;
  const progress = totalDocuments === 0 ? 0 : Math.round(accumulatedProgress / totalDocuments);
  return {
    totalDocuments,
    completedDocuments,
    processingDocuments,
    failedDocuments,
    waitingDocuments,
    chunkCount,
    progress,
    state:
      totalDocuments === 0
        ? 'EMPTY'
        : failedDocuments > 0
          ? 'FAILED'
          : completedDocuments === totalDocuments
            ? 'READY'
            : 'PROCESSING',
  };
}

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(99, Math.max(0, Math.round(value)));
}
