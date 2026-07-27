function Get-EnterpriseCriticalPrivilegesSql {
  @'
WITH expected_tables(table_name) AS (
  VALUES ('agent_runs'), ('auth_action_tokens'), ('auth_login_rate_limits'), ('outbox_events')
), actual_table_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    table_acl.privilege_type::text AS privilege_type,
    table_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND table_acl.grantee <> target_table.relowner
), expected_table_acl(table_name, grantee, privilege_type, is_grantable) AS (
  VALUES
    ('agent_runs', 'enterprise_agent_app', 'SELECT', false),
    ('agent_runs', 'enterprise_agent_app', 'INSERT', false),
    ('agent_runs', 'enterprise_agent_app', 'UPDATE', false),
    ('agent_runs', 'enterprise_agent_admin', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'INSERT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'UPDATE', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'DELETE', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'INSERT', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'UPDATE', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'DELETE', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'SELECT', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'INSERT', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'UPDATE', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'DELETE', false),
    ('outbox_events', 'enterprise_agent_app', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_app', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_outbox', 'SELECT', false)
), actual_column_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    attribute_definition.attname::text AS column_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    column_acl.privilege_type::text AS privilege_type,
    column_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN pg_attribute attribute_definition ON attribute_definition.attrelid = target_table.oid
  CROSS JOIN LATERAL aclexplode(attribute_definition.attacl) column_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND target_table.relname IN (
      'agent_runs', 'auth_action_tokens', 'auth_login_rate_limits', 'outbox_events', 'employments'
    )
    AND attribute_definition.attnum > 0
    AND NOT attribute_definition.attisdropped
), expected_column_acl(table_name, column_name, grantee, privilege_type, is_grantable) AS (
  VALUES
    ('employments', 'status', 'enterprise_agent_auth', 'UPDATE', false),
    ('employments', 'updated_at', 'enterprise_agent_auth', 'UPDATE', false),
    ('outbox_events', 'status', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'attempts', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'available_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'locked_by', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'locked_until', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'last_error', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'provider_name', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'provider_receipt', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'published_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_events', 'first_attempted_at', 'enterprise_agent_outbox', 'UPDATE', false)
)
SELECT
  (SELECT count(*) FROM expected_tables) = 4
  AND (
    SELECT count(*)
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
    WHERE target_schema.nspname = 'public' AND target_table.relkind = 'r'
  ) = 4
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN (
    'enterprise_agent_app', 'enterprise_agent_auth', 'enterprise_agent_admin', 'enterprise_agent_outbox'
  )) = 4
  AND NOT EXISTS (
    SELECT * FROM actual_table_acl
    EXCEPT
    SELECT * FROM expected_table_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_table_acl
    EXCEPT
    SELECT * FROM actual_table_acl
  )
  AND NOT EXISTS (
    SELECT * FROM actual_column_acl
    EXCEPT
    SELECT * FROM expected_column_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_column_acl
    EXCEPT
    SELECT * FROM actual_column_acl
  );
'@
}

function Get-EnterpriseAuthActionTokenAclSql {
  @'
WITH target AS (
  SELECT target_table.oid, target_table.relowner, target_table.relacl
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public' AND target_table.relname = 'auth_action_tokens'
), actual_acl AS (
  SELECT acl.grantee, acl.privilege_type::text AS privilege_type, acl.is_grantable
  FROM target
  CROSS JOIN LATERAL aclexplode(COALESCE(target.relacl, acldefault('r', target.relowner))) acl
  WHERE acl.grantee <> target.relowner
), expected_acl AS (
  SELECT role_definition.oid AS grantee, expected_privilege.privilege_type, false AS is_grantable
  FROM pg_roles role_definition
  CROSS JOIN (VALUES ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text))
    expected_privilege(privilege_type)
  WHERE role_definition.rolname IN ('enterprise_agent_auth', 'enterprise_agent_admin')
)
SELECT
  (SELECT count(*) FROM target) = 1
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('enterprise_agent_auth', 'enterprise_agent_admin')) = 2
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM actual_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM expected_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute_definition
    WHERE attribute_definition.attrelid = 'public.auth_action_tokens'::regclass
      AND attribute_definition.attnum > 0
      AND NOT attribute_definition.attisdropped
      AND COALESCE(cardinality(attribute_definition.attacl), 0) > 0
  );
'@
}

function Get-EnterpriseCapabilityRoleHardeningSql {
  @'
WITH capability_roles AS (
  SELECT * FROM pg_roles
  WHERE rolname IN (
    'enterprise_agent_app',
    'enterprise_agent_auth',
    'enterprise_agent_admin',
    'enterprise_agent_outbox',
    'enterprise_agent_provisioner'
  )
)
SELECT
  (SELECT count(*) FROM capability_roles) = 5
  AND (SELECT bool_and(
    NOT rolsuper
    AND NOT rolinherit
    AND NOT rolcreaterole
    AND NOT rolcreatedb
    AND NOT rolcanlogin
    AND NOT rolreplication
    AND NOT rolbypassrls
  ) FROM capability_roles)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN capability_roles member_role ON member_role.oid = role_membership.member
  )
  AND NOT EXISTS (
    SELECT login_role.oid
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN pg_roles login_role ON login_role.oid = role_membership.member
    WHERE login_role.rolcanlogin
      AND login_role.rolname <> current_user
    GROUP BY login_role.oid
    HAVING count(DISTINCT granted_role.oid) > 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN pg_roles login_role ON login_role.oid = role_membership.member
    WHERE login_role.rolcanlogin
      AND login_role.rolname <> current_user
      AND (login_role.rolsuper OR login_role.rolbypassrls)
  );
