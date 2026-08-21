-- The ingestion worker runs under the least-privilege outbox role. New columns
-- are not covered by its existing column-level grants, so explicitly grant only
-- the access required to prioritize and increment real processing failures.
GRANT SELECT (failure_attempts), UPDATE (failure_attempts)
ON TABLE public.knowledge_ingestion_jobs
TO enterprise_agent_outbox;
