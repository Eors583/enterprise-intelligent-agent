-- P0-3 process runtime foundation.
-- Process definitions remain administrator-managed master data. Runtime state
-- is owned by a separate NOLOGIN capability role and never by the model.

-- PostgreSQL cannot safely use a newly-added enum value until the transaction
-- that added it commits. Keep the enum extension atomic, then install the
-- dependent runtime foundation in its own all-or-nothing transaction.
BEGIN;
ALTER TYPE public."ProcessNodeType" ADD VALUE IF NOT EXISTS 'HUMAN_APPROVAL';
ALTER TYPE public."ProcessNodeType" ADD VALUE IF NOT EXISTS 'AGENT_EXECUTION';
ALTER TYPE public."ProcessNodeType" ADD VALUE IF NOT EXISTS 'CONDITION';
ALTER TYPE public."ProcessNodeType" ADD VALUE IF NOT EXISTS 'TIMER';
ALTER TYPE public."ProcessNodeType" ADD VALUE IF NOT EXISTS 'COMPENSATION';
COMMIT;

BEGIN;
CREATE TYPE public."ProcessInstanceStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED'
);

CREATE TYPE public."ProcessStepStatus" AS ENUM (
  'WAITING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'REJECTED',
  'TIMED_OUT',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED',
  'SKIPPED'
);

CREATE TYPE public."ProcessCommandType" AS ENUM (
  'START',
  'PAUSE',
  'RESUME',
  'COMPLETE',
  'FAIL',
  'CANCEL',
  'BEGIN_COMPENSATION',
  'COMPLETE_COMPENSATION',
  'FAIL_COMPENSATION'
);

CREATE TYPE public."ProcessStepCommandType" AS ENUM (
  'ACTIVATE',
  'CLAIM',
  'COMPLETE',
  'REJECT',
  'TIMEOUT',
  'FAIL',
  'RETRY',
  'CANCEL',
  'SKIP',
  'BEGIN_COMPENSATION',
  'COMPLETE_COMPENSATION',
  'FAIL_COMPENSATION'
);

CREATE TYPE public."ProcessActorType" AS ENUM ('USER', 'AGENT', 'SERVICE');

CREATE TABLE public."process_edges" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "process_version_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "from_node_id" UUID NOT NULL,
  "from_node_code" VARCHAR(100) NOT NULL,
  "to_node_id" UUID NOT NULL,
  "to_node_code" VARCHAR(100) NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "condition" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_edges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_edges_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_edges_route_key" UNIQUE (
    "tenant_id", "process_version_id", "from_node_id", "to_node_id"
  ),
  CONSTRAINT "process_edges_default_priority_key" UNIQUE (
    "tenant_id", "process_version_id", "from_node_id", "priority"
  ),
  CONSTRAINT "process_edges_version_positive_check" CHECK ("process_version" > 0),
  CONSTRAINT "process_edges_no_self_loop_check" CHECK ("from_node_id" <> "to_node_id"),
  CONSTRAINT "process_edges_condition_object_check" CHECK (
    jsonb_typeof("condition") = 'object'
  )
);

CREATE TABLE public."process_instances" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "process_version_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "trigger_event_id" UUID,
  "correlation_id" UUID NOT NULL,
  "status" public."ProcessInstanceStatus" NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "input" JSONB NOT NULL,
  "output" JSONB,
  "failure_code" VARCHAR(160),
  "failure_detail" TEXT,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "started_at" TIMESTAMPTZ(6),
  "paused_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "compensation_started_at" TIMESTAMPTZ(6),
  "compensation_completed_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_instances_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_instances_tenant_id_id_revision_key" UNIQUE (
    "tenant_id", "id", "revision"
  ),
  CONSTRAINT "process_instances_tenant_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "process_instances_task_key" UNIQUE (
    "tenant_id", "task_id", "task_version"
  ),
  CONSTRAINT "process_instances_process_version_positive_check" CHECK ("process_version" > 0),
  CONSTRAINT "process_instances_objective_version_positive_check" CHECK ("objective_version" > 0),
  CONSTRAINT "process_instances_task_version_positive_check" CHECK ("task_version" > 0),
  CONSTRAINT "process_instances_revision_positive_check" CHECK ("revision" > 0),
  CONSTRAINT "process_instances_input_object_check" CHECK (jsonb_typeof("input") = 'object'),
  CONSTRAINT "process_instances_output_object_check" CHECK (
    "output" IS NULL OR jsonb_typeof("output") = 'object'
  ),
  CONSTRAINT "process_instances_permission_labels_array_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  ),
  CONSTRAINT "process_instances_request_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "process_instances_idempotency_key_check" CHECK (
    btrim("idempotency_key") <> ''
  ),
  CONSTRAINT "process_instances_failure_pair_check" CHECK (
    ("failure_code" IS NULL) = ("failure_detail" IS NULL)
  ),
  CONSTRAINT "process_instances_state_time_check" CHECK (
    ("status" = 'PENDING' AND "started_at" IS NULL)
    OR (
      "status" IN (
        'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED',
        'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'
      )
      AND "started_at" IS NOT NULL
    )
    OR "status" = 'CANCELLED'
  ),
  CONSTRAINT "process_instances_paused_time_check" CHECK (
    "status" <> 'PAUSED' OR "paused_at" IS NOT NULL
  ),
  CONSTRAINT "process_instances_completed_time_check" CHECK (
    "status" <> 'COMPLETED' OR "completed_at" IS NOT NULL
  ),
  CONSTRAINT "process_instances_cancelled_time_check" CHECK (
    "status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL
  ),
  CONSTRAINT "process_instances_failed_detail_check" CHECK (
    "status" NOT IN ('FAILED', 'COMPENSATION_FAILED') OR "failure_code" IS NOT NULL
  ),
  CONSTRAINT "process_instances_compensation_time_check" CHECK (
    "status" NOT IN ('COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED')
    OR "compensation_started_at" IS NOT NULL
  ),
  CONSTRAINT "process_instances_compensated_time_check" CHECK (
    "status" <> 'COMPENSATED' OR "compensation_completed_at" IS NOT NULL
  )
);

CREATE TABLE public."process_step_instances" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "process_instance_id" UUID NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "process_version_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "process_node_id" UUID NOT NULL,
  "process_node_code" VARCHAR(100) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" public."ProcessStepStatus" NOT NULL DEFAULT 'WAITING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "resolved_role_assignment_id" UUID,
  "resolved_agent_id" UUID,
  "assignment_snapshot" JSONB,
  "input" JSONB NOT NULL,
  "output" JSONB,
  "available_at" TIMESTAMPTZ(6) NOT NULL,
  "claimed_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "due_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "timed_out_at" TIMESTAMPTZ(6),
  "failure_code" VARCHAR(160),
  "failure_detail" TEXT,
  "compensation_for_step_id" UUID,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_step_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_step_instances_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_step_instances_tenant_id_id_revision_key" UNIQUE (
    "tenant_id", "id", "revision"
  ),
  CONSTRAINT "process_step_instances_attempt_key" UNIQUE (
    "tenant_id", "process_instance_id", "process_node_id", "attempt"
  ),
  CONSTRAINT "process_step_instances_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "process_step_instances_attempt_positive_check" CHECK (
    "attempt" > 0 AND "attempt" <= 100
  ),
  CONSTRAINT "process_step_instances_revision_positive_check" CHECK ("revision" > 0),
  CONSTRAINT "process_step_instances_input_object_check" CHECK (jsonb_typeof("input") = 'object'),
  CONSTRAINT "process_step_instances_output_object_check" CHECK (
    "output" IS NULL OR jsonb_typeof("output") = 'object'
  ),
  CONSTRAINT "process_step_instances_assignment_snapshot_check" CHECK (
    "assignment_snapshot" IS NULL OR jsonb_typeof("assignment_snapshot") = 'object'
  ),
  CONSTRAINT "process_step_instances_assignment_pair_check" CHECK (
    ("resolved_role_assignment_id" IS NULL) = ("assignment_snapshot" IS NULL)
  ),
  CONSTRAINT "process_step_instances_agent_assignment_check" CHECK (
    "resolved_agent_id" IS NULL OR "resolved_role_assignment_id" IS NOT NULL
  ),
  CONSTRAINT "process_step_instances_not_own_compensation_check" CHECK (
    "compensation_for_step_id" IS NULL OR "compensation_for_step_id" <> "id"
  ),
  CONSTRAINT "process_step_instances_due_time_check" CHECK (
    "due_at" IS NULL OR "due_at" > "available_at"
  ),
  CONSTRAINT "process_step_instances_failure_pair_check" CHECK (
    ("failure_code" IS NULL) = ("failure_detail" IS NULL)
  ),
  CONSTRAINT "process_step_instances_failed_detail_check" CHECK (
    "status" NOT IN ('FAILED', 'COMPENSATION_FAILED') OR "failure_code" IS NOT NULL
  ),
  CONSTRAINT "process_step_instances_started_time_check" CHECK (
    "status" NOT IN (
      'RUNNING', 'COMPLETED', 'REJECTED', 'FAILED',
      'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'
    )
    OR "started_at" IS NOT NULL
  ),
  CONSTRAINT "process_step_instances_completed_time_check" CHECK (
    "status" NOT IN ('COMPLETED', 'REJECTED', 'COMPENSATED')
    OR "completed_at" IS NOT NULL
  ),
  CONSTRAINT "process_step_instances_timeout_time_check" CHECK (
    "status" <> 'TIMED_OUT' OR "timed_out_at" IS NOT NULL
  ),
  CONSTRAINT "process_step_instances_request_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."process_commands" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "process_instance_id" UUID NOT NULL,
  "command" public."ProcessCommandType" NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "result_revision" INTEGER NOT NULL,
  "actor_type" public."ProcessActorType" NOT NULL,
  "actor_user_id" UUID,
  "actor_agent_id" UUID,
  "actor_service_id" VARCHAR(160),
  "actor_role_assignment_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "effective_at" TIMESTAMPTZ(6) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_commands_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "process_commands_revision_check" CHECK (
    "expected_revision" > 0 AND "result_revision" = "expected_revision" + 1
  ),
  CONSTRAINT "process_commands_reason_check" CHECK (btrim("reason") <> ''),
  CONSTRAINT "process_commands_actor_shape_check" CHECK (
    (
      "actor_type" = 'USER'
      AND "actor_user_id" IS NOT NULL
      AND "actor_agent_id" IS NULL
      AND "actor_service_id" IS NULL
      AND "actor_role_assignment_id" IS NOT NULL
    )
    OR (
      "actor_type" = 'AGENT'
      AND "actor_user_id" IS NULL
      AND "actor_agent_id" IS NOT NULL
      AND "actor_service_id" IS NULL
      AND "actor_role_assignment_id" IS NOT NULL
    )
    OR (
      "actor_type" = 'SERVICE'
      AND "actor_user_id" IS NULL
      AND "actor_agent_id" IS NULL
      AND "actor_service_id" IS NOT NULL
      AND btrim("actor_service_id") <> ''
      AND "actor_role_assignment_id" IS NULL
    )
  ),
  CONSTRAINT "process_commands_payload_object_check" CHECK (
    jsonb_typeof("payload") = 'object'
  )
);

