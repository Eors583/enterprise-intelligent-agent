import { Prisma, PrismaClient } from '@prisma/client';

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(databaseTestsEnabled)('PostgreSQL tenant RLS', () => {
  const prisma = new PrismaClient();
  const tenantId = '00000000-0000-7000-8000-000000000001';
  const otherTenantId = '00000000-0000-7000-8000-000000000009';
  const otherTenantUserId = '00000000-0000-7000-8000-000000000109';
  const tenantRlsBaseline = [
    { tableName: 'agent_instances', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'agent_runs', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'agent_templates', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'agent_versions', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'answer_feedbacks', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'audit_events', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'auth_action_tokens',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    { tableName: 'auth_sessions', tenantColumn: 'tenant_id', roles: ['enterprise_agent_admin'] },
    { tableName: 'conversation_participants', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'conversations', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'directory_employment_bindings',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    {
      tableName: 'directory_integrations',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    {
      tableName: 'directory_org_unit_bindings',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    {
      tableName: 'directory_user_bindings',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    { tableName: 'employments', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'knowledge_base_org_units',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
    },
    {
      tableName: 'knowledge_bases',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
    },
    { tableName: 'knowledge_chunk_embeddings', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'knowledge_chunks', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'knowledge_document_versions', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'knowledge_documents',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
    },
    {
      tableName: 'knowledge_ingestion_jobs',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
    },
    { tableName: 'manager_relations', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'messages', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'org_units', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    { tableName: 'organizations', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'outbox_events',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_app', 'enterprise_agent_provisioner'],
    },
    {
      tableName: 'password_credentials',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin'],
    },
    { tableName: 'positions', tenantColumn: 'tenant_id', roles: ['PUBLIC'] },
    {
      tableName: 'tenants',
      tenantColumn: 'id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner'],
    },
    {
      tableName: 'users',
      tenantColumn: 'tenant_id',
      roles: ['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner'],
    },
  ] as const;

  const tenantScopedForeignKeys = [
    'agent_instances_tenant_id_created_by_id_fkey',
    'agent_instances_tenant_id_owner_user_id_fkey',
    'agent_instances_tenant_id_version_id_fkey',
    'agent_versions_tenant_id_template_id_fkey',
    'conversation_participants_tenant_id_agent_id_fkey',
    'conversation_participants_tenant_id_conversation_id_fkey',
    'conversation_participants_tenant_id_user_id_fkey',
    'conversations_tenant_id_created_by_id_fkey',
    'conversations_tenant_id_relay_agent_a_id_fkey',
    'conversations_tenant_id_relay_agent_b_id_fkey',
    'agent_runs_tenant_id_agent_id_fkey',
    'agent_runs_tenant_id_agent_version_id_fkey',
    'agent_runs_tenant_id_conversation_id_fkey',
    'agent_runs_tenant_id_input_message_id_fkey',
    'agent_runs_tenant_id_output_message_id_fkey',
    'agent_runs_tenant_id_parent_run_id_fkey',
    'agent_runs_tenant_id_requester_user_id_fkey',
    'auth_sessions_tenant_id_user_id_fkey',
    'auth_action_tokens_tenant_id_user_id_fkey',
    'auth_action_tokens_tenant_id_created_by_id_fkey',
    'employments_tenant_id_organization_id_org_unit_id_fkey',
    'employments_tenant_id_organization_id_fkey',
    'employments_tenant_id_organization_id_position_id_fkey',
    'employments_tenant_id_user_id_fkey',
    'manager_relations_tenant_id_employment_id_fkey',
    'manager_relations_tenant_id_manager_employment_id_fkey',
    'messages_tenant_id_conversation_id_fkey',
    'messages_tenant_id_sender_agent_id_fkey',
    'messages_tenant_id_sender_user_id_fkey',
    'answer_feedbacks_tenant_id_message_id_fkey',
    'answer_feedbacks_tenant_id_user_id_fkey',
    'knowledge_bases_tenant_id_created_by_id_fkey',
    'knowledge_base_org_units_tenant_id_knowledge_base_id_fkey',
    'knowledge_base_org_units_tenant_id_org_unit_id_fkey',
    'knowledge_documents_tenant_id_created_by_id_fkey',
    'knowledge_documents_tenant_id_knowledge_base_id_fkey',
    'knowledge_documents_current_version_fkey',
    'knowledge_document_versions_knowledge_base_fkey',
    'knowledge_document_versions_document_fkey',
    'knowledge_document_versions_created_by_fkey',
    'knowledge_chunks_knowledge_base_fkey',
    'knowledge_chunks_document_fkey',
    'knowledge_chunks_document_version_fkey',
    'knowledge_chunk_embeddings_chunk_fkey',
    'knowledge_ingestion_jobs_document_version_fkey',
    'org_units_tenant_id_organization_id_fkey',
    'org_units_tenant_id_organization_id_parent_id_fkey',
    'password_credentials_tenant_id_user_id_fkey',
    'positions_tenant_id_organization_id_org_unit_id_fkey',
    'positions_tenant_id_organization_id_fkey',
    'directory_integrations_tenant_id_organization_id_fkey',
    'directory_user_bindings_tenant_id_integration_id_fkey',
    'directory_user_bindings_tenant_id_user_id_fkey',
    'directory_org_unit_bindings_integration_organization_fkey',
    'directory_org_unit_bindings_tenant_org_unit_fkey',
    'directory_employment_bindings_integration_organization_fkey',
    'directory_employment_bindings_user_binding_fkey',
    'directory_employment_bindings_org_unit_binding_fkey',
    'directory_employment_bindings_employment_identity_fkey',
  ] as const;

  const knowledgeIdentityForeignKeys = {
    knowledge_documents_current_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'id', 'current_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_document_versions_document_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_chunks_document_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_chunks_document_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_chunk_embeddings_chunk_fkey: {
      local: ['tenant_id', 'chunk_id'],
      referenced: ['tenant_id', 'id'],
    },
  } as const;

  afterAll(async () => prisma.$disconnect());

  it('default-denies rows when app.tenant_id is absent', async () => {
    const count = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      return transaction.user.count();
    });
    expect(count).toBe(0);
  });

  it('does not expose rows for a different tenant context', async () => {
    const count = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
      return transaction.user.count();
    });
    expect(count).toBe(0);
  });

  it('exposes only rows for the selected tenant context', async () => {
    const expectedUserCount = await prisma.user.count({ where: { tenantId } });
    const result = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return {
        tenants: await transaction.tenant.count(),
        users: await transaction.user.count(),
      };
    });
    expect(result).toEqual({ tenants: 1, users: expectedUserCount });
  });

  it('keeps every tenant policy restrictive and forced at the table boundary', async () => {
    const baseline = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        permissive: boolean;
        command: string;
        roles: string[];
        usingExpression: string;
        checkExpression: string;
      }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        policy.polpermissive AS permissive,
        policy.polcmd::text AS command,
        ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        )::text[] AS roles,
        pg_get_expr(policy.polqual, policy.polrelid) AS "usingExpression",
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS "checkExpression"
      FROM pg_policy AS policy
      JOIN pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND policy.polname = 'tenant_isolation'
      ORDER BY relation.relname
    `;

    expect(baseline).toEqual(
      tenantRlsBaseline.map(({ tableName, tenantColumn, roles }) => {
        const expression = `(${tenantColumn} = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`;
        return {
          tableName,
          rowSecurity: true,
          forceRowSecurity: true,
          permissive: false,
          command: '*',
          roles: [...roles],
          usingExpression: expression,
          checkExpression: expression,
        };
      }),
    );

    const tenantColumnTables = await prisma.$queryRaw<Array<{ tableName: string }>>`
      SELECT DISTINCT relation.relname AS "tableName"
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND attribute.attname = 'tenant_id'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname
    `;
    expect(tenantColumnTables.map(({ tableName }) => tableName)).toEqual(
      tenantRlsBaseline
        .filter(({ tenantColumn }) => tenantColumn === 'tenant_id')
        .map(({ tableName }) => tableName),
    );
  });

  it('limits the cross-tenant knowledge worker to queue identifiers and transitions', async () => {
    const policies = await prisma.$queryRaw<
      Array<{
        policyName: string;
        permissive: string;
        command: string;
        roles: string[];
      }>
    >`
      SELECT
        policyname AS "policyName",
        permissive,
        cmd AS command,
        roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'knowledge_ingestion_jobs'
        AND policyname IN ('tenant_isolation', 'enterprise_agent_outbox_access')
      ORDER BY policyname
    `;
    expect(policies).toEqual([
      {
        policyName: 'enterprise_agent_outbox_access',
        permissive: 'PERMISSIVE',
        command: 'ALL',
        roles: ['enterprise_agent_outbox'],
      },
      {
        policyName: 'tenant_isolation',
        permissive: 'RESTRICTIVE',
        command: 'ALL',
        roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
      },
    ]);

    const columnPrivileges = await prisma.$queryRaw<
      Array<{ columnName: string; privilegeType: string }>
    >`
      SELECT
        column_name AS "columnName",
        privilege_type AS "privilegeType"
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'knowledge_ingestion_jobs'
        AND grantee = 'enterprise_agent_outbox'
      ORDER BY privilege_type, column_name
    `;
    expect(columnPrivileges).toEqual([
      ...[
        'attempts',
        'available_at',
        'claimed_by',
        'created_at',
        'document_version_id',
        'id',
        'lease_expires_at',
        'started_at',
        'status',
        'tenant_id',
      ].map((columnName) => ({ columnName, privilegeType: 'SELECT' })),
      ...[
        'attempts',
        'available_at',
        'claimed_by',
        'error_code',
        'error_message',
        'finished_at',
        'lease_expires_at',
        'progress',
        'stage',
        'started_at',
        'status',
        'updated_at',
      ].map((columnName) => ({ columnName, privilegeType: 'UPDATE' })),
    ]);

    const [boundary] = await prisma.$queryRaw<
      Array<{
        canInsert: boolean;
        canDelete: boolean;
        canReadVersions: boolean;
        canReadChunks: boolean;
        canReadQueueContent: boolean;
      }>
    >`
      SELECT
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'INSERT'
        ) AS "canInsert",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'DELETE'
        ) AS "canDelete",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_document_versions',
          'SELECT'
        ) AS "canReadVersions",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_chunks',
          'SELECT'
        ) AS "canReadChunks",
        has_column_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'error_message',
          'SELECT'
        ) AS "canReadQueueContent"
    `;
    expect(boundary).toEqual({
      canInsert: false,
      canDelete: false,
      canReadVersions: false,
      canReadChunks: false,
      canReadQueueContent: false,
    });
  });

  it('keeps pre-auth login throttle buckets opaque and exclusive to the auth role', async () => {
    const [boundary] = await prisma.$queryRaw<
      Array<{
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        authPolicyCount: number;
        authCanSelect: boolean;
        authCanWrite: boolean;
        appCanSelect: boolean;
        adminCanSelect: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        (
          SELECT count(*)::int
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'auth_login_rate_limits'
            AND policyname = 'enterprise_agent_auth_access'
            AND roles = ARRAY['enterprise_agent_auth']::name[]
        ) AS "authPolicyCount",
        has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'SELECT') AS "authCanSelect",
        (
          has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'INSERT')
          AND has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'UPDATE')
          AND has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'DELETE')
        ) AS "authCanWrite",
        has_table_privilege('enterprise_agent_app', 'public.auth_login_rate_limits', 'SELECT') AS "appCanSelect",
        has_table_privilege('enterprise_agent_admin', 'public.auth_login_rate_limits', 'SELECT') AS "adminCanSelect"
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'auth_login_rate_limits'
    `;

    expect(boundary).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      authPolicyCount: 1,
      authCanSelect: true,
      authCanWrite: true,
      appCanSelect: false,
      adminCanSelect: false,
    });
  });

  it('forces tenant isolation for admin invitation access while keeping opaque lookup in the auth role', async () => {
    const tokenId = '00000000-0000-7000-8000-0000000008a1';
    const tokenHash = 'a'.repeat(64);
    await prisma.authActionToken.create({
      data: {
        id: tokenId,
        tenantId,
        userId: '00000000-0000-7000-8000-000000000101',
        purpose: 'PASSWORD_RESET',
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      const [boundary] = await prisma.$queryRaw<
        Array<{
          rowSecurity: boolean;
          forceRowSecurity: boolean;
          authCanWrite: boolean;
          adminCanWrite: boolean;
          appCanSelect: boolean;
        }>
      >`
        SELECT
          relation.relrowsecurity AS "rowSecurity",
          relation.relforcerowsecurity AS "forceRowSecurity",
          (
            has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'SELECT')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'INSERT')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'UPDATE')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'DELETE')
          ) AS "authCanWrite",
          (
            has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'SELECT')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'INSERT')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'UPDATE')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'DELETE')
          ) AS "adminCanWrite",
          has_table_privilege('enterprise_agent_app', 'public.auth_action_tokens', 'SELECT') AS "appCanSelect"
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'auth_action_tokens'
      `;
      expect(boundary).toEqual({
        rowSecurity: true,
        forceRowSecurity: true,
        authCanWrite: true,
        adminCanWrite: true,
        appCanSelect: false,
      });

      const withoutContext = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        return transaction.authActionToken.count();
      });
      const wrongTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return transaction.authActionToken.count();
      });
      const ownTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return transaction.authActionToken.count({ where: { id: tokenId } });
      });
      expect({ withoutContext, wrongTenant, ownTenant }).toEqual({
        withoutContext: 0,
        wrongTenant: 0,
        ownTenant: 1,
      });
    } finally {
      await prisma.authActionToken.deleteMany({ where: { id: tokenId } });
    }
  });

  it('tenant-isolates Feishu integration state for the admin database role', async () => {
    const organization = await prisma.organization.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });
    const integrationId = '00000000-0000-7000-8000-0000000008f1';
    await prisma.directoryIntegration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'FEISHU' } },
      create: {
        id: integrationId,
        tenantId,
        organizationId: organization.id,
        provider: 'FEISHU',
      },
      update: {},
    });
    try {
      const withoutContext = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        return transaction.directoryIntegration.count();
      });
      const wrongTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return transaction.directoryIntegration.count();
      });
      const ownTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return transaction.directoryIntegration.count();
      });
      expect({ withoutContext, wrongTenant, ownTenant }).toEqual({
        withoutContext: 0,
        wrongTenant: 0,
        ownTenant: 1,
      });
    } finally {
      await prisma.directoryIntegration.deleteMany({ where: { id: integrationId, tenantId } });
    }
  });

  it('denies the API role migration metadata and catalog writes', async () => {
    const migrationMetadata = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations');
      }),
    );
    const catalogWrite = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ${tenantId}::uuid
        `;
      }),
    );

    expect(migrationMetadata).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
    expect(catalogWrite).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
  });

  it('limits the provisioner to tenant catalog data', async () => {
    const visibleTenantCount = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_provisioner');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return transaction.tenant.count();
    });
    const conversationRead = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_provisioner');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRawUnsafe('SELECT count(*) FROM conversations');
      }),
    );

    expect(visibleTenantCount).toBe(1);
    expect(conversationRead).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
  });

  it('rejects a message whose sender is not an active participant', async () => {
    const rejectedMessage = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO conversations (
            id, tenant_id, direct_key, created_by_id, updated_at
          ) VALUES (
            '00000000-0000-7000-8000-000000000899'::uuid,
            ${tenantId}::uuid,
            'inactive-sender-negative-test',
            '00000000-0000-7000-8000-000000000101'::uuid,
            CURRENT_TIMESTAMP
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO conversation_participants (
            id, tenant_id, conversation_id, type, participant_key, user_id, display_name
          ) VALUES (
            '00000000-0000-7000-8000-000000000898'::uuid,
            ${tenantId}::uuid,
            '00000000-0000-7000-8000-000000000899'::uuid,
            'USER',
            'user:00000000-0000-7000-8000-000000000101',
            '00000000-0000-7000-8000-000000000101'::uuid,
            'Active participant'
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO messages (
            id,
            tenant_id,
            conversation_id,
            sender_type,
            sender_user_id,
            sender_key,
            sender_name,
            client_message_id,
            content
          ) VALUES (
            '00000000-0000-7000-8000-000000000897'::uuid,
            ${tenantId}::uuid,
            '00000000-0000-7000-8000-000000000899'::uuid,
            'USER',
            '00000000-0000-7000-8000-000000000102'::uuid,
            'user:00000000-0000-7000-8000-000000000102',
            'Not a participant',
            'inactive-sender-negative-test',
            '{"type":"text","text":"must be rejected"}'::jsonb
          )
        `;
      }),
    );

    expect(rejectedMessage).toMatchObject({
      prismaCode: 'P2010',
      sqlState: '23514',
    });
    expect(rejectedMessage.databaseMessage).toContain(
      'message sender is not an active conversation participant',
    );
  });

  it('uses tenant_id in every business foreign key, including message senders', async () => {
    const constraints = await prisma.$queryRaw<
      Array<{ constraintName: string; definition: string }>
    >(Prisma.sql`
      SELECT
        constraint_name.conname AS "constraintName",
        pg_get_constraintdef(constraint_name.oid) AS definition
      FROM pg_constraint AS constraint_name
      WHERE constraint_name.contype = 'f'
        AND constraint_name.conname IN (${Prisma.join(tenantScopedForeignKeys)})
      ORDER BY constraint_name.conname
    `);

    expect(constraints.map(({ constraintName }) => constraintName)).toEqual(
      [...tenantScopedForeignKeys].sort(),
    );
    for (const { definition } of constraints) {
      const normalized = definition.replaceAll('"', '');
      const columns = normalized.match(
        /^FOREIGN KEY\s+\(([^)]+)\)\s+REFERENCES\s+[^(]+\(([^)]+)\)/,
      );
      expect(columns).not.toBeNull();

      const localColumns = columns?.[1]?.split(', ').map((column) => column.trim()) ?? [];
      const referencedColumns = columns?.[2]?.split(', ').map((column) => column.trim()) ?? [];
      expect(localColumns[0]).toBe('tenant_id');
      expect(referencedColumns[0]).toBe('tenant_id');
      expect(localColumns).toHaveLength(referencedColumns.length);
    }
  });

  it('uses the full knowledge-base document identity in every version and chunk foreign key', async () => {
    const constraints = await prisma.$queryRaw<
      Array<{ constraintName: string; definition: string }>
    >(Prisma.sql`
      SELECT
        constraint_name.conname AS "constraintName",
        pg_get_constraintdef(constraint_name.oid) AS definition
      FROM pg_constraint AS constraint_name
      WHERE constraint_name.contype = 'f'
        AND constraint_name.conname IN (${Prisma.join(Object.keys(knowledgeIdentityForeignKeys))})
      ORDER BY constraint_name.conname
    `);

    expect(constraints).toHaveLength(Object.keys(knowledgeIdentityForeignKeys).length);
    for (const { constraintName, definition } of constraints) {
      const expected =
        knowledgeIdentityForeignKeys[constraintName as keyof typeof knowledgeIdentityForeignKeys];
      expect(expected).toBeDefined();
      const columns = definition
        .replaceAll('"', '')
        .match(/^FOREIGN KEY\s+\(([^)]+)\)\s+REFERENCES\s+[^(]+\(([^)]+)\)/);
      expect(columns).not.toBeNull();
      expect(splitConstraintColumns(columns?.[1])).toEqual(expected.local);
      expect(splitConstraintColumns(columns?.[2])).toEqual(expected.referenced);
    }
  });

  it('rejects a version that labels a document with another knowledge base in the same tenant', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO knowledge_document_versions (
            id, tenant_id, knowledge_base_id, document_id, version_number,
            source_type, content_text, created_by_id
          ) VALUES (
            '00000000-0000-7000-8000-00000000d901'::uuid,
            ${tenantId}::uuid,
            ${fixture.knowledgeBaseBId}::uuid,
            ${fixture.documentAId}::uuid,
            2,
            'TEXT',
            'must be rejected',
            ${fixture.userId}::uuid
          )
        `;
        throw new Error('Expected the cross-knowledge-base version insert to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_document_versions_document_fkey');
  });

  it('rejects a current version that belongs to another knowledge-base document', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          UPDATE knowledge_documents
          SET current_version_id = ${fixture.versionBId}::uuid
          WHERE tenant_id = ${tenantId}::uuid
            AND id = ${fixture.documentAId}::uuid
        `;
        throw new Error('Expected the cross-document current version update to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_documents_current_version_fkey');
  });

  it('rejects a chunk whose knowledge base disagrees with its document and version', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO knowledge_chunks (
            id, tenant_id, knowledge_base_id, document_id, document_version_id,
            chunk_index, content, token_count, content_hash
          ) VALUES (
            '00000000-0000-7000-8000-00000000d902'::uuid,
            ${tenantId}::uuid,
            ${fixture.knowledgeBaseBId}::uuid,
            ${fixture.documentAId}::uuid,
            ${fixture.versionAId}::uuid,
            0,
            'must be rejected',
            3,
            ${'c'.repeat(64)}
          )
        `;
        throw new Error('Expected the cross-knowledge-base chunk insert to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_chunks_document_fkey');
  });

  it('allows only one active ingestion job per version', async () => {
    const [index] = await prisma.$queryRaw<Array<{ unique: boolean; predicate: string | null }>>`
      SELECT
        definition.indisunique AS unique,
        pg_get_expr(definition.indpred, definition.indrelid) AS predicate
      FROM pg_index AS definition
      JOIN pg_class AS index_relation ON index_relation.oid = definition.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_relation.relname = 'knowledge_ingestion_jobs_active_version_key'
    `;
    expect(index?.unique).toBe(true);
    expect(index?.predicate).toContain("'PENDING'");
    expect(index?.predicate).toContain("'RUNNING'");

    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d601'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'PENDING'::"KnowledgeIngestionStatus"
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d602'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'PENDING'::"KnowledgeIngestionStatus"
          )
        `;
        throw new Error('Expected the duplicate active ingestion job to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23505' });
  });

  it('rejects a running ingestion job without an owned lease', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d603'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'RUNNING'::"KnowledgeIngestionStatus"
          )
        `;
        throw new Error('Expected the unleased running ingestion job to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
    expect(rejected.databaseMessage).toContain('knowledge_ingestion_jobs_claim_state_check');
  });

  it('tenant-isolates knowledge versions, chunks, and ingestion jobs across two real tenants', async () => {
    let observation:
      | {
          totalVersions: number;
          totalChunks: number;
          totalJobs: number;
          appVersionTenantIds: string[];
          appChunkTenantIds: string[];
          adminJobTenantIds: string[];
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_KNOWLEDGE_RLS_FIXTURE');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const fixture = await createTwoTenantKnowledgeFixture(transaction);
          const totals = {
            totalVersions: await transaction.knowledgeDocumentVersion.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalChunks: await transaction.knowledgeChunk.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalJobs: await transaction.knowledgeIngestionJob.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
          };

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const appVersions = await transaction.knowledgeDocumentVersion.findMany({
            select: { tenantId: true },
          });
          const appChunks = await transaction.knowledgeChunk.findMany({
            select: { tenantId: true },
          });

          await transaction.$executeRawUnsafe('RESET ROLE');
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const adminJobs = await transaction.knowledgeIngestionJob.findMany({
            select: { tenantId: true },
          });
          observation = {
            ...totals,
            appVersionTenantIds: appVersions.map((row) => row.tenantId),
            appChunkTenantIds: appChunks.map((row) => row.tenantId),
            adminJobTenantIds: adminJobs.map((row) => row.tenantId),
          };
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      totalVersions: 2,
      totalChunks: 2,
      totalJobs: 2,
      appVersionTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      appChunkTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      adminJobTenantIds: ['00000000-0000-7000-8000-00000000c001'],
    });
  });

  it('tenant-isolates semantic embeddings across two real tenants', async () => {
    let observation:
      | {
          total: number;
          visibleTenantIds: string[];
          visibleChunkIds: string[];
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_KNOWLEDGE_EMBEDDING_RLS_FIXTURE');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const fixture = await createTwoTenantKnowledgeFixture(transaction);
          for (const [index, tenantId] of fixture.tenantIds.entries()) {
            await transaction.$executeRaw`
              INSERT INTO public."knowledge_chunk_embeddings" (
                "tenant_id", "chunk_id", "embedding_model", "embedding_dimension",
                "content_hash", "embedding"
              ) VALUES (
                ${tenantId}::uuid,
                ${fixture.chunkIds[index]}::uuid,
                'rls-test-embedding-model',
                1536,
                ${String(index === 0 ? 'a' : 'b').repeat(64)},
                ${unitVectorLiteral(index)}::vector
              )
            `;
          }
          const [totalRow] = await transaction.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM public."knowledge_chunk_embeddings"
            WHERE "tenant_id" IN (${fixture.tenantAId}::uuid, ${fixture.tenantBId}::uuid)
          `;

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const visible = await transaction.$queryRaw<Array<{ tenantId: string; chunkId: string }>>`
            SELECT "tenant_id"::text AS "tenantId", "chunk_id"::text AS "chunkId"
            FROM public."knowledge_chunk_embeddings"
            ORDER BY "chunk_id"
          `;
          observation = {
            total: totalRow?.count ?? 0,
            visibleTenantIds: visible.map((row) => row.tenantId),
            visibleChunkIds: visible.map((row) => row.chunkId),
          };
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      total: 2,
      visibleTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      visibleChunkIds: ['00000000-0000-7000-8000-00000000c501'],
    });
  });

  it('rejects a semantic embedding whose chunk belongs to another tenant', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantKnowledgeFixture(transaction);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_chunk_embeddings" (
            "tenant_id", "chunk_id", "embedding_model", "embedding_dimension",
            "content_hash", "embedding"
          ) VALUES (
            ${fixture.tenantAId}::uuid,
            ${fixture.chunkIds[1]}::uuid,
            'cross-tenant-negative-test',
            1536,
            ${'c'.repeat(64)},
            ${unitVectorLiteral(0)}::vector
          )
        `;
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_chunk_embeddings_chunk_fkey');
  });

  it('tenant-isolates answer-feedback reads and updates across two real tenants', async () => {
    let observation:
      | {
          total: number;
          visibleTenantIds: string[];
          crossTenantUpdates: number;
          ownTenantUpdates: number;
          ownRating: string | undefined;
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_ANSWER_FEEDBACK_RLS_FIXTURE');

    await expect(
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const total = await transaction.answerFeedback.count({
          where: { tenantId: { in: [fixture.tenantAId, fixture.tenantBId] } },
        });

        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
        const visible = await transaction.answerFeedback.findMany({
          select: { tenantId: true },
          orderBy: { tenantId: 'asc' },
        });
        const crossTenant = await transaction.answerFeedback.updateMany({
          where: { tenantId: fixture.tenantBId },
          data: { rating: 'HELPFUL', reason: null },
        });
        const ownTenant = await transaction.answerFeedback.updateMany({
          where: { tenantId: fixture.tenantAId },
          data: { rating: 'NOT_HELPFUL', reason: 'OTHER', comment: 'tenant A update' },
        });
        const own = await transaction.answerFeedback.findFirst({
          where: { tenantId: fixture.tenantAId },
          select: { rating: true },
        });
        observation = {
          total,
          visibleTenantIds: visible.map((row) => row.tenantId),
          crossTenantUpdates: crossTenant.count,
          ownTenantUpdates: ownTenant.count,
          ownRating: own?.rating,
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      total: 2,
      visibleTenantIds: ['00000000-0000-7000-8000-00000000e001'],
      crossTenantUpdates: 0,
      ownTenantUpdates: 1,
      ownRating: 'NOT_HELPFUL',
    });
  });

  it('enforces one answer feedback per tenant/message/user and tenant-scoped parents', async () => {
    const duplicate = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const existing = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantAId },
        });
        await transaction.answerFeedback.create({
          data: {
            tenantId: existing.tenantId,
            messageId: existing.messageId,
            userId: existing.userId,
            rating: 'HELPFUL',
          },
        });
      }),
    );
    expect(duplicate).toMatchObject({ prismaCode: 'P2002' });

    const crossTenantParent = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const tenantAFeedback = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantAId },
        });
        const tenantBFeedback = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantBId },
        });
        await transaction.$executeRaw`
          INSERT INTO answer_feedbacks (
            tenant_id, message_id, user_id, rating
          ) VALUES (
            ${fixture.tenantAId}::uuid,
            ${tenantBFeedback.messageId}::uuid,
            ${tenantAFeedback.userId}::uuid,
            'HELPFUL'
          )
        `;
      }),
    );
    expect(crossTenantParent).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(crossTenantParent.databaseMessage).toContain(
      'answer_feedbacks_tenant_id_message_id_fkey',
    );
  });

  it('makes a cross-tenant parent indistinguishable from a missing parent', async () => {
    const attemptInsert = async (createOtherTenantParent: boolean) => {
      try {
        await prisma.$transaction(async (transaction) => {
          if (createOtherTenantParent) {
            // This setup runs as the local migration login. The failing insert
            // below runs only after demotion to the restricted application role.
            // The rejected transaction rolls all setup back automatically.
            await transaction.tenant.create({
              data: {
                id: otherTenantId,
                slug: 'foreign-key-negative-test',
                name: 'Foreign key negative test',
              },
            });
            await transaction.user.create({
              data: {
                id: otherTenantUserId,
                tenantId: otherTenantId,
                email: 'foreign-key-negative@example.test',
                emailNormalized: 'foreign-key-negative@example.test',
                displayName: 'Foreign tenant user',
              },
            });
          }

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await transaction.$executeRaw`
            INSERT INTO conversations (
              id,
              tenant_id,
              direct_key,
              created_by_id,
              updated_at
            ) VALUES (
              '00000000-0000-7000-8000-000000000809'::uuid,
              ${tenantId}::uuid,
              'foreign-key-negative-test',
              ${otherTenantUserId}::uuid,
              CURRENT_TIMESTAMP
            )
          `;
        });
      } catch (error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
        const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
        return {
          prismaCode: error.code,
          sqlState: String(metadata?.code),
          databaseMessage: String(metadata?.message),
        };
      }
      throw new Error('Expected the tenant-scoped foreign key to reject the insert.');
    };

    const crossTenant = await attemptInsert(true);
    const missing = await attemptInsert(false);

    expect(crossTenant).toEqual(missing);
    expect(crossTenant).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(crossTenant.databaseMessage).toContain('conversations_tenant_id_created_by_id_fkey');
    await expect(prisma.tenant.count({ where: { id: otherTenantId } })).resolves.toBe(0);
  });

  async function captureDatabaseError(
    operation: () => Promise<unknown>,
  ): Promise<{ prismaCode: string; sqlState: string; databaseMessage: string }> {
    try {
      await operation();
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
      return {
        prismaCode: error.code,
        sqlState: String(metadata?.code),
        databaseMessage: String(metadata?.message),
      };
    }
    throw new Error('Expected the database operation to be denied.');
  }
});

function splitConstraintColumns(value: string | undefined): string[] {
  return value?.split(',').map((column) => column.trim()) ?? [];
}

async function createKnowledgeIdentityFixture(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<{
  userId: string;
  knowledgeBaseAId: string;
  knowledgeBaseBId: string;
  documentAId: string;
  documentBId: string;
  versionAId: string;
  versionBId: string;
}> {
  const userId = '00000000-0000-7000-8000-000000000101';
  const knowledgeBaseAId = '00000000-0000-7000-8000-00000000d101';
  const knowledgeBaseBId = '00000000-0000-7000-8000-00000000d102';
  const documentAId = '00000000-0000-7000-8000-00000000d201';
  const documentBId = '00000000-0000-7000-8000-00000000d202';
  const versionAId = '00000000-0000-7000-8000-00000000d301';
  const versionBId = '00000000-0000-7000-8000-00000000d302';

  await transaction.knowledgeBase.createMany({
    data: [
      {
        id: knowledgeBaseAId,
        tenantId,
        key: 'knowledge-identity-negative-a',
        name: 'Knowledge identity negative A',
        status: 'ACTIVE',
        createdById: userId,
      },
      {
        id: knowledgeBaseBId,
        tenantId,
        key: 'knowledge-identity-negative-b',
        name: 'Knowledge identity negative B',
        status: 'ACTIVE',
        createdById: userId,
      },
    ],
  });
  await transaction.knowledgeDocument.createMany({
    data: [
      {
        id: documentAId,
        tenantId,
        knowledgeBaseId: knowledgeBaseAId,
        title: 'Knowledge identity document A',
        sourceType: 'TEXT',
        status: 'READY',
        createdById: userId,
      },
      {
        id: documentBId,
        tenantId,
        knowledgeBaseId: knowledgeBaseBId,
        title: 'Knowledge identity document B',
        sourceType: 'TEXT',
        status: 'READY',
        createdById: userId,
      },
    ],
  });
  await transaction.knowledgeDocumentVersion.createMany({
    data: [
      {
        id: versionAId,
        tenantId,
        knowledgeBaseId: knowledgeBaseAId,
        documentId: documentAId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Knowledge identity content A',
        status: 'READY',
        createdById: userId,
      },
      {
        id: versionBId,
        tenantId,
        knowledgeBaseId: knowledgeBaseBId,
        documentId: documentBId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Knowledge identity content B',
        status: 'READY',
        createdById: userId,
      },
    ],
  });

  return {
    userId,
    knowledgeBaseAId,
    knowledgeBaseBId,
    documentAId,
    documentBId,
    versionAId,
    versionBId,
  };
}

async function createTwoTenantKnowledgeFixture(
  transaction: Prisma.TransactionClient,
): Promise<{ tenantAId: string; tenantBId: string; tenantIds: string[]; chunkIds: string[] }> {
  const tenantAId = '00000000-0000-7000-8000-00000000c001';
  const tenantBId = '00000000-0000-7000-8000-00000000c002';
  const tenantIds = [tenantAId, tenantBId];
  const userIds = ['00000000-0000-7000-8000-00000000c101', '00000000-0000-7000-8000-00000000c102'];
  const knowledgeBaseIds = [
    '00000000-0000-7000-8000-00000000c201',
    '00000000-0000-7000-8000-00000000c202',
  ];
  const documentIds = [
    '00000000-0000-7000-8000-00000000c301',
    '00000000-0000-7000-8000-00000000c302',
  ];
  const versionIds = [
    '00000000-0000-7000-8000-00000000c401',
    '00000000-0000-7000-8000-00000000c402',
  ];
  const chunkIds = ['00000000-0000-7000-8000-00000000c501', '00000000-0000-7000-8000-00000000c502'];
  const jobIds = ['00000000-0000-7000-8000-00000000c601', '00000000-0000-7000-8000-00000000c602'];

  await transaction.tenant.createMany({
    data: tenantIds.map((id, index) => ({
      id,
      slug: `knowledge-rls-fixture-${index + 1}`,
      name: `Knowledge RLS fixture ${index + 1}`,
    })),
  });
  await transaction.user.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: userIds[index]!,
      tenantId,
      email: `owner-${index + 1}@knowledge-rls.test`,
      emailNormalized: `owner-${index + 1}@knowledge-rls.test`,
      displayName: `Knowledge RLS owner ${index + 1}`,
      role: 'OWNER' as const,
    })),
  });
  await transaction.knowledgeBase.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: knowledgeBaseIds[index]!,
      tenantId,
      key: 'knowledge-rls-fixture',
      name: `Knowledge RLS base ${index + 1}`,
      status: 'ACTIVE' as const,
      createdById: userIds[index]!,
    })),
  });
  await transaction.knowledgeDocument.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: documentIds[index]!,
      tenantId,
      knowledgeBaseId: knowledgeBaseIds[index]!,
      title: `Knowledge RLS document ${index + 1}`,
      sourceType: 'TEXT' as const,
      contentText: `tenant ${index + 1}`,
      status: 'READY' as const,
      documentVersion: 1,
      createdById: userIds[index]!,
    })),
  });
  await transaction.knowledgeDocumentVersion.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: versionIds[index]!,
      tenantId,
      knowledgeBaseId: knowledgeBaseIds[index]!,
      documentId: documentIds[index]!,
      versionNumber: 1,
      sourceType: 'TEXT' as const,
      contentText: `tenant ${index + 1}`,
      status: 'READY' as const,
      createdById: userIds[index]!,
    })),
  });
  for (const [index, tenantId] of tenantIds.entries()) {
    await transaction.knowledgeDocument.update({
      where: { id: documentIds[index]! },
      data: { currentVersionId: versionIds[index]! },
    });
    await transaction.knowledgeChunk.create({
      data: {
        id: chunkIds[index]!,
        tenantId,
        knowledgeBaseId: knowledgeBaseIds[index]!,
        documentId: documentIds[index]!,
        documentVersionId: versionIds[index]!,
        chunkIndex: 0,
        content: `tenant ${index + 1}`,
        tokenCount: 2,
        contentHash: (index === 0 ? 'a' : 'b').repeat(64),
      },
    });
    await transaction.knowledgeIngestionJob.create({
      data: {
        id: jobIds[index]!,
        tenantId,
        documentVersionId: versionIds[index]!,
        stage: 'READY',
        status: 'SUCCEEDED',
        progress: 100,
        attempts: 1,
      },
    });
  }

  return { tenantAId, tenantBId, tenantIds, chunkIds };
}

function unitVectorLiteral(nonZeroIndex: number): string {
  return `[${Array.from({ length: 1_536 }, (_, index) => (index === nonZeroIndex ? '1' : '0')).join(',')}]`;
}

async function createTwoTenantAnswerFeedbackFixture(
  transaction: Prisma.TransactionClient,
): Promise<{ tenantAId: string; tenantBId: string }> {
  const tenantIds = [
    '00000000-0000-7000-8000-00000000e001',
    '00000000-0000-7000-8000-00000000e002',
  ];
  const userIds = ['00000000-0000-7000-8000-00000000e101', '00000000-0000-7000-8000-00000000e102'];
  const conversationIds = [
    '00000000-0000-7000-8000-00000000e201',
    '00000000-0000-7000-8000-00000000e202',
  ];
  const participantIds = [
    '00000000-0000-7000-8000-00000000e301',
    '00000000-0000-7000-8000-00000000e302',
  ];
  const messageIds = [
    '00000000-0000-7000-8000-00000000e401',
    '00000000-0000-7000-8000-00000000e402',
  ];

  await transaction.tenant.createMany({
    data: tenantIds.map((id, index) => ({
      id,
      slug: `answer-feedback-rls-${index + 1}`,
      name: `Answer feedback RLS ${index + 1}`,
    })),
  });
  await transaction.user.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: userIds[index]!,
      tenantId,
      email: `answer-feedback-${index + 1}@rls.test`,
      emailNormalized: `answer-feedback-${index + 1}@rls.test`,
      displayName: `Feedback user ${index + 1}`,
    })),
  });
  await transaction.conversation.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: conversationIds[index]!,
      tenantId,
      directKey: `answer-feedback-rls-${index + 1}`,
      createdById: userIds[index]!,
    })),
  });
  await transaction.conversationParticipant.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: participantIds[index]!,
      tenantId,
      conversationId: conversationIds[index]!,
      type: 'USER' as const,
      participantKey: `user:${userIds[index]!}`,
      userId: userIds[index]!,
      displayName: `Feedback user ${index + 1}`,
    })),
  });
  await transaction.message.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: messageIds[index]!,
      tenantId,
      conversationId: conversationIds[index]!,
      senderType: 'USER' as const,
      senderUserId: userIds[index]!,
      senderKey: `user:${userIds[index]!}`,
      senderName: `Feedback user ${index + 1}`,
      clientMessageId: `answer-feedback-rls-${index + 1}`,
      content: { type: 'text', text: `feedback fixture ${index + 1}` },
    })),
  });
  await transaction.answerFeedback.createMany({
    data: tenantIds.map((tenantId, index) => ({
      tenantId,
      messageId: messageIds[index]!,
      userId: userIds[index]!,
      rating: 'HELPFUL' as const,
    })),
  });

  return { tenantAId: tenantIds[0]!, tenantBId: tenantIds[1]! };
}