'@
}

function Get-EnterpriseTenantRlsIntegritySql {
  @'
WITH expected(table_name, tenant_column, role_names) AS (
  VALUES
    ('agent_instances', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_runs', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_templates', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('answer_feedbacks', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('audit_events', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('auth_action_tokens', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('auth_sessions', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('conversation_participants', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('conversations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('directory_employment_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_integrations', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_org_unit_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_user_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('employments', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_base_org_units', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_bases', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_chunk_embeddings', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_chunks', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_document_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_documents', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_ingestion_jobs', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('manager_relations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('messages', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('org_units', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('organizations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('outbox_events', 'tenant_id', ARRAY['enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('password_credentials', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('positions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('tenants', 'id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('users', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[])
)
SELECT
  (SELECT count(*) FROM expected) = 31
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_policy
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relkind = 'r'
        AND target_table.relname = expected_policy.table_name
        AND target_table.relrowsecurity
        AND target_table.relforcerowsecurity
        AND policy_definition.polname = 'tenant_isolation'
        AND NOT policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = expected_policy.role_names
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = format(
          '(%I = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
          expected_policy.tenant_column
        )
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = format(
          '(%I = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
          expected_policy.tenant_column
        )
    )
  )
  AND (
    SELECT count(*)
    FROM pg_policy policy_definition
    JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    WHERE target_schema.nspname = 'public'
      AND policy_definition.polname = 'tenant_isolation'
  ) = 31
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN pg_attribute tenant_attribute ON tenant_attribute.attrelid = target_table.oid
    WHERE target_schema.nspname = 'public'
      AND target_table.relkind IN ('r', 'p')
      AND tenant_attribute.attname = 'tenant_id'
      AND tenant_attribute.attnum > 0
      AND NOT tenant_attribute.attisdropped
      AND NOT EXISTS (
        SELECT 1 FROM expected expected_policy
        WHERE expected_policy.table_name = target_table.relname
      )
  );
'@
}

function Get-EnterpriseAuthLoginRateLimitBoundarySql {
  @'
SELECT EXISTS (
  SELECT 1
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'auth_login_rate_limits'
    AND target_table.relkind = 'r'
    AND target_table.relrowsecurity
    AND target_table.relforcerowsecurity
    AND (
      SELECT count(*) FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = target_table.oid
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = target_table.oid
        AND policy_definition.polname = 'enterprise_agent_auth_access'
        AND policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = ARRAY['enterprise_agent_auth']::text[]
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = 'true'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = 'true'
    )
);
'@
}

function Get-EnterpriseAuthActionTokenPolicyIntegritySql {
  @'
WITH expected(policy_name, role_names) AS (
  VALUES
    ('auth_action_tokens_admin_access', ARRAY['enterprise_agent_admin']::text[]),
    ('auth_action_tokens_auth_access', ARRAY['enterprise_agent_auth']::text[])
)
SELECT
  (SELECT count(*) FROM pg_policy policy_definition
   WHERE policy_definition.polrelid = 'public.auth_action_tokens'::regclass) = 3
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_policy
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = 'public.auth_action_tokens'::regclass
        AND policy_definition.polname = expected_policy.policy_name
        AND policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = expected_policy.role_names
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = 'true'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = 'true'
    )
  );
'@
}

function Get-EnterpriseAuthActionTokenKeyConstraintsSql {
  @'
SELECT
  EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_pkey'
      AND constraint_definition.contype = 'p'
      AND constraint_definition.convalidated
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_token_hash_key'
      AND constraint_definition.contype = 'u'
      AND constraint_definition.convalidated
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'token_hash')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.tenants'::regclass
      AND constraint_definition.confdeltype = 'r'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.tenants'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_user_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.users'::regclass
      AND constraint_definition.confdeltype = 'c'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'user_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_created_by_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.users'::regclass
      AND constraint_definition.confdeltype = 'r'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'created_by_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'id')
      ]::smallint[]
  );
'@
}

function Get-EnterpriseAuthActionTokenCheckConstraintsSql {
  @'
WITH expected(constraint_name, constraint_definition) AS (
  VALUES
    ('auth_action_tokens_purpose_check',
      'CHECK (purpose::text = ANY (ARRAY[''PASSWORD_RESET''::character varying, ''MEMBER_INVITATION''::character varying]))'),
    ('auth_action_tokens_delivery_status_check',
      'CHECK (delivery_status::text = ANY (ARRAY[''NOT_CONFIGURED''::character varying, ''PENDING''::character varying, ''SENT''::character varying, ''FAILED''::character varying]))'),
    ('auth_action_tokens_delivery_attempts_check', 'CHECK (delivery_attempts >= 0)'),
    ('auth_action_tokens_expiry_check', 'CHECK (expires_at > created_at)'),
    ('auth_action_tokens_terminal_check', 'CHECK (consumed_at IS NULL OR revoked_at IS NULL)'),
    ('auth_action_tokens_consumed_at_check', 'CHECK (consumed_at IS NULL OR consumed_at >= created_at)'),
    ('auth_action_tokens_revoked_at_check', 'CHECK (revoked_at IS NULL OR revoked_at >= created_at)')
)
SELECT
  (SELECT count(*) FROM expected) = 7
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_constraint
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
        AND constraint_definition.conname = expected_constraint.constraint_name
        AND constraint_definition.contype = 'c'
        AND constraint_definition.convalidated
        AND replace(
          replace(
            pg_get_constraintdef(constraint_definition.oid, true),
            '::character varying::text',
            '::character varying'
          ),
          '::text[]',
          ''
        ) = expected_constraint.constraint_definition
    )
  );
'@
}

function Get-EnterpriseAgentRunUsageConstraintsSql {
  @'
WITH expected(constraint_name, constraint_definition) AS (
  VALUES
    ('agent_runs_succeeded_reported_usage_positive_check',
      'CHECK (status <> ''SUCCEEDED''::' || quote_ident('AgentRunStatus') || ' OR usage_recorded_at IS NULL OR total_tokens > 0 AND (input_tokens + output_tokens) > 0)'),
    ('agent_runs_total_tokens_consistent_check',
      'CHECK (total_tokens >= (input_tokens + output_tokens))'),
    ('agent_runs_unverified_tokens_zero_check',
      'CHECK (usage_recorded_at IS NOT NULL OR input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0)'),
    ('agent_runs_unverified_cost_zero_check',
      'CHECK (cost_recorded_at IS NOT NULL OR cost_micros = 0)'),
    ('agent_runs_usage_nonnegative_check',
      'CHECK (input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0 AND tool_calls >= 0 AND cost_micros >= 0 AND reserved_tokens >= 0 AND (latency_ms IS NULL OR latency_ms >= 0))')
)
SELECT
  (SELECT count(*) FROM expected) = 5
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_constraint
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      WHERE constraint_definition.conrelid = 'public.agent_runs'::regclass
        AND constraint_definition.conname = expected_constraint.constraint_name
        AND constraint_definition.contype = 'c'
        AND constraint_definition.convalidated
        AND pg_get_constraintdef(constraint_definition.oid, true) = expected_constraint.constraint_definition
    )
  );
'@
}