CREATE TABLE public."process_step_commands" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "process_step_instance_id" UUID NOT NULL,
  "command" public."ProcessStepCommandType" NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "result_revision" INTEGER NOT NULL,
  "actor_type" public."ProcessActorType" NOT NULL,
  "actor_user_id" UUID,
  "actor_agent_id" UUID,
  "actor_service_id" VARCHAR(160),
  "actor_role_assignment_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "effective_at" TIMESTAMPTZ(6) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "process_step_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_step_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_step_commands_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "process_step_commands_revision_check" CHECK (
    "expected_revision" > 0 AND "result_revision" = "expected_revision" + 1
  ),
  CONSTRAINT "process_step_commands_reason_check" CHECK (btrim("reason") <> ''),
  CONSTRAINT "process_step_commands_actor_shape_check" CHECK (
    (
      "actor_type" = 'USER'
      AND "actor_user_id" IS NOT NULL
      AND "actor_agent_id" IS NULL
      AND "actor_service_id" IS NULL
      AND "actor_role_assignment_id" IS NOT NULL
    )
    OR (
      "actor_type" = 'AGENT'
      AND "actor_user_id" IS NULL
      AND "actor_agent_id" IS NOT NULL
      AND "actor_service_id" IS NULL
      AND "actor_role_assignment_id" IS NOT NULL
    )
    OR (
      "actor_type" = 'SERVICE'
      AND "actor_user_id" IS NULL
      AND "actor_agent_id" IS NULL
      AND "actor_service_id" IS NOT NULL
      AND btrim("actor_service_id") <> ''
      AND "actor_role_assignment_id" IS NULL
    )
  ),
  CONSTRAINT "process_step_commands_payload_object_check" CHECK (
    jsonb_typeof("payload") = 'object'
  )
);

ALTER TABLE public."process_edges"
  ADD CONSTRAINT "process_edges_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "process_edges_version_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id", "process_version"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_edges_from_node_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "from_node_id", "from_node_code"
    )
    REFERENCES public."process_nodes"(
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "id", "code"
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_edges_to_node_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "to_node_id", "to_node_code"
    )
    REFERENCES public."process_nodes"(
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "id", "code"
    )
    ON DELETE RESTRICT;

ALTER TABLE public."process_instances"
  ADD CONSTRAINT "process_instances_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "process_instances_version_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id", "process_version"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_instances_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_instances_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT;

