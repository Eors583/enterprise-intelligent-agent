BEGIN;

CREATE TYPE public."KnowledgeGraphRecordStatus" AS ENUM ('ACTIVE', 'REVIEW', 'DEPRECATED');

-- Evidence rows repeat the complete source identity so that a tenant, knowledge
-- base, document or version cannot be relabelled while pointing at another
-- chunk. PostgreSQL requires the referenced column sequence to be unique.
CREATE UNIQUE INDEX "knowledge_chunks_evidence_identity_key"
  ON public."knowledge_chunks"(
    "tenant_id",
    "knowledge_base_id",
    "document_id",
    "document_version_id",
    "id"
  );

CREATE TABLE public."knowledge_entities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "knowledge_base_id" UUID NOT NULL,
  "entity_type" VARCHAR(100) NOT NULL,
  "canonical_name" VARCHAR(300) NOT NULL,
  "normalized_name" VARCHAR(300) NOT NULL,
  "description" TEXT,
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attributes" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "confidence" DECIMAL(5, 4) NOT NULL DEFAULT 1,
  "status" public."KnowledgeGraphRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_entities_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_entities_entity_type_check"
    CHECK (length(btrim("entity_type")) > 0 AND "entity_type" = btrim("entity_type")),
  CONSTRAINT "knowledge_entities_canonical_name_check"
    CHECK (length(btrim("canonical_name")) > 0 AND "canonical_name" = btrim("canonical_name")),
  CONSTRAINT "knowledge_entities_normalized_name_check"
    CHECK (
      length("normalized_name") > 0
      AND "normalized_name" = lower(btrim("normalized_name"))
    ),
  CONSTRAINT "knowledge_entities_aliases_check"
    CHECK (NOT ('' = ANY ("aliases"))),
  CONSTRAINT "knowledge_entities_attributes_check"
    CHECK (jsonb_typeof("attributes") = 'object'),
  CONSTRAINT "knowledge_entities_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entities_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_entities_scope_identity_key"
  ON public."knowledge_entities"("tenant_id", "knowledge_base_id", "id");
CREATE UNIQUE INDEX "knowledge_entities_canonical_key"
  ON public."knowledge_entities"(
    "tenant_id",
    "knowledge_base_id",
    "entity_type",
    "normalized_name"
  );
CREATE INDEX "knowledge_entities_lookup_idx"
  ON public."knowledge_entities"("tenant_id", "knowledge_base_id", "status", "entity_type");
CREATE INDEX "knowledge_entities_name_trgm_idx"
  ON public."knowledge_entities"
  USING GIN ("canonical_name" gin_trgm_ops);

CREATE TABLE public."knowledge_entity_mentions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "knowledge_base_id" UUID NOT NULL,
  "entity_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version_id" UUID NOT NULL,
  "chunk_id" UUID NOT NULL,
  "surface_form" VARCHAR(500) NOT NULL,
  "start_offset" INTEGER NOT NULL,
  "end_offset" INTEGER NOT NULL,
  "confidence" DECIMAL(5, 4) NOT NULL DEFAULT 1,
  "extractor" VARCHAR(120) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_entity_mentions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_entity_mentions_offsets_check"
    CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset"),
  CONSTRAINT "knowledge_entity_mentions_surface_form_check"
    CHECK (length(btrim("surface_form")) > 0),
  CONSTRAINT "knowledge_entity_mentions_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_entity_mentions_extractor_check"
    CHECK (length(btrim("extractor")) > 0 AND "extractor" = btrim("extractor")),
  CONSTRAINT "knowledge_entity_mentions_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "knowledge_entity_mentions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entity_mentions_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entity_mentions_entity_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "entity_id")
    REFERENCES public."knowledge_entities"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entity_mentions_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entity_mentions_document_version_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_entity_mentions_chunk_fkey"
    FOREIGN KEY (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "chunk_id"
    )
    REFERENCES public."knowledge_chunks"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_entity_mentions_tenant_identity_key"
  ON public."knowledge_entity_mentions"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_entity_mentions_location_key"
  ON public."knowledge_entity_mentions"(
    "tenant_id",
    "entity_id",
    "chunk_id",
    "start_offset",
    "end_offset"
  );
CREATE INDEX "knowledge_entity_mentions_chunk_idx"
  ON public."knowledge_entity_mentions"("tenant_id", "knowledge_base_id", "chunk_id");
CREATE INDEX "knowledge_entity_mentions_version_idx"
  ON public."knowledge_entity_mentions"(
    "tenant_id",
    "knowledge_base_id",
    "document_version_id"
  );

