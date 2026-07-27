BEGIN;

ALTER TABLE public."directory_integrations"
    ADD COLUMN "connector_app_id" varchar(200),
    ADD COLUMN "connector_secret" text;

ALTER TABLE public."directory_integrations"
    ADD CONSTRAINT "directory_integrations_connector_credentials_check"
        CHECK (
            ("connector_app_id" IS NULL AND "connector_secret" IS NULL)
            OR
            (length("connector_app_id") BETWEEN 3 AND 200 AND length("connector_secret") BETWEEN 20 AND 4096)
        );

COMMIT;