ALTER TABLE public."process_step_instances"
  ADD CONSTRAINT "process_step_instances_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_instances_instance_fkey"
    FOREIGN KEY ("tenant_id", "process_instance_id")
    REFERENCES public."process_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_instances_node_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "process_node_id", "process_node_code"
    )
    REFERENCES public."process_nodes"(
      "tenant_id", "process_definition_id", "process_version_id", "process_version",
      "id", "code"
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_instances_assignment_fkey"
    FOREIGN KEY ("tenant_id", "resolved_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_instances_agent_fkey"
    FOREIGN KEY ("tenant_id", "resolved_agent_id")
    REFERENCES public."agent_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_instances_compensation_fkey"
    FOREIGN KEY ("tenant_id", "compensation_for_step_id")
    REFERENCES public."process_step_instances"("tenant_id", "id")
    ON DELETE RESTRICT;

ALTER TABLE public."process_commands"
  ADD CONSTRAINT "process_commands_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "process_commands_instance_fkey"
    FOREIGN KEY ("tenant_id", "process_instance_id")
    REFERENCES public."process_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_commands_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_commands_actor_agent_fkey"
    FOREIGN KEY ("tenant_id", "actor_agent_id")
    REFERENCES public."agent_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_commands_actor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT;

ALTER TABLE public."process_step_commands"
  ADD CONSTRAINT "process_step_commands_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_commands_step_fkey"
    FOREIGN KEY ("tenant_id", "process_step_instance_id")
    REFERENCES public."process_step_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_commands_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_commands_actor_agent_fkey"
    FOREIGN KEY ("tenant_id", "actor_agent_id")
    REFERENCES public."agent_instances"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "process_step_commands_actor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT;

ALTER TABLE public."tasks"
  DROP CONSTRAINT "tasks_no_unverified_process_instance_check",
  ADD CONSTRAINT "tasks_process_instance_fkey"
    FOREIGN KEY ("tenant_id", "process_instance_id")
    REFERENCES public."process_instances"("tenant_id", "id")
    ON DELETE RESTRICT;

-- The runtime is created after its Task, so the Task link is attached in the
-- same transaction and verified in both directions at commit. The earlier
-- placeholder CHECK intentionally forbade this link until the runtime tables
-- and validation triggers existed.
DROP TRIGGER "tasks_immutability_trigger" ON public."tasks";
CREATE OR REPLACE FUNCTION public.enforce_process_linked_task_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  linked_instance_valid boolean;
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."previous_version_id" IS DISTINCT FROM OLD."previous_version_id"
     OR NEW."previous_version_number" IS DISTINCT FROM OLD."previous_version_number"
  THEN
    RAISE EXCEPTION 'Business version identity and lineage are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_identity_immutable';
  END IF;
  IF OLD."process_instance_id" IS NOT NULL
     AND NEW."process_instance_id" IS DISTINCT FROM OLD."process_instance_id"
  THEN
    RAISE EXCEPTION 'A Task Process Instance link is immutable once attached.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_process_instance_immutable';
  END IF;
  IF OLD."status" <> 'PLANNED'
     AND (
       to_jsonb(NEW) - ARRAY[
         'status', 'revision', 'ready_at', 'started_at', 'delivered_at',
         'completed_at', 'cancelled_at', 'process_instance_id', 'updated_at'
       ]
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'status', 'revision', 'ready_at', 'started_at', 'delivered_at',
         'completed_at', 'cancelled_at', 'process_instance_id', 'updated_at'
       ]
     )
  THEN
    RAISE EXCEPTION 'Active Task columns are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_published_core_immutable';
  END IF;
  IF NEW."process_instance_id" IS NOT NULL
     AND NEW."process_instance_id" IS DISTINCT FROM OLD."process_instance_id"
  THEN
    SELECT
      instance."task_id" = NEW."id"
      AND instance."task_version" = NEW."version"
      AND instance."objective_id" = NEW."objective_id"
      AND instance."objective_version" = NEW."objective_version"
      AND instance."process_definition_id" = NEW."process_definition_id"
      AND instance."process_version_id" = NEW."process_version_id"
      AND instance."process_version" = NEW."process_version"
      AND instance."status" = 'PENDING'
    INTO linked_instance_valid
    FROM public."process_instances" instance
    WHERE instance."tenant_id" = NEW."tenant_id"
      AND instance."id" = NEW."process_instance_id"
    FOR SHARE;
    IF COALESCE(linked_instance_valid, false) = false THEN
      RAISE EXCEPTION 'A Task can link only its matching pending Process Instance.'
        USING ERRCODE = '23514', CONSTRAINT = 'tasks_process_instance_identity_check';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "tasks_immutability_trigger"
  BEFORE UPDATE ON public."tasks"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_process_linked_task_immutability();

CREATE OR REPLACE FUNCTION public.validate_process_instance_task_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  linked boolean;
BEGIN
  SELECT task."process_instance_id" = NEW."id"
    INTO linked
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
    AND task."version" = NEW."task_version";
  IF COALESCE(linked, false) = false THEN
    RAISE EXCEPTION 'A Process Instance and Task must be linked in the same transaction.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_task_link_check';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "process_instances_task_link_trigger"
  AFTER INSERT ON public."process_instances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_instance_task_link();

CREATE OR REPLACE FUNCTION public.guard_task_process_runtime_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  runtime_status public."ProcessInstanceStatus";
BEGIN
  IF NEW."process_instance_id" IS NULL
     OR NEW."status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
  THEN
    RETURN NEW;
  END IF;
  SELECT instance."status"
    INTO runtime_status
  FROM public."process_instances" instance
  WHERE instance."tenant_id" = NEW."tenant_id"
    AND instance."id" = NEW."process_instance_id"
    AND instance."task_id" = NEW."id"
    AND instance."task_version" = NEW."version"
  FOR SHARE;
  IF runtime_status NOT IN (
    'COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATED', 'COMPENSATION_FAILED'
  ) THEN
    RAISE EXCEPTION 'A Task cannot become terminal while its Process Instance is active.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_process_runtime_terminal_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "tasks_process_runtime_terminal_trigger"
  BEFORE UPDATE OF "status" ON public."tasks"
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_process_runtime_state();

CREATE INDEX "process_edges_from_idx"
  ON public."process_edges"(
    "tenant_id", "process_version_id", "from_node_id", "priority", "id"
  );
CREATE INDEX "process_edges_to_idx"
  ON public."process_edges"("tenant_id", "process_version_id", "to_node_id");
CREATE UNIQUE INDEX "process_edges_one_default_per_node_idx"
  ON public."process_edges"("tenant_id", "process_version_id", "from_node_id")
  WHERE "is_default";
CREATE INDEX "process_instances_status_idx"
  ON public."process_instances"("tenant_id", "status", "updated_at", "id");
CREATE INDEX "process_instances_objective_idx"
  ON public."process_instances"("tenant_id", "objective_id", "objective_version", "status");
CREATE INDEX "process_instances_correlation_idx"
  ON public."process_instances"("tenant_id", "correlation_id", "created_at", "id");
CREATE INDEX "process_step_instances_work_idx"
  ON public."process_step_instances"(
    "tenant_id", "status", "available_at", "due_at", "id"
  );
CREATE INDEX "process_step_instances_assignment_idx"
  ON public."process_step_instances"(
    "tenant_id", "resolved_role_assignment_id", "status", "due_at"
  );
CREATE INDEX "process_commands_trace_idx"
  ON public."process_commands"(
    "tenant_id", "process_instance_id", "result_revision", "created_at"
  );
CREATE INDEX "process_step_commands_trace_idx"
  ON public."process_step_commands"(
    "tenant_id", "process_step_instance_id", "result_revision", "created_at"
  );
CREATE UNIQUE INDEX "process_commands_one_per_revision_idx"
  ON public."process_commands"(
    "tenant_id", "process_instance_id", "result_revision"
  );
CREATE UNIQUE INDEX "process_step_commands_one_per_revision_idx"
  ON public."process_step_commands"(
    "tenant_id", "process_step_instance_id", "result_revision"
  );

CREATE OR REPLACE FUNCTION public.guard_process_graph_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  version_status public."ProcessVersionStatus";
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      (row_data->>'tenant_id') || ':process-graph:' || (row_data->>'process_version_id'),
      0
    )
  );
  SELECT "status"
    INTO version_status
  FROM public."process_versions"
  WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
    AND "id" = (row_data->>'process_version_id')::uuid
  FOR UPDATE;
  IF version_status IS NULL THEN
    RAISE EXCEPTION 'The Process Version does not exist.'
      USING ERRCODE = '23503', CONSTRAINT = 'process_graph_version_missing';
  END IF;
  IF version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'A published or retired Process graph is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_graph_published_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."tenant_id", NEW."process_definition_id", NEW."process_version_id",
    NEW."process_version", NEW."from_node_id", NEW."to_node_id"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."process_definition_id", OLD."process_version_id",
    OLD."process_version", OLD."from_node_id", OLD."to_node_id"
  ) THEN
    RAISE EXCEPTION 'Process Edge identity cannot be changed.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_edges_identity_immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER "process_edges_parent_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."process_edges"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_graph_mutation();

CREATE OR REPLACE FUNCTION public.validate_process_graph_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  start_id uuid;
  node_count integer;
  reachable_count integer;
  reachable_end_count integer;
  invalid_edge_count integer;
  invalid_node_count integer;
  cycle_count integer;
BEGIN
  IF NEW."status" <> 'PUBLISHED' OR (
    TG_OP = 'UPDATE' AND OLD."status" = NEW."status"
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':process-graph:' || NEW."id"::text,
      0
    )
  );
  SELECT
    count(*),
    (min("id"::text) FILTER (WHERE "type" = 'START'))::uuid
    INTO node_count, start_id
  FROM public."process_nodes"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "process_definition_id" = NEW."process_definition_id"
    AND "process_version_id" = NEW."id"
    AND "process_version" = NEW."version";

  SELECT count(*)
    INTO invalid_edge_count
  FROM public."process_edges" edge
  JOIN public."process_nodes" source_node
    ON source_node."tenant_id" = edge."tenant_id"
   AND source_node."id" = edge."from_node_id"
  JOIN public."process_nodes" target_node
    ON target_node."tenant_id" = edge."tenant_id"
   AND target_node."id" = edge."to_node_id"
  WHERE edge."tenant_id" = NEW."tenant_id"
    AND edge."process_version_id" = NEW."id"
    AND (
      source_node."type" = 'END'
      OR target_node."type" = 'START'
      OR (
        source_node."type" <> 'CONDITION'
        AND (
          edge."is_default"
          OR edge."condition" <> '{}'::jsonb
        )
      )
      OR (
        source_node."type" = 'CONDITION'
        AND (
          (
            edge."is_default"
            AND edge."condition" <> '{}'::jsonb
          )
          OR (
            edge."is_default" = false
            AND (
              edge."condition" = '{}'::jsonb
              OR jsonb_typeof(edge."condition"->'expression') IS DISTINCT FROM 'object'
            )
          )
        )
      )
    );
  IF invalid_edge_count <> 0 THEN
    RAISE EXCEPTION 'The Process graph contains an invalid edge.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_graph_edge_validity_check';
  END IF;

  SELECT count(*)
    INTO invalid_node_count
  FROM public."process_nodes" node
  WHERE node."tenant_id" = NEW."tenant_id"
    AND node."process_version_id" = NEW."id"
    AND (
      node."type" IN ('ACTIVITY', 'DECISION', 'MILESTONE')
      OR (
        node."type" NOT IN ('END')
        AND NOT EXISTS (
          SELECT 1
          FROM public."process_edges" edge
          WHERE edge."tenant_id" = node."tenant_id"
            AND edge."process_version_id" = node."process_version_id"
            AND edge."from_node_id" = node."id"
        )
      )
      OR (
        node."type" NOT IN ('START')
        AND NOT EXISTS (
          SELECT 1
          FROM public."process_edges" edge
          WHERE edge."tenant_id" = node."tenant_id"
            AND edge."process_version_id" = node."process_version_id"
            AND edge."to_node_id" = node."id"
        )
      )
      OR (
        node."type" IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION')
        AND (
          jsonb_typeof(node."configuration"->'roleTemplateId') IS DISTINCT FROM 'string'
          OR COALESCE(
            (node."configuration"->>'roleTemplateId')
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            false
          ) = false
          OR NOT EXISTS (
            SELECT 1
            FROM public."agent_templates" role_template
            WHERE role_template."tenant_id" = node."tenant_id"
              AND role_template."id" =
                (node."configuration"->>'roleTemplateId')::uuid
          )
          OR jsonb_typeof(node."configuration"->'requiredPermissionAction') IS DISTINCT FROM 'string'
          OR COALESCE(
            (node."configuration"->>'requiredPermissionAction')
              ~ '^[a-z0-9]+([._:-][a-z0-9]+)*$',
            false
          ) = false
          OR COALESCE((node."configuration"->>'slaMinutes') ~ '^[1-9][0-9]*$', false) = false
        )
      )
      OR (
        node."type" = 'HUMAN_APPROVAL'
        AND (
          (
            node."configuration" ? 'allowAgentActor'
            AND jsonb_typeof(node."configuration"->'allowAgentActor') <> 'boolean'
          )
          OR COALESCE((node."configuration"->>'allowAgentActor')::boolean, false)
        )
      )
      OR (
        node."configuration" ? 'required'
        AND jsonb_typeof(node."configuration"->'required') <> 'boolean'
      )
      OR (
        node."type" = 'CONDITION'
        AND (
          (
            SELECT count(*)
            FROM public."process_edges" edge
            WHERE edge."tenant_id" = node."tenant_id"
              AND edge."process_version_id" = node."process_version_id"
              AND edge."from_node_id" = node."id"
          ) < 2
          OR (
            SELECT count(*)
            FROM public."process_edges" edge
            WHERE edge."tenant_id" = node."tenant_id"
              AND edge."process_version_id" = node."process_version_id"
              AND edge."from_node_id" = node."id"
              AND edge."is_default"
          ) <> 1
          OR (
            SELECT count(*)
            FROM public."process_edges" edge
            WHERE edge."tenant_id" = node."tenant_id"
              AND edge."process_version_id" = node."process_version_id"
              AND edge."from_node_id" = node."id"
              AND edge."is_default" = false
          ) <> (
            SELECT count(DISTINCT edge."condition")
            FROM public."process_edges" edge
            WHERE edge."tenant_id" = node."tenant_id"
              AND edge."process_version_id" = node."process_version_id"
              AND edge."from_node_id" = node."id"
              AND edge."is_default" = false
          )
        )
      )
      OR (
        node."type" NOT IN ('CONDITION', 'END')
        AND (
          SELECT count(*)
          FROM public."process_edges" edge
          WHERE edge."tenant_id" = node."tenant_id"
            AND edge."process_version_id" = node."process_version_id"
            AND edge."from_node_id" = node."id"
        ) <> 1
      )
    );
  IF invalid_node_count <> 0 THEN
    RAISE EXCEPTION 'The Process graph contains an incomplete or unsafe node.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_graph_node_validity_check';
  END IF;

  WITH RECURSIVE walk("node_id", "path", "cycle") AS (
    SELECT start_id, ARRAY[start_id], false
    UNION ALL
    SELECT edge."to_node_id", walk."path" || edge."to_node_id",
           edge."to_node_id" = ANY(walk."path")
    FROM walk
    JOIN public."process_edges" edge
      ON edge."tenant_id" = NEW."tenant_id"
     AND edge."process_version_id" = NEW."id"
     AND edge."from_node_id" = walk."node_id"
    WHERE walk."cycle" = false
  )
  SELECT
    count(DISTINCT "node_id"),
    count(*) FILTER (WHERE "cycle")
  INTO reachable_count, cycle_count
  FROM walk;
  IF cycle_count <> 0 OR reachable_count <> node_count THEN
    RAISE EXCEPTION 'The Process graph must be acyclic and every node must be reachable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_graph_reachability_check';
  END IF;

  WITH RECURSIVE walk("node_id") AS (
    SELECT start_id
    UNION
    SELECT edge."to_node_id"
    FROM walk
    JOIN public."process_edges" edge
      ON edge."tenant_id" = NEW."tenant_id"
     AND edge."process_version_id" = NEW."id"
     AND edge."from_node_id" = walk."node_id"
  )
  SELECT count(*)
    INTO reachable_end_count
  FROM walk
  JOIN public."process_nodes" node
    ON node."tenant_id" = NEW."tenant_id"
   AND node."id" = walk."node_id"
  WHERE node."type" = 'END';
  IF reachable_end_count < 1 THEN
    RAISE EXCEPTION 'The Process graph requires a reachable END node.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_graph_end_reachable_check';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "process_versions_graph_publication_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."process_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_graph_publication();

