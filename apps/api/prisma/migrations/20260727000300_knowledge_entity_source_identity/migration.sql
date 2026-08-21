BEGIN;

ALTER TABLE public."knowledge_entities"
  ADD COLUMN "external_key" VARCHAR(300);

-- Existing rows were produced before source identities existed. Semantic rows
-- remain globally resolvable by normalized name. Source-scoped rows receive a
-- collision-free legacy identity and converge to the document-derived identity
-- on the next version rebuild without rewriting historical evidence.
UPDATE public."knowledge_entities"
SET "external_key" = 'legacy:' || "id"::text
WHERE "entity_type" IN ('DOCUMENT', 'SECTION');

ALTER TABLE public."knowledge_entities"
  ADD CONSTRAINT "knowledge_entities_external_key_check"
    CHECK (
      "external_key" IS NULL
      OR (
        length("external_key") > 0
        AND "external_key" = lower(btrim("external_key"))
      )
    ),
  ADD CONSTRAINT "knowledge_entities_source_identity_check"
    CHECK (
      "entity_type" NOT IN ('DOCUMENT', 'SECTION')
      OR "external_key" IS NOT NULL
    );

DROP INDEX public."knowledge_entities_canonical_key";

CREATE UNIQUE INDEX "knowledge_entities_semantic_identity_key"
  ON public."knowledge_entities"(
    "tenant_id",
    "knowledge_base_id",
    "entity_type",
    "normalized_name"
  )
  WHERE "external_key" IS NULL;

CREATE UNIQUE INDEX "knowledge_entities_source_identity_key"
  ON public."knowledge_entities"(
    "tenant_id",
    "knowledge_base_id",
    "entity_type",
    "external_key"
  )
  WHERE "external_key" IS NOT NULL;

COMMIT;
