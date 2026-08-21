-- The ingestion worker uses updated_at only to rotate work fairly across tenants.
GRANT SELECT (updated_at)
ON TABLE public.knowledge_ingestion_jobs
TO enterprise_agent_outbox;
