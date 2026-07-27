import type {
  AdminOrgUnit,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';

import {
  currentPublishedKnowledgeVersion,
  latestKnowledgeVersion,
} from './knowledge-ingestion-outcome';

export type KnowledgeDocumentSourceFilter = 'ALL' | 'FILE' | 'TEXT' | 'MARKDOWN';
export type KnowledgeDocumentStatusFilter =
  'ALL' | 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';

export interface KnowledgeBaseReadiness {
  readonly ready: boolean;
  readonly publishedDocumentCount: number;
  readonly indexedDocumentCount: number;
}

export function effectiveKnowledgeDocumentStatus(
  document: KnowledgeDocumentSummary,
): Exclude<KnowledgeDocumentStatusFilter, 'ALL'> {
  if (document.status === 'ARCHIVED') return 'ARCHIVED';
  const latest = latestKnowledgeVersion(document);
  if (
    latest?.status === 'FAILED' ||
    latest?.ingestionJob?.status === 'FAILED' ||
    document.status === 'FAILED'
  ) {
    return 'FAILED';
  }
  if (
    latest?.status === 'PROCESSING' ||
    latest?.ingestionJob?.status === 'PENDING' ||
    latest?.ingestionJob?.status === 'RUNNING' ||
    document.status === 'PROCESSING'
  ) {
    return 'PROCESSING';
  }
  return currentPublishedKnowledgeVersion(document) ? 'READY' : 'DRAFT';
}

export function filterKnowledgeDocuments(
  documents: ReadonlyArray<KnowledgeDocumentSummary>,
  query: string,
  source: KnowledgeDocumentSourceFilter,
  status: KnowledgeDocumentStatusFilter,
): KnowledgeDocumentSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  return documents.filter((document) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      document.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery) ||
      (document.fileName?.toLocaleLowerCase('zh-CN').includes(normalizedQuery) ?? false);
    const matchesSource = source === 'ALL' || document.sourceType === source;
    const matchesStatus = status === 'ALL' || effectiveKnowledgeDocumentStatus(document) === status;
    return matchesQuery && matchesSource && matchesStatus;
  });
}

export function knowledgeBaseReadiness(
  documents: ReadonlyArray<KnowledgeDocumentSummary>,
): KnowledgeBaseReadiness {
  let publishedDocumentCount = 0;
  let indexedDocumentCount = 0;
  for (const document of documents) {
    if (document.status === 'ARCHIVED') continue;
    const published = currentPublishedKnowledgeVersion(document);
    if (!published || published.status !== 'READY') continue;
    publishedDocumentCount += 1;
    if (published.chunkCount > 0) indexedDocumentCount += 1;
  }
  return {
    ready: indexedDocumentCount > 0,
    publishedDocumentCount,
    indexedDocumentCount,
  };
}

export function orgUnitPath(units: ReadonlyArray<AdminOrgUnit>, unitId: string): string {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(unitId);
  while (current && !visited.has(current.id)) {
    names.unshift(current.name);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(' / ');
}

export function previewableKnowledgeVersion(
  document: KnowledgeDocumentSummary,
): KnowledgeDocumentVersionSummary | null {
  const published = currentPublishedKnowledgeVersion(document);
  if (published && published.chunkCount > 0) return published;
  return (
    [...document.versions]
      .filter((version) => version.chunkCount > 0)
      .sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null
  );
}
