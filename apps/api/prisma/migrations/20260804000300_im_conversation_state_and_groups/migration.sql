ALTER TYPE public."ConversationType" ADD VALUE IF NOT EXISTS 'GROUP';

CREATE TYPE public."ConversationParticipantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

ALTER TABLE public."conversation_participants"
  ADD COLUMN "role" public."ConversationParticipantRole" NOT NULL DEFAULT 'MEMBER';

CREATE TABLE public."conversation_user_states" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "unread_count" integer NOT NULL DEFAULT 0,
  "last_read_message_id" uuid,
  "last_read_at" timestamptz(6),
  "pinned_at" timestamptz(6),
  "archived_at" timestamptz(6),
  "muted_until" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_user_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_user_states_unread_count_ck" CHECK ("unread_count" >= 0),
  CONSTRAINT "conversation_user_states_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "conversation_user_states_tenant_conversation_user_key"
    UNIQUE ("tenant_id", "conversation_id", "user_id"),
  CONSTRAINT "conversation_user_states_conversation_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id")
    REFERENCES public."conversations" ("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "conversation_user_states_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "conversation_user_states_list_idx"
  ON public."conversation_user_states"
  ("tenant_id", "user_id", "pinned_at" DESC, "archived_at", "updated_at" DESC);

CREATE INDEX "conversation_user_states_unread_idx"
  ON public."conversation_user_states" ("tenant_id", "conversation_id", "unread_count");

INSERT INTO public."conversation_user_states" (
  "tenant_id", "conversation_id", "user_id", "unread_count", "created_at", "updated_at"
)
SELECT participant."tenant_id", participant."conversation_id", participant."user_id", 0, now(), now()
FROM public."conversation_participants" participant
WHERE participant."type" = 'USER'
  AND participant."user_id" IS NOT NULL
  AND participant."left_at" IS NULL
ON CONFLICT ("tenant_id", "conversation_id", "user_id") DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_conversation_user_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."type" = 'USER' AND NEW."user_id" IS NOT NULL AND NEW."left_at" IS NULL THEN
    INSERT INTO public."conversation_user_states" (
      "tenant_id", "conversation_id", "user_id", "unread_count", "created_at", "updated_at"
    ) VALUES (
      NEW."tenant_id", NEW."conversation_id", NEW."user_id", 0, now(), now()
    )
    ON CONFLICT ("tenant_id", "conversation_id", "user_id")
    DO UPDATE SET "updated_at" = EXCLUDED."updated_at";
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "conversation_participants_user_state_trigger"
AFTER INSERT OR UPDATE OF "left_at", "display_name", "role"
ON public."conversation_participants"
FOR EACH ROW EXECUTE FUNCTION public.ensure_conversation_user_state();

CREATE OR REPLACE FUNCTION public.project_message_unread_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public."conversation_user_states" (
    "tenant_id", "conversation_id", "user_id", "unread_count", "created_at", "updated_at"
  )
  SELECT
    participant."tenant_id",
    participant."conversation_id",
    participant."user_id",
    1,
    now(),
    now()
  FROM public."conversation_participants" participant
  WHERE participant."tenant_id" = NEW."tenant_id"
    AND participant."conversation_id" = NEW."conversation_id"
    AND participant."type" = 'USER'
    AND participant."user_id" IS NOT NULL
    AND participant."left_at" IS NULL
    AND (NEW."sender_user_id" IS NULL OR participant."user_id" <> NEW."sender_user_id")
  ON CONFLICT ("tenant_id", "conversation_id", "user_id")
  DO UPDATE SET
    "unread_count" = public."conversation_user_states"."unread_count" + 1,
    "archived_at" = NULL,
    "updated_at" = EXCLUDED."updated_at";

  IF NEW."sender_user_id" IS NOT NULL THEN
    UPDATE public."conversation_user_states"
    SET "unread_count" = 0,
        "last_read_message_id" = NEW."id",
        "last_read_at" = NEW."created_at",
        "updated_at" = now()
    WHERE "tenant_id" = NEW."tenant_id"
      AND "conversation_id" = NEW."conversation_id"
      AND "user_id" = NEW."sender_user_id";
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "messages_unread_projection_trigger"
AFTER INSERT ON public."messages"
FOR EACH ROW EXECUTE FUNCTION public.project_message_unread_state();

ALTER TABLE public."conversation_user_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."conversation_user_states" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON public."conversation_user_states"
AS RESTRICTIVE FOR ALL TO PUBLIC
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "enterprise_agent_access" ON public."conversation_user_states"
AS PERMISSIVE FOR ALL TO enterprise_agent_app
USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public."conversation_user_states"
TO enterprise_agent_app;

REVOKE ALL ON FUNCTION public.ensure_conversation_user_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_message_unread_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_conversation_user_state() TO enterprise_agent_app;
GRANT EXECUTE ON FUNCTION public.project_message_unread_state() TO enterprise_agent_app;
