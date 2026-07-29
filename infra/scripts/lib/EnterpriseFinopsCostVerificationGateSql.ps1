function Get-EnterpriseFinopsCostVerificationIntegritySql {
  @'
WITH target_table AS (
  SELECT
    table_row.oid,
    table_row.relrowsecurity,
    table_row.relforcerowsecurity
  FROM pg_catalog.pg_class table_row
  JOIN pg_catalog.pg_namespace namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relname = 'finops_cost_verification_reviews'
    AND table_row.relkind = 'r'
), expected_acl(grantee, privilege_type, is_grantable) AS (
  VALUES
    ('enterprise_agent_admin'::text, 'INSERT'::text, false),
    ('enterprise_agent_admin'::text, 'SELECT'::text, false)
), actual_acl AS (
  SELECT
    grantee_role.rolname::text AS grantee,
    acl_entry.privilege_type::text,
    acl_entry.is_grantable
  FROM target_table
  JOIN pg_catalog.pg_class table_row ON table_row.oid = target_table.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(table_row.relacl, acldefault('r', table_row.relowner))
  ) acl_entry
  JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = acl_entry.grantee
  WHERE acl_entry.grantee <> table_row.relowner
), expected_foreign_keys(constraint_name, parent_table) AS (
  VALUES
    ('finops_cost_verification_reviews_tenant_fkey', 'tenants'),
    ('finops_cost_verification_reviews_cost_fkey', 'finops_cost_entries'),
    ('finops_cost_verification_reviews_reviewer_fkey', 'users'),
    ('finops_cost_verification_reviews_evidence_fkey', 'evidence')
), actual_foreign_keys AS (
  SELECT
    constraint_row.conname::text AS constraint_name,
    parent_table.relname::text AS parent_table,
    constraint_row.convalidated
  FROM target_table
  JOIN pg_catalog.pg_constraint constraint_row
    ON constraint_row.conrelid = target_table.oid
   AND constraint_row.contype = 'f'
  JOIN pg_catalog.pg_class parent_table
    ON parent_table.oid = constraint_row.confrelid
), expected_triggers(trigger_name) AS (
  VALUES
    ('finops_prepare_cost_verification_review_trigger'),
    ('finops_cost_verification_reviews_append_only'),
    ('finops_cost_review_budget_alert_projector_trigger')
), actual_triggers AS (
  SELECT trigger_row.tgname::text AS trigger_name
  FROM target_table
  JOIN pg_catalog.pg_trigger trigger_row
    ON trigger_row.tgrelid = target_table.oid
  WHERE NOT trigger_row.tgisinternal
), restrictive_policy AS (
  SELECT
    ARRAY(
      SELECT COALESCE(role_row.rolname, 'PUBLIC')::text
      FROM unnest(policy_row.polroles) assigned_role(role_oid)
      LEFT JOIN pg_catalog.pg_roles role_row ON role_row.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_row.rolname, 'PUBLIC')
    ) AS roles,
    pg_get_expr(policy_row.polqual, policy_row.polrelid) AS using_expression,
    pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) AS check_expression
  FROM target_table
  JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = target_table.oid
  WHERE NOT policy_row.polpermissive
    AND policy_row.polcmd = '*'
), admin_policy AS (
  SELECT count(*) AS policy_count
  FROM target_table
  JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = target_table.oid
  WHERE policy_row.polpermissive
    AND policy_row.polcmd = '*'
    AND ARRAY(
      SELECT role_row.rolname::text
      FROM unnest(policy_row.polroles) assigned_role(role_oid)
      JOIN pg_catalog.pg_roles role_row ON role_row.oid = assigned_role.role_oid
    ) = ARRAY['enterprise_agent_admin']::text[]
), effective_view AS (
  SELECT
    view_row.relkind = 'v' AS present,
    COALESCE(
      (
        SELECT option_value = 'true'
        FROM pg_catalog.pg_options_to_table(view_row.reloptions)
        WHERE option_name = 'security_invoker'
      ),
      false
    ) AS security_invoker
  FROM pg_catalog.pg_class view_row
  JOIN pg_catalog.pg_namespace namespace_row
    ON namespace_row.oid = view_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND view_row.relname = 'finops_effective_cost_verifications'
)
SELECT
  (SELECT count(*) FROM target_table) = 1
  AND (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM target_table)
  AND NOT EXISTS (
    SELECT * FROM actual_acl
    EXCEPT
    SELECT * FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_acl
    EXCEPT
    SELECT * FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT constraint_name, parent_table FROM actual_foreign_keys
    EXCEPT
    SELECT * FROM expected_foreign_keys
  )
  AND NOT EXISTS (
    SELECT * FROM expected_foreign_keys
    EXCEPT
    SELECT constraint_name, parent_table FROM actual_foreign_keys
  )
  AND NOT EXISTS (SELECT 1 FROM actual_foreign_keys WHERE NOT convalidated)
  AND NOT EXISTS (
    SELECT * FROM actual_triggers
    EXCEPT
    SELECT * FROM expected_triggers
  )
  AND NOT EXISTS (
    SELECT * FROM expected_triggers
    EXCEPT
    SELECT * FROM actual_triggers
  )
  AND (
    SELECT roles = ARRAY['PUBLIC']::text[]
      AND using_expression =
        '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
      AND check_expression =
        '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    FROM restrictive_policy
  )
  AND (SELECT policy_count = 1 FROM admin_policy)
  AND (SELECT present AND security_invoker FROM effective_view)
  AND to_regprocedure(
    'public.finops_effective_cost_verification_status(uuid,uuid)'
  ) IS NOT NULL
  AND to_regprocedure(
    'public.finops_prepare_cost_verification_review()'
  ) IS NOT NULL
  AND to_regprocedure(
    'public.finops_cost_review_budget_alert_projector()'
  ) IS NOT NULL;
'@
}
