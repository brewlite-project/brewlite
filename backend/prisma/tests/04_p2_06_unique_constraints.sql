-- SCRUM-80 / P2-06: insert-based positive and negative UNIQUE tests.
-- REQUIRED: a disposable PostgreSQL DB with all nine Phase 1 + SCRUM-76 migrations.
-- Run: psql "$PSQL_URL" -X -v ON_ERROR_STOP=1 -f backend/prisma/tests/04_p2_06_unique_constraints.sql
-- No persistent test records: every fixture/change is rolled back.
-- This proves physical DB enforcement, NOT concurrency, finalization or cross-provider business guards.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO public;

DO $guard$
DECLARE applied integer;
BEGIN
  IF current_database() NOT IN (
    'brewlite_scrum76_verify', 'brewlite_scrum76_legacy_verify',
    'brewlite_scrum80_verify', 'brewlite_scrum80_legacy_verify'
  ) THEN
    RAISE EXCEPTION 'SCRUM-80 SAFETY STOP: unexpected database %', current_database();
  END IF;

  SELECT COUNT(*) INTO applied
    FROM public._prisma_migrations
   WHERE migration_name IN (
     '20261031190000_scrum76_payment_pending_enum',
     '20261031190100_scrum76_payment_gateway_delta'
   ) AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF applied <> 2 THEN
    RAISE EXCEPTION 'SCRUM-80 requires both committed SCRUM-76 migrations; found %', applied;
  END IF;
END $guard$;

CREATE FUNCTION pg_temp.scrum80_expect_rejection(
  sql_command text, expected_sqlstate text, expected_constraint text
) RETURNS void LANGUAGE plpgsql AS $func$
DECLARE actual_sqlstate text; actual_constraint text;
BEGIN
  BEGIN
    EXECUTE sql_command;
    RAISE EXCEPTION 'Expected rejection did not occur: %', expected_constraint;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      actual_sqlstate = RETURNED_SQLSTATE,
      actual_constraint = CONSTRAINT_NAME;
    IF actual_sqlstate IS DISTINCT FROM expected_sqlstate
       OR actual_constraint IS DISTINCT FROM expected_constraint THEN
      RAISE EXCEPTION 'FAIL: expected SQLSTATE % / %, got % / %',
        expected_sqlstate, expected_constraint, actual_sqlstate, actual_constraint;
    END IF;
  END;
END $func$;

DO $tests$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  order_a_active uuid := gen_random_uuid();
  order_a_terminal uuid := gen_random_uuid();
  order_b_active uuid := gen_random_uuid();
  txn_ref_a text := 'S80A' || replace(gen_random_uuid()::text, '-', '');
  txn_ref_b text := 'S80B' || replace(gen_random_uuid()::text, '-', '');
  txn_ref_c text := 'S80C' || replace(gen_random_uuid()::text, '-', '');
  mock_json jsonb := '{"schemaVersion":1,"fixture":"scrum80-constraints-only"}'::jsonb;