CREATE OR REPLACE FUNCTION public.guard_process_instance_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_valid boolean;
  task_valid boolean;
BEGIN
  IF NEW."status" <> 'PENDING' OR NEW."revision" <> 1 THEN
    RAISE EXCEPTION 'A Process Instance must be inserted as PENDING revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_initial_state_check';
  END IF;
  IF NEW."output" IS NOT NULL
     OR NEW."failure_code" IS NOT NULL
     OR NEW."failure_detail" IS NOT NULL
     OR NEW."started_at" IS NOT NULL
     OR NEW."paused_at" IS NOT NULL
     OR NEW."completed_at" IS NOT NULL
     OR NEW."cancelled_at" IS NOT NULL
     OR NEW."compensation_started_at" IS NOT NULL
     OR NEW."compensation_completed_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'A pending Process Instance cannot preload outcome state.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_initial_outcome_empty';
  END IF;
  SELECT
    version."status" = 'PUBLISHED'
    AND version."effective_from" <= CURRENT_TIMESTAMP
    AND (version."effective_to" IS NULL OR version."effective_to" > CURRENT_TIMESTAMP)
    AND definition."status" = 'ACTIVE'
    AND definition."current_version_id" = version."id"
    AND definition."current_version_number" = version."version"
  INTO version_valid
  FROM public."process_versions" version
  JOIN public."process_definitions" definition
    ON definition."tenant_id" = version."tenant_id"
   AND definition."id" = version."process_definition_id"
  WHERE version."tenant_id" = NEW."tenant_id"
    AND version."id" = NEW."process_version_id"
    AND version."process_definition_id" = NEW."process_definition_id"
    AND version."version" = NEW."process_version"
  FOR SHARE OF version, definition;
  IF COALESCE(version_valid, false) = false THEN
    RAISE EXCEPTION 'A Process Instance requires the current published Process Version.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_published_version_check';
  END IF;
  SELECT
    task."status" IN ('READY', 'IN_PROGRESS')
    AND task."objective_id" = NEW."objective_id"
    AND task."objective_version" = NEW."objective_version"
    AND task."process_definition_id" = NEW."process_definition_id"
    AND task."process_version_id" = NEW."process_version_id"
    AND task."process_version" = NEW."process_version"
  INTO task_valid
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
    AND task."version" = NEW."task_version"
  FOR SHARE;
  IF COALESCE(task_valid, false) = false THEN
    RAISE EXCEPTION 'A Process Instance requires a matching active Task.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_active_task_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "process_instances_insert_trigger"
  BEFORE INSERT ON public."process_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_instance_insert();

CREATE OR REPLACE FUNCTION public.guard_process_instance_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  missing_required integer;
  completed_end integer;
