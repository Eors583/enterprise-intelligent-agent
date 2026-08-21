BEGIN;

CREATE TABLE public."knowledge_parent_chunks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "parent_index" integer NOT NULL,
  "heading_path" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "content" text NOT NULL,
  "token_count" integer NOT NULL CHECK ("token_count" >= 0),
  "content_hash" char(64) NOT NULL CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_parent_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_parent_chunks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_parent_chunks_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_parent_chunks_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_parent_chunks_document_version_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"(
      "tenant_id", "knowledge_base_id", "document_id", "id"
    ) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_parent_chunks_tenant_id_id_key"
  ON public."knowledge_parent_chunks"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_parent_chunks_scope_identity_key"
  ON public."knowledge_parent_chunks"(
    "tenant_id", "knowledge_base_id", "document_id", "document_version_id", "id"
  );
CREATE UNIQUE INDEX "knowledge_parent_chunks_version_index_key"
  ON public."knowledge_parent_chunks"("tenant_id", "document_version_id", "parent_index");
CREATE INDEX "knowledge_parent_chunks_scope_idx"
  ON public."knowledge_parent_chunks"("tenant_id", "knowledge_base_id", "document_id");

ALTER TABLE public."knowledge_chunks"
  ADD COLUMN "parent_chunk_id" uuid,
  ADD COLUMN "previous_chunk_id" uuid,
  ADD COLUMN "next_chunk_id" uuid;

-- Existing chunks are grouped by heading into compatibility parents. A normal
-- re-ingestion replaces these with parser-native page or section parents.
WITH grouped AS (
  SELECT
    chunk."tenant_id",
    chunk."knowledge_base_id",
    chunk."document_id",
    chunk."document_version_id",
    chunk."heading_path",
    min(chunk."chunk_index") AS first_chunk_index,
    string_agg(chunk."content", E'\n\n' ORDER BY chunk."chunk_index") AS content,
    sum(chunk."token_count")::integer AS token_count,
    min(chunk."metadata"::text)::jsonb AS metadata
  FROM public."knowledge_chunks" AS chunk
  GROUP BY
    chunk."tenant_id", chunk."knowledge_base_id", chunk."document_id",
    chunk."document_version_id", chunk."heading_path"
), numbered AS (
  SELECT
    grouped.*,
    row_number() OVER (
      PARTITION BY grouped."tenant_id", grouped."document_version_id"
      ORDER BY grouped.first_chunk_index, grouped."heading_path"
    )::integer - 1 AS parent_index
  FROM grouped
)
INSERT INTO public."knowledge_parent_chunks" (
  "tenant_id", "knowledge_base_id", "document_id", "document_version_id",
  "parent_index", "heading_path", "content", "token_count", "content_hash", "metadata"
)
SELECT
  "tenant_id", "knowledge_base_id", "document_id", "document_version_id",
  parent_index, "heading_path", content, token_count,
  encode(digest(content, 'sha256'), 'hex'),
  metadata || jsonb_build_object('migrationBackfill', true)
FROM numbered;

UPDATE public."knowledge_chunks" AS chunk
SET "parent_chunk_id" = parent."id"
FROM public."knowledge_parent_chunks" AS parent
WHERE parent."tenant_id" = chunk."tenant_id"
  AND parent."knowledge_base_id" = chunk."knowledge_base_id"
  AND parent."document_id" = chunk."document_id"
  AND parent."document_version_id" = chunk."document_version_id"
  AND parent."heading_path" = chunk."heading_path";

WITH ordered AS (
  SELECT
    "tenant_id", "id",
    lag("id") OVER (
      PARTITION BY "tenant_id", "document_version_id" ORDER BY "chunk_index", "id"
    ) AS previous_chunk_id,
    lead("id") OVER (
      PARTITION BY "tenant_id", "document_version_id" ORDER BY "chunk_index", "id"
    ) AS next_chunk_id
  FROM public."knowledge_chunks"
)
UPDATE public."knowledge_chunks" AS chunk
SET
  "previous_chunk_id" = ordered.previous_chunk_id,
  "next_chunk_id" = ordered.next_chunk_id
FROM ordered
WHERE ordered."tenant_id" = chunk."tenant_id" AND ordered."id" = chunk."id";

ALTER TABLE public."knowledge_chunks"
  ALTER COLUMN "parent_chunk_id" SET NOT NULL,
  ADD CONSTRAINT "knowledge_chunks_parent_chunk_fkey"
    FOREIGN KEY (
      "tenant_id", "knowledge_base_id", "document_id", "document_version_id", "parent_chunk_id"
    ) REFERENCES public."knowledge_parent_chunks"(
      "tenant_id", "knowledge_base_id", "document_id", "document_version_id", "id"
    ) ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_chunks_previous_not_self_check"
    CHECK ("previous_chunk_id" IS NULL OR "previous_chunk_id" <> "id"),
  ADD CONSTRAINT "knowledge_chunks_next_not_self_check"
    CHECK ("next_chunk_id" IS NULL OR "next_chunk_id" <> "id");

CREATE INDEX "knowledge_chunks_parent_idx"
  ON public."knowledge_chunks"("tenant_id", "parent_chunk_id", "chunk_index");
CREATE INDEX "knowledge_chunks_previous_idx"
  ON public."knowledge_chunks"("tenant_id", "previous_chunk_id")
  WHERE "previous_chunk_id" IS NOT NULL;
CREATE INDEX "knowledge_chunks_next_idx"
  ON public."knowledge_chunks"("tenant_id", "next_chunk_id")
  WHERE "next_chunk_id" IS NOT NULL;

GRANT SELECT ON TABLE public."knowledge_parent_chunks" TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."knowledge_parent_chunks"
  TO enterprise_agent_admin;

ALTER TABLE public."knowledge_parent_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_parent_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public."knowledge_parent_chunks"
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_access ON public."knowledge_parent_chunks"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true);
CREATE POLICY enterprise_agent_admin_access ON public."knowledge_parent_chunks"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true);

COMMENT ON TABLE public."knowledge_parent_chunks" IS
  'Page or section parent context blocks for child retrieval chunks.';
COMMENT ON COLUMN public."knowledge_chunks"."previous_chunk_id" IS
  'Previous child in deterministic document-version order; scoped by the row tenant and version.';
COMMENT ON COLUMN public."knowledge_chunks"."next_chunk_id" IS
  'Next child in deterministic document-version order; scoped by the row tenant and version.';

COMMIT;
