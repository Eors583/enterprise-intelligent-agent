-- Version the complete embedding contract instead of treating 1536 dimensions
-- as a system-wide invariant. Existing embeddings are attached to a legacy
-- ACTIVE index version and keep using the configured base Qdrant collection.

BEGIN;

CREATE TYPE public."KnowledgeEmbeddingIndexStatus" AS ENUM (
  'BUILDING',
  'ACTIVE',
  'RETIRED',
  'FAILED'
);

CREATE TABLE public."knowledge_embedding_index_versions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" public."KnowledgeEmbeddingIndexStatus" NOT NULL DEFAULT 'BUILDING',
  "provider" varchar(40) NOT NULL,
  "model" varchar(200) NOT NULL,
  "dimensions" integer NOT NULL,
  "distance" varchar(24) NOT NULL DEFAULT 'COSINE',
  "normalization" varchar(24) NOT NULL DEFAULT 'L2',
  "collection_name" varchar(200),
  "created_by_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "activated_at" timestamptz(6),
  "retired_at" timestamptz(6),
  "failure_code" varchar(120),
  CONSTRAINT "knowledge_embedding_index_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_embedding_index_versions_dimensions_check"
    CHECK ("dimensions" BETWEEN 1 AND 16000),
  CONSTRAINT "knowledge_embedding_index_versions_distance_check"
    CHECK ("distance" = 'COSINE'),
  CONSTRAINT "knowledge_embedding_index_versions_normalization_check"
    CHECK ("normalization" IN ('L2', 'NONE')),
  CONSTRAINT "knowledge_embedding_index_versions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_embedding_index_versions_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_embedding_index_versions_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_embedding_index_versions_tenant_id_id_key"
  ON public."knowledge_embedding_index_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_embedding_index_versions_scope_identity_key"
  ON public."knowledge_embedding_index_versions"("tenant_id", "knowledge_base_id", "id");
CREATE UNIQUE INDEX "knowledge_embedding_index_versions_number_key"
  ON public."knowledge_embedding_index_versions"("tenant_id", "knowledge_base_id", "version");
CREATE INDEX "knowledge_embedding_index_versions_lookup_idx"
  ON public."knowledge_embedding_index_versions"(
    "tenant_id", "knowledge_base_id", "status", "version" DESC
  );

ALTER TABLE public."knowledge_bases"
  ADD COLUMN "active_embedding_index_version_id" uuid,
  ADD COLUMN "pending_embedding_index_version_id" uuid;

-- A typmod-free pgvector column keeps PostgreSQL as a dimension-agnostic
-- evidence ledger and exact-search fallback. Dimension-specific ANN lives in
-- Qdrant collections; a mixed-dimension HNSW index would be invalid.
DROP INDEX public."knowledge_chunk_embeddings_embedding_hnsw_idx";
ALTER TABLE public."knowledge_chunk_embeddings"
  DROP CONSTRAINT "knowledge_chunk_embeddings_dimension_check";
ALTER TABLE public."knowledge_chunk_embeddings"
  ALTER COLUMN "embedding" TYPE vector USING "embedding"::vector;
ALTER TABLE public."knowledge_chunk_embeddings"
  ADD CONSTRAINT "knowledge_chunk_embeddings_dimension_check"
    CHECK (
      "embedding_dimension" BETWEEN 1 AND 16000
      AND vector_dims("embedding") = "embedding_dimension"
    );
ALTER TABLE public."knowledge_chunk_embeddings"
  ADD COLUMN "embedding_index_version_id" uuid;

