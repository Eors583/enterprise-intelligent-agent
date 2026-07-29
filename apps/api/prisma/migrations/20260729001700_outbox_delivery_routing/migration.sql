-- Domain facts are immutable records. Delivery state belongs to a concrete
-- consumer and must not mutate or overload the source event.
BEGIN;

CREATE TYPE public."OutboxEventRoutingPurpose" AS ENUM (
  'FACT_ONLY',
  'DELIVERY',
  'QUARANTINED'
);

CREATE TABLE public."outbox_event_routes" (
  "event_type" VARCHAR(160) NOT NULL,
  "purpose" public."OutboxEventRoutingPurpose" NOT NULL,
  "consumer_key" VARCHAR(120),
  "lane" VARCHAR(120),
  "description" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_event_routes_pkey" PRIMARY KEY ("event_type"),
  CONSTRAINT "outbox_event_routes_delivery_shape_check" CHECK (
    (
      "purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose"
      AND "consumer_key" IS NOT NULL
      AND btrim("consumer_key") <> ''
      AND "lane" IS NOT NULL
      AND btrim("lane") <> ''
    )
    OR (
      "purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose"
      AND "consumer_key" IS NULL
      AND "lane" IS NULL
    )
  ),
  CONSTRAINT "outbox_event_routes_no_quarantine_registry_check" CHECK (
    "purpose" <> 'QUARANTINED'::public."OutboxEventRoutingPurpose"
  )
);

