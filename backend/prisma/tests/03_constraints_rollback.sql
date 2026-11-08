-- NEGATIVE/POSITIVE DB constraint tests. Requires successfully migrated disposable database.
-- Everything (including fixtures) is ROLLED BACK. psql -v ON_ERROR_STOP=1 -f tests/03_constraints_rollback.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.must_reject(command text, expected_code text, expected_constraint text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE actual_code text; actual_constraint text;
BEGIN
  BEGIN
    EXECUTE command;
    RAISE EXCEPTION 'Expected SQL rejection did not occur for %', expected_constraint;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_code = RETURNED_SQLSTATE,
                            actual_constraint = CONSTRAINT_NAME;
    IF actual_code IS DISTINCT FROM expected_code OR actual_constraint IS DISTINCT FROM expected_constraint THEN
      RAISE EXCEPTION 'Expected SQLSTATE % constraint %, got % / %',
          expected_code, expected_constraint, actual_code, actual_constraint;
    END IF;
  END;
END $fn$;
DO $test$
DECLARE uid uuid := gen_random_uuid(); oid uuid := gen_random_uuid();
        zid uuid := gen_random_uuid(); vid uuid := gen_random_uuid();
        eventid uuid := gen_random_uuid();
        sn text := '{"schemaVersion":1}';
BEGIN
  INSERT INTO users(id,email,password_hash)
    VALUES(uid, 'scrum76_' || replace(uid::text,'-','') || '@example.test', 'SCRUM76_ONLY_FIXTURE');
  INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at)
    VALUES(oid,uid,'PENDING',85000,0,85000,clock_timestamp()+interval '15 minutes');

  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
       method,status,response_snapshot)
   VALUES(gen_random_uuid(),oid,uid,'mock-failed-1','same-hash',85000,'MOCK',
       'CARD','FAILED',sn::jsonb);
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
       method,status,response_snapshot)
   VALUES(gen_random_uuid(),oid,uid,'mock-failed-2','same-hash',85000,'MOCK',
       'CARD','FAILED',sn::jsonb);

  -- INVALID MOCK: method must be present; even though column is nullable for other providers.
  PERFORM pg_temp.must_reject(format($q$INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,status,response_snapshot)
      VALUES(gen_random_uuid(),%L::uuid,%L::uuid,'bad-mock','hash',85000,'MOCK','FAILED','{}'::jsonb)$q$,
      oid,uid),'23514','ck_payments_provider_shape');

  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
    method,status,response_snapshot)
   VALUES(gen_random_uuid(),oid,uid,'mock-success','hash',85000,'MOCK','WALLET','SUCCESS',sn::jsonb);
  -- Existing cross-provider 1-SUCCESS partial unique remains enforced.
  PERFORM pg_temp.must_reject(format($q$INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
      method,status,response_snapshot) VALUES(gen_random_uuid(),%L::uuid,%L::uuid,'duplicate-success','hash',85000,'MOCK','CARD','SUCCESS','{}'::jsonb)$q$,
      oid,uid),'23505','uq_payments_one_success_per_order');

  -- A fresh second Order/User to test VNPay PENDING without application business guard.
  INSERT INTO users(id,email,password_hash)
    VALUES(vid, 'scrum76_' || replace(vid::text,'-','') || '@example.test', 'SCRUM76_ONLY_FIXTURE');
  INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at)
    VALUES(zid,vid,'PENDING',85000,0,85000,clock_timestamp()+interval '15 minutes');
  INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
    status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,initiation_snapshot,
    reconcile_until,reconciliation_state,next_query_at)
   VALUES(gen_random_uuid(),zid,vid,'vnp-key-1','hash',85000,'VNPAY',
    'PENDING','TXN'||replace(zid::text,'-',''),'TESTMERCHANT','20261031190000',
    clock_timestamp()+interval '10 minutes',sn::jsonb,
    clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes')
    RETURNING id INTO eventid;
  PERFORM pg_temp.must_reject(format($q$INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,provider,
    status,vnp_txn_ref,vnp_tmn_code,vnp_create_date,gateway_expires_at,initiation_snapshot,reconcile_until,reconciliation_state,next_query_at)
    VALUES(gen_random_uuid(),%L::uuid,%L::uuid,'vnp-key-2','hash',85000,'VNPAY','PENDING','other-txn',
    'TESTMERCHANT','20261031190000',clock_timestamp()+interval '10 minutes','{}'::jsonb,
    clock_timestamp()+interval '65 minutes','SCHEDULED',clock_timestamp()+interval '15 minutes')$q$,
    zid,vid),'23505','uq_payments_one_pending_vnpay_per_order');

  -- Durable verified event model: accepted example and rejected duplicate identity.
  INSERT INTO payment_gateway_events(id,payment_id,source,event_identity,amount_vnd,
    response_code,transaction_status,outcome,disposition,received_at,verified_at,evidence)
    VALUES(gen_random_uuid(),eventid,'IPN',repeat('a',64),85000,
    '00','00','SUCCESS','OBSERVED',clock_timestamp(),clock_timestamp(),sn::jsonb);
  PERFORM pg_temp.must_reject(format($q$INSERT INTO payment_gateway_events(id,payment_id,source,event_identity,amount_vnd,
    response_code,transaction_status,outcome,disposition,received_at,verified_at,evidence)
    VALUES(gen_random_uuid(),%L::uuid,'IPN',repeat('a',64),85000,
    '00','00','SUCCESS','OBSERVED',clock_timestamp(),clock_timestamp(),'{}'::jsonb)$q$, eventid),
     '23505','uq_payment_gateway_events_identity');
  PERFORM pg_temp.must_reject(format($q$INSERT INTO payment_gateway_events(id,payment_id,source,event_identity,
    amount_vnd,outcome,disposition,received_at,verified_at,evidence)
    VALUES(gen_random_uuid(),%L::uuid,'IPN',repeat('b',64),NULL,'UNKNOWN','OBSERVED',clock_timestamp(),clock_timestamp(),'{}'::jsonb)$q$,
    eventid),'23514','ck_gateway_events_source');
  RAISE NOTICE 'SCRUM-76 DB constraints PASS on disposable fixture (will ROLLBACK)';
END $test$;
ROLLBACK;
