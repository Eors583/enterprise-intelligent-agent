-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LOCKED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ManagerRelationType" AS ENUM ('DIRECT', 'DOTTED_LINE');

-- CreateEnum
CREATE TYPE "AgentVersionStatus" AS ENUM ('DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "AgentInstanceStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT');

-- CreateEnum
CREATE TYPE "ConversationParticipantType" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "MessageContentType" AS ENUM ('TEXT');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'AGENT', 'SERVICE');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "phone" VARCHAR(40),
    "display_name" VARCHAR(120) NOT NULL,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "external_key" VARCHAR(200),
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(300),
    "country_code" CHAR(2),
    "timezone" VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "external_key" VARCHAR(200),
    "name" VARCHAR(200) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "org_unit_id" UUID,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "position_id" UUID,
    "employee_number" VARCHAR(100),
    "work_email" VARCHAR(320),
    "employment_type" VARCHAR(80),
    "hire_date" DATE,
    "city" VARCHAR(120),
    "status" "EmploymentStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_relations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employment_id" UUID NOT NULL,
    "manager_employment_id" UUID NOT NULL,
    "relation_type" "ManagerRelationType" NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgentVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "system_prompt" TEXT NOT NULL,
    "model_policy" JSONB NOT NULL,
    "tool_policy" JSONB NOT NULL,
    "knowledge_scope" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_instances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "version_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "summary" TEXT,
    "status" "AgentInstanceStatus" NOT NULL DEFAULT 'OFFLINE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
    "direct_key" VARCHAR(240) NOT NULL,
    "title" VARCHAR(200),
    "created_by_id" UUID NOT NULL,
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "type" "ConversationParticipantType" NOT NULL,
    "participant_key" VARCHAR(48) NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "display_name" VARCHAR(200) NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_type" "ConversationParticipantType" NOT NULL,
    "sender_user_id" UUID,
    "sender_agent_id" UUID,
    "sender_key" VARCHAR(48) NOT NULL,
    "sender_name" VARCHAR(200) NOT NULL,
    "client_message_id" VARCHAR(200) NOT NULL,
    "content_type" "MessageContentType" NOT NULL DEFAULT 'TEXT',
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(160) NOT NULL,
    "resource_type" VARCHAR(100) NOT NULL,
    "resource_id" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "organizations_tenant_id_name_idx" ON "organizations"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_tenant_id_external_key_key" ON "organizations"("tenant_id", "external_key");

