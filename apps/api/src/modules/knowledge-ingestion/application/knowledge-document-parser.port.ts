import type {
  DocumentParsingInput,
  ParsedKnowledgeDocument,
} from '../infrastructure/document-parser.adapter.js';

export const KNOWLEDGE_DOCUMENT_PARSER = Symbol('KNOWLEDGE_DOCUMENT_PARSER');

export interface KnowledgeDocumentParser {
  parse(input: DocumentParsingInput): Promise<ParsedKnowledgeDocument>;
}