BEGIN
  -- Two distinct users, two active orders. A also owns a terminal PAID order:
  -- PostgreSQL must permit a PAID order alongside one active order of the same user.
  INSERT INTO users(id, email, password_hash) VALUES
    (user_a, 'scrum80a_' || replace(user_a::text, '-', '') || '@example.test', 'TEST_ONLY'),
    (user_b, 'scrum80b_' || replace(user_b::text, '-', '') || '@example.test', 'TEST_ONLY');

  INSERT INTO orders(id, user_id, status, subtotal_vnd, discount_vnd, total_vnd, expires_at)
  VALUES
    (order_a_active, user_a, 'PENDING', 85000, 0, 85000, clock_timestamp() + interval '15 minutes'),
    (order_b_active, user_b, 'PAYMENT_FAILED', 85000, 0, 85000, clock_timestamp() + interval '15 minutes');

  INSERT INTO orders(id, user_id, status, subtotal_vnd, discount_vnd, total_vnd, expires_at, paid_at)
  VALUES (order_a_terminal, user_a, 'PAID', 85000, 0, 85000,
          clock_timestamp() + interval '15 minutes', clock_timestamp());

  -- NEGATIVE 1: two active orders for one user, across PENDING/PAYMENT_FAILED.
  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at)
    VALUES (gen_random_uuid(),%L::uuid,'PAYMENT_FAILED',85000,0,85000,clock_timestamp()+interval '15 minutes')
  $sql$, user_a), '23505', 'uq_orders_one_active_per_user');

  -- POSITIVE: different users may reuse a key (the index is per user, not global).
  -- POSITIVE: distinct FAILED attempts for the same Order are permitted.
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                       provider,method,status,response_snapshot)
  VALUES
    (gen_random_uuid(),order_a_active,user_a,'s80-shared-key','hash-a',85000,
     'MOCK','CARD','FAILED',mock_json),
    (gen_random_uuid(),order_b_active,user_b,'s80-shared-key','hash-b',85000,
     'MOCK','WALLET','FAILED',mock_json),
    (gen_random_uuid(),order_a_active,user_a,'s80-another-failed','hash-a2',85000,
     'MOCK','CARD','FAILED',mock_json);

  -- NEGATIVE 2: same (user_id, idempotency_key), even on a separate row.
  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                         provider,method,status,response_snapshot)
    VALUES (gen_random_uuid(),%L::uuid,%L::uuid,'s80-shared-key','hash-duplicate',85000,
            'MOCK','CARD','FAILED','{}'::jsonb)
  $sql$,order_a_active,user_a), '23505', 'uq_payments_user_idempotency');

  -- NEGATIVE 3: the same key is also rejected across providers.
  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
      status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,
      initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
    VALUES (gen_random_uuid(),%L::uuid,%L::uuid,'s80-shared-key','hash-vnp',85000,'VNPAY',
      'PENDING',%L,'TESTMERCHANT','20261101130000',clock_timestamp()+interval '10 minutes',
      '{}'::jsonb,clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes')
  $sql$,order_a_active,user_a,txn_ref_c), '23505', 'uq_payments_user_idempotency');

  -- A PAID Order accepts one SUCCESS. The second SUCCESS is rejected, regardless
  -- of distinct keys (this tests DB uniqueness, not a real payment state flow).
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                       provider,method,status,response_snapshot)
  VALUES (gen_random_uuid(),order_a_terminal,user_a,'s80-success-one','hash-success',85000,
          'MOCK','WALLET','SUCCESS',mock_json);

  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                         provider,method,status,response_snapshot)
    VALUES (gen_random_uuid(),%L::uuid,%L::uuid,'s80-success-two','hash-success-2',85000,
      'MOCK','CARD','SUCCESS','{}'::jsonb)
  $sql$,order_a_terminal,user_a), '23505', 'uq_payments_one_success_per_order');

  -- POSITIVE: the first VNPay PENDING attempt in each Order with distinct TxnRef.
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
    provider,status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,
    initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
  VALUES (gen_random_uuid(),order_a_active,user_a,'s80-vnp-pending-one','hash-vnp-1',85000,
    'VNPAY','PENDING',txn_ref_a,'TESTMERCHANT','20261101130000',
    clock_timestamp()+interval '10 minutes',mock_json,
    clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes');

  -- NEGATIVE 4: duplicate non-NULL VNPay TxnRef across DIFFERENT orders/users.
  -- This must hit txn_ref uniqueness rather than the one-pending-per-order index.
  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
      provider,status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,
      initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
    VALUES (gen_random_uuid(),%L::uuid,%L::uuid,'s80-vnp-duplicate-ref','hash-vnp-dup',85000,
      'VNPAY','PENDING',%L,'TESTMERCHANT','20261101130000',
      clock_timestamp()+interval '10 minutes','{}'::jsonb,
      clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes')
  $sql$,order_b_active,user_b,txn_ref_a), '23505', 'uq_payments_vnp_txn_ref');

  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
    provider,status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,
    initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
  VALUES (gen_random_uuid(),order_b_active,user_b,'s80-vnp-pending-two','hash-vnp-2',85000,
    'VNPAY','PENDING',txn_ref_b,'TESTMERCHANT','20261101130000',
    clock_timestamp()+interval '10 minutes',mock_json,
    clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes');

  -- NEGATIVE 5: a second VNPay PENDING on the same Order, with a UNIQUE TxnRef.
  PERFORM pg_temp.scrum80_expect_rejection(format($sql$
    INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
      provider,status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,
      initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
    VALUES (gen_random_uuid(),%L::uuid,%L::uuid,'s80-vnp-pending-three','hash-vnp-3',85000,
      'VNPAY','PENDING',%L,'TESTMERCHANT','20261101130000',
      clock_timestamp()+interval '10 minutes','{}'::jsonb,
      clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes')
  $sql$,order_a_active,user_a,txn_ref_c), '23505', 'uq_payments_one_pending_vnpay_per_order');

  RAISE NOTICE 'SCRUM-80 UNIQUE tests PASS: active Order, idempotency (same/cross provider), SUCCESS, VNPay TxnRef, VNPay PENDING; all fixtures ROLLBACK';
END $tests$;
ROLLBACK;