INSERT INTO public."outbox_event_routes" (
  "event_type", "purpose", "consumer_key", "lane", "description"
)
VALUES
  (
    'message.created.v1', 'DELIVERY', 'im-delivery', 'im.message',
    'Deliver a committed conversation message to the configured IM provider.'
  ),
  (
    'agent.run_requested.v1', 'DELIVERY', 'agent-run-worker', 'agent.run.execute',
    'Execute one Agent Run through the AI Runtime.'
  ),
  (
    'agent.run_cancel_requested.v1', 'DELIVERY', 'agent-run-worker', 'agent.run.cancel',
    'Cancel or reconcile one Agent Run.'
  ),
  (
    'ToolInvocationCommandRecorded', 'DELIVERY', 'tool-execution-worker', 'tool.execute',
    'Dispatch one sealed Tool Invocation command.'
  ),
  (
    'ToolInvocation.ReconciliationRequested', 'DELIVERY',
    'tool-reconciliation-worker', 'tool.reconcile',
    'Reconcile a Tool Invocation whose external outcome is unknown.'
  ),
  (
    'admin.directory.feishu.sync.requested.v1', 'DELIVERY',
    'feishu-directory-worker', 'directory.feishu.sync',
    'Apply one reviewed Feishu directory synchronization preview.'
  ),
  (
    'conversation.created.v1', 'FACT_ONLY', NULL, NULL,
    'Conversation creation audit fact.'
  ),
  (
    'agent.answer-feedback.recorded.v1', 'FACT_ONLY', NULL, NULL,
    'Employee answer feedback fact.'
  ),
  (
    'BusinessEventDelivery.Replayed', 'FACT_ONLY', NULL, NULL,
    'Business-event replay governance fact.'
  ),
  (
    'Collaboration.Requested', 'FACT_ONLY', NULL, NULL,
    'Structured collaboration request fact.'
  ),
  (
    'Correction.FeedbackSubmitted', 'FACT_ONLY', NULL, NULL,
    'Correction feedback submission fact.'
  ),
  (
    'experience.knowledge-projection.status-changed.v1', 'FACT_ONLY', NULL, NULL,
    'Experience-to-knowledge projection lifecycle fact.'
  ),
  (
    'ExperienceCandidateCreated', 'FACT_ONLY', NULL, NULL,
    'Experience candidate creation fact.'
  ),
  (
    'MemoryCandidateCreated', 'FACT_ONLY', NULL, NULL,
    'Memory candidate creation fact.'
  ),
  (
    'finops.cost.auto_projected.v1', 'FACT_ONLY', NULL, NULL,
    'FinOps automatic projection fact.'
  ),
  (
    'finops.projection.blocked.v1', 'FACT_ONLY', NULL, NULL,
    'FinOps projection blocking fact.'
  ),
  (
    'finops.projection.resolved.v1', 'FACT_ONLY', NULL, NULL,
    'FinOps projection reconciliation fact.'
  ),
  (
    'knowledge.document-version.governance-reviewed.v1', 'FACT_ONLY', NULL, NULL,
    'Knowledge governance review fact.'
  ),
  (
    'knowledge.document-version.governance-updated.v1', 'FACT_ONLY', NULL, NULL,
    'Knowledge governance update fact.'
  ),
  (
    'knowledge.document-version.parse-reviewed.v1', 'FACT_ONLY', NULL, NULL,
    'Knowledge parse review fact.'
  ),
  (
    'knowledge.document-version.published.v1', 'FACT_ONLY', NULL, NULL,
    'Knowledge publication fact.'
  ),
  (
    'Process.Started', 'FACT_ONLY', NULL, NULL,
    'Process start fact.'
  ),
  (
    'ToolDefinition.Created', 'FACT_ONLY', NULL, NULL,
    'Tool definition creation fact.'
  ),
  (
    'ToolVersion.DraftCreated', 'FACT_ONLY', NULL, NULL,
    'Tool version draft fact.'
  ),
  (
    'AiEvaluationDatasetChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation dataset governance fact.'
  ),
  (
    'AiEvaluationDatasetVersionChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation dataset-version governance fact.'
  ),
  (
    'AiEvaluationCaseChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation case governance fact.'
  ),
  (
    'AiEvaluationAnnotationChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation annotation governance fact.'
  ),
  (
    'AiEvaluationRunChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation Run governance fact.'
  ),
  (
    'AiEvaluationBadCaseChanged', 'FACT_ONLY', NULL, NULL,
    'AI evaluation bad-case governance fact.'
  ),
  (
    'AiEvaluationReleaseReadinessChecked', 'FACT_ONLY', NULL, NULL,
    'AI evaluation release-readiness fact.'
  ),
  (
    'AiEvaluationRunnerAttestationVerified', 'FACT_ONLY', NULL, NULL,
    'AI evaluation Runner attestation fact.'
  ),
  (
    'AiModelCatalogVersionChanged', 'FACT_ONLY', NULL, NULL,
    'AI model-catalog governance fact.'
  ),
  (
    'AiModelRoutePolicyVersionChanged', 'FACT_ONLY', NULL, NULL,
    'AI model-route policy governance fact.'
  ),
  (
    'AiModelCircuitStateChanged', 'FACT_ONLY', NULL, NULL,
    'AI model circuit-state governance fact.'
  ),
  (
    'AiModelAttemptReceiptRecorded', 'FACT_ONLY', NULL, NULL,
    'AI model attempt receipt fact.'
  ),
  (
    'AiSafetyDecisionRecorded', 'FACT_ONLY', NULL, NULL,
    'AI safety decision fact.'
  ),
  (
    'IdentityGovernanceCommandApplied.v1', 'FACT_ONLY', NULL, NULL,
    'Identity-governance command application fact.'
  ),
  (
    'IdentityGovernanceCommandRejected.v1', 'FACT_ONLY', NULL, NULL,
    'Identity-governance command rejection fact.'
  ),
  (
    'IdentityBreakGlassRequest.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass request fact.'
  ),
  (
    'IdentityBreakGlassApprove.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass approval fact.'
  ),
  (
    'IdentityBreakGlassReject.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass rejection fact.'
  ),
  (
    'IdentityBreakGlassActivate.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass activation fact.'
  ),
  (
    'IdentityBreakGlassRevoke.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass revocation fact.'
  ),
  (
    'IdentityBreakGlassExpire.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass expiry fact.'
  ),
  (
    'IdentityBreakGlassReview_close.v1', 'FACT_ONLY', NULL, NULL,
    'Break-glass review closure fact.'
  ),
  (
    'IdentityPrincipalDeprovisioned.v1', 'FACT_ONLY', NULL, NULL,
    'SCIM principal-deprovisioning fact.'
  );

ALTER TABLE public."outbox_events"
  ADD COLUMN "routing_purpose" public."OutboxEventRoutingPurpose"
    NOT NULL DEFAULT 'QUARANTINED',
  ADD COLUMN "routing_resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "routing_error" TEXT;

CREATE TABLE public."outbox_event_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "consumer_key" VARCHAR(120) NOT NULL,
  "lane" VARCHAR(120) NOT NULL,
  "status" public."OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_by" VARCHAR(120),
  "locked_until" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "provider_name" VARCHAR(80),
  "provider_receipt" JSONB,
  "first_attempted_at" TIMESTAMPTZ(6),
  "acknowledged_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_event_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_event_deliveries_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "outbox_event_deliveries_event_consumer_key"
    UNIQUE ("tenant_id", "event_id", "consumer_key"),
  CONSTRAINT "outbox_event_deliveries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbox_event_deliveries_event_fkey"
    FOREIGN KEY ("tenant_id", "event_id")
    REFERENCES public."outbox_events"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbox_event_deliveries_attempts_nonnegative_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "outbox_event_deliveries_lease_pair_check" CHECK (
    ("locked_by" IS NULL) = ("locked_until" IS NULL)
  ),
  CONSTRAINT "outbox_event_deliveries_acknowledgement_check" CHECK (
    (
      "status" = 'PUBLISHED'::public."OutboxEventStatus"
      AND "acknowledged_at" IS NOT NULL
    )
    OR (
      "status" <> 'PUBLISHED'::public."OutboxEventStatus"
      AND "acknowledged_at" IS NULL
    )
  )
);

