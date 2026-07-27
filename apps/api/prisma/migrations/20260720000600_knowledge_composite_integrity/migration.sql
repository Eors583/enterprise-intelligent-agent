-- A knowledge document's tenant, knowledge base, document, and version form one
-- indivisible identity. The original ingestion migration constrained tenant and
-- document ids, but still allowed same-tenant rows to mix knowledge-base ids.

BEGIN;

CREATE UNIQUE INDEX "knowledge_documents_scope_identity_key"
  ON public."knowledge_documents"("tenant_id", "knowledge_base_id", "id");

CREATE UNIQUE INDEX "knowledge_documents_current_version_identity_key"
  ON public."knowledge_documents"(
    "tenant_id", "knowledge_base_id", "id", "current_version_id"
  );

CREATE UNIQUE INDEX "knowledge_document_versions_scope_identity_key"
  ON public."knowledge_document_versions"(
    "tenant_id", "knowledge_base_id", "document_id", "id"
  );

ALTER TABLE public."knowledge_documents"
  DROP CONSTRAINT "knowledge_documents_current_version_fkey";

ALTER TABLE public."knowledge_document_versions"
  DROP CONSTRAINT "knowledge_document_versions_document_fkey";

ALTER TABLE public."knowledge_chunks"
  DROP CONSTRAINT "knowledge_chunks_document_fkey",
  DROP CONSTRAINT "knowledge_chunks_document_version_fkey";

ALTER TABLE public."knowledge_document_versions"
  ADD CONSTRAINT "knowledge_document_versions_document_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
  REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public."knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_document_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
  REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_chunks_document_version_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id", "document_version_id")
  REFERENCES public."knowledge_document_versions"(
    "tenant_id", "knowledge_base_id", "document_id", "id"
  )
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE public."knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_current_version_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "id", "current_version_id")
  REFERENCES public."knowledge_document_versions"(
    "tenant_id", "knowledge_base_id", "document_id", "id"
  )
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMIT;
