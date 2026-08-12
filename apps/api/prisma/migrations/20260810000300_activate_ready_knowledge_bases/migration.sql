-- Initial product flow no longer has a separate publish gate. A Knowledge Base
-- with at least one current READY document is immediately available to the
-- permission-aware employee retrieval path.
UPDATE public."knowledge_bases" AS knowledge_base
SET
  "status" = 'ACTIVE'::public."KnowledgeBaseStatus",
  "version" = knowledge_base."version" + 1,
  "updated_at" = now()
WHERE knowledge_base."status" = 'DRAFT'::public."KnowledgeBaseStatus"
  AND EXISTS (
    SELECT 1
    FROM public."knowledge_documents" AS document
    JOIN public."knowledge_document_versions" AS version
      ON version."tenant_id" = document."tenant_id"
     AND version."knowledge_base_id" = document."knowledge_base_id"
     AND version."document_id" = document."id"
     AND version."id" = document."current_version_id"
    WHERE document."tenant_id" = knowledge_base."tenant_id"
      AND document."knowledge_base_id" = knowledge_base."id"
      AND document."status" = 'READY'::public."KnowledgeDocumentStatus"
      AND version."status" = 'READY'::public."KnowledgeDocumentVersionStatus"
  );
