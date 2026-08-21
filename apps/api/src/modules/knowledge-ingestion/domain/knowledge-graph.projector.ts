import { createHash } from 'node:crypto';

const MAX_ENTITIES = 240;
const MAX_MENTIONS = 1_000;
const MAX_RELATIONS = 500;
const MAX_ENTITY_NAME_LENGTH = 160;
const MAX_ENTITY_ALIASES = 32;

export interface KnowledgeGraphChunkInput {
  readonly id: string;
  readonly chunkIndex: number;
  readonly headingPath: readonly string[];
  readonly content: string;
}

export interface ProjectedKnowledgeEntity {
  readonly key: string;
  readonly entityType: string;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly externalKey: string | null;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly confidence: number;
}

export interface ProjectedKnowledgeEntityMention {
  readonly entityKey: string;
  readonly chunkId: string;
  readonly surfaceForm: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly confidence: number;
  readonly extractor: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ProjectedKnowledgeRelationEvidence {
  readonly chunkId: string;
  readonly excerpt: string;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly confidence: number;
  readonly extractor: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ProjectedKnowledgeRelation {
  readonly key: string;
  readonly subjectEntityKey: string;
  readonly predicate: string;
  readonly normalizedPredicate: string;
  readonly objectEntityKey: string;
  readonly confidence: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly evidence: readonly ProjectedKnowledgeRelationEvidence[];
}

export interface KnowledgeGraphProjection {
  readonly entities: readonly ProjectedKnowledgeEntity[];
  readonly mentions: readonly ProjectedKnowledgeEntityMention[];
  readonly relations: readonly ProjectedKnowledgeRelation[];
}

interface MutableRelation {
  readonly key: string;
  readonly subjectEntityKey: string;
  readonly predicate: string;
  readonly normalizedPredicate: string;
  readonly objectEntityKey: string;
  confidence: number;
  readonly attributes: Record<string, string | number | boolean>;
  readonly evidence: ProjectedKnowledgeRelationEvidence[];
}

interface EntityDescriptor {
  readonly entityType: string;
  readonly canonicalName: string;
  readonly externalKey?: string;
  readonly confidence: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

const DECLARATION_MAPPINGS: readonly {
  readonly label: RegExp;
  readonly predicate: string;
  readonly entityType: string;
}[] = [
  {
    label: /(?:制度|文件|流程|产品|项目)?(?:编号|代码|编码|ID)$/iu,
    predicate: 'IDENTIFIED_BY',
    entityType: 'IDENTIFIER',
  },
  { label: /(?:负责人|责任人|所有者|联系人)$/u, predicate: 'OWNED_BY', entityType: 'PERSON' },
  { label: /(?:适用范围|适用于|适用对象)$/u, predicate: 'APPLIES_TO', entityType: 'SCOPE' },
  {
    label: /(?:所属部门|负责部门|组织|部门)$/u,
    predicate: 'BELONGS_TO',
    entityType: 'ORGANIZATION',
  },
  { label: /(?:生效日期|发布日期|截止日期|日期)$/u, predicate: 'EFFECTIVE_ON', entityType: 'DATE' },
  { label: /(?:依赖系统|依赖服务|依赖项)$/u, predicate: 'DEPENDS_ON', entityType: 'SYSTEM' },
] as const;

const SENTENCE_RELATIONS: readonly {
  readonly marker: string;
  readonly predicate: string;
  readonly subjectType: string;
  readonly objectType: string;
}[] = [
  { marker: '属于', predicate: 'BELONGS_TO', subjectType: 'CONCEPT', objectType: 'CONCEPT' },
  { marker: '依赖', predicate: 'DEPENDS_ON', subjectType: 'CONCEPT', objectType: 'SYSTEM' },
  { marker: '引用', predicate: 'REFERENCES', subjectType: 'CONCEPT', objectType: 'CONCEPT' },
  { marker: '适用于', predicate: 'APPLIES_TO', subjectType: 'POLICY', objectType: 'SCOPE' },
  { marker: '负责', predicate: 'RESPONSIBLE_FOR', subjectType: 'CONCEPT', objectType: 'CONCEPT' },
] as const;

export function projectKnowledgeGraph(input: {
  readonly documentId: string;
  readonly documentTitle: string;
  readonly chunks: readonly KnowledgeGraphChunkInput[];
}): KnowledgeGraphProjection {
  const entities = new Map<string, ProjectedKnowledgeEntity>();
  const mentions = new Map<string, ProjectedKnowledgeEntityMention>();
  const relations = new Map<string, MutableRelation>();

  const addEntity = (descriptor: EntityDescriptor): ProjectedKnowledgeEntity | null => {
    const canonicalName = cleanEntityName(descriptor.canonicalName);
    if (canonicalName.length < 2) return null;
    const normalizedName = normalizeEntityName(canonicalName);
    if (normalizedName.length < 2) return null;
    const externalKey = descriptor.externalKey ?? null;
    const key = entityKey(descriptor.entityType, normalizedName, externalKey);
    const existing = entities.get(key);
    if (existing !== undefined) {
      const aliases = mergeEntityAliases(existing.canonicalName, existing.aliases, [canonicalName]);
      if (aliases === existing.aliases) return existing;
      const updated = { ...existing, aliases };
      entities.set(key, updated);
      return updated;
    }
    if (entities.size >= MAX_ENTITIES) return null;
    const entity: ProjectedKnowledgeEntity = {
      key,
      entityType: descriptor.entityType,
      canonicalName,
      normalizedName,
      externalKey,
      description: null,
      aliases: [],
      attributes: descriptor.attributes ?? {},
      confidence: clampConfidence(descriptor.confidence),
    };
    entities.set(key, entity);
    return entity;
  };

  const addMention = (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surfaceForm: string,
    startOffset: number,
    confidence: number,
    extractor: string,
    metadata: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    if (entity === null || mentions.size >= MAX_MENTIONS) return;
    const boundedStart = Math.max(0, Math.min(chunk.content.length, startOffset));
    const boundedEnd = Math.max(
      boundedStart,
      Math.min(chunk.content.length, boundedStart + surfaceForm.length),
    );
    const key = `${entity.key}:${chunk.id}:${boundedStart}:${boundedEnd}`;
    if (mentions.has(key)) return;
    mentions.set(key, {
      entityKey: entity.key,
      chunkId: chunk.id,
      surfaceForm: surfaceForm.slice(0, MAX_ENTITY_NAME_LENGTH),
      startOffset: boundedStart,
      endOffset: boundedEnd,
      confidence: clampConfidence(confidence),
      extractor,
      metadata,
    });
  };

  const addRelation = (
    subject: ProjectedKnowledgeEntity | null,
    predicate: string,
    object: ProjectedKnowledgeEntity | null,
    confidence: number,
    evidence?: ProjectedKnowledgeRelationEvidence,
    attributes: Record<string, string | number | boolean> = {},
  ): void => {
    if (subject === null || object === null || subject.key === object.key) return;
    const normalizedPredicate = normalizePredicate(predicate);
    const key = relationKey(subject.key, normalizedPredicate, object.key);
    const existing = relations.get(key);
    if (existing !== undefined) {
      existing.confidence = Math.max(existing.confidence, clampConfidence(confidence));
      if (
        evidence !== undefined &&
        !existing.evidence.some(
          (item) =>
            item.chunkId === evidence.chunkId &&
            item.startOffset === evidence.startOffset &&
            item.endOffset === evidence.endOffset,
        )
      ) {
        existing.evidence.push(evidence);
      }
      return;
    }
    if (relations.size >= MAX_RELATIONS) return;
    relations.set(key, {
      key,
      subjectEntityKey: subject.key,
      predicate,
      normalizedPredicate,
      objectEntityKey: object.key,
      confidence: clampConfidence(confidence),
      attributes,
      evidence: evidence === undefined ? [] : [evidence],
    });
  };

  const document = addEntity({
    entityType: 'DOCUMENT',
    canonicalName: input.documentTitle,
    externalKey: documentExternalKey(input.documentId),
    confidence: 1,
    attributes: { documentId: input.documentId },
  });

  const sectionByPath = new Map<string, ProjectedKnowledgeEntity>();
  for (const chunk of [...input.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    let parent = document;
    for (let depth = 0; depth < chunk.headingPath.length; depth += 1) {
      const path = chunk.headingPath.slice(0, depth + 1);
      const pathKey = path.map(normalizeEntityName).join('/');
      let section = sectionByPath.get(pathKey) ?? null;
      if (section === null) {
        section = addEntity({
          entityType: 'SECTION',
          canonicalName: `${input.documentTitle} / ${path.join(' / ')}`,
          externalKey: sectionExternalKey(input.documentId, pathKey),
          confidence: 1,
          attributes: { depth: depth + 1 },
        });
        if (section !== null) sectionByPath.set(pathKey, section);
      }
      addRelation(
        parent,
        parent?.entityType === 'DOCUMENT' ? 'CONTAINS_SECTION' : 'PARENT_OF',
        section,
        1,
        graphEvidence(chunk, chunk.headingPath[depth] ?? '', null, null, 1, 'heading_path'),
      );
      parent = section;
    }

    extractChunkTopic(chunk, parent ?? document, addEntity, addMention, addRelation);
    extractDeclarations(chunk, document, addEntity, addMention, addRelation);
    extractQuotedTerms(chunk, addEntity, addMention);
    extractIdentifiers(chunk, addEntity, addMention);
    extractSentenceRelations(chunk, addEntity, addMention, addRelation);
  }

  return {
    entities: [...entities.values()],
    mentions: [...mentions.values()],
    relations: [...relations.values()].map((relation) => ({
      ...relation,
      evidence: relation.evidence.slice(0, 20),
    })),
  };
}

function extractChunkTopic(
  chunk: KnowledgeGraphChunkInput,
  parent: ProjectedKnowledgeEntity | null,
  addEntity: (descriptor: EntityDescriptor) => ProjectedKnowledgeEntity | null,
  addMention: (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surface: string,
    start: number,
    confidence: number,
    extractor: string,
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ) => void,
  addRelation: (
    subject: ProjectedKnowledgeEntity | null,
    predicate: string,
    object: ProjectedKnowledgeEntity | null,
    confidence: number,
    evidence?: ProjectedKnowledgeRelationEvidence,
    attributes?: Record<string, string | number | boolean>,
  ) => void,
): void {
  const match = /[^\s。！？!?\n][^。！？!?\n]{1,118}/u.exec(chunk.content);
  if (match === null) return;
  const surface = cleanEntityName(match[0]);
  if (surface.length < 2) return;
  const topic = addEntity({
    entityType: 'TOPIC',
    canonicalName: surface,
    confidence: 0.76,
    attributes: { chunkIndex: chunk.chunkIndex },
  });
  const startOffset = match.index + Math.max(0, match[0].indexOf(surface));
  addMention(topic, chunk, surface, startOffset, 0.76, 'chunk_topic', {
    chunkIndex: chunk.chunkIndex,
  });
  addRelation(
    parent,
    'DESCRIBES',
    topic,
    0.76,
    graphEvidence(chunk, surface, startOffset, startOffset + surface.length, 0.76, 'chunk_topic'),
  );
}

function extractDeclarations(
  chunk: KnowledgeGraphChunkInput,
  document: ProjectedKnowledgeEntity | null,
  addEntity: (descriptor: EntityDescriptor) => ProjectedKnowledgeEntity | null,
  addMention: (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surface: string,
    start: number,
    confidence: number,
    extractor: string,
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ) => void,
  addRelation: (
    subject: ProjectedKnowledgeEntity | null,
    predicate: string,
    object: ProjectedKnowledgeEntity | null,
    confidence: number,
    evidence?: ProjectedKnowledgeRelationEvidence,
    attributes?: Record<string, string | number | boolean>,
  ) => void,
): void {
  const declaration = /(?:^|\n)\s*([^:\n：]{2,32})\s*[:：]\s*([^\n]{2,180})/gu;
  for (const match of chunk.content.matchAll(declaration)) {
    const label = cleanEntityName(match[1] ?? '');
    const value = cleanEntityName(match[2] ?? '');
    if (label.length < 2 || value.length < 2) continue;
    const mapping = DECLARATION_MAPPINGS.find((candidate) => candidate.label.test(label));
    const entity = addEntity({
      entityType: mapping?.entityType ?? inferEntityType(value),
      canonicalName: value,
      confidence: mapping === undefined ? 0.82 : 0.96,
      attributes: { declarationLabel: label },
    });
    const valueOffset = (match.index ?? 0) + (match[0]?.lastIndexOf(match[2] ?? '') ?? 0);
    addMention(
      entity,
      chunk,
      value,
      valueOffset,
      mapping === undefined ? 0.82 : 0.96,
      'declaration',
      {
        label,
      },
    );
    addRelation(
      document,
      mapping?.predicate ?? 'HAS_ATTRIBUTE',
      entity,
      mapping === undefined ? 0.78 : 0.95,
      graphEvidence(
        chunk,
        match[0] ?? `${label}：${value}`,
        match.index ?? null,
        (match.index ?? 0) + (match[0]?.length ?? 0),
        mapping === undefined ? 0.78 : 0.95,
        'declaration',
      ),
      { label },
    );
  }
}

function extractQuotedTerms(
  chunk: KnowledgeGraphChunkInput,
  addEntity: (descriptor: EntityDescriptor) => ProjectedKnowledgeEntity | null,
  addMention: (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surface: string,
    start: number,
    confidence: number,
    extractor: string,
  ) => void,
): void {
  const quoted = /[“「『"]([^”」』"\n]{2,80})[”」』"]/gu;
  for (const match of chunk.content.matchAll(quoted)) {
    const value = cleanEntityName(match[1] ?? '');
    const entity = addEntity({ entityType: 'TERM', canonicalName: value, confidence: 0.86 });
    const offset = (match.index ?? 0) + 1;
    addMention(entity, chunk, value, offset, 0.86, 'quoted_term');
  }
}

function extractIdentifiers(
  chunk: KnowledgeGraphChunkInput,
  addEntity: (descriptor: EntityDescriptor) => ProjectedKnowledgeEntity | null,
  addMention: (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surface: string,
    start: number,
    confidence: number,
    extractor: string,
  ) => void,
): void {
  const identifiers =
    /\b(?=[A-Z0-9_-]{4,48}\b)(?=[A-Z0-9_-]*[A-Z])(?=[A-Z0-9_-]*\d)[A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/g;
  for (const match of chunk.content.matchAll(identifiers)) {
    const value = match[0];
    const entity = addEntity({ entityType: 'IDENTIFIER', canonicalName: value, confidence: 0.98 });
    addMention(entity, chunk, value, match.index ?? 0, 0.98, 'identifier');
  }
}

function extractSentenceRelations(
  chunk: KnowledgeGraphChunkInput,
  addEntity: (descriptor: EntityDescriptor) => ProjectedKnowledgeEntity | null,
  addMention: (
    entity: ProjectedKnowledgeEntity | null,
    chunk: KnowledgeGraphChunkInput,
    surface: string,
    start: number,
    confidence: number,
    extractor: string,
  ) => void,
  addRelation: (
    subject: ProjectedKnowledgeEntity | null,
    predicate: string,
    object: ProjectedKnowledgeEntity | null,
    confidence: number,
    evidence?: ProjectedKnowledgeRelationEvidence,
  ) => void,
): void {
  const sentences = chunk.content.matchAll(/[^。！？!?\n]{4,240}[。！？!?]?/gu);
  for (const sentenceMatch of sentences) {
    const sentence = sentenceMatch[0].trim();
    const sentenceOffset = sentenceMatch.index ?? 0;
    for (const mapping of SENTENCE_RELATIONS) {
      const markerOffset = sentence.indexOf(mapping.marker);
      if (markerOffset < 2) continue;
      const subjectName = cleanRelationOperand(sentence.slice(0, markerOffset), true);
      const objectName = cleanRelationOperand(
        sentence.slice(markerOffset + mapping.marker.length),
        false,
      );
      if (subjectName.length < 2 || objectName.length < 2) continue;
      const subject = addEntity({
        entityType: mapping.subjectType,
        canonicalName: subjectName,
        confidence: 0.72,
      });
      const object = addEntity({
        entityType: mapping.objectType,
        canonicalName: objectName,
        confidence: 0.72,
      });
      const subjectOffset = sentenceOffset + sentence.indexOf(subjectName);
      const objectOffset =
        sentenceOffset +
        markerOffset +
        mapping.marker.length +
        sentence.slice(markerOffset + mapping.marker.length).indexOf(objectName);
      addMention(subject, chunk, subjectName, subjectOffset, 0.72, 'relation_pattern');
      addMention(object, chunk, objectName, objectOffset, 0.72, 'relation_pattern');
      addRelation(
        subject,
        mapping.predicate,
        object,
        0.72,
        graphEvidence(
          chunk,
          sentence,
          sentenceOffset,
          sentenceOffset + sentence.length,
          0.72,
          'relation_pattern',
        ),
      );
      break;
    }
  }
}

function graphEvidence(
  chunk: KnowledgeGraphChunkInput,
  excerpt: string,
  startOffset: number | null,
  endOffset: number | null,
  confidence: number,
  extractor: string,
): ProjectedKnowledgeRelationEvidence {
  return {
    chunkId: chunk.id,
    excerpt: excerpt.trim().slice(0, 500) || chunk.content.slice(0, 500),
    startOffset,
    endOffset,
    confidence: clampConfidence(confidence),
    extractor,
    metadata: { chunkIndex: chunk.chunkIndex },
  };
}

function cleanRelationOperand(value: string, takeTail: boolean): string {
  const withoutLead = value.replace(/^(?:其中|本制度|本流程|该|此|根据|若|当)\s*/u, '');
  const pieces = withoutLead
    .split(/[，,；;：:]/u)
    .map(cleanEntityName)
    .filter(Boolean);
  const candidate = takeTail ? (pieces.at(-1) ?? '') : (pieces[0] ?? '');
  return candidate.slice(0, 80);
}

function inferEntityType(value: string): string {
  if (/^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?$/u.test(value)) return 'DATE';
  if (/^(?:[\p{Script=Han}A-Za-z0-9]+(?:公司|集团|中心|部门|委员会|办公室))$/u.test(value)) {
    return 'ORGANIZATION';
  }
  if (/^[A-Z0-9]+(?:[-_][A-Z0-9]+)+$/.test(value)) return 'IDENTIFIER';
  return 'VALUE';
}

function cleanEntityName(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(
      /^[\s"'“”‘’「」『』【】()\[\]，,。；;：:]+|[\s"'“”‘’「」『』【】()\[\]，,。；;：:]+$/gu,
      '',
    )
    .trim()
    .slice(0, MAX_ENTITY_NAME_LENGTH);
}

function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function mergeEntityAliases(
  canonicalName: string,
  existing: readonly string[],
  candidates: readonly string[],
): readonly string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of [...existing, ...candidates]) {
    const alias = cleanEntityName(value);
    if (alias.length < 2 || alias === canonicalName || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
    if (aliases.length === MAX_ENTITY_ALIASES) break;
  }
  if (
    aliases.length === existing.length &&
    aliases.every((alias, index) => alias === existing[index])
  ) {
    return existing;
  }
  return aliases;
}

function normalizePredicate(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function entityKey(entityType: string, normalizedName: string, externalKey: string | null): string {
  return createHash('sha256')
    .update(`${entityType}\0${externalKey ?? `semantic:${normalizedName}`}`)
    .digest('hex')
    .slice(0, 32);
}

function documentExternalKey(documentId: string): string {
  return `document:${documentId.toLowerCase()}`;
}

function sectionExternalKey(documentId: string, normalizedHeadingPath: string): string {
  const pathDigest = createHash('sha256').update(normalizedHeadingPath).digest('hex');
  return `${documentExternalKey(documentId)}:section:${pathDigest}`;
}

function relationKey(subjectKey: string, predicate: string, objectKey: string): string {
  return createHash('sha256')
    .update(`${subjectKey}\0${predicate}\0${objectKey}`)
    .digest('hex')
    .slice(0, 32);
}

function clampConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}
