-- SCRUM-80 / P2-06: strict read-only index verification, including actual predicates.
-- This additionally checks two UNIQUE indexes that SCRUM-76 postflight did not inspect.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL search_path TO public;
DO $verify$
DECLARE record_index record;
        predicate text;
        definition text;
BEGIN
  FOR record_index IN SELECT * FROM (VALUES
    ('uq_payments_user_idempotency','payments','user_id','idempotency_key',false),
    ('uq_payments_vnp_txn_ref','payments','vnp_txn_ref',NULL,false),
    ('uq_payments_one_success_per_order','payments','order_id','SUCCESS',true),
    ('uq_payments_one_pending_vnpay_per_order','payments','order_id','PENDING',true),
    ('uq_orders_one_active_per_user','orders','user_id','PAYMENT_FAILED',true)
  ) AS q(name,table_name,key_1,key_2,partial)
  LOOP
    SELECT pg_get_indexdef(i.indexrelid), pg_get_expr(i.indpred,i.indrelid)
      INTO definition,predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
     WHERE ns.nspname='public'
       AND tbl.relname=record_index.table_name
       AND idx.relname=record_index.name
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND (i.indpred IS NOT NULL)=record_index.partial;
    IF definition IS NULL THEN
      RAISE EXCEPTION 'Missing/non-unique/invalid index or wrong partial flag: %',record_index.name;
    END IF;
    IF position(record_index.key_1 IN definition)=0 THEN
      RAISE EXCEPTION 'Index % missing key %',record_index.name,record_index.key_1;
    END IF;
    IF record_index.partial AND
       (predicate IS NULL OR position(record_index.key_2 IN predicate)=0
        OR position('status' IN predicate)=0) THEN
      RAISE EXCEPTION 'Index % missing expected status predicate %: %',record_index.name,record_index.key_2,predicate;
    END IF;
    IF record_index.name = 'uq_payments_one_pending_vnpay_per_order'
       AND (position('VNPAY' IN predicate)=0 OR position('provider' IN predicate)=0) THEN
      RAISE EXCEPTION 'Index % must filter both VNPAY and PENDING: %',record_index.name,predicate;
    END IF;
    IF record_index.name = 'uq_orders_one_active_per_user'
       AND position('PENDING' IN predicate)=0 THEN
      RAISE EXCEPTION 'Index % must filter both PENDING and PAYMENT_FAILED: %',record_index.name,predicate;
    END IF;
    IF NOT record_index.partial AND record_index.key_2 IS NOT NULL AND
       position(record_index.key_2 IN definition)=0 THEN
      RAISE EXCEPTION 'Index % missing second key %',record_index.name,record_index.key_2;
    END IF;
    -- Assert full key shape for the single-column indexes from pg_index metadata.
    IF record_index.name <> 'uq_payments_user_idempotency' AND
       (SELECT i.indnkeyatts FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
         WHERE idx.relname=record_index.name) <> 1 THEN
      RAISE EXCEPTION 'Expected single key column: %',record_index.name;
    END IF;
    IF record_index.name = 'uq_payments_user_idempotency' AND
       (SELECT i.indnkeyatts FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
         WHERE idx.relname=record_index.name) <> 2 THEN
      RAISE EXCEPTION 'Expected two key columns: %',record_index.name;
    END IF;
    RAISE NOTICE 'PASS % | %',record_index.name,coalesce(predicate,'NON-PARTIAL');
    definition := NULL;
    predicate := NULL;
  END LOOP;
  RAISE NOTICE 'SCRUM-80 INDEX CATALOG PASS: five UNIQUE indexes present, valid and correctly filtered';
END $verify$;
ROLLBACK;
