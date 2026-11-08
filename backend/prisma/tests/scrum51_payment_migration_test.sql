-- SCRUM-51: Payment schema integration tests.
-- Run ONLY against a disposable test database, never production.
-- The entire test is transactional: no test records persist.
\set ON_ERROR_STOP on
BEGIN;
DO $test$
DECLARE
  a uuid := md5(random()::text || clock_timestamp()::text)::uuid;
  b uuid := md5(random()::text || clock_timestamp()::text)::uuid;
  oa uuid := md5(random()::text || clock_timestamp()::text)::uuid;
  ob uuid := md5(random()::text || clock_timestamp()::text)::uuid;
  p uuid;
  n integer;
BEGIN
  INSERT INTO users (id,email,password_hash,full_name)
  VALUES
    (a, 'scrum51-a-' || a::text || '@example.test', 'INTEGRATION_TEST_NOT_A_LOGIN_HASH', 'SCRUM51 A'),
    (b, 'scrum51-b-' || b::text || '@example.test', 'INTEGRATION_TEST_NOT_A_LOGIN_HASH', 'SCRUM51 B');
  RAISE NOTICE 'PASS: two isolated test users inserted';

  INSERT INTO orders (id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,expires_at)
  VALUES (oa,a,'PENDING',10000,0,10000,clock_timestamp() + interval '15 minutes'),
         (ob,b,'PENDING',10000,0,10000,clock_timestamp() + interval '15 minutes');
  RAISE NOTICE 'PASS: two valid test orders inserted';

  INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
  VALUES (md5(random()::text || clock_timestamp()::text)::uuid,oa,a,'test-fail-001','hash-failed-001',10000,'CARD','FAILED','{"paymentStatus":"FAILED"}'::jsonb),
         (md5(random()::text || clock_timestamp()::text)::uuid,oa,a,'test-fail-002','hash-failed-002',10000,'CARD','FAILED','{"paymentStatus":"FAILED"}'::jsonb);
  SELECT count(*) INTO n FROM payments WHERE order_id=oa AND status='FAILED';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 FAILED payments, got %',n; END IF;
  RAISE NOTICE 'PASS: multiple FAILED attempts per order';

  INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
  VALUES (md5(random()::text || clock_timestamp()::text)::uuid,oa,a,'shared-key-001','hash-success-001',10000,'CARD','SUCCESS','{"paymentStatus":"SUCCESS","pointsEarned":1}'::jsonb);
  RAISE NOTICE 'PASS: first SUCCESS after FAILED attempts';

  BEGIN
    INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
    VALUES (md5(random()::text || clock_timestamp()::text)::uuid,oa,a,'test-success-002','hash-success-002',10000,'WALLET','SUCCESS','{}'::jsonb);
    RAISE EXCEPTION 'FAIL: second SUCCESS was allowed';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: second SUCCESS rejected by unique index';
  END;

  BEGIN
    INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
    VALUES (md5(random()::text || clock_timestamp()::text)::uuid,oa,a,'shared-key-001','hash-different',10000,'WALLET','FAILED','{}'::jsonb);
    RAISE EXCEPTION 'FAIL: duplicate key for same user was allowed';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate idempotency key for same user rejected';
  END;

  INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
  VALUES (md5(random()::text || clock_timestamp()::text)::uuid,ob,b,'shared-key-001','hash-user-b',10000,'CARD','FAILED','{"paymentStatus":"FAILED"}'::jsonb);
  RAISE NOTICE 'PASS: same idempotency key allowed for different user';

  BEGIN
    INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
    VALUES (md5(random()::text || clock_timestamp()::text)::uuid,ob,b,'negative-001','hash-neg',-1,'CARD','FAILED','{}'::jsonb);
    RAISE EXCEPTION 'FAIL: negative payment amount was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: negative amount rejected by CHECK';
  END;

  BEGIN
    INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
    VALUES (md5(random()::text || clock_timestamp()::text)::uuid,
            md5(random()::text || clock_timestamp()::text)::uuid,a,'invalid-fk-001','hash-fk',10000,'CARD','FAILED','{}'::jsonb);
    RAISE EXCEPTION 'FAIL: invalid order FK was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: nonexistent order FK rejected';
  END;

  BEGIN
    INSERT INTO payments (id,order_id,user_id,idempotency_key,request_hash,amount_vnd,method,status,response_snapshot)
    VALUES (md5(random()::text || clock_timestamp()::text)::uuid,ob,
            md5(random()::text || clock_timestamp()::text)::uuid,'invalid-user-001','hash-user-fk',10000,'CARD','FAILED','{}'::jsonb);
    RAISE EXCEPTION 'FAIL: invalid user FK was allowed';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: nonexistent user FK rejected';
  END;

  SELECT count(*) INTO n FROM payments
  WHERE order_id=oa AND response_snapshot ->> 'pointsEarned' = '1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: JSONB snapshot read did not match'; END IF;
  RAISE NOTICE 'PASS: JSONB snapshot stored and queried';
  RAISE NOTICE 'ALL SCRUM-51 DATABASE CONSTRAINT TESTS PASSED (transaction will be rolled back)';
END
$test$;
ROLLBACK;
