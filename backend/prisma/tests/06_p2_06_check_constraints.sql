-- SCRUM-80 / PR #120: PostgreSQL DML negative/positive CHECK verification.
-- TEST-ONLY: run against the isolated SCRUM-80 Docker PostgreSQL database,
-- never against shared/production. All fixtures and the temporary helper ROLLBACK.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO public;

DO $guard$
DECLARE applied integer;
BEGIN
  IF current_database() NOT IN ('brewlite_scrum80_verify','brewlite_scrum80_legacy_verify')
  THEN RAISE EXCEPTION 'SCRUM80 SAFETY STOP: wrong database %',current_database(); END IF;
  SELECT count(*) INTO applied FROM _prisma_migrations
    WHERE migration_name IN ('20261031190000_scrum76_payment_pending_enum',
                             '20261031190100_scrum76_payment_gateway_delta')
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF applied <> 2 THEN RAISE EXCEPTION 'SCRUM80 requires both SCRUM76 migrations'; END IF;
END $guard$;

CREATE FUNCTION pg_temp.expect_check(command text, name text)
RETURNS void LANGUAGE plpgsql AS $func$
DECLARE actual_state text; actual_name text;
BEGIN
  BEGIN
    EXECUTE command;
    RAISE EXCEPTION 'Test did NOT reject invalid data for %',name;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE,
                            actual_name = CONSTRAINT_NAME;
    IF actual_state IS DISTINCT FROM '23514' OR actual_name IS DISTINCT FROM name THEN
      RAISE EXCEPTION 'Expected CHECK % (23514), got % / %',name,actual_state,actual_name;
    END IF;
  END;
  RAISE NOTICE 'PASS CHECK %', name;
END $func$;

CREATE FUNCTION pg_temp.expect_valid(command text, label text)
RETURNS void LANGUAGE plpgsql AS $func$
BEGIN
  EXECUTE command;
  RAISE NOTICE 'PASS VALID %', label;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Expected valid DML for %, got SQLSTATE %: %', label, SQLSTATE, SQLERRM;
END $func$;

DO $test$
DECLARE
  user_mock uuid:=gen_random_uuid(); user_zero uuid:=gen_random_uuid();
  user_vnp uuid:=gen_random_uuid(); user_terminal uuid:=gen_random_uuid();
  order_mock uuid:=gen_random_uuid(); order_zero uuid:=gen_random_uuid();
  order_vnp uuid:=gen_random_uuid(); order_terminal uuid:=gen_random_uuid();
  pay_mock uuid:=gen_random_uuid(); pay_zero uuid:=gen_random_uuid();
  pay_vnp uuid:=gen_random_uuid(); pay_terminal uuid:=gen_random_uuid();
  event_id uuid:=gen_random_uuid();
  user_failed uuid:=gen_random_uuid(); order_failed uuid:=gen_random_uuid(); pay_failed uuid:=gen_random_uuid();
