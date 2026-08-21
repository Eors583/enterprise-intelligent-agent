import { createHash } from 'node:crypto';

export type KnowledgeDocumentSourceType = 'TEXT' | 'MARKDOWN';

export interface KnowledgeDocumentChunkingInput {
  content: string;
  sourceType: KnowledgeDocumentSourceType;
}

export interface KnowledgeDocumentChunkingOptions {
  /** Approximate size of a chunk. Defaults to 500 tokens. */
  targetTokens?: number;
  /** Approximate shared suffix/prefix between adjacent chunks. Defaults to 80 tokens. */
  overlapTokens?: number;
  /** Stable token approximation. Defaults to two Unicode characters per token. */
  charactersPerToken?: number;
}

export interface KnowledgeDocumentChunk {
  headingPath: string[];
  parentIndex: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  contentHash: string;
}

export interface KnowledgeDocumentParentChunk {
  headingPath: string[];
  parentIndex: number;
  content: string;
  tokenCount: number;
  contentHash: string;
}

export interface KnowledgeDocumentChunkHierarchy {
  parents: KnowledgeDocumentParentChunk[];
  chunks: KnowledgeDocumentChunk[];
}

interface MarkdownSection {
  headingPath: string[];
  content: string;
}

interface Heading {
  level: number;
  title: string;
}

interface ResolvedChunkingOptions {
  targetTokens: number;
  overlapTokens: number;
  charactersPerToken: number;
}

const DEFAULT_TARGET_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 80;
const DEFAULT_CHARACTERS_PER_TOKEN = 2;
const MINIMUM_BOUNDARY_RATIO = 0.7;

/**
 * Splits normalized document text into deterministic, ordered domain chunks.
 * This function performs no persistence, network access, or framework integration.
 */
export function chunkKnowledgeDocument(
  input: KnowledgeDocumentChunkingInput,
  options: KnowledgeDocumentChunkingOptions = {},
): KnowledgeDocumentChunk[] {
  return chunkKnowledgeDocumentWithParents(input, options).chunks;
}

/**
 * Builds an explicit two-level hierarchy. A Markdown section (or the complete
 * plain-text input) is the parent block; child ordering is global and
 * deterministic and retains the configured overlap across the section.
 */
export function chunkKnowledgeDocumentWithParents(
  input: KnowledgeDocumentChunkingInput,
  options: KnowledgeDocumentChunkingOptions = {},
): KnowledgeDocumentChunkHierarchy {
  const resolvedOptions = resolveOptions(options);
  const normalizedContent = normalizeLineEndings(input.content);
  if (normalizedContent.trim().length === 0) return { parents: [], chunks: [] };

  const sections =
    input.sourceType === 'MARKDOWN'
      ? splitMarkdownSections(normalizedContent)
      : [{ headingPath: [], content: trimBlankLines(normalizedContent) }];
  const maximumCharacters = resolvedOptions.targetTokens * resolvedOptions.charactersPerToken;
  const overlapCharacters = resolvedOptions.overlapTokens * resolvedOptions.charactersPerToken;

  const parents: KnowledgeDocumentParentChunk[] = [];
  const chunks: KnowledgeDocumentChunk[] = [];
  for (const section of sections) {
    const parentIndex = parents.length;
    parents.push({
      headingPath: [...section.headingPath],
      parentIndex,
      content: section.content,
      tokenCount: estimateTokenCount(section.content, resolvedOptions.charactersPerToken),
      contentHash: hashContent(section.content),
    });
    for (const content of splitSectionContent(
      section.content,
      maximumCharacters,
      overlapCharacters,
    )) {
      chunks.push({
        headingPath: [...section.headingPath],
        parentIndex,
        chunkIndex: chunks.length,
        content,
        tokenCount: estimateTokenCount(content, resolvedOptions.charactersPerToken),
        contentHash: hashContent(content),
      });
    }
  }
  return { parents, chunks };
}

/** Returns the same stable character-based approximation used by the chunker. */
export function estimateTokenCount(content: string, charactersPerToken = 2): number {
  assertPositiveInteger('charactersPerToken', charactersPerToken);
  const characterCount = Array.from(content).length;
  return characterCount === 0 ? 0 : Math.ceil(characterCount / charactersPerToken);
}

function resolveOptions(options: KnowledgeDocumentChunkingOptions): ResolvedChunkingOptions {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const charactersPerToken = options.charactersPerToken ?? DEFAULT_CHARACTERS_PER_TOKEN;

  assertPositiveInteger('targetTokens', targetTokens);
  assertNonNegativeInteger('overlapTokens', overlapTokens);
  assertPositiveInteger('charactersPerToken', charactersPerToken);
  if (overlapTokens >= targetTokens) {
    throw new RangeError('overlapTokens must be smaller than targetTokens');
  }

  return { targetTokens, overlapTokens, charactersPerToken };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
}

