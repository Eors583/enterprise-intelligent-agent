-- verify_audit_event_chain is SECURITY INVOKER and calls the immutable payload
-- renderer while running as enterprise_agent_admin. Keep the helper private,
-- but grant the exact capability required by the verifier's execution role.

REVOKE ALL ON FUNCTION public.audit_event_chain_payload(
  uuid,
  uuid,
  public."AuditActorType",
  uuid,
  text,
  text,
  uuid,
  jsonb,
  timestamptz,
  bigint,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.audit_event_chain_payload(
  uuid,
  uuid,
  public."AuditActorType",
  uuid,
  text,
  text,
  uuid,
  jsonb,
  timestamptz,
  bigint,
  text
) TO enterprise_agent_admin;
