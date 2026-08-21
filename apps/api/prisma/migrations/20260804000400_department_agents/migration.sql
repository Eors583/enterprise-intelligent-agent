CREATE TYPE public."AgentInstanceKind" AS ENUM ('MEMBER', 'DEPARTMENT');

ALTER TABLE public."agent_instances"
  ADD COLUMN "kind" public."AgentInstanceKind" NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN "org_unit_id" uuid;

ALTER TABLE public."agent_instances"
  ADD CONSTRAINT "agent_instances_department_fkey"
  FOREIGN KEY ("tenant_id", "org_unit_id")
  REFERENCES public."org_units"("tenant_id", "id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "agent_instances_tenant_id_org_unit_id_status_idx"
  ON public."agent_instances"("tenant_id", "org_unit_id", "status");

COMMENT ON COLUMN public."agent_instances"."kind" IS
  'MEMBER is owned by a person; DEPARTMENT is shared by active employees of the bound org unit.';

COMMENT ON COLUMN public."agent_instances"."org_unit_id" IS
  'Department boundary for DEPARTMENT agents. NULL for member and legacy agents.';
