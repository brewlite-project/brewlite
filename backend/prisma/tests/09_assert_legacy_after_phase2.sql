-- READ ONLY; run ONLY AFTER both SCRUM-76 migrations on brewlite_scrum80_legacy_verify.
\set ON_ERROR_STOP on
DO $check$
DECLARE n integer; ns integer; nf integer; nm integer;
BEGIN
 IF current_database()<>'brewlite_scrum80_legacy_verify' THEN
   RAISE EXCEPTION 'STOP: wrong database %',current_database();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='payments' AND column_name='provider') THEN
   RAISE EXCEPTION 'Phase2 provider column missing';
 END IF;
 SELECT count(*),count(*) FILTER(WHERE status='SUCCESS'),
        count(*) FILTER(WHERE status='FAILED'),count(*) FILTER(WHERE provider='MOCK')
 INTO n,ns,nf,nm FROM payments WHERE id IN(
  '76000000-0000-4000-8000-000000000201'::uuid,
  '76000000-0000-4000-8000-000000000202'::uuid,
  '76000000-0000-4000-8000-000000000203'::uuid
 );
 IF n<>3 OR ns<>1 OR nf<>2 OR nm<>3 THEN
   RAISE EXCEPTION 'Legacy counts/providers wrong: n=% success=% failed=% mock=%',n,ns,nf,nm;
 END IF;
 IF EXISTS(SELECT 1 FROM payments WHERE id IN(
  '76000000-0000-4000-8000-000000000201'::uuid,
  '76000000-0000-4000-8000-000000000202'::uuid,
  '76000000-0000-4000-8000-000000000203'::uuid
 ) AND (updated_at IS NULL OR updated_at<>created_at OR response_snapshot IS NULL
        OR method IS NULL OR reconciliation_state::text<>'NONE'
        OR query_attempts<>0 OR has_financial_exception)) THEN
   RAISE EXCEPTION 'Legacy Mock compatibility/backfill invariants failed';
 END IF;
 IF (SELECT count(*) FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>9 THEN
   RAISE EXCEPTION 'Expected exactly 9 committed Prisma migrations';
 END IF;
 RAISE NOTICE 'SCRUM80 legacy upgrade PASS: 3/3 MOCK, 1 SUCCESS, 2 FAILED, updated_at=created_at';
END $check$;
SELECT id,provider,status,method,amount_vnd,created_at,updated_at
FROM payments WHERE id IN (
 '76000000-0000-4000-8000-000000000201'::uuid,
 '76000000-0000-4000-8000-000000000202'::uuid,
 '76000000-0000-4000-8000-000000000203'::uuid
) ORDER BY id;
