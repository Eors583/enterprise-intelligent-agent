-- The initial knowledge workflow no longer asks ordinary users to publish a
-- successfully indexed document manually. Promote any READY version left by
-- the former workflow so removing that button cannot strand historical data.

CREATE TEMP TABLE knowledge_auto_publish_backfill ON COMMIT DROP AS
SELECT DISTINCT ON (document."tenant_id", document."id")
  document."tenant_id",
  document."knowledge_base_id",
  document."id" AS "document_id",
  version."id" AS "document_version_id",
  version."version_number",
  version."content_text",
  version."checksum",
  version."object_key",
  version."mime_type",
  version."file_name",
  CURRENT_TIMESTAMP AS "published_at"
FROM public."knowledge_documents" document
JOIN public."knowledge_document_versions" version
  ON version."tenant_id" = document."tenant_id"
 AND version."knowledge_base_id" = document."knowledge_base_id"
 AND version."document_id" = document."id"
WHERE document."status" <> 'ARCHIVED'::public."KnowledgeDocumentStatus"
  AND version."status" = 'READY'::public."KnowledgeDocumentVersionStatus"
  AND version."published_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM public."knowledge_chunks" chunk
    WHERE chunk."tenant_id" = version."tenant_id"
      AND chunk."document_version_id" = version."id"
  )
  AND (
    document."current_version_id" IS NULL
    OR version."version_number" > document."document_version"
  )
ORDER BY document."tenant_id", document."id", version."version_number" DESC, version."id" DESC;

UPDATE public."knowledge_graph_projections" projection
SET
  "status" = 'OBSOLETE'::public."KnowledgeGraphProjectionStatus",
  "obsoleted_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP
FROM knowledge_auto_publish_backfill selected
WHERE projection."tenant_id" = selected."tenant_id"
  AND projection."knowledge_base_id" = selected."knowledge_base_id"
  AND projection."document_id" = selected."document_id"
  AND projection."status" = 'ACTIVE'::public."KnowledgeGraphProjectionStatus";

UPDATE public."knowledge_graph_projections" projection
SET
  "status" = 'ACTIVE'::public."KnowledgeGraphProjectionStatus",
  "activated_at" = CURRENT_TIMESTAMP,
  "obsoleted_at" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
FROM knowledge_auto_publish_backfill selected
WHERE projection."tenant_id" = selected."tenant_id"
  AND projection."knowledge_base_id" = selected."knowledge_base_id"
  AND projection."document_id" = selected."document_id"
  AND projection."document_version_id" = selected."document_version_id"
  AND projection."status" = 'CANDIDATE'::public."KnowledgeGraphProjectionStatus";

UPDATE public."knowledge_document_versions" version
SET "published_at" = selected."published_at"
FROM knowledge_auto_publish_backfill selected
WHERE version."tenant_id" = selected."tenant_id"
  AND version."id" = selected."document_version_id"
  AND version."published_at" IS NULL;

UPDATE public."knowledge_documents" document
SET
  "current_version_id" = selected."document_version_id",
  "status" = 'READY'::public."KnowledgeDocumentStatus",
  "document_version" = selected."version_number",
  "content_text" = selected."content_text",
  "checksum" = selected."checksum",
  "object_key" = selected."object_key",
  "mime_type" = selected."mime_type",
  "file_name" = selected."file_name",
  "updated_at" = CURRENT_TIMESTAMP
FROM knowledge_auto_publish_backfill selected
WHERE document."tenant_id" = selected."tenant_id"
  AND document."id" = selected."document_id";

INSERT INTO public."outbox_events" (
  "id",
  "tenant_id",
  "aggregate_type",
  "aggregate_id",
  "event_type",
  "payload"
)
SELECT
  gen_random_uuid(),
  selected."tenant_id",
  'knowledge_document_version',
  selected."document_version_id",
  'knowledge.document-version.published.v1',
  jsonb_build_object(
    'knowledgeBaseId', selected."knowledge_base_id",
    'documentId', selected."document_id",
    'documentVersionId', selected."document_version_id",
    'version', selected."version_number",
    'graphProjectionId', projection."id",
    'graphHash', projection."graph_hash",
    'publishedAt', to_char(selected."published_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
FROM knowledge_auto_publish_backfill selected
LEFT JOIN public."knowledge_graph_projections" projection
  ON projection."tenant_id" = selected."tenant_id"
 AND projection."knowledge_base_id" = selected."knowledge_base_id"
 AND projection."document_id" = selected."document_id"
 AND projection."document_version_id" = selected."document_version_id"
 AND projection."status" = 'ACTIVE'::public."KnowledgeGraphProjectionStatus";