-- CreateIndex
CREATE INDEX "org_units_tenant_id_parent_id_sort_order_idx" ON "org_units"("tenant_id", "parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "org_units_tenant_id_organization_id_external_key_key" ON "org_units"("tenant_id", "organization_id", "external_key");

-- CreateIndex
CREATE INDEX "positions_tenant_id_org_unit_id_idx" ON "positions"("tenant_id", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_tenant_id_code_key" ON "positions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "employments_tenant_id_org_unit_id_status_idx" ON "employments"("tenant_id", "org_unit_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employments_tenant_id_user_id_organization_id_org_unit_id_key" ON "employments"("tenant_id", "user_id", "organization_id", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "employments_tenant_id_employee_number_key" ON "employments"("tenant_id", "employee_number");

-- CreateIndex
CREATE INDEX "manager_relations_tenant_id_manager_employment_id_relation__idx" ON "manager_relations"("tenant_id", "manager_employment_id", "relation_type");

-- CreateIndex
CREATE UNIQUE INDEX "manager_relations_tenant_id_employment_id_manager_employmen_key" ON "manager_relations"("tenant_id", "employment_id", "manager_employment_id", "relation_type");

-- CreateIndex
CREATE INDEX "agent_templates_tenant_id_name_idx" ON "agent_templates"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_templates_tenant_id_key_key" ON "agent_templates"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "agent_versions_tenant_id_status_published_at_idx" ON "agent_versions"("tenant_id", "status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_tenant_id_template_id_version_key" ON "agent_versions"("tenant_id", "template_id", "version");

-- CreateIndex
CREATE INDEX "agent_instances_tenant_id_owner_user_id_status_idx" ON "agent_instances"("tenant_id", "owner_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_instances_tenant_id_key_key" ON "agent_instances"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_last_message_at_updated_at_idx" ON "conversations"("tenant_id", "last_message_at" DESC, "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_direct_key_key" ON "conversations"("tenant_id", "direct_key");

-- CreateIndex
CREATE INDEX "conversation_participants_tenant_id_user_id_left_at_idx" ON "conversation_participants"("tenant_id", "user_id", "left_at");

-- CreateIndex
CREATE INDEX "conversation_participants_tenant_id_agent_id_left_at_idx" ON "conversation_participants"("tenant_id", "agent_id", "left_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_tenant_id_conversation_id_partici_key" ON "conversation_participants"("tenant_id", "conversation_id", "participant_key");

-- CreateIndex
CREATE INDEX "messages_tenant_id_conversation_id_created_at_id_idx" ON "messages"("tenant_id", "conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_conversation_id_sender_key_client_messag_key" ON "messages"("tenant_id", "conversation_id", "sender_key", "client_message_id");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_status_available_at_idx" ON "outbox_events"("tenant_id", "status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_resource_type_resource_id_occurred_a_idx" ON "audit_events"("tenant_id", "resource_type", "resource_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_relations" ADD CONSTRAINT "manager_relations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_relations" ADD CONSTRAINT "manager_relations_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_relations" ADD CONSTRAINT "manager_relations_manager_employment_id_fkey" FOREIGN KEY ("manager_employment_id") REFERENCES "employments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "agent_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "agent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_fkey" FOREIGN KEY ("sender_agent_id") REFERENCES "agent_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants for polymorphic principals. Prisma cannot express these checks.
ALTER TABLE "conversation_participants"
ADD CONSTRAINT "conversation_participants_principal_check" CHECK (
    ("type" = 'USER' AND "user_id" IS NOT NULL AND "agent_id" IS NULL AND "participant_key" = 'user:' || "user_id"::text)
    OR
    ("type" = 'AGENT' AND "agent_id" IS NOT NULL AND "user_id" IS NULL AND "participant_key" = 'agent:' || "agent_id"::text)
);

ALTER TABLE "messages"
ADD CONSTRAINT "messages_sender_check" CHECK (
    ("sender_type" = 'USER' AND "sender_user_id" IS NOT NULL AND "sender_agent_id" IS NULL AND "sender_key" = 'user:' || "sender_user_id"::text)
    OR
    ("sender_type" = 'AGENT' AND "sender_agent_id" IS NOT NULL AND "sender_user_id" IS NULL AND "sender_key" = 'agent:' || "sender_agent_id"::text)
);

ALTER TABLE "messages"
ADD CONSTRAINT "messages_text_content_check" CHECK (
    "content_type" <> 'TEXT'
    OR (jsonb_typeof("content") = 'object' AND "content"->>'type' = 'text' AND length("content"->>'text') BETWEEN 1 AND 20000)
);

ALTER TABLE "manager_relations"
ADD CONSTRAINT "manager_relations_not_self_check" CHECK ("employment_id" <> "manager_employment_id");

-- The local migration login is intentionally privileged. Application queries
-- are demoted to this role so PostgreSQL cannot bypass RLS through superuser or
-- table-owner privileges. Production must keep login and migration credentials separate.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_app') THEN
        CREATE ROLE enterprise_agent_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
        ALTER ROLE enterprise_agent_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    EXECUTE format('GRANT enterprise_agent_app TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO enterprise_agent_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO enterprise_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO enterprise_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO enterprise_agent_app;

-- RLS is intentionally forced, including for table owners. Every application
-- transaction must first call set_config('app.tenant_id', tenant_uuid, true).
-- current_setting(..., true) returns NULL when context is absent, so policies
-- default-deny without relying on a session-level value in the connection pool.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenants"
USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organizations"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "org_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "org_units"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "positions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "positions"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "employments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employments"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "manager_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manager_relations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "manager_relations"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "agent_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_templates"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_versions"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "agent_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_instances"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conversations"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conversation_participants"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "messages"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "outbox_events"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_events"
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
