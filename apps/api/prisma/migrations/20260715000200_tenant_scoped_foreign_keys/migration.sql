-- Tenant isolation must remain true even when a query bypasses application
-- validation. Every business relation below includes tenant_id on both sides,
-- so a tenant A row cannot reference a tenant B parent whose globally unique id
-- is otherwise valid.
--
-- The migration is intentionally data-preserving: it only adds candidate keys
-- and replaces foreign-key constraints. Existing invalid cross-tenant rows make
-- the migration fail atomically instead of being rewritten or deleted.
BEGIN;

-- Composite candidate keys required by PostgreSQL and Prisma for tenant-scoped
-- references. Create these before replacing any existing foreign keys.
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");
CREATE UNIQUE INDEX "organizations_tenant_id_id_key" ON "organizations"("tenant_id", "id");
CREATE UNIQUE INDEX "org_units_tenant_id_id_key" ON "org_units"("tenant_id", "id");
CREATE UNIQUE INDEX "positions_tenant_id_id_key" ON "positions"("tenant_id", "id");
CREATE UNIQUE INDEX "employments_tenant_id_id_key" ON "employments"("tenant_id", "id");
CREATE UNIQUE INDEX "agent_templates_tenant_id_id_key" ON "agent_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "agent_versions_tenant_id_id_key" ON "agent_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "agent_instances_tenant_id_id_key" ON "agent_instances"("tenant_id", "id");
CREATE UNIQUE INDEX "conversations_tenant_id_id_key" ON "conversations"("tenant_id", "id");

-- Remove only the old id-only business foreign keys. Root tenant_id -> tenants.id
-- constraints remain unchanged.
ALTER TABLE "org_units" DROP CONSTRAINT "org_units_organization_id_fkey";
ALTER TABLE "org_units" DROP CONSTRAINT "org_units_parent_id_fkey";
ALTER TABLE "positions" DROP CONSTRAINT "positions_organization_id_fkey";
ALTER TABLE "positions" DROP CONSTRAINT "positions_org_unit_id_fkey";
ALTER TABLE "employments" DROP CONSTRAINT "employments_user_id_fkey";
ALTER TABLE "employments" DROP CONSTRAINT "employments_organization_id_fkey";
ALTER TABLE "employments" DROP CONSTRAINT "employments_org_unit_id_fkey";
ALTER TABLE "employments" DROP CONSTRAINT "employments_position_id_fkey";
ALTER TABLE "manager_relations" DROP CONSTRAINT "manager_relations_employment_id_fkey";
ALTER TABLE "manager_relations" DROP CONSTRAINT "manager_relations_manager_employment_id_fkey";
ALTER TABLE "agent_versions" DROP CONSTRAINT "agent_versions_template_id_fkey";
ALTER TABLE "agent_instances" DROP CONSTRAINT "agent_instances_version_id_fkey";
ALTER TABLE "agent_instances" DROP CONSTRAINT "agent_instances_owner_user_id_fkey";
ALTER TABLE "agent_instances" DROP CONSTRAINT "agent_instances_created_by_id_fkey";
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_created_by_id_fkey";
ALTER TABLE "conversation_participants" DROP CONSTRAINT "conversation_participants_conversation_id_fkey";
ALTER TABLE "conversation_participants" DROP CONSTRAINT "conversation_participants_user_id_fkey";
ALTER TABLE "conversation_participants" DROP CONSTRAINT "conversation_participants_agent_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_conversation_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_user_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_agent_id_fkey";

-- Directory and employment graph.
ALTER TABLE "org_units"
ADD CONSTRAINT "org_units_tenant_id_organization_id_fkey"
FOREIGN KEY ("tenant_id", "organization_id")
REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "org_units"
ADD CONSTRAINT "org_units_tenant_id_parent_id_fkey"
FOREIGN KEY ("tenant_id", "parent_id")
REFERENCES "org_units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions"
ADD CONSTRAINT "positions_tenant_id_organization_id_fkey"
FOREIGN KEY ("tenant_id", "organization_id")
REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions"
ADD CONSTRAINT "positions_tenant_id_org_unit_id_fkey"
FOREIGN KEY ("tenant_id", "org_unit_id")
REFERENCES "org_units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employments"
ADD CONSTRAINT "employments_tenant_id_user_id_fkey"
FOREIGN KEY ("tenant_id", "user_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employments"
ADD CONSTRAINT "employments_tenant_id_organization_id_fkey"
FOREIGN KEY ("tenant_id", "organization_id")
REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employments"
ADD CONSTRAINT "employments_tenant_id_org_unit_id_fkey"
FOREIGN KEY ("tenant_id", "org_unit_id")
REFERENCES "org_units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employments"
ADD CONSTRAINT "employments_tenant_id_position_id_fkey"
FOREIGN KEY ("tenant_id", "position_id")
REFERENCES "positions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "manager_relations"
ADD CONSTRAINT "manager_relations_tenant_id_employment_id_fkey"
FOREIGN KEY ("tenant_id", "employment_id")
REFERENCES "employments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "manager_relations"
ADD CONSTRAINT "manager_relations_tenant_id_manager_employment_id_fkey"
FOREIGN KEY ("tenant_id", "manager_employment_id")
REFERENCES "employments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Agent definition and ownership graph. owner_user_id now uses RESTRICT because
-- a composite SET NULL action would also try to null the required tenant_id.
ALTER TABLE "agent_versions"
ADD CONSTRAINT "agent_versions_tenant_id_template_id_fkey"
FOREIGN KEY ("tenant_id", "template_id")
REFERENCES "agent_templates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_instances"
ADD CONSTRAINT "agent_instances_tenant_id_version_id_fkey"
FOREIGN KEY ("tenant_id", "version_id")
REFERENCES "agent_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_instances"
ADD CONSTRAINT "agent_instances_tenant_id_owner_user_id_fkey"
FOREIGN KEY ("tenant_id", "owner_user_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_instances"
ADD CONSTRAINT "agent_instances_tenant_id_created_by_id_fkey"
FOREIGN KEY ("tenant_id", "created_by_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Conversation graph, including both optional message sender variants.
ALTER TABLE "conversations"
ADD CONSTRAINT "conversations_tenant_id_created_by_id_fkey"
FOREIGN KEY ("tenant_id", "created_by_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "conversation_participants"
ADD CONSTRAINT "conversation_participants_tenant_id_conversation_id_fkey"
FOREIGN KEY ("tenant_id", "conversation_id")
REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_participants"
ADD CONSTRAINT "conversation_participants_tenant_id_user_id_fkey"
FOREIGN KEY ("tenant_id", "user_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "conversation_participants"
ADD CONSTRAINT "conversation_participants_tenant_id_agent_id_fkey"
FOREIGN KEY ("tenant_id", "agent_id")
REFERENCES "agent_instances"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "messages"
ADD CONSTRAINT "messages_tenant_id_conversation_id_fkey"
FOREIGN KEY ("tenant_id", "conversation_id")
REFERENCES "conversations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "messages"
ADD CONSTRAINT "messages_tenant_id_sender_user_id_fkey"
FOREIGN KEY ("tenant_id", "sender_user_id")
REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "messages"
ADD CONSTRAINT "messages_tenant_id_sender_agent_id_fkey"
FOREIGN KEY ("tenant_id", "sender_agent_id")
REFERENCES "agent_instances"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
