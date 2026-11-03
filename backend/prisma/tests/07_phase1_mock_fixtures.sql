-- SCRUM-76 Phase1 -> Phase2 legacy Mock data verification.
-- RUN ONLY ON DISPOSABLE brewlite_scrum80_legacy_verify AFTER 7 PHASE 1 MIGRATIONS.
-- NO PHASE 2 migration may be applied yet. Do not execute on a shared DB.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
DECLARE finished_count integer;
BEGIN
  IF current_database() <> 'brewlite_scrum80_legacy_verify' THEN
    RAISE EXCEPTION 'STOP: incorrect database: %',current_database();
  END IF;
  SELECT count(*) INTO finished_count FROM public._prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF finished_count <> 7 THEN
    RAISE EXCEPTION 'STOP: expected 7 completed Phase1 migrations, found %',finished_count;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payments' AND column_name='provider')
  OR to_regclass('public.payment_gateway_events') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: Phase2 columns/tables already exist';
  END IF;
  IF EXISTS (SELECT 1 FROM payments) THEN
    RAISE EXCEPTION 'STOP: expected empty payments in isolated fixture database';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id IN
       ('76000000-0000-4000-8000-000000000001'::uuid,'76000000-0000-4000-8000-000000000002'::uuid)) THEN
    RAISE EXCEPTION 'STOP: fixture UUIDs already in use';
  END IF;
END $guard$;

-- Minimal synthetic Order rows serve SQL migration/replay compatibility checks only;
-- they are not evidence of end-to-end application Order creation.
INSERT INTO users(id,email,password_hash,created_at)
VALUES
 ('76000000-0000-4000-8000-000000000001','scrum76-mock-legacy-a@example.test','SCRUM80_SYNTHETIC_ONLY','2026-10-30T08:00:00Z'),
 ('76000000-0000-4000-8000-000000000002','scrum76-mock-legacy-b@example.test','SCRUM80_SYNTHETIC_ONLY','2026-10-30T09:00:00Z');
INSERT INTO orders(id,user_id,status,subtotal_vnd,discount_vnd,total_vnd,points_earned,
                   created_at,updated_at,expires_at,paid_at)
VALUES
 ('76000000-0000-4000-8000-000000000101','76000000-0000-4000-8000-000000000001',
  'PAID',85000,0,85000,8,'2026-10-30T08:00:00Z','2026-10-30T08:05:00Z',
  '2026-10-30T08:15:00Z','2026-10-30T08:05:00Z'),
 ('76000000-0000-4000-8000-000000000102','76000000-0000-4000-8000-000000000002',
  'PAYMENT_FAILED',50000,0,50000,0,'2026-10-30T09:00:00Z','2026-10-30T09:02:00Z',
  '2026-10-30T09:15:00Z',NULL);

INSERT INTO payments(id,order_id,user_id,idempotency_key,request_hash,amount_vnd,
                     method,status,mock_reference,method_last4,response_snapshot,created_at)
VALUES
 ('76000000-0000-4000-8000-000000000201','76000000-0000-4000-8000-000000000101',
  '76000000-0000-4000-8000-000000000001','scrum76-phase1-failed-a',repeat('a',64),85000,
  'CARD','FAILED','MOCK-76000000-0000-4000-8000-000000000201','4242',
  jsonb_build_object(
   'paymentId','76000000-0000-4000-8000-000000000201',
   'orderId','76000000-0000-4000-8000-000000000101',
   'method','CARD','paymentStatus','FAILED','orderStatus','PAYMENT_FAILED',
   'amountVnd',85000,'methodLast4','4242',
   'mockReference','MOCK-76000000-0000-4000-8000-000000000201',
   'pointsEarned',0,'failureReason','PAYMENT_DECLINED',
   'createdAt','2026-10-30T08:02:00.000Z'),
  '2026-10-30T08:02:00Z'),
 ('76000000-0000-4000-8000-000000000202','76000000-0000-4000-8000-000000000101',
  '76000000-0000-4000-8000-000000000001','scrum76-phase1-success-a',repeat('b',64),85000,
  'WALLET','SUCCESS','MOCK-76000000-0000-4000-8000-000000000202','1234',
  jsonb_build_object(
   'paymentId','76000000-0000-4000-8000-000000000202',
   'orderId','76000000-0000-4000-8000-000000000101',
   'method','WALLET','paymentStatus','SUCCESS','orderStatus','PAID',
   'amountVnd',85000,'methodLast4','1234',
   'mockReference','MOCK-76000000-0000-4000-8000-000000000202',
   'pointsEarned',8,'failureReason',NULL,
   'createdAt','2026-10-30T08:05:00.000Z'),
  '2026-10-30T08:05:00Z'),
 ('76000000-0000-4000-8000-000000000203','76000000-0000-4000-8000-000000000102',
  '76000000-0000-4000-8000-000000000002','scrum76-phase1-failed-b',repeat('c',64),50000,
  'WALLET','FAILED','MOCK-76000000-0000-4000-8000-000000000203','5678',
  jsonb_build_object(
   'paymentId','76000000-0000-4000-8000-000000000203',
   'orderId','76000000-0000-4000-8000-000000000102',
   'method','WALLET','paymentStatus','FAILED','orderStatus','PAYMENT_FAILED',
   'amountVnd',50000,'methodLast4','5678',
   'mockReference','MOCK-76000000-0000-4000-8000-000000000203',
   'pointsEarned',0,'failureReason','PAYMENT_DECLINED',
   'createdAt','2026-10-30T09:02:00.000Z'),
  '2026-10-30T09:02:00Z');

DO $verify$
DECLARE n bigint; nsuccess bigint; nfailed bigint;
BEGIN
 SELECT count(*),count(*) FILTER (WHERE status='SUCCESS'),count(*) FILTER (WHERE status='FAILED')
 INTO n,nsuccess,nfailed FROM payments WHERE id::text LIKE '76000000-0000-4000-8000-0000000002%';
 IF n<>3 OR nsuccess<>1 OR nfailed<>2 THEN
   RAISE EXCEPTION 'Legacy fixture counts incorrect: total %, success %, failed %',n,nsuccess,nfailed;
 END IF;
 RAISE NOTICE 'SCRUM80 Phase1 Mock fixtures PASS: 3 payments (1 SUCCESS / 2 FAILED)';
END $verify$;
COMMIT;
