ALTER TABLE public."knowledge_bases"
  ADD COLUMN "retrieval_mode" varchar(24) NOT NULL DEFAULT 'HYBRID',
  ADD COLUMN "retrieval_top_k" integer NOT NULL DEFAULT 8,
  ADD COLUMN "retrieval_score_threshold" numeric(5, 4) NOT NULL DEFAULT 0.08,
  ADD COLUMN "retrieval_semantic_weight" numeric(5, 4) NOT NULL DEFAULT 0.7,
  ADD COLUMN "retrieval_keyword_weight" numeric(5, 4) NOT NULL DEFAULT 0.3,
  ADD COLUMN "retrieval_rerank_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "relationship_retrieval_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "max_chunks_per_document" integer NOT NULL DEFAULT 3,
  ADD COLUMN "chunk_target_tokens" integer NOT NULL DEFAULT 500,
  ADD COLUMN "chunk_overlap_tokens" integer NOT NULL DEFAULT 80;

ALTER TABLE public."knowledge_bases"
  ADD CONSTRAINT "knowledge_bases_retrieval_mode_check"
    CHECK ("retrieval_mode" IN ('HYBRID', 'VECTOR', 'FULL_TEXT')),
  ADD CONSTRAINT "knowledge_bases_retrieval_top_k_check"
    CHECK ("retrieval_top_k" BETWEEN 1 AND 20),
  ADD CONSTRAINT "knowledge_bases_retrieval_score_threshold_check"
    CHECK ("retrieval_score_threshold" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_bases_retrieval_semantic_weight_check"
    CHECK ("retrieval_semantic_weight" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_bases_retrieval_keyword_weight_check"
    CHECK ("retrieval_keyword_weight" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_bases_retrieval_hybrid_weight_check"
    CHECK (
      "retrieval_mode" <> 'HYBRID'
      OR "retrieval_semantic_weight" + "retrieval_keyword_weight" = 1
    ),
  ADD CONSTRAINT "knowledge_bases_max_chunks_per_document_check"
    CHECK ("max_chunks_per_document" BETWEEN 1 AND 10),
  ADD CONSTRAINT "knowledge_bases_chunk_target_tokens_check"
    CHECK ("chunk_target_tokens" BETWEEN 100 AND 2000),
  ADD CONSTRAINT "knowledge_bases_chunk_overlap_tokens_check"
    CHECK (
      "chunk_overlap_tokens" BETWEEN 0 AND 500
      AND "chunk_overlap_tokens" < "chunk_target_tokens"
    );

COMMENT ON COLUMN public."knowledge_bases"."retrieval_mode" IS
  'Dify-style retrieval strategy: HYBRID, VECTOR, or FULL_TEXT. Provider failure may still degrade safely to lexical retrieval.';

COMMENT ON COLUMN public."knowledge_bases"."retrieval_score_threshold" IS
  'Minimum final relevance score required before a chunk may enter an Agent Run context.';

COMMENT ON COLUMN public."knowledge_bases"."relationship_retrieval_enabled" IS
  'Enables governed, evidenced PostgreSQL knowledge-graph expansion after base recall.';

COMMENT ON COLUMN public."knowledge_bases"."chunk_target_tokens" IS
  'Target size for newly indexed chunks. Existing published versions remain immutable until explicitly re-indexed.';
