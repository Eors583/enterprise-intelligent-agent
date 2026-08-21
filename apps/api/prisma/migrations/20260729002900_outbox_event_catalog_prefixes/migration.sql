BEGIN;

-- Prefixes are deliberately FACT_ONLY. Work-producing events must be exact
-- routes so a new command cannot silently acquire or bypass a consumer.
CREATE TABLE public."outbox_event_route_prefixes" (
  "event_type_prefix" VARCHAR(159) NOT NULL,
  "purpose" public."OutboxEventRoutingPurpose" NOT NULL DEFAULT 'FACT_ONLY',
  "description" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_event_route_prefixes_pkey" PRIMARY KEY ("event_type_prefix"),
  CONSTRAINT "outbox_event_route_prefixes_fact_only_check"
    CHECK ("purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose"),
  CONSTRAINT "outbox_event_route_prefixes_value_check"
    CHECK (length(btrim("event_type_prefix")) BETWEEN 2 AND 159)
);

INSERT INTO public."outbox_event_route_prefixes" (
  "event_type_prefix", "purpose", "description"
)
VALUES
  ('admin.knowledge-document-version.', 'FACT_ONLY', 'Knowledge ingestion lifecycle facts.'),
  ('admin.knowledge-graph-', 'FACT_ONLY', 'Knowledge graph automatic-governance facts.'),
  ('business_semantics.', 'FACT_ONLY', 'Business-semantics governance and lifecycle facts.'),
  ('Experience', 'FACT_ONLY', 'Experience lifecycle and governance facts.'),
  ('finops.', 'FACT_ONLY', 'FinOps governance, projection, and ledger facts.'),
  ('knowledge.graph.', 'FACT_ONLY', 'Knowledge graph governance facts.'),
  ('marketing.', 'FACT_ONLY', 'Marketing governance and execution facts.'),
  ('Memory', 'FACT_ONLY', 'Memory lifecycle and governance facts.'),
  ('organization.', 'FACT_ONLY', 'Organization governance facts.'),
  ('people.', 'FACT_ONLY', 'People and competency governance facts.'),
  ('ProcessInstance.', 'FACT_ONLY', 'Process-instance lifecycle facts.'),
  ('ProcessStep.', 'FACT_ONLY', 'Process-step lifecycle facts.'),
  ('ToolVersion.', 'FACT_ONLY', 'Tool-version lifecycle facts.');

CREATE OR REPLACE FUNCTION public.route_outbox_event_to_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  route_record record;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW."tenant_id"::text, true);

  -- Exact routes always win. In particular, every DELIVERY route is exact.
  SELECT route."purpose", route."consumer_key", route."lane"
    INTO route_record
  FROM public."outbox_event_routes" route
  WHERE route."event_type" = NEW."event_type";

  IF route_record."purpose" IS NULL THEN
    SELECT prefix."purpose", NULL::varchar(120), NULL::varchar(120)
      INTO route_record
    FROM public."outbox_event_route_prefixes" prefix
    WHERE left(NEW."event_type", length(prefix."event_type_prefix"))
      = prefix."event_type_prefix"
    ORDER BY length(prefix."event_type_prefix") DESC, prefix."event_type_prefix"
    LIMIT 1;
  END IF;

  IF route_record."purpose" IS NULL THEN
    UPDATE public."outbox_events"
    SET "routing_purpose" = 'QUARANTINED',
        "routing_resolved_at" = CURRENT_TIMESTAMP,
        "routing_error" = 'UNREGISTERED_EVENT_TYPE'
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."id";
    PERFORM set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
    RETURN NEW;
  END IF;

  UPDATE public."outbox_events"
  SET "routing_purpose" = route_record."purpose",
      "routing_resolved_at" = CURRENT_TIMESTAMP,
      "routing_error" = NULL
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";

  IF route_record."purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose" THEN
    INSERT INTO public."outbox_event_deliveries" (
      "tenant_id", "event_id", "consumer_key", "lane", "status",
      "attempts", "available_at", "created_at", "updated_at"
    )
    VALUES (
      NEW."tenant_id", NEW."id", route_record."consumer_key",
      route_record."lane", 'PENDING'::public."OutboxEventStatus",
      0, NEW."available_at", NEW."created_at", CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenant_id", "event_id", "consumer_key") DO NOTHING;
  END IF;

  PERFORM set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.route_outbox_event_to_delivery() FROM PUBLIC;

-- Existing quarantined facts are reclassified in place. No event is copied,
-- marked delivered, or replayed, and original event IDs remain unchanged.
UPDATE public."outbox_events" event
SET "routing_purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose",
    "routing_resolved_at" = CURRENT_TIMESTAMP,
    "routing_error" = NULL
WHERE event."routing_purpose" = 'QUARANTINED'::public."OutboxEventRoutingPurpose"
  AND event."routing_error" = 'UNREGISTERED_EVENT_TYPE'
  AND EXISTS (
    SELECT 1
    FROM public."outbox_event_route_prefixes" prefix
    WHERE left(event."event_type", length(prefix."event_type_prefix"))
      = prefix."event_type_prefix"
  );

REVOKE ALL PRIVILEGES ON TABLE public."outbox_event_route_prefixes"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_provisioner, enterprise_agent_outbox;
GRANT SELECT ON TABLE public."outbox_event_route_prefixes"
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_outbox;

COMMIT;