WITH grouped AS (
  SELECT
    chunk."tenant_id",
    chunk."knowledge_base_id",
    embedding."embedding_model" AS model,
    embedding."embedding_dimension" AS dimensions,
    max(embedding."updated_at") AS last_embedded_at
  FROM public."knowledge_chunk_embeddings" embedding
  JOIN public."knowledge_chunks" chunk
    ON chunk."tenant_id" = embedding."tenant_id"
   AND chunk."id" = embedding."chunk_id"
  GROUP BY
    chunk."tenant_id",
    chunk."knowledge_base_id",
    embedding."embedding_model",
    embedding."embedding_dimension"
), ranked AS (
  SELECT
    grouped.*,
    row_number() OVER (
      PARTITION BY grouped."tenant_id", grouped."knowledge_base_id"
      ORDER BY grouped.last_embedded_at ASC, grouped.model ASC, grouped.dimensions ASC
    )::integer AS version,
    row_number() OVER (
      PARTITION BY grouped."tenant_id", grouped."knowledge_base_id"
      ORDER BY grouped.last_embedded_at DESC, grouped.model DESC, grouped.dimensions DESC
    ) AS newest_rank
  FROM grouped
)
INSERT INTO public."knowledge_embedding_index_versions" (
  "id",
  "tenant_id",
  "knowledge_base_id",
  "version",
  "status",
  "provider",
  "model",
  "dimensions",
  "distance",
  "normalization",
  "collection_name",
  "created_by_id",
  "created_at",
  "activated_at",
  "retired_at"
)
SELECT
  gen_random_uuid(),
  ranked."tenant_id",
  ranked."knowledge_base_id",
  ranked.version,
  CASE
    WHEN ranked.newest_rank = 1 THEN 'ACTIVE'::public."KnowledgeEmbeddingIndexStatus"
    ELSE 'RETIRED'::public."KnowledgeEmbeddingIndexStatus"
  END,
  'legacy_runtime',
  ranked.model,
  ranked.dimensions,
  'COSINE',
  'L2',
  NULL,
  knowledge_base."created_by_id",
  ranked.last_embedded_at,
  CASE WHEN ranked.newest_rank = 1 THEN ranked.last_embedded_at ELSE NULL END,
  CASE WHEN ranked.newest_rank = 1 THEN NULL ELSE ranked.last_embedded_at END
FROM ranked
JOIN public."knowledge_bases" knowledge_base
  ON knowledge_base."tenant_id" = ranked."tenant_id"
 AND knowledge_base."id" = ranked."knowledge_base_id";

UPDATE public."knowledge_chunk_embeddings" embedding
SET "embedding_index_version_id" = index_version."id"
FROM public."knowledge_chunks" chunk,
     public."knowledge_embedding_index_versions" index_version
WHERE chunk."tenant_id" = embedding."tenant_id"
  AND chunk."id" = embedding."chunk_id"
  AND index_version."tenant_id" = chunk."tenant_id"
  AND index_version."knowledge_base_id" = chunk."knowledge_base_id"
  AND index_version."model" = embedding."embedding_model"
  AND index_version."dimensions" = embedding."embedding_dimension";

ALTER TABLE public."knowledge_chunk_embeddings"
  ALTER COLUMN "embedding_index_version_id" SET NOT NULL;

DROP INDEX public."knowledge_chunk_embeddings_tenant_chunk_model_key";
CREATE UNIQUE INDEX "knowledge_chunk_embeddings_tenant_chunk_index_version_key"
  ON public."knowledge_chunk_embeddings"(
    "tenant_id", "chunk_id", "embedding_index_version_id"
  );
CREATE INDEX "knowledge_chunk_embeddings_tenant_index_version_idx"
  ON public."knowledge_chunk_embeddings"("tenant_id", "embedding_index_version_id");

ALTER TABLE public."knowledge_chunk_embeddings"
  ADD CONSTRAINT "knowledge_chunk_embeddings_index_version_fkey"
  FOREIGN KEY ("tenant_id", "embedding_index_version_id")
  REFERENCES public."knowledge_embedding_index_versions"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

UPDATE public."knowledge_bases" knowledge_base
SET "active_embedding_index_version_id" = active_index."id"
FROM public."knowledge_embedding_index_versions" active_index
WHERE active_index."tenant_id" = knowledge_base."tenant_id"
  AND active_index."knowledge_base_id" = knowledge_base."id"
  AND active_index."status" = 'ACTIVE';

ALTER TABLE public."knowledge_bases"
  ADD CONSTRAINT "knowledge_bases_active_embedding_index_version_fkey"
  FOREIGN KEY (
    "tenant_id", "id", "active_embedding_index_version_id"
  ) REFERENCES public."knowledge_embedding_index_versions"(
    "tenant_id", "knowledge_base_id", "id"
  ) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_bases_pending_embedding_index_version_fkey"
  FOREIGN KEY (
    "tenant_id", "id", "pending_embedding_index_version_id"
  ) REFERENCES public."knowledge_embedding_index_versions"(
    "tenant_id", "knowledge_base_id", "id"
  ) ON DELETE RESTRICT ON UPDATE NO ACTION;

GRANT SELECT ON TABLE public."knowledge_embedding_index_versions" TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public."knowledge_embedding_index_versions" TO enterprise_agent_admin;

ALTER TABLE public."knowledge_embedding_index_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_embedding_index_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public."knowledge_embedding_index_versions"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_embedding_index_versions"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

CREATE POLICY enterprise_agent_access
  ON public."knowledge_embedding_index_versions"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

COMMIT;
