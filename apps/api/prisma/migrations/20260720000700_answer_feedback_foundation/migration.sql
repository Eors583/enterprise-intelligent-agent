BEGIN;

CREATE TYPE "AnswerFeedbackRating" AS ENUM ('HELPFUL', 'NOT_HELPFUL');
CREATE TYPE "AnswerFeedbackReason" AS ENUM (
  'INCORRECT',
  'IRRELEVANT_CITATION',
  'OUTDATED',
  'MISSING_KNOWLEDGE',
  'OTHER'
);

CREATE TABLE public."answer_feedbacks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "rating" "AnswerFeedbackRating" NOT NULL,
  "reason" "AnswerFeedbackReason",
  "comment" varchar(500),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "answer_feedbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "answer_feedbacks_rating_reason_check" CHECK (
    ("rating" = 'HELPFUL' AND "reason" IS NULL)
    OR ("rating" = 'NOT_HELPFUL' AND "reason" IS NOT NULL)
  ),
  CONSTRAINT "answer_feedbacks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "answer_feedbacks_tenant_id_message_id_fkey"
    FOREIGN KEY ("tenant_id", "message_id")
    REFERENCES public."messages"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "answer_feedbacks_tenant_id_user_id_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "answer_feedbacks_tenant_id_message_id_user_id_key"
  ON public."answer_feedbacks"("tenant_id", "message_id", "user_id");
CREATE INDEX "answer_feedbacks_tenant_id_user_id_updated_at_idx"
  ON public."answer_feedbacks"("tenant_id", "user_id", "updated_at" DESC);
CREATE INDEX "answer_feedbacks_tenant_id_rating_updated_at_idx"
  ON public."answer_feedbacks"("tenant_id", "rating", "updated_at" DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE public."answer_feedbacks" TO enterprise_agent_app;
GRANT SELECT ON TABLE public."answer_feedbacks" TO enterprise_agent_admin;

ALTER TABLE public."answer_feedbacks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."answer_feedbacks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."answer_feedbacks"
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY enterprise_agent_access ON public."answer_feedbacks"
  AS PERMISSIVE FOR ALL TO enterprise_agent_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY enterprise_agent_admin_access ON public."answer_feedbacks"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_admin
  USING (true);

COMMIT;
