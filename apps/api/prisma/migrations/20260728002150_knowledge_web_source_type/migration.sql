-- PostgreSQL does not allow a newly-added enum value to be referenced before
-- the transaction that introduced it commits. Keep this change in its own
-- migration so the following parse-governance migration can safely use WEB.
ALTER TYPE public."KnowledgeSourceType" ADD VALUE IF NOT EXISTS 'WEB';
