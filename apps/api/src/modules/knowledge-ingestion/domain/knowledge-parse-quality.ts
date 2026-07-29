import type { ParsedKnowledgeDocument } from '../infrastructure/document-parser.adapter.js';

export const KNOWLEDGE_PARSE_QUALITY_THRESHOLD = 0.65;

export interface KnowledgeParseQualityAssessment {
  readonly score: number;
  readonly parserName: string;
  readonly diagnostics: {
    readonly characterCount: number;
    readonly sourceByteLength: number;
    readonly chunkCount: number;
    readonly pageCount: number | null;
    readonly nonEmptyPageCount: number | null;
    readonly replacementCharacterCount: number;
    readonly qualityThreshold: number;
    readonly lowQualityReasons: readonly string[];
  };
}

export function assessKnowledgeParseQuality(input: {
  readonly parsed: ParsedKnowledgeDocument;
  readonly sourceByteLength: number;
  readonly chunkCount: number;
}): KnowledgeParseQualityAssessment {
  const characterCount = Array.from(input.parsed.text).length;
  const replacementCharacterCount = countOccurrences(input.parsed.text, '\ufffd');
  const pageCount = input.parsed.metadata.pageCount ?? null;
  const nonEmptyPageCount =
    input.parsed.pages === undefined
      ? null
      : input.parsed.pages.filter((page) => page.text.trim().length > 0).length;
  const lengthScore = Math.min(1, characterCount / 1_000);
  const chunkScore = Math.min(1, input.chunkCount / 3);
  const pageScore =
    pageCount === null || nonEmptyPageCount === null ? 1 : nonEmptyPageCount / pageCount;
  const integrityScore =
    characterCount === 0 ? 0 : Math.max(0, 1 - replacementCharacterCount / characterCount / 0.001);
  const score = roundFour(
    lengthScore * 0.45 + chunkScore * 0.25 + pageScore * 0.15 + integrityScore * 0.15,
  );
  const lowQualityReasons: string[] = [];
  if (characterCount < 200) lowQualityReasons.push('CONTENT_TOO_SHORT');
  if (input.chunkCount < 1) lowQualityReasons.push('NO_SEARCHABLE_CHUNKS');
  if (pageScore < 0.8) lowQualityReasons.push('PAGE_COVERAGE_LOW');
  if (replacementCharacterCount > 0) lowQualityReasons.push('INVALID_CHARACTER_REPLACEMENTS');
  if (score < KNOWLEDGE_PARSE_QUALITY_THRESHOLD) lowQualityReasons.push('QUALITY_BELOW_THRESHOLD');

  return {
    score,
    parserName: input.parsed.metadata.parser ?? parserNameFor(input.parsed.metadata.mimeType),
    diagnostics: {
      characterCount,
      sourceByteLength: input.sourceByteLength,
      chunkCount: input.chunkCount,
      pageCount,
      nonEmptyPageCount,
      replacementCharacterCount,
      qualityThreshold: KNOWLEDGE_PARSE_QUALITY_THRESHOLD,
      lowQualityReasons,
    },
  };
}

function parserNameFor(mimeType: string): string {
  switch (mimeType) {
    case 'text/plain':
      return 'utf8-text-v1';
    case 'text/markdown':
      return 'utf8-markdown-v1';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'mammoth-v1';
    default:
      return 'local-document-parser-v1';
  }
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  for (const character of value) if (character === search) count += 1;
  return count;
}

function roundFour(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}
