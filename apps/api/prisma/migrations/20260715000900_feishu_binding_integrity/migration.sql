-- Strengthen Feishu binding identity and add durable two-phase removal markers.
BEGIN;

ALTER TABLE public."directory_user_bindings"
    ADD COLUMN "missing_since_at" timestamptz(6);

ALTER TABLE public."directory_org_unit_bindings"
    ADD COLUMN "missing_since_at" timestamptz(6);

ALTER TABLE public."directory_employment_bindings"
    ADD COLUMN "user_id" uuid,
    ADD COLUMN "organization_id" uuid,
    ADD COLUMN "org_unit_id" uuid,
    ADD COLUMN "missing_since_at" timestamptz(6);

UPDATE public."directory_employment_bindings" AS binding
SET
    "user_id" = employment."user_id",
    "organization_id" = employment."organization_id",
    "org_unit_id" = employment."org_unit_id"
FROM public."employments" AS employment
WHERE employment."tenant_id" = binding."tenant_id"
  AND employment."id" = binding."employment_id";

ALTER TABLE public."directory_employment_bindings"
    ALTER COLUMN "user_id" SET NOT NULL,
    ALTER COLUMN "organization_id" SET NOT NULL,
    ALTER COLUMN "org_unit_id" SET NOT NULL;

CREATE UNIQUE INDEX "employments_directory_binding_key"
    ON public."employments"("tenant_id", "id", "user_id", "organization_id", "org_unit_id");
CREATE UNIQUE INDEX "directory_integrations_tenant_id_id_organization_id_key"
    ON public."directory_integrations"("tenant_id", "id", "organization_id");
CREATE UNIQUE INDEX "directory_user_bindings_employment_key"
    ON public."directory_user_bindings"(
        "tenant_id", "integration_id", "external_user_id", "user_id"
    );
CREATE UNIQUE INDEX "directory_org_unit_bindings_employment_key"
    ON public."directory_org_unit_bindings"(
        "tenant_id", "integration_id", "external_department_id", "organization_id", "org_unit_id"
    );

CREATE INDEX "directory_user_bindings_missing_since_idx"
    ON public."directory_user_bindings"("tenant_id", "integration_id", "missing_since_at");
CREATE INDEX "directory_org_unit_bindings_missing_since_idx"
    ON public."directory_org_unit_bindings"("tenant_id", "integration_id", "missing_since_at");
CREATE INDEX "directory_employment_bindings_missing_since_idx"
    ON public."directory_employment_bindings"("tenant_id", "integration_id", "missing_since_at");

ALTER TABLE public."directory_org_unit_bindings"
    DROP CONSTRAINT "directory_org_unit_bindings_tenant_id_integration_id_fkey",
    ADD CONSTRAINT "directory_org_unit_bindings_integration_organization_fkey"
        FOREIGN KEY ("tenant_id", "integration_id", "organization_id")
        REFERENCES public."directory_integrations"("tenant_id", "id", "organization_id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."directory_employment_bindings"
    DROP CONSTRAINT "directory_employment_bindings_tenant_id_integration_id_fkey",
    DROP CONSTRAINT "directory_employment_bindings_tenant_id_employment_id_fkey",
    ADD CONSTRAINT "directory_employment_bindings_integration_organization_fkey"
        FOREIGN KEY ("tenant_id", "integration_id", "organization_id")
        REFERENCES public."directory_integrations"("tenant_id", "id", "organization_id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_employment_bindings_user_binding_fkey"
        FOREIGN KEY ("tenant_id", "integration_id", "external_user_id", "user_id")
        REFERENCES public."directory_user_bindings"(
            "tenant_id", "integration_id", "external_user_id", "user_id"
        )
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_employment_bindings_org_unit_binding_fkey"
        FOREIGN KEY (
            "tenant_id", "integration_id", "external_department_id", "organization_id", "org_unit_id"
        )
        REFERENCES public."directory_org_unit_bindings"(
            "tenant_id", "integration_id", "external_department_id", "organization_id", "org_unit_id"
        )
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_employment_bindings_employment_identity_fkey"
        FOREIGN KEY ("tenant_id", "employment_id", "user_id", "organization_id", "org_unit_id")
        REFERENCES public."employments"(
            "tenant_id", "id", "user_id", "organization_id", "org_unit_id"
        )
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