function Get-EnterpriseAuthActionTokenActiveIndexSql {
  @'
SELECT EXISTS (
  SELECT 1
  FROM pg_index index_definition
  JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
  JOIN pg_class target_table ON target_table.oid = index_definition.indrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'auth_action_tokens'
    AND index_relation.relname = 'auth_action_tokens_active_user_purpose_key'
    AND index_definition.indisunique
    AND index_definition.indisvalid
    AND index_definition.indisready
    AND index_definition.indislive
    AND NOT index_definition.indisprimary
    AND index_definition.indexprs IS NULL
    AND index_definition.indnkeyatts = 3
    AND index_definition.indnatts = 3
    AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'tenant_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'user_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'purpose')
    ]::smallint[]
    AND regexp_replace(
      lower(pg_get_expr(index_definition.indpred, index_definition.indrelid)),
      '[^a-z_]+',
      '',
      'g'
    ) = 'consumed_atisnullandrevoked_atisnull'
);
'@
}

function Get-EnterpriseAuthActionTokenSupportingIndexesSql {
  @'
SELECT
  EXISTS (
    SELECT 1
    FROM pg_index index_definition
    JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
    WHERE index_definition.indrelid = 'public.auth_action_tokens'::regclass
      AND index_relation.relname = 'auth_action_tokens_tenant_user_purpose_created_idx'
      AND NOT index_definition.indisunique
      AND index_definition.indisvalid
      AND index_definition.indisready
      AND index_definition.indislive
      AND NOT index_definition.indisprimary
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL
      AND index_definition.indnkeyatts = 4
      AND index_definition.indnatts = 4
      AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'user_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'purpose'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'created_at')
      ]::smallint[]
      AND string_to_array(index_definition.indoption::text, ' ')::smallint[] = ARRAY[0, 0, 0, 3]::smallint[]
  )
  AND EXISTS (
    SELECT 1
    FROM pg_index index_definition
    JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
    WHERE index_definition.indrelid = 'public.auth_action_tokens'::regclass
      AND index_relation.relname = 'auth_action_tokens_expires_at_idx'
      AND NOT index_definition.indisunique
      AND index_definition.indisvalid
      AND index_definition.indisready
      AND index_definition.indislive
      AND NOT index_definition.indisprimary
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL
      AND index_definition.indnkeyatts = 1
      AND index_definition.indnatts = 1
      AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'expires_at')
      ]::smallint[]
      AND string_to_array(index_definition.indoption::text, ' ')::smallint[] = ARRAY[0]::smallint[]
  );
'@
}
