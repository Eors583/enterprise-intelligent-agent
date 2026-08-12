ALTER TABLE public."knowledge_document_versions"
  ADD COLUMN "structured_object_key" text,
  ADD COLUMN "structured_object_size" integer,
  ADD COLUMN "structured_object_sha256" char(64),
  ADD COLUMN "structured_format" varchar(120);

ALTER TABLE public."knowledge_document_versions"
  ADD CONSTRAINT "knowledge_document_versions_structured_object_complete_check"
  CHECK (
    ("structured_object_key" IS NULL
      AND "structured_object_size" IS NULL
      AND "structured_object_sha256" IS NULL
      AND "structured_format" IS NULL)
    OR
    ("structured_object_key" IS NOT NULL
      AND "structured_object_size" IS NOT NULL
      AND "structured_object_size" >= 0
      AND "structured_object_sha256" ~ '^[0-9a-f]{64}$'
      AND "structured_format" IS NOT NULL)
  );

COMMENT ON COLUMN public."knowledge_document_versions"."structured_object_key" IS
  'Object-storage key for the normalized, lossless parser JSON; source binaries remain in object_key.';

COMMENT ON COLUMN public."knowledge_document_versions"."structured_format" IS
  'Versioned schema identifier for the structured parser artifact.';
