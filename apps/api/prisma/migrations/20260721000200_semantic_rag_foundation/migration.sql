-- Semantic RAG foundation. pg_trgm remains a lexical candidate source; semantic
-- retrieval is stored separately so embeddings can be rebuilt without changing
-- the immutable chunk/version lineage used by citations.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Identical boilerplate can legitimately appear more than once in one document.
-- Chunk position, not content hash, is the version-local identity.
DROP INDEX public."knowledge_chunks_version_hash_key";
CREATE INDEX "knowledge_chunks_version_hash_idx"
  ON public."knowledge_chunks"("tenant_id", "document_version_id", "content_hash");

CREATE TABLE public."knowledge_chunk_embeddings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "chunk_id" uuid NOT NULL,
  "embedding_model" varchar(200) NOT NULL,
  "embedding_dimension" integer NOT NULL,
  "content_hash" char(64) NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_chunk_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_chunk_embeddings_dimension_check"
    CHECK ("embedding_dimension" = 1536 AND vector_dims("embedding") = 1536),
  CONSTRAINT "knowledge_chunk_embeddings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_chunk_embeddings_chunk_fkey"
    FOREIGN KEY ("tenant_id", "chunk_id")
    REFERENCES public."knowledge_chunks"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_chunk_embeddings_tenant_chunk_model_key"
  ON public."knowledge_chunk_embeddings"("tenant_id", "chunk_id", "embedding_model");
CREATE INDEX "knowledge_chunk_embeddings_tenant_model_idx"
  ON public."knowledge_chunk_embeddings"("tenant_id", "embedding_model");
CREATE INDEX "knowledge_chunk_embeddings_embedding_hnsw_idx"
  ON public."knowledge_chunk_embeddings"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

GRANT SELECT ON TABLE public."knowledge_chunk_embeddings" TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."knowledge_chunk_embeddings"
  TO enterprise_agent_admin;

ALTER TABLE public."knowledge_chunk_embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_chunk_embeddings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public."knowledge_chunk_embeddings"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_chunk_embeddings"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

CREATE POLICY enterprise_agent_access
  ON public."knowledge_chunk_embeddings"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

COMMIT;
