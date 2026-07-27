-- Fence a local binding namespace to one Feishu app identity and accept the
-- official employee number length.
BEGIN;

ALTER TABLE public."directory_integrations"
    ADD COLUMN "connector_fingerprint" char(64);

ALTER TABLE public."employments"
    ALTER COLUMN "employee_number" TYPE varchar(255);

ALTER TABLE public."directory_integrations"
    ADD CONSTRAINT "directory_integrations_connector_fingerprint_check"
        CHECK (
            "connector_fingerprint" IS NULL
            OR "connector_fingerprint" ~ '^[0-9a-f]{64}$'
        );

COMMIT;