CREATE TABLE public."knowledge_relations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "knowledge_base_id" UUID NOT NULL,
  "subject_entity_id" UUID NOT NULL,
  "predicate" VARCHAR(200) NOT NULL,
  "normalized_predicate" VARCHAR(200) NOT NULL,
  "object_entity_id" UUID NOT NULL,
  "attributes" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "confidence" DECIMAL(5, 4) NOT NULL DEFAULT 1,
  "status" public."KnowledgeGraphRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_relations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_relations_predicate_check"
    CHECK (length(btrim("predicate")) > 0 AND "predicate" = btrim("predicate")),
  CONSTRAINT "knowledge_relations_normalized_predicate_check"
    CHECK (
      length("normalized_predicate") > 0
      AND "normalized_predicate" = upper(btrim("normalized_predicate"))
    ),
  CONSTRAINT "knowledge_relations_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_relations_attributes_check"
    CHECK (jsonb_typeof("attributes") = 'object'),
  CONSTRAINT "knowledge_relations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relations_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relations_subject_entity_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "subject_entity_id")
    REFERENCES public."knowledge_entities"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relations_object_entity_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "object_entity_id")
    REFERENCES public."knowledge_entities"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_relations_scope_identity_key"
  ON public."knowledge_relations"("tenant_id", "knowledge_base_id", "id");
CREATE UNIQUE INDEX "knowledge_relations_assertion_key"
  ON public."knowledge_relations"(
    "tenant_id",
    "knowledge_base_id",
    "subject_entity_id",
    "normalized_predicate",
    "object_entity_id"
  );
CREATE INDEX "knowledge_relations_lookup_idx"
  ON public."knowledge_relations"(
    "tenant_id",
    "knowledge_base_id",
    "status",
    "normalized_predicate"
  );
CREATE INDEX "knowledge_relations_reverse_lookup_idx"
  ON public."knowledge_relations"(
    "tenant_id",
    "knowledge_base_id",
    "object_entity_id",
    "normalized_predicate"
  );

CREATE TABLE public."knowledge_relation_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "knowledge_base_id" UUID NOT NULL,
  "relation_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version_id" UUID NOT NULL,
  "chunk_id" UUID NOT NULL,
  "excerpt" TEXT NOT NULL,
  "start_offset" INTEGER,
  "end_offset" INTEGER,
  "confidence" DECIMAL(5, 4) NOT NULL DEFAULT 1,
  "extractor" VARCHAR(120) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_relation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_relation_evidence_offsets_check"
    CHECK (
      ("start_offset" IS NULL AND "end_offset" IS NULL)
      OR (
        "start_offset" IS NOT NULL
        AND "end_offset" IS NOT NULL
        AND "start_offset" >= 0
        AND "end_offset" > "start_offset"
      )
    ),
  CONSTRAINT "knowledge_relation_evidence_excerpt_check"
    CHECK (length(btrim("excerpt")) > 0),
  CONSTRAINT "knowledge_relation_evidence_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_relation_evidence_extractor_check"
    CHECK (length(btrim("extractor")) > 0 AND "extractor" = btrim("extractor")),
  CONSTRAINT "knowledge_relation_evidence_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "knowledge_relation_evidence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relation_evidence_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relation_evidence_relation_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "relation_id")
    REFERENCES public."knowledge_relations"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relation_evidence_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relation_evidence_document_version_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_relation_evidence_chunk_fkey"
    FOREIGN KEY (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "chunk_id"
    )
    REFERENCES public."knowledge_chunks"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_relation_evidence_tenant_identity_key"
  ON public."knowledge_relation_evidence"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_relation_evidence_location_key"
  ON public."knowledge_relation_evidence"(
    "tenant_id",
    "relation_id",
    "chunk_id",
    COALESCE("start_offset", -1),
    COALESCE("end_offset", -1),
    md5("excerpt")
  );
CREATE INDEX "knowledge_relation_evidence_relation_idx"
  ON public."knowledge_relation_evidence"("tenant_id", "knowledge_base_id", "relation_id");
CREATE INDEX "knowledge_relation_evidence_chunk_idx"
  ON public."knowledge_relation_evidence"("tenant_id", "knowledge_base_id", "chunk_id");
CREATE INDEX "knowledge_relation_evidence_version_idx"
  ON public."knowledge_relation_evidence"(
    "tenant_id",
    "knowledge_base_id",
    "document_version_id"
  );

GRANT SELECT ON TABLE
  public."knowledge_entities",
  public."knowledge_entity_mentions",
  public."knowledge_relations",
  public."knowledge_relation_evidence"
TO enterprise_agent_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."knowledge_entities",
  public."knowledge_entity_mentions",
  public."knowledge_relations",
  public."knowledge_relation_evidence"
TO enterprise_agent_admin;

ALTER TABLE public."knowledge_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_entities" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_entity_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_entity_mentions" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_relations" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_relation_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_relation_evidence" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public."knowledge_entities"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_entities"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);
CREATE POLICY enterprise_agent_access
  ON public."knowledge_entities"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

CREATE POLICY tenant_isolation
  ON public."knowledge_entity_mentions"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_entity_mentions"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);
CREATE POLICY enterprise_agent_access
  ON public."knowledge_entity_mentions"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

CREATE POLICY tenant_isolation
  ON public."knowledge_relations"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_relations"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);
CREATE POLICY enterprise_agent_access
  ON public."knowledge_relations"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

CREATE POLICY tenant_isolation
  ON public."knowledge_relation_evidence"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_relation_evidence"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);
CREATE POLICY enterprise_agent_access
  ON public."knowledge_relation_evidence"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

COMMIT;