CREATE INDEX "outbox_event_deliveries_claim_idx"
  ON public."outbox_event_deliveries"(
    "consumer_key", "lane", "status", "available_at",
    "locked_until", "created_at", "id"
  );
CREATE INDEX "outbox_event_deliveries_tenant_status_idx"
  ON public."outbox_event_deliveries"(
    "tenant_id", "status", "available_at", "created_at", "id"
  );

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
  -- The trigger runs as the migration owner so callers never need permission
  -- to mutate routing metadata or insert delivery rows. FORCE RLS still
  -- applies to a non-BYPASSRLS owner, therefore bind the trusted tenant from
  -- the already accepted source row and restore the caller context before
  -- returning.
  previous_tenant := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW."tenant_id"::text, true);

  SELECT route."purpose", route."consumer_key", route."lane"
    INTO route_record
  FROM public."outbox_event_routes" route
  WHERE route."event_type" = NEW."event_type";

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

CREATE TRIGGER "outbox_events_delivery_routing_trigger"
  AFTER INSERT ON public."outbox_events"
  FOR EACH ROW EXECUTE FUNCTION public.route_outbox_event_to_delivery();

UPDATE public."outbox_events" event
SET "routing_purpose" = COALESCE(
      route."purpose",
      'QUARANTINED'::public."OutboxEventRoutingPurpose"
    ),
    "routing_resolved_at" = CURRENT_TIMESTAMP,
    "routing_error" = CASE
      WHEN route."event_type" IS NULL THEN 'UNREGISTERED_EVENT_TYPE'
      ELSE NULL
    END
FROM (
  SELECT existing."id", registry."event_type", registry."purpose"
  FROM public."outbox_events" existing
  LEFT JOIN public."outbox_event_routes" registry
    ON registry."event_type" = existing."event_type"
) route
WHERE route."id" = event."id";

INSERT INTO public."outbox_event_deliveries" (
  "tenant_id", "event_id", "consumer_key", "lane", "status",
  "attempts", "available_at", "locked_by", "locked_until", "last_error",
  "provider_name", "provider_receipt", "first_attempted_at",
  "acknowledged_at", "created_at", "updated_at"
)
SELECT
  event."tenant_id", event."id", route."consumer_key", route."lane",
  event."status", event."attempts", event."available_at",
  event."locked_by", event."locked_until", event."last_error",
  event."provider_name", event."provider_receipt", event."first_attempted_at",
  CASE
    WHEN event."status" = 'PUBLISHED'::public."OutboxEventStatus"
      THEN COALESCE(event."published_at", event."created_at")
    ELSE NULL
  END,
  event."created_at", CURRENT_TIMESTAMP
FROM public."outbox_events" event
JOIN public."outbox_event_routes" route
  ON route."event_type" = event."event_type"
 AND route."purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose"
ON CONFLICT ("tenant_id", "event_id", "consumer_key") DO NOTHING;

REVOKE ALL PRIVILEGES ON TABLE
  public."outbox_event_routes",
  public."outbox_event_deliveries"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_provisioner, enterprise_agent_outbox;

GRANT SELECT ON TABLE public."outbox_event_routes"
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_outbox;
GRANT SELECT ON TABLE public."outbox_event_deliveries"
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_outbox;
GRANT UPDATE (
  "status", "attempts", "available_at", "locked_by", "locked_until",
  "last_error", "provider_name", "provider_receipt", "first_attempted_at",
  "acknowledged_at", "updated_at"
) ON TABLE public."outbox_event_deliveries"
  TO enterprise_agent_outbox;

REVOKE UPDATE (
  "status", "attempts", "available_at", "locked_by", "locked_until",
  "last_error", "provider_name", "provider_receipt", "first_attempted_at",
  "published_at"
) ON TABLE public."outbox_events"
  FROM enterprise_agent_outbox;
REVOKE UPDATE (
  "status", "available_at", "locked_by", "locked_until", "last_error",
  "provider_name", "provider_receipt", "published_at"
) ON TABLE public."outbox_events"
  FROM enterprise_agent_admin;

ALTER TABLE public."outbox_event_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."outbox_event_deliveries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation"
  ON public."outbox_event_deliveries"
  AS RESTRICTIVE
  FOR ALL
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_provisioner
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY "enterprise_agent_access"
  ON public."outbox_event_deliveries"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

CREATE POLICY "enterprise_agent_admin_access"
  ON public."outbox_event_deliveries"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_admin
  USING (true);

CREATE POLICY "enterprise_agent_outbox_access"
  ON public."outbox_event_deliveries"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_outbox
  USING (true)
  WITH CHECK (true);

COMMIT;
