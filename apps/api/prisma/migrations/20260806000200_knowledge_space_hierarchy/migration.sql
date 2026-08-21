-- Classify every knowledge base under one of four sibling knowledge-space
-- roots. The generic target identity keeps the knowledge boundary independent
-- from organization, project and member table layouts; the API validates
-- concrete targets through its boundary adapters.

BEGIN;

CREATE TYPE public."KnowledgeSpaceType" AS ENUM (
  'COMPANY',
  'DEPARTMENT',
  'PROJECT',
  'MEMBER'
);

ALTER TABLE public."knowledge_bases"
  ADD COLUMN "space_type" public."KnowledgeSpaceType" NOT NULL DEFAULT 'COMPANY',
  ADD COLUMN "space_target_id" uuid,
  ADD COLUMN "space_target_name" varchar(200);

-- Existing flat knowledge bases become company knowledge without changing
-- their visibility or retrieval behavior.
UPDATE public."knowledge_bases" knowledge_base
SET
  "space_target_id" = knowledge_base."tenant_id",
  "space_target_name" = tenant."name"
FROM public."tenants" tenant
WHERE tenant."id" = knowledge_base."tenant_id";

ALTER TABLE public."knowledge_bases"
  ALTER COLUMN "space_target_id" SET NOT NULL,
  ALTER COLUMN "space_target_name" SET NOT NULL,
  ADD CONSTRAINT "knowledge_bases_space_target_name_check"
    CHECK (length(btrim("space_target_name")) BETWEEN 1 AND 200);

CREATE INDEX "knowledge_bases_space_tree_idx"
  ON public."knowledge_bases"(
    "tenant_id", "space_type", "space_target_id", "name"
  );

COMMIT;