BEGIN
  IF (
    NEW."tenant_id", NEW."process_definition_id", NEW."process_version_id",
    NEW."process_version", NEW."objective_id", NEW."objective_version",
    NEW."task_id", NEW."task_version", NEW."trigger_event_id", NEW."correlation_id",
    NEW."input", NEW."permission_labels",
    NEW."idempotency_key", NEW."request_hash", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."process_definition_id", OLD."process_version_id",
    OLD."process_version", OLD."objective_id", OLD."objective_version",
    OLD."task_id", OLD."task_version", OLD."trigger_event_id", OLD."correlation_id",
    OLD."input", OLD."permission_labels",
    OLD."idempotency_key", OLD."request_hash", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Process Instance identity and execution snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Process Instance transition requires an exact revision increment.'
      USING ERRCODE = '40001', CONSTRAINT = 'process_instances_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('RUNNING', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATING'))
    OR (OLD."status" = 'PAUSED' AND NEW."status" IN ('RUNNING', 'CANCELLED', 'COMPENSATING'))
    OR (OLD."status" IN ('COMPLETED', 'CANCELLED', 'FAILED', 'COMPENSATION_FAILED')
        AND NEW."status" = 'COMPENSATING')
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'COMPENSATING' AND NEW."status" IN ('COMPENSATED', 'COMPENSATION_FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid Process Instance status transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_status_transition_check';
  END IF;
  IF NEW."output" IS DISTINCT FROM OLD."output" AND NEW."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Process output may be written only by COMPLETE.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_output_transition_check';
  END IF;
  IF (
       NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
       OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"
     )
     AND NEW."status" NOT IN ('FAILED', 'COMPENSATION_FAILED')
  THEN
    RAISE EXCEPTION 'Process failure detail may be written only by a failure transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_failure_transition_check';
  END IF;
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     AND NOT (OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING')
     AND NEW."status" <> 'COMPENSATING'
  THEN
    RAISE EXCEPTION 'Process started_at does not match this transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_started_transition_check';
  END IF;
  IF NEW."paused_at" IS DISTINCT FROM OLD."paused_at" AND NEW."status" <> 'PAUSED' THEN
    RAISE EXCEPTION 'Process paused_at may be written only by PAUSE.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_paused_transition_check';
  END IF;
  IF NEW."completed_at" IS DISTINCT FROM OLD."completed_at" AND NEW."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Process completed_at may be written only by COMPLETE.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_completed_transition_check';
  END IF;
  IF NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at" AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Process cancelled_at may be written only by CANCEL.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_cancelled_transition_check';
  END IF;
  IF NEW."compensation_started_at" IS DISTINCT FROM OLD."compensation_started_at"
     AND NEW."status" <> 'COMPENSATING'
  THEN
    RAISE EXCEPTION 'Compensation start time may be written only by BEGIN_COMPENSATION.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_compensation_start_transition_check';
  END IF;
  IF NEW."compensation_completed_at" IS DISTINCT FROM OLD."compensation_completed_at"
     AND NEW."status" <> 'COMPENSATED'
  THEN
    RAISE EXCEPTION 'Compensation completion time may be written only by COMPLETE_COMPENSATION.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_instances_compensation_complete_transition_check';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    SELECT count(*)
      INTO missing_required
    FROM public."process_nodes" node
    WHERE node."tenant_id" = NEW."tenant_id"
      AND node."process_version_id" = NEW."process_version_id"
      AND node."type" NOT IN ('START')
      AND COALESCE((node."configuration"->>'required')::boolean, true)
      AND NOT EXISTS (
        SELECT 1
        FROM public."process_step_instances" step
        WHERE step."tenant_id" = NEW."tenant_id"
          AND step."process_instance_id" = NEW."id"
          AND step."process_node_id" = node."id"
          AND (
            step."status" = 'COMPLETED'
            OR (
              step."status" = 'SKIPPED'
              AND node."type" NOT IN ('HUMAN_APPROVAL', 'END')
            )
          )
      );
    SELECT count(*)
      INTO completed_end
    FROM public."process_step_instances" step
    JOIN public."process_nodes" node
      ON node."tenant_id" = step."tenant_id"
     AND node."id" = step."process_node_id"
    WHERE step."tenant_id" = NEW."tenant_id"
      AND step."process_instance_id" = NEW."id"
      AND node."type" = 'END'
      AND step."status" = 'COMPLETED';
    IF missing_required <> 0 OR completed_end < 1 THEN
      RAISE EXCEPTION 'A Process Instance cannot complete before required steps and END.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_instances_completion_check';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "process_instances_transition_trigger"
  BEFORE UPDATE ON public."process_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_instance_transition();

CREATE OR REPLACE FUNCTION public.build_process_step_assignment_snapshot(
  p_tenant_id uuid,
  p_process_instance_id uuid,
  p_process_node_id uuid,
  p_role_assignment_id uuid,
  p_agent_id uuid,
  p_evaluated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  node_type public."ProcessNodeType";
  node_configuration jsonb;
  task_id uuid;
  task_permission_labels jsonb;
  task_organization_id uuid;
  required_action text;
  required_action_namespace text;
  assignment_record record;
  context_organization_id uuid;
BEGIN
  SELECT node."type", node."configuration", instance."task_id",
         task."permission_labels", owner_unit."organization_id"
    INTO node_type, node_configuration, task_id,
         task_permission_labels, task_organization_id
  FROM public."process_nodes" node
  JOIN public."process_instances" instance
    ON instance."tenant_id" = node."tenant_id"
   AND instance."id" = p_process_instance_id
   AND instance."process_version_id" = node."process_version_id"
   AND instance."process_version" = node."process_version"
  JOIN public."tasks" task
    ON task."tenant_id" = instance."tenant_id"
   AND task."id" = instance."task_id"
   AND task."version" = instance."task_version"
  LEFT JOIN public."org_units" owner_unit
    ON owner_unit."tenant_id" = task."tenant_id"
   AND owner_unit."id" = task."owner_org_unit_id"
  WHERE node."tenant_id" = p_tenant_id
    AND node."id" = p_process_node_id;
  IF node_type IS NULL THEN
    RAISE EXCEPTION 'The Process Step node is not part of its Process Instance.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_node_instance_match';
  END IF;
  IF node_type NOT IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION') THEN
    RAISE EXCEPTION 'Only executable Process Steps may resolve a Role Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_node_type';
  END IF;

  required_action := node_configuration->>'requiredPermissionAction';
  required_action_namespace := split_part(required_action, '.', 1) || '.*';
  SELECT assignment."id", assignment."user_id", assignment."employment_id",
         assignment."role_template_id", assignment."role_version_id",
         assignment."agent_instance_id", assignment."permission_scope",
         assignment."organization_scope", assignment."status",
         assignment."effective_from", assignment."effective_to",
         employment."organization_id", employment."org_unit_id",
         employment."status" AS employment_status,
         unit."status" AS org_unit_status,
         role_version."status" AS role_version_status
    INTO assignment_record
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
   AND unit."id" = employment."org_unit_id"
   AND unit."organization_id" = employment."organization_id"
  JOIN public."agent_versions" role_version
    ON role_version."tenant_id" = assignment."tenant_id"
   AND role_version."template_id" = assignment."role_template_id"
   AND role_version."id" = assignment."role_version_id"
  WHERE assignment."tenant_id" = p_tenant_id
    AND assignment."id" = p_role_assignment_id
  FOR SHARE OF assignment, employment, unit, role_version;

  context_organization_id := COALESCE(
    task_organization_id,
    assignment_record."organization_id"
  );
  IF assignment_record."id" IS NULL
     OR assignment_record."status" <> 'ACTIVE'
     OR assignment_record."effective_from" > p_evaluated_at
     OR (
       assignment_record."effective_to" IS NOT NULL
       AND assignment_record."effective_to" <= p_evaluated_at
     )
     OR assignment_record."employment_status" <> 'ACTIVE'
     OR assignment_record."org_unit_status" <> 'ACTIVE'
     OR assignment_record."role_version_status" NOT IN ('PUBLISHED', 'RETIRED')
     OR assignment_record."role_template_id"::text
          IS DISTINCT FROM node_configuration->>'roleTemplateId'
     OR jsonb_typeof(assignment_record."permission_scope"->'actions') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(
         assignment_record."permission_scope"->'actions'
       ) action(value)
       WHERE action.value IN ('*', required_action, required_action_namespace)
     )
     OR jsonb_typeof(assignment_record."permission_scope"->'taskIds') IS DISTINCT FROM 'array'
     OR NOT (
       assignment_record."permission_scope"->'taskIds'
       @> jsonb_build_array(task_id::text)
     )
     OR jsonb_typeof(
       assignment_record."permission_scope"->'permissionLabels'
     ) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(task_permission_labels) required_label(value)
       WHERE NOT (
         assignment_record."permission_scope"->'permissionLabels'
         @> jsonb_build_array(required_label.value)
       )
     )
     OR jsonb_typeof(
       assignment_record."organization_scope"->'organizationIds'
     ) IS DISTINCT FROM 'array'
     OR NOT (
       assignment_record."organization_scope"->'organizationIds'
       @> jsonb_build_array(context_organization_id::text)
     )
  THEN
    RAISE EXCEPTION 'The resolved Role Assignment is not eligible for this Process Step.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_assignment_scope';
  END IF;
  IF node_type = 'HUMAN_APPROVAL' AND p_agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'A human approval Process Step cannot resolve to an Agent actor.'
      USING ERRCODE = '23514', CONSTRAINT = 'human_approval_human_actor';
  END IF;
  IF node_type = 'AGENT_EXECUTION'
     AND (
       p_agent_id IS NULL
       OR p_agent_id IS DISTINCT FROM assignment_record."agent_instance_id"
     )
  THEN
    RAISE EXCEPTION 'An Agent execution must resolve the Role Assignment Agent.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_execution_agent_match';
  END IF;

  RETURN jsonb_build_object(
    'assignmentId', assignment_record."id",
    'userId', assignment_record."user_id",
    'employmentId', assignment_record."employment_id",
    'organizationId', assignment_record."organization_id",
    'orgUnitId', assignment_record."org_unit_id",
    'roleTemplateId', assignment_record."role_template_id",
    'roleVersionId', assignment_record."role_version_id",
    'roleVersionStatus', assignment_record."role_version_status",
    'agentId', CASE
      WHEN node_type = 'AGENT_EXECUTION' THEN assignment_record."agent_instance_id"
      ELSE NULL
    END,
    'requiredPermissionAction', required_action,
    'evaluatedAt', p_evaluated_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_process_step_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_valid boolean;
  node_type public."ProcessNodeType";
  compensation_valid boolean;
BEGIN
  IF NEW."status" NOT IN ('WAITING', 'READY') OR NEW."revision" <> 1 THEN
    RAISE EXCEPTION 'A Process Step must be inserted as WAITING/READY revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_initial_state_check';
  END IF;
  IF NEW."output" IS NOT NULL
     OR NEW."failure_code" IS NOT NULL
     OR NEW."failure_detail" IS NOT NULL
     OR NEW."claimed_at" IS NOT NULL
     OR NEW."started_at" IS NOT NULL
     OR NEW."completed_at" IS NOT NULL
     OR NEW."timed_out_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'A new Process Step cannot preload outcome state.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_initial_outcome_empty';
  END IF;
  SELECT
    instance."process_definition_id" = NEW."process_definition_id"
    AND instance."process_version_id" = NEW."process_version_id"
    AND instance."process_version" = NEW."process_version"
    AND instance."status" IN ('PENDING', 'RUNNING', 'PAUSED')
  INTO parent_valid
  FROM public."process_instances" instance
  WHERE instance."tenant_id" = NEW."tenant_id"
    AND instance."id" = NEW."process_instance_id"
  FOR SHARE;
  IF COALESCE(parent_valid, false) = false THEN
    RAISE EXCEPTION 'A Process Step requires a matching nonterminal Process Instance.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_parent_check';
  END IF;
  SELECT "type"
    INTO node_type
  FROM public."process_nodes"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."process_node_id";
  IF NEW."compensation_for_step_id" IS NOT NULL THEN
    SELECT
      node_type = 'COMPENSATION'
      AND original."process_instance_id" = NEW."process_instance_id"
      AND original."status" IN (
        'COMPLETED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'COMPENSATION_FAILED'
      )
    INTO compensation_valid
    FROM public."process_step_instances" original
    WHERE original."tenant_id" = NEW."tenant_id"
      AND original."id" = NEW."compensation_for_step_id"
    FOR SHARE;
    IF COALESCE(compensation_valid, false) = false THEN
      RAISE EXCEPTION 'A compensation step must reference a terminal step in the same Process Instance.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_step_compensation_target';
    END IF;
  ELSIF node_type = 'COMPENSATION' THEN
    RAISE EXCEPTION 'A compensation node requires its original Process Step.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_compensation_target';
  END IF;
  IF node_type IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION') AND NEW."status" = 'READY'
     AND NEW."resolved_role_assignment_id" IS NULL THEN
    RAISE EXCEPTION 'A ready executable Process Step requires a resolved Role Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_resolution_required';
  END IF;
  IF node_type = 'HUMAN_APPROVAL' AND NEW."resolved_agent_id" IS NOT NULL THEN
    RAISE EXCEPTION 'A human approval Process Step cannot resolve to an Agent actor.'
      USING ERRCODE = '23514', CONSTRAINT = 'human_approval_human_actor';
  END IF;
  IF NEW."resolved_role_assignment_id" IS NOT NULL THEN
    NEW."assignment_snapshot" := public.build_process_step_assignment_snapshot(
      NEW."tenant_id",
      NEW."process_instance_id",
      NEW."process_node_id",
      NEW."resolved_role_assignment_id",
      NEW."resolved_agent_id",
      CURRENT_TIMESTAMP
    );
  ELSIF NEW."resolved_agent_id" IS NOT NULL OR NEW."assignment_snapshot" IS NOT NULL THEN
    RAISE EXCEPTION 'Process Step resolution fields must be supplied as one trusted unit.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_shape';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "process_step_instances_insert_trigger"
  BEFORE INSERT ON public."process_step_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_step_insert();

CREATE OR REPLACE FUNCTION public.guard_process_step_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  node_type public."ProcessNodeType";
  parent_status public."ProcessInstanceStatus";
  valid_evidence_count integer;
  requested_evidence_count integer;
BEGIN
  IF (
    NEW."tenant_id", NEW."process_instance_id", NEW."process_definition_id",
    NEW."process_version_id", NEW."process_version", NEW."process_node_id",
    NEW."process_node_code", NEW."idempotency_key",
    NEW."request_hash", NEW."input", NEW."available_at", NEW."due_at",
    NEW."compensation_for_step_id", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."process_instance_id", OLD."process_definition_id",
    OLD."process_version_id", OLD."process_version", OLD."process_node_id",
    OLD."process_node_code", OLD."idempotency_key",
    OLD."request_hash", OLD."input", OLD."available_at", OLD."due_at",
    OLD."compensation_for_step_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Process Step identity and execution snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Process Step transition requires an exact revision increment.'
      USING ERRCODE = '40001', CONSTRAINT = 'process_step_instances_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'WAITING' AND NEW."status" IN ('READY', 'SKIPPED', 'CANCELLED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN (
      'RUNNING', 'TIMED_OUT', 'CANCELLED', 'SKIPPED'
    ))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN (
      'COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED'
    ))
    OR (OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED') AND NEW."status" = 'READY')
    OR (OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED') AND NEW."status" = 'CANCELLED')
    OR (OLD."status" IN (
      'COMPLETED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'COMPENSATION_FAILED'
    ) AND NEW."status" = 'COMPENSATING')
    OR (OLD."status" = 'COMPENSATING' AND NEW."status" IN ('COMPENSATED', 'COMPENSATION_FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid Process Step status transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_status_transition_check';
  END IF;
  IF NEW."attempt" <> OLD."attempt" + (
    CASE
      WHEN OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED')
        AND NEW."status" = 'READY'
        THEN 1
      ELSE 0
    END
  ) THEN
    RAISE EXCEPTION 'Process Step attempt may increment exactly once only on RETRY.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_instances_attempt_transition_check';
  END IF;

  SELECT instance."status"
    INTO parent_status
  FROM public."process_instances" instance
  WHERE instance."tenant_id" = NEW."tenant_id"
    AND instance."id" = NEW."process_instance_id"
  FOR SHARE;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'The parent Process Instance does not exist.'
      USING ERRCODE = '23503', CONSTRAINT = 'process_step_instances_parent_check';
  END IF;
  IF parent_status IN ('COMPLETED', 'COMPENSATED', 'COMPENSATION_FAILED')
     OR (
       parent_status = 'CANCELLED'
       AND NEW."status" NOT IN ('CANCELLED', 'COMPENSATING')
     )
  THEN
    RAISE EXCEPTION 'A terminal Process Instance cannot advance normal Process Steps.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_parent_terminal';
  END IF;

  SELECT "type"
    INTO node_type
  FROM public."process_nodes"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."process_node_id";

  IF node_type IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION')
     AND NEW."status" = 'SKIPPED'
  THEN
    RAISE EXCEPTION 'A human or Agent execution step cannot be skipped.'
      USING ERRCODE = '23514', CONSTRAINT = 'executable_process_step_no_skip';
  END IF;
  IF OLD."resolved_role_assignment_id" IS NOT NULL
     AND (
       NEW."resolved_role_assignment_id" IS DISTINCT FROM OLD."resolved_role_assignment_id"
       OR NEW."resolved_agent_id" IS DISTINCT FROM OLD."resolved_agent_id"
       OR NEW."assignment_snapshot" IS DISTINCT FROM OLD."assignment_snapshot"
     )
  THEN
    RAISE EXCEPTION 'A resolved Process Step identity and snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_immutable';
  END IF;
  IF OLD."resolved_role_assignment_id" IS NULL
     AND NEW."resolved_role_assignment_id" IS NOT NULL
  THEN
    IF NOT (OLD."status" = 'WAITING' AND NEW."status" = 'READY') THEN
      RAISE EXCEPTION 'A Process Step may resolve an assignment only while activating.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_transition';
    END IF;
    NEW."assignment_snapshot" := public.build_process_step_assignment_snapshot(
      NEW."tenant_id",
      NEW."process_instance_id",
      NEW."process_node_id",
      NEW."resolved_role_assignment_id",
      NEW."resolved_agent_id",
      CURRENT_TIMESTAMP
    );
  ELSIF NEW."resolved_role_assignment_id" IS NULL
     AND (NEW."resolved_agent_id" IS NOT NULL OR NEW."assignment_snapshot" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Process Step resolution fields must be supplied as one trusted unit.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_shape';
  END IF;
  IF node_type = 'HUMAN_APPROVAL' AND NEW."status" IN ('RUNNING', 'COMPLETED', 'REJECTED') THEN
    IF NEW."resolved_role_assignment_id" IS NULL OR NEW."resolved_agent_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A human approval step requires a human Role Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'human_approval_human_actor';
    END IF;
    IF NEW."status" IN ('COMPLETED', 'REJECTED') AND (
      NEW."output" IS NULL
      OR jsonb_typeof(NEW."output"->'evidenceIds') <> 'array'
      OR jsonb_array_length(NEW."output"->'evidenceIds') < 1
    ) THEN
      RAISE EXCEPTION 'A human approval decision requires evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_required';
    END IF;
    IF NEW."status" IN ('COMPLETED', 'REJECTED') THEN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
           OR (item.value #>> '{}')
                !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) THEN
        RAISE EXCEPTION 'Human approval evidence IDs must be UUID strings.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_id_shape';
      END IF;
      requested_evidence_count := jsonb_array_length(NEW."output"->'evidenceIds');
      IF requested_evidence_count <> (
        SELECT count(DISTINCT item.value #>> '{}')
        FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
      ) THEN
        RAISE EXCEPTION 'Human approval evidence IDs must be unique.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_unique';
      END IF;
      SELECT count(*)
        INTO valid_evidence_count
      FROM public."evidence" evidence
      WHERE evidence."tenant_id" = NEW."tenant_id"
        AND evidence."id" IN (
          SELECT (item.value #>> '{}')::uuid
          FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
        )
        AND evidence."status" = 'ACTIVE'
        AND evidence."verified_at" IS NOT NULL
        AND evidence."effective_from" <= CURRENT_TIMESTAMP
        AND (
          evidence."effective_to" IS NULL
          OR evidence."effective_to" > CURRENT_TIMESTAMP
        );
      IF valid_evidence_count <> requested_evidence_count THEN
        RAISE EXCEPTION 'Human approval requires current verified Evidence records.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_valid';
      END IF;
    END IF;
  END IF;

  IF NEW."output" IS DISTINCT FROM OLD."output"
     AND NEW."status" NOT IN ('COMPLETED', 'REJECTED')
  THEN
    RAISE EXCEPTION 'Step output may be written only by COMPLETE or REJECT.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_output_transition_check';
  END IF;
  IF (
       NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
       OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"
     )
     AND NEW."status" NOT IN ('FAILED', 'COMPENSATION_FAILED')
  THEN
    RAISE EXCEPTION 'Step failure detail may be written only by a failure transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_failure_transition_check';
  END IF;
  IF NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at" AND NEW."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'Step claimed_at may be written only by CLAIM.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_claim_transition_check';
  END IF;
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     AND NEW."status" NOT IN ('RUNNING', 'COMPENSATING')
  THEN
    RAISE EXCEPTION 'Step started_at does not match this transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_started_transition_check';
  END IF;
  IF NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
     AND NEW."status" NOT IN ('COMPLETED', 'REJECTED', 'COMPENSATED')
  THEN
    RAISE EXCEPTION 'Step completed_at does not match this terminal transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_completed_transition_check';
  END IF;
  IF NEW."timed_out_at" IS DISTINCT FROM OLD."timed_out_at"
     AND NEW."status" <> 'TIMED_OUT'
  THEN
    RAISE EXCEPTION 'Step timed_out_at may be written only by TIMEOUT.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_timeout_transition_check';
  END IF;

  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "process_step_instances_transition_trigger"
  BEFORE UPDATE ON public."process_step_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_step_transition();

CREATE OR REPLACE FUNCTION public.guard_process_command_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  assignment_user_id uuid;
  assignment_agent_id uuid;
  assignment_active boolean;
  assignment_actions jsonb;
  step_record record;
  actor_snapshot jsonb;
BEGIN
  NEW."created_at" := CURRENT_TIMESTAMP;
  IF TG_TABLE_NAME = 'process_step_commands' THEN
    SELECT step."process_instance_id", step."process_node_id",
           step."resolved_role_assignment_id", step."resolved_agent_id",
           node."type" AS node_type
      INTO step_record
    FROM public."process_step_instances" step
    JOIN public."process_nodes" node
      ON node."tenant_id" = step."tenant_id"
     AND node."id" = step."process_node_id"
    WHERE step."tenant_id" = NEW."tenant_id"
      AND step."id" = NEW."process_step_instance_id"
    FOR SHARE OF step, node;
    IF step_record."process_instance_id" IS NULL THEN
      RAISE EXCEPTION 'The Process Step command target does not exist.'
        USING ERRCODE = '23503', CONSTRAINT = 'process_step_commands_step_fkey';
    END IF;

    IF NEW."command" IN (
      'ACTIVATE', 'TIMEOUT', 'RETRY', 'CANCEL', 'SKIP',
      'BEGIN_COMPENSATION', 'COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'
    ) THEN
      IF NEW."actor_type" <> 'SERVICE' THEN
        RAISE EXCEPTION 'Lifecycle Process Step commands require the orchestrator service.'
          USING ERRCODE = '23514', CONSTRAINT = 'process_step_commands_service_actor_required';
      END IF;
      IF NEW."command" = 'SKIP'
         AND step_record."node_type" IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION')
      THEN
        RAISE EXCEPTION 'Human and Agent execution Process Steps cannot be skipped.'
          USING ERRCODE = '23514', CONSTRAINT = 'process_step_commands_skip_forbidden';
      END IF;
      RETURN NEW;
    END IF;

    IF step_record."node_type" = 'HUMAN_APPROVAL' THEN
      IF NEW."command" NOT IN ('CLAIM', 'COMPLETE', 'REJECT')
         OR NEW."actor_type" <> 'USER'
         OR NEW."actor_role_assignment_id"
              IS DISTINCT FROM step_record."resolved_role_assignment_id"
      THEN
        RAISE EXCEPTION 'Human approval commands require the resolved human Role Assignment.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_command_actor';
      END IF;
    ELSIF step_record."node_type" = 'AGENT_EXECUTION' THEN
      IF NEW."command" NOT IN ('CLAIM', 'COMPLETE', 'FAIL')
         OR NEW."actor_type" <> 'AGENT'
         OR NEW."actor_role_assignment_id"
              IS DISTINCT FROM step_record."resolved_role_assignment_id"
         OR NEW."actor_agent_id" IS DISTINCT FROM step_record."resolved_agent_id"
      THEN
        RAISE EXCEPTION 'Agent execution commands require the resolved Agent Role Assignment.'
          USING ERRCODE = '23514', CONSTRAINT = 'agent_execution_command_actor';
      END IF;
    ELSIF NEW."command" IN ('CLAIM', 'COMPLETE', 'FAIL') THEN
      IF NEW."actor_type" <> 'SERVICE' THEN
        RAISE EXCEPTION 'Deterministic Process Steps may be completed only by the orchestrator.'
          USING ERRCODE = '23514', CONSTRAINT = 'process_step_commands_service_actor_required';
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'This command is not valid for the Process Step node type.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_step_commands_node_command';
    END IF;

    actor_snapshot := public.build_process_step_assignment_snapshot(
      NEW."tenant_id",
      step_record."process_instance_id",
      step_record."process_node_id",
      NEW."actor_role_assignment_id",
      CASE WHEN NEW."actor_type" = 'AGENT' THEN NEW."actor_agent_id" ELSE NULL END,
      CURRENT_TIMESTAMP
    );
    IF (
         NEW."actor_type" = 'USER'
         AND NEW."actor_user_id"::text
              IS DISTINCT FROM actor_snapshot->>'userId'
       )
       OR (
         NEW."actor_type" = 'AGENT'
         AND NEW."actor_agent_id"::text
              IS DISTINCT FROM actor_snapshot->>'agentId'
       )
    THEN
      RAISE EXCEPTION 'The Process Step command principal does not match the resolved assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_step_commands_actor_assignment_match';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."actor_type" = 'SERVICE' THEN
    RETURN NEW;
  END IF;
  IF NEW."actor_type" <> 'USER' THEN
    RAISE EXCEPTION 'Process Instance commands require a service or authorized human actor.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_commands_actor_type';
  END IF;
  SELECT
    assignment."user_id",
    assignment."agent_instance_id",
    assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= CURRENT_TIMESTAMP
      AND (assignment."effective_to" IS NULL OR assignment."effective_to" > CURRENT_TIMESTAMP)
      AND employment."status" = 'ACTIVE'
      AND unit."status" = 'ACTIVE'
      AND role_version."status" IN ('PUBLISHED', 'RETIRED'),
    assignment."permission_scope"->'actions'
  INTO assignment_user_id, assignment_agent_id, assignment_active, assignment_actions
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
    AND unit."id" = employment."org_unit_id"
  JOIN public."agent_versions" role_version
    ON role_version."tenant_id" = assignment."tenant_id"
   AND role_version."template_id" = assignment."role_template_id"
   AND role_version."id" = assignment."role_version_id"
  WHERE assignment."tenant_id" = NEW."tenant_id"
    AND assignment."id" = NEW."actor_role_assignment_id"
  FOR SHARE OF assignment, employment, unit, role_version;
  IF COALESCE(assignment_active, false) = false
     OR NEW."actor_user_id" IS DISTINCT FROM assignment_user_id
     OR jsonb_typeof(assignment_actions) IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(assignment_actions) action(value)
       WHERE action.value IN ('*', 'process.*', 'process.instance.command')
     )
  THEN
    RAISE EXCEPTION 'The command actor does not match an effective Role Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_actor_assignment_match';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "process_commands_actor_trigger"
  BEFORE INSERT ON public."process_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_command_actor();
CREATE TRIGGER "process_step_commands_actor_trigger"
  BEFORE INSERT ON public."process_step_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_command_actor();

CREATE OR REPLACE FUNCTION public.guard_process_command_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Process command history is append-only.'
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;

CREATE TRIGGER "process_commands_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."process_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_command_append_only();
CREATE TRIGGER "process_step_commands_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."process_step_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_command_append_only();

CREATE OR REPLACE FUNCTION public.validate_process_command_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_revision integer;
BEGIN
  IF TG_TABLE_NAME = 'process_commands' THEN
    SELECT "revision"
      INTO current_revision
    FROM public."process_instances"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."process_instance_id"
    FOR SHARE;
  ELSE
    SELECT "revision"
      INTO current_revision
    FROM public."process_step_instances"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."process_step_instance_id"
    FOR SHARE;
  END IF;
  IF current_revision IS NULL OR current_revision <> NEW."result_revision" THEN
    RAISE EXCEPTION 'The command result revision does not match runtime state.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_state_revision_match';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "process_commands_revision_trigger"
  AFTER INSERT ON public."process_commands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_command_revision();
CREATE CONSTRAINT TRIGGER "process_step_commands_revision_trigger"
  AFTER INSERT ON public."process_step_commands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_command_revision();

CREATE OR REPLACE FUNCTION public.validate_process_transition_command_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  actual_command text;
  expected_command text;
BEGIN
  IF TG_TABLE_NAME = 'process_instances' THEN
    expected_command := CASE
      WHEN OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING' THEN 'START'
      WHEN OLD."status" = 'PENDING' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'PAUSED' THEN 'PAUSE'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'COMPLETED' THEN 'COMPLETE'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'FAILED' THEN 'FAIL'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'COMPENSATING'
        THEN 'BEGIN_COMPENSATION'
      WHEN OLD."status" = 'PAUSED' AND NEW."status" = 'RUNNING' THEN 'RESUME'
      WHEN OLD."status" = 'PAUSED' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" = 'PAUSED' AND NEW."status" = 'COMPENSATING'
        THEN 'BEGIN_COMPENSATION'
      WHEN OLD."status" IN ('COMPLETED', 'CANCELLED', 'FAILED', 'COMPENSATION_FAILED')
       AND NEW."status" = 'COMPENSATING' THEN 'BEGIN_COMPENSATION'
      WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATED'
        THEN 'COMPLETE_COMPENSATION'
      WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATION_FAILED'
        THEN 'FAIL_COMPENSATION'
    END;
    SELECT command."command"::text
      INTO actual_command
    FROM public."process_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."process_instance_id" = NEW."id"
      AND command."expected_revision" = OLD."revision"
      AND command."result_revision" = NEW."revision";
  ELSE
    expected_command := CASE
      WHEN OLD."status" = 'WAITING' AND NEW."status" = 'READY' THEN 'ACTIVATE'
      WHEN OLD."status" = 'WAITING' AND NEW."status" = 'SKIPPED' THEN 'SKIP'
      WHEN OLD."status" = 'WAITING' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" = 'READY' AND NEW."status" = 'RUNNING' THEN 'CLAIM'
      WHEN OLD."status" = 'READY' AND NEW."status" = 'TIMED_OUT' THEN 'TIMEOUT'
      WHEN OLD."status" = 'READY' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" = 'READY' AND NEW."status" = 'SKIPPED' THEN 'SKIP'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'COMPLETED' THEN 'COMPLETE'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'REJECTED' THEN 'REJECT'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'TIMED_OUT' THEN 'TIMEOUT'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'FAILED' THEN 'FAIL'
      WHEN OLD."status" = 'RUNNING' AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED')
       AND NEW."status" = 'READY' THEN 'RETRY'
      WHEN OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED')
       AND NEW."status" = 'CANCELLED' THEN 'CANCEL'
      WHEN OLD."status" IN (
        'COMPLETED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'COMPENSATION_FAILED'
      ) AND NEW."status" = 'COMPENSATING' THEN 'BEGIN_COMPENSATION'
      WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATED'
        THEN 'COMPLETE_COMPENSATION'
      WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATION_FAILED'
        THEN 'FAIL_COMPENSATION'
    END;
    SELECT command."command"::text
      INTO actual_command
    FROM public."process_step_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."process_step_instance_id" = NEW."id"
      AND command."expected_revision" = OLD."revision"
      AND command."result_revision" = NEW."revision";
  END IF;
  IF expected_command IS NULL OR actual_command IS DISTINCT FROM expected_command THEN
    RAISE EXCEPTION 'Runtime transition command mismatch: expected %, received %.',
      expected_command, actual_command
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_command_coverage';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "process_instances_command_coverage_trigger"
  AFTER UPDATE ON public."process_instances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_transition_command_coverage();
CREATE CONSTRAINT TRIGGER "process_step_instances_command_coverage_trigger"
  AFTER UPDATE ON public."process_step_instances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_transition_command_coverage();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_process'
  ) THEN
    CREATE ROLE enterprise_agent_process
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_process
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT enterprise_agent_process TO %I', current_user);
END
$$;

REVOKE enterprise_agent_process
  FROM enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin,
       enterprise_agent_outbox, enterprise_agent_provisioner;
REVOKE enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin,
       enterprise_agent_outbox, enterprise_agent_provisioner
  FROM enterprise_agent_process;

GRANT USAGE ON SCHEMA public
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_process;

REVOKE ALL PRIVILEGES ON TABLE
  public."process_edges",
  public."process_instances",
  public."process_step_instances",
  public."process_commands",
  public."process_step_commands"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin, enterprise_agent_process;

GRANT SELECT ON TABLE
  public."process_edges",
  public."process_instances",
  public."process_step_instances",
  public."process_commands",
  public."process_step_commands"
  TO enterprise_agent_app, enterprise_agent_admin;

GRANT INSERT, UPDATE, DELETE ON TABLE public."process_edges"
  TO enterprise_agent_admin;

GRANT SELECT ON TABLE
  public."employments",
  public."org_units",
  public."agent_templates",
  public."agent_versions",
  public."agent_instances",
  public."role_assignments",
  public."objectives",
  public."process_definitions",
  public."process_versions",
  public."process_nodes",
  public."process_edges",
  public."tasks",
  public."deliverables",
  public."acceptances",
  public."deliverable_evidence",
  public."acceptance_evidence",
  public."evidence",
  public."process_instances",
  public."process_step_instances",
  public."process_commands",
  public."process_step_commands"
  TO enterprise_agent_process;

-- Collaboration candidate resolution needs only the public identity fields.
-- Keep the process capability away from credentials and all other user data.
GRANT SELECT ("tenant_id", "id", "display_name", "status")
  ON TABLE public."users"
  TO enterprise_agent_process;
GRANT SELECT (
  "tenant_id", "objective_id", "objective_version", "role_assignment_id"
)
  ON TABLE public."objective_role_assignments"
  TO enterprise_agent_process;

GRANT INSERT, UPDATE ON TABLE
  public."process_instances",
  public."process_step_instances"
  TO enterprise_agent_process;
GRANT UPDATE ("process_instance_id") ON TABLE public."tasks"
  TO enterprise_agent_process;
GRANT INSERT ON TABLE
  public."process_commands",
  public."process_step_commands"
  TO enterprise_agent_process;
GRANT INSERT (
  "tenant_id", "actor_type", "actor_id", "action", "resource_type",
  "resource_id", "metadata", "occurred_at"
) ON TABLE public."audit_events" TO enterprise_agent_process;
GRANT INSERT (
  "tenant_id", "aggregate_type", "aggregate_id", "event_type", "payload"
) ON TABLE public."outbox_events" TO enterprise_agent_process;

-- The semantic and assignment migrations use a restrictive PUBLIC tenant
-- policy plus role-specific permissive policies. Add the minimum read path
-- needed by runtime guards; without this, the capability role has SQL SELECT
-- privilege but RLS hides every referenced row.
DO $process_reference_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'employments',
    'org_units',
    'agent_templates',
    'agent_versions',
    'agent_instances',
    'role_assignments',
    'objectives',
    'objective_role_assignments',
    'process_definitions',
    'process_versions',
    'process_nodes',
    'tasks',
    'deliverables',
    'acceptances',
    'deliverable_evidence',
    'acceptance_evidence',
    'evidence'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY enterprise_agent_process_read ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_process USING (true)',
      table_name
    );
  END LOOP;
END
$process_reference_rls$;

-- The identity migration intentionally scopes its restrictive users policy to
-- the app/admin/provisioning roles. Add an explicit process-role tenant gate
-- before making the four candidate-display columns visible.
CREATE POLICY enterprise_agent_process_tenant_isolation
  ON public."users"
  AS RESTRICTIVE
  FOR SELECT
  TO enterprise_agent_process
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY enterprise_agent_process_read
  ON public."users"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_process
  USING (true);

CREATE POLICY enterprise_agent_process_task_link
  ON public."tasks"
  AS PERMISSIVE
  FOR UPDATE
  TO enterprise_agent_process
  USING ("process_instance_id" IS NULL)
  WITH CHECK ("process_instance_id" IS NOT NULL);

CREATE POLICY enterprise_agent_process_insert
  ON public."audit_events"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_process
  WITH CHECK (true);

CREATE POLICY enterprise_agent_process_tenant_isolation
  ON public."outbox_events"
  AS RESTRICTIVE
  FOR ALL
  TO enterprise_agent_process
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY enterprise_agent_process_insert
  ON public."outbox_events"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_process
  WITH CHECK (true);

REVOKE ALL ON FUNCTION public.build_process_step_assignment_snapshot(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_process_step_assignment_snapshot(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) TO enterprise_agent_process;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'process_edges',
    'process_instances',
    'process_step_instances',
    'process_commands',
    'process_step_commands'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_access ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_admin USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_process_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_process '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$$;

DROP POLICY enterprise_agent_admin_access ON public."process_edges";
CREATE POLICY enterprise_agent_admin_access
  ON public."process_edges"
  AS PERMISSIVE FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);
COMMIT;
