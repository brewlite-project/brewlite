-- Run on a disposable PostgreSQL database AFTER BOTH SCRUM-76 migrations.
-- Read-only assertion script; any mismatch causes a nonzero psql exit code.
\set ON_ERROR_STOP on
DO $audit$
DECLARE i RECORD; expected_count integer; actual_count integer;
BEGIN
  -- Seven Phase 1 migrations and both SCRUM-76 migrations must have finished.
  SELECT COUNT(*) INTO actual_count FROM _prisma_migrations
   WHERE migration_name IN ('20261031190000_scrum76_payment_pending_enum',
      '20261031190100_scrum76_payment_gateway_delta') AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF actual_count <> 2 THEN RAISE EXCEPTION 'Two SCRUM-76 Prisma migrations not both committed'; END IF;

  IF NOT EXISTS(SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
       WHERE t.typname='payment_status' AND e.enumlabel='PENDING')
  THEN RAISE EXCEPTION 'PaymentStatus.PENDING missing'; END IF;

  FOR i IN SELECT * FROM (VALUES
    ('uq_orders_one_active_per_user','orders','user_id','PENDING','PAYMENT_FAILED'),
    ('uq_payments_one_success_per_order','payments','order_id','SUCCESS',NULL),
    ('uq_payments_one_pending_vnpay_per_order','payments','order_id','PENDING','VNPAY')
  ) AS x(name,table_name,indexed_column,term1,term2)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index ix
      JOIN pg_class idx ON idx.oid=ix.indexrelid
      JOIN pg_class t ON t.oid=ix.indrelid
      JOIN pg_namespace ns ON ns.oid=t.relnamespace
      WHERE ns.nspname='public' AND t.relname=i.table_name AND idx.relname=i.name
        AND ix.indisunique AND ix.indisvalid AND ix.indisready
        AND ix.indpred IS NOT NULL
        AND pg_get_indexdef(ix.indexrelid) ILIKE '%' || i.indexed_column || '%'
        AND pg_get_expr(ix.indpred,ix.indrelid) LIKE '%' || i.term1 || '%'
        AND (i.term2 IS NULL OR pg_get_expr(ix.indpred,ix.indrelid) LIKE '%' || i.term2 || '%')
    ) THEN RAISE EXCEPTION 'Missing/invalid partial unique % or wrong predicate',i.name; END IF;
  END LOOP;

  SELECT COUNT(*) INTO expected_count FROM (VALUES
    ('ck_payments_amount_nonnegative'),('ck_payments_provider_shape'),
    ('ck_payments_nonmock_mask'),('ck_payments_gateway_shape'),
    ('ck_payments_vnp_terminal'),('ck_payments_json_objects'),
    ('ck_payments_query_attempts'),('ck_payments_reconcile_shape'),
    ('ck_payments_claim_pair'),('ck_payments_query_history'),
    ('ck_payments_financial_review'),('ck_payments_nonvnp_reconcile_clean')
  ) x(name);
  SELECT COUNT(*) INTO actual_count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
   WHERE t.relname='payments' AND c.contype='c' AND c.convalidated
     AND c.conname IN ('ck_payments_amount_nonnegative','ck_payments_provider_shape',
        'ck_payments_nonmock_mask','ck_payments_gateway_shape','ck_payments_vnp_terminal',
        'ck_payments_json_objects','ck_payments_query_attempts','ck_payments_reconcile_shape',
        'ck_payments_claim_pair','ck_payments_query_history','ck_payments_financial_review',
        'ck_payments_nonvnp_reconcile_clean');
  IF actual_count <> expected_count THEN RAISE EXCEPTION 'Payment CHECKs missing % / %', actual_count,expected_count; END IF;

  SELECT COUNT(*) INTO actual_count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
   WHERE t.relname='payment_gateway_events' AND c.contype='c' AND c.convalidated
     AND c.conname IN ('ck_gateway_events_identity','ck_gateway_events_source',
        'ck_gateway_events_amount','ck_gateway_events_terminal_evidence',
        'ck_gateway_events_exception','ck_gateway_events_evidence',
        'ck_gateway_events_disposition_outcome');
  IF actual_count <> 7 THEN RAISE EXCEPTION 'Gateway CHECKs missing % / 7',actual_count; END IF;

  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='payment_gateway_events_payment_id_fkey'
    AND conrelid='payment_gateway_events'::regclass AND confrelid='payments'::regclass
    AND confdeltype='r')
  THEN RAISE EXCEPTION 'Gateway event FK missing or not RESTRICT'; END IF;

  IF EXISTS(SELECT 1 FROM payments WHERE provider IS NULL OR updated_at IS NULL
     OR (provider='MOCK' AND (method IS NULL OR response_snapshot IS NULL)))
  THEN RAISE EXCEPTION 'Legacy Mock backfill/nullability violated'; END IF;

  IF EXISTS(SELECT 1 FROM payments WHERE provider='MOCK' AND created_at<>updated_at
       AND query_attempts=0)
  THEN RAISE NOTICE 'Some Mock updated_at differs from created_at: verify post-migration application writes / pre-existing data'; END IF;

  RAISE NOTICE 'SCRUM76 postflight: enum, index predicates, CHECKs, event FK and Mock backfill PASS';
END $audit$;
SELECT COUNT(*) AS all_payments, COUNT(*) FILTER(WHERE provider='MOCK') AS mock_rows,
       COUNT(*) FILTER(WHERE provider='VNPAY') AS vnpay_rows,
       COUNT(*) FILTER(WHERE provider='ZERO_AMOUNT') AS zero_rows
FROM payments;
