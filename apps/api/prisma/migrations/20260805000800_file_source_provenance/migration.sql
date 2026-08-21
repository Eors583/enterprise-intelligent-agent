-- Connector-managed files retain a stable HTTPS source location for provenance.
-- TEXT/MARKDOWN sources still cannot claim an external URL, while WEB keeps its
-- mandatory HTTPS invariant and ordinary FILE uploads may remain NULL.
ALTER TABLE public."knowledge_document_versions"
  DROP CONSTRAINT "knowledge_document_versions_source_uri_check";

ALTER TABLE public."knowledge_document_versions"
  ADD CONSTRAINT "knowledge_document_versions_source_uri_check" CHECK (
    (
      "source_type" = 'WEB'
      AND "source_uri" IS NOT NULL
      AND length("source_uri") BETWEEN 9 AND 2048
      AND "source_uri" ~ '^https://'
    )
    OR (
      "source_type" = 'FILE'
      AND (
        "source_uri" IS NULL
        OR (
          length("source_uri") BETWEEN 9 AND 2048
          AND "source_uri" ~ '^https://'
        )
      )
    )
    OR (
      "source_type" IN ('TEXT', 'MARKDOWN')
      AND "source_uri" IS NULL
    )
  );
