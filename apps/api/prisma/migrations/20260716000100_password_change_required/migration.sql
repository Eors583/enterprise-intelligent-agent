-- Mark provisioned credentials that must be replaced at first login. Existing
-- credentials remain valid without forcing a password change.
BEGIN;

ALTER TABLE public."password_credentials"
    ADD COLUMN "must_change_password" boolean NOT NULL DEFAULT false;

UPDATE public."password_credentials"
SET "must_change_password" = false;

COMMIT;