function trimBlankLines(content: string): string {
  const lines = content.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]?.trim().length === 0) end -= 1;
  return lines.slice(start, end).join('\n');
}

function splitMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  const headings: Heading[] = [];
  let sectionLines: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  const flushSection = (): void => {
    const sectionContent = trimBlankLines(sectionLines.join('\n'));
    if (sectionContent.trim().length > 0) {
      sections.push({
        headingPath: headings.map((heading) => heading.title),
        content: sectionContent,
      });
    }
    sectionLines = [];
  };

  for (const line of lines) {
    const delimiter = readFenceDelimiter(line);
    if (fence !== undefined) {
      sectionLines.push(line);
      if (
        delimiter !== undefined &&
        delimiter.marker === fence.marker &&
        delimiter.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (delimiter !== undefined) {
      fence = delimiter;
      sectionLines.push(line);
      continue;
    }

    const heading = readAtxHeading(line);
    if (heading === undefined) {
      sectionLines.push(line);
      continue;
    }

    flushSection();
    while ((headings.at(-1)?.level ?? 0) >= heading.level) headings.pop();
    headings.push(heading);
  }
  flushSection();

  return sections;
}

function readAtxHeading(line: string): Heading | undefined {
  const match = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/u.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return undefined;

  const rawTitle = match?.[2] ?? '';
  const title = rawTitle.replace(/[\t ]+#+[\t ]*$/u, '').trim();
  if (title.length === 0) return undefined;
  return { level: marker.length, title };
}

function readFenceDelimiter(line: string): { marker: '`' | '~'; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  const delimiter = match?.[1];
  if (delimiter === undefined) return undefined;
  const marker = delimiter[0];
  if (marker !== '`' && marker !== '~') return undefined;
  return { marker, length: delimiter.length };
}

function splitSectionContent(
  content: string,
  maximumCharacters: number,
  overlapCharacters: number,
): string[] {
  const normalizedContent = trimBlankLines(content);
  if (normalizedContent.trim().length === 0) return [];

  const characters = Array.from(normalizedContent);
  const result: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const idealEnd = Math.min(start + maximumCharacters, characters.length);
    const end =
      idealEnd === characters.length ? idealEnd : findPreferredEnd(characters, start, idealEnd);
    const chunk = trimBlankLines(characters.slice(start, end).join(''));
    if (chunk.trim().length > 0) result.push(chunk);
    if (end >= characters.length) break;

    const desiredStart = Math.max(start + 1, end - overlapCharacters);
    const nextStart = alignOverlapStart(characters, desiredStart, end, overlapCharacters);
    start = nextStart > start ? nextStart : Math.min(end, start + 1);
  }

  return result;
}

function findPreferredEnd(characters: string[], start: number, idealEnd: number): number {
  const minimumEnd = Math.max(
    start + 1,
    start + Math.floor((idealEnd - start) * MINIMUM_BOUNDARY_RATIO),
  );
  const predicates: Array<(previous: string, beforePrevious: string | undefined) => boolean> = [
    (previous, beforePrevious) => previous === '\n' && beforePrevious === '\n',
    (previous) => previous === '\n',
    (previous) => /[.!?。！？；;]/u.test(previous),
    (previous) => /\s/u.test(previous),
  ];

  for (const predicate of predicates) {
    for (let end = idealEnd; end >= minimumEnd; end -= 1) {
      const previous = characters[end - 1];
      if (previous !== undefined && predicate(previous, characters[end - 2])) return end;
    }
  }
  return idealEnd;
}

function alignOverlapStart(
  characters: string[],
  desiredStart: number,
  end: number,
  overlapCharacters: number,
): number {
  if (overlapCharacters === 0) return end;

  const maximumAdvance = Math.max(4, Math.floor(overlapCharacters / 4));
  const latestStart = Math.min(end - 1, desiredStart + maximumAdvance);
  const predicates: Array<(previous: string, current: string | undefined) => boolean> = [
    (previous, current) => previous === '\n' && current === '\n',
    (previous) => previous === '\n',
    (previous) => /[.!?。！？；;]/u.test(previous),
    (previous) => /\s/u.test(previous),
  ];

  for (const predicate of predicates) {
    for (let candidate = desiredStart; candidate <= latestStart; candidate += 1) {
      const previous = characters[candidate - 1];
      if (previous !== undefined && predicate(previous, characters[candidate])) {
        return skipWhitespace(characters, candidate, end);
      }
    }
  }
  return desiredStart;
}

function skipWhitespace(characters: string[], start: number, end: number): number {
  let candidate = start;
  while (candidate < end && /\s/u.test(characters[candidate] ?? '')) candidate += 1;
  return candidate < end ? candidate : start;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
