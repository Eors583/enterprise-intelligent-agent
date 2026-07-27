GRANT SELECT, INSERT, UPDATE ON TABLE agent_templates TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE agent_versions TO enterprise_agent_admin;

-- Existing tenants may already have synchronized directory members from before
-- personal-agent provisioning was introduced. Seed the tenant-local template and
-- published version once so those members become contactable without rebinding Feishu.
INSERT INTO agent_templates (id, tenant_id, key, name, description, created_at, updated_at)
SELECT
  gen_random_uuid(),
  tenant.id,
  'personal-work-assistant',
  '个人工作助手',
  '企业成员的个人工作智能体模板。',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM tenants AS tenant
WHERE EXISTS (
  SELECT 1 FROM directory_user_bindings AS binding WHERE binding.tenant_id = tenant.id
)
AND NOT EXISTS (
  SELECT 1
  FROM agent_templates AS template
  WHERE template.tenant_id = tenant.id AND template.key = 'personal-work-assistant'
);

INSERT INTO agent_versions (
  id,
  tenant_id,
  template_id,
  version,
  status,
  system_prompt,
  model_policy,
  tool_policy,
  knowledge_scope,
  published_at,
  created_at
)
SELECT
  gen_random_uuid(),
  template.tenant_id,
  template.id,
  COALESCE((SELECT MAX(existing.version) FROM agent_versions AS existing WHERE existing.template_id = template.id), 0) + 1,
  'PUBLISHED',
  '你是该企业成员的个人工作智能体。仅在租户权限和用户授权范围内提供工作协助；回答应准确、简洁，不得泄露其他成员或租户的数据。',
  '{"route":"default"}'::jsonb,
  '{"allow":[]}'::jsonb,
  '{"mode":"owner-authorized"}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM agent_templates AS template
WHERE template.key = 'personal-work-assistant'
AND EXISTS (
  SELECT 1 FROM directory_user_bindings AS binding WHERE binding.tenant_id = template.tenant_id
)
AND NOT EXISTS (
  SELECT 1
  FROM agent_versions AS version
  WHERE version.template_id = template.id AND version.status = 'PUBLISHED'
);

INSERT INTO agent_instances (
  id,
  tenant_id,
  key,
  version_id,
  owner_user_id,
  created_by_id,
  name,
  summary,
  status,
  settings,
  created_at,
  updated_at
)
SELECT DISTINCT ON (member.tenant_id, member.id)
  gen_random_uuid(),
  member.tenant_id,
  CONCAT('feishu-personal-', member.id),
  version.id,
  member.id,
  creator.id,
  CONCAT(member.display_name, '的智能体'),
  CONCAT('可在企业授权范围内代表 ', member.display_name, ' 提供工作协助。'),
  'ONLINE',
  '{"visibility":"tenant","provisionedBy":"feishu-directory"}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM directory_user_bindings AS binding
JOIN users AS member
  ON member.tenant_id = binding.tenant_id AND member.id = binding.user_id
JOIN agent_templates AS template
  ON template.tenant_id = member.tenant_id AND template.key = 'personal-work-assistant'
JOIN LATERAL (
  SELECT published.id
  FROM agent_versions AS published
  WHERE published.tenant_id = template.tenant_id
    AND published.template_id = template.id
    AND published.status = 'PUBLISHED'
  ORDER BY published.version DESC, published.published_at DESC
  LIMIT 1
) AS version ON TRUE
JOIN LATERAL (
  SELECT candidate.id
  FROM users AS candidate
  WHERE candidate.tenant_id = member.tenant_id
    AND candidate.status = 'ACTIVE'
  ORDER BY
    CASE candidate.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,
    candidate.created_at
  LIMIT 1
) AS creator ON TRUE
WHERE member.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM agent_instances AS existing
    WHERE existing.tenant_id = member.tenant_id AND existing.owner_user_id = member.id
  )
ON CONFLICT (tenant_id, key) DO NOTHING;
