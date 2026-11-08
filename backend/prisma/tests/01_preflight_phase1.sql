-- Read-only. Run BEFORE migration on the disposable upgraded Phase 1 database.
-- Use psql -v ON_ERROR_STOP=1 -f tests/01_preflight_phase1.sql
\set ON_ERROR_STOP on
SELECT current_database() AS database_name, current_schema() AS schema_name, version() AS postgres_version;
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations ORDER BY started_at;
SELECT COUNT(*) AS legacy_payment_count,
       COUNT(*) FILTER (WHERE status = 'SUCCESS') AS legacy_success,
       COUNT(*) FILTER (WHERE status = 'FAILED') AS legacy_failed,
       COUNT(*) FILTER (WHERE jsonb_typeof(response_snapshot) <> 'object') AS invalid_legacy_snapshots
FROM payments;
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
AND indexname IN ('uq_orders_one_active_per_user','uq_payments_one_success_per_order')
ORDER BY indexname;
SELECT conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
WHERE t.relname='payments' ORDER BY conname;
-- IMPORTANT: save count/checksums outside this session, and compare originals after migration.
-- Do NOT run these commands against shared or production databases.