BEGIN
  INSERT INTO users(id,email,password_hash) VALUES
    (user_mock,'scrum80ck-'||replace(user_mock::text,'-','')||'@example.test','TEST_ONLY'),
    (user_zero,'scrum80ck-'||replace(user_zero::text,'-','')||'@example.test','TEST_ONLY'),
    (user_vnp,'scrum80ck-'||replace(user_vnp::text,'-','')||'@example.test','TEST_ONLY'),
    (user_terminal,'scrum80ck-'||replace(user_terminal::text,'-','')||'@example.test','TEST_ONLY');
  INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at,paid_at)
  VALUES
    (order_mock,user_mock,'PAYMENT_FAILED',85000,0,85000,clock_timestamp()+interval '15 min',NULL),
    (order_zero,user_zero,'PAID',0,0,0,clock_timestamp()+interval '15 min',clock_timestamp()),
    (order_vnp,user_vnp,'PENDING',85000,0,85000,clock_timestamp()+interval '15 min',NULL),
    (order_terminal,user_terminal,'PAID',85000,0,85000,clock_timestamp()+interval '15 min',clock_timestamp());

  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                       provider,method,status,response_snapshot)
  VALUES (pay_mock,order_mock,user_mock,'s80-ck-mock','hm',85000,'MOCK','CARD','FAILED','{}'::jsonb),
         (pay_zero,order_zero,user_zero,'s80-ck-zero','hz',0,'ZERO_AMOUNT',NULL,'SUCCESS','{}'::jsonb);
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                       provider,method,status,response_snapshot,vnp_txn_ref,vnp_tmn_code,
                       vnp_create_date,gateway_expires_at,initiation_snapshot,
                       reconciliation_state,next_query_at,reconcile_until)
  VALUES (pay_vnp,order_vnp,user_vnp,'s80-ck-vnp','hv',85000,
          'VNPAY',NULL,'PENDING',NULL,'S80CK'||replace(gen_random_uuid()::text,'-',''),
          'TESTMERCHANT','20261101130000',clock_timestamp()+interval '10 min',
          '{}'::jsonb,'SCHEDULED',clock_timestamp()+interval '15 min',clock_timestamp()+interval '65 min');
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                       provider,method,status,response_snapshot,vnp_txn_ref,vnp_tmn_code,
                       vnp_create_date,gateway_expires_at,initiation_snapshot,
                       final_outcome_snapshot,verified_at,finalized_at,
                       reconciliation_state,reconcile_until)
  VALUES (pay_terminal,order_terminal,user_terminal,'s80-ck-terminal','ht',85000,
          'VNPAY',NULL,'SUCCESS',NULL,'S80CK'||replace(gen_random_uuid()::text,'-',''),
          'TESTMERCHANT','20261101130000',clock_timestamp()+interval '10 min',
          '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp(),'RESOLVED',
          clock_timestamp()+interval '65 min');
  -- Positive gateway evidence: verified IPN, well-formed identity and amount.
  INSERT INTO payment_gateway_events(id,payment_id,source,event_identity,amount_vnd,
    response_code,transaction_status,outcome,disposition,received_at,verified_at,evidence)
  VALUES(event_id,pay_terminal,'IPN',repeat('a',64),85000,
    '00','00','SUCCESS','FINALIZED',clock_timestamp(),clock_timestamp(),'{}'::jsonb);

  -- Positive VNPAY FAILED terminal fixture (separate Order / immutable original fixtures).
  INSERT INTO users(id,email,password_hash) VALUES
    (user_failed,'scrum80ck-'||replace(user_failed::text,'-','')||'@example.test','TEST_ONLY');
  INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at,paid_at)
    VALUES(order_failed,user_failed,'PAYMENT_FAILED',85000,0,85000,clock_timestamp()+interval '15 min',NULL);
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
    provider,method,status,response_snapshot,vnp_txn_ref,vnp_tmn_code,vnp_create_date,
    gateway_expires_at,initiation_snapshot,final_outcome_snapshot,verified_at,finalized_at,
    reconciliation_state,reconcile_until)
  VALUES(pay_failed,order_failed,user_failed,'s80-ck-failed','hf',85000,'VNPAY',NULL,'FAILED',NULL,
    'S80CK'||replace(gen_random_uuid()::text,'-',''),'TESTMERCHANT','20261101130000',
    clock_timestamp()+interval '10 min','{}'::jsonb,'{}'::jsonb,
    clock_timestamp(),clock_timestamp(),'RESOLVED',clock_timestamp()+interval '65 min');
  RAISE NOTICE 'PASS VALID VNPAY FAILED terminal (verified/finalized evidence)';

  -- Explicit missing-gateway-field cases: 23514 AND exact constraint name.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET vnp_txn_ref=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET vnp_tmn_code=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET gateway_expires_at=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET initiation_snapshot=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET reconcile_until=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET response_snapshot=NULL WHERE id=%L::uuid',pay_zero),'ck_payments_provider_shape');

  -- REQUIRES_REVIEW valid pair and invalid missing/blank reason; restore PENDING scheduler state.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET reconciliation_state=''REQUIRES_REVIEW'', next_query_at=NULL,review_reason=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_reconcile_shape');
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET reconciliation_state=''REQUIRES_REVIEW'', next_query_at=NULL, review_reason=''Manual investigation needed'' WHERE id=%L::uuid',pay_vnp),'REQUIRES_REVIEW with review_reason');
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET reconciliation_state=''SCHEDULED'', next_query_at=clock_timestamp()+interval ''15 min'',review_reason=NULL WHERE id=%L::uuid',pay_vnp),'Restore SCHEDULED after review example');

  -- Claim and lease must be present together; valid pair on SCHEDULED, then clear.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET lease_expires_at=clock_timestamp()+interval ''5 min'' WHERE id=%L::uuid',pay_vnp),'ck_payments_claim_pair');
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET claim_token=gen_random_uuid(), lease_expires_at=clock_timestamp()+interval ''5 min'' WHERE id=%L::uuid',pay_vnp),'Claim/lease complete pair');
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET claim_token=NULL, lease_expires_at=NULL WHERE id=%L::uuid',pay_vnp),'Claim/lease release pair');

  -- QueryDR: positive history requires attempts >0, a timestamp and request id.
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET query_attempts=1,last_query_at=clock_timestamp(),last_query_request_id=''scrum80-query-1'' WHERE id=%L::uuid',pay_vnp),'Valid QueryDR history shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET last_query_request_id=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_query_history');
  PERFORM pg_temp.expect_valid(format('UPDATE payments SET query_attempts=0,last_query_at=NULL,last_query_request_id=NULL,last_query_error=NULL WHERE id=%L::uuid',pay_vnp),'Restore empty QueryDR history');

  -- MOCK shape and zero-amount provider guard.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET amount_vnd=-1 WHERE id=%L::uuid',pay_mock), 'ck_payments_amount_nonnegative');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET method=NULL WHERE id=%L::uuid',pay_mock), 'ck_payments_provider_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET status=''PENDING'' WHERE id=%L::uuid',pay_mock), 'ck_payments_provider_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET amount_vnd=1 WHERE id=%L::uuid',pay_zero), 'ck_payments_provider_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET method_last4=''4242'' WHERE id=%L::uuid',pay_zero),'ck_payments_nonmock_mask');
  -- VNPAY metadata, PENDING vs terminal lifecycle, JSON data types.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET vnp_create_date=''WRONG'' WHERE id=%L::uuid',pay_vnp),'ck_payments_gateway_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET response_snapshot=''{}''::jsonb WHERE id=%L::uuid',pay_vnp),'ck_payments_provider_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET status=''SUCCESS'', reconciliation_state=''RESOLVED'', next_query_at=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_vnp_terminal');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET final_outcome_snapshot=NULL WHERE id=%L::uuid',pay_terminal),'ck_payments_vnp_terminal');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET response_snapshot=''[]''::jsonb WHERE id=%L::uuid',pay_mock),'ck_payments_json_objects');
  -- QueryDR metadata / reconciliation / lease fencing / financial review.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET query_attempts=-1 WHERE id=%L::uuid',pay_vnp),'ck_payments_query_attempts');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET next_query_at=NULL WHERE id=%L::uuid',pay_vnp),'ck_payments_reconcile_shape');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET claim_token=gen_random_uuid() WHERE id=%L::uuid',pay_vnp),'ck_payments_claim_pair');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET query_attempts=1 WHERE id=%L::uuid',pay_vnp),'ck_payments_query_history');
  PERFORM pg_temp.expect_check(format('UPDATE payments SET has_financial_exception=true WHERE id=%L::uuid',pay_terminal),'ck_payments_financial_review');
  -- Non-VNPay must not retain QueryDR/reconciliation-only metadata.
  PERFORM pg_temp.expect_check(format('UPDATE payments SET review_reason=''SHOULD_NOT_EXIST'' WHERE id=%L::uuid',pay_mock),'ck_payments_nonvnp_reconcile_clean');
  -- Check gateway events: identity/source/proof/exception JSON & disposition.
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET event_identity=''BAD'' WHERE id=%L::uuid',event_id),'ck_gateway_events_identity');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET source=''QUERYDR'' WHERE id=%L::uuid',event_id),'ck_gateway_events_source');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET amount_vnd=-1 WHERE id=%L::uuid',event_id),'ck_gateway_events_amount');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET response_code=NULL WHERE id=%L::uuid',event_id),'ck_gateway_events_terminal_evidence');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET disposition=''CONFLICT'' WHERE id=%L::uuid',event_id),'ck_gateway_events_exception');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET evidence=''[]''::jsonb WHERE id=%L::uuid',event_id),'ck_gateway_events_evidence');
  PERFORM pg_temp.expect_check(format('UPDATE payment_gateway_events SET disposition=''FINANCIAL_EXCEPTION'',outcome=''UNKNOWN'',exception_reason=''late'' WHERE id=%L::uuid',event_id),'ck_gateway_events_disposition_outcome');
  RAISE NOTICE 'SCRUM80 CHECK DML PASS: provider, zero amount, VNPay, lifecycle, reconciliation, exception and event evidence; ROLLBACK';
END $test$;
ROLLBACK;
