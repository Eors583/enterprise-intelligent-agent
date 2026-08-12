BEGIN;

UPDATE "knowledge_bases" AS knowledge_base
   SET "status" = 'ARCHIVED'::"KnowledgeBaseStatus",
       "version" = knowledge_base."version" + 1,
       "updated_at" = NOW()
 WHERE knowledge_base."status" <> 'ARCHIVED'::"KnowledgeBaseStatus"
   AND EXISTS (
     SELECT 1
       FROM "knowledge_documents" AS historical_document
      WHERE historical_document."tenant_id" = knowledge_base."tenant_id"
        AND historical_document."knowledge_base_id" = knowledge_base."id"
   )
   AND NOT EXISTS (
     SELECT 1
       FROM "knowledge_documents" AS active_document
      WHERE active_document."tenant_id" = knowledge_base."tenant_id"
        AND active_document."knowledge_base_id" = knowledge_base."id"
        AND active_document."status" <> 'ARCHIVED'::"KnowledgeDocumentStatus"
   );

COMMIT;
