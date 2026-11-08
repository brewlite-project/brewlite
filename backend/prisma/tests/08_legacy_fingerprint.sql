-- READ ONLY; run identically BEFORE and AFTER Phase2 migration.
-- Compares exact Phase1 Payment columns, including full JSON snapshot, key/hash and time.
\set ON_ERROR_STOP on
DO $guard$
BEGIN
 IF current_database() <> 'brewlite_scrum80_legacy_verify' THEN
  RAISE EXCEPTION 'STOP: expected brewlite_scrum80_legacy_verify; got %',current_database();
 END IF;
 IF (SELECT count(*) FROM payments WHERE id IN (
  '76000000-0000-4000-8000-000000000201'::uuid,
  '76000000-0000-4000-8000-000000000202'::uuid,
  '76000000-0000-4000-8000-000000000203'::uuid
 ))<>3 THEN RAISE EXCEPTION 'STOP: expected 3 saved Mock payments'; END IF;
END $guard$;
SELECT p.id::text || E'\t' || md5(jsonb_build_object(
 'id',p.id, 'order_id',p.order_id,'user_id',p.user_id,
 'idempotency_key',p.idempotency_key,'request_hash',p.request_hash,
 'amount_vnd',p.amount_vnd,'method',p.method::text,'status',p.status::text,
 'mock_reference',p.mock_reference,'method_last4',p.method_last4,
 'response_snapshot',p.response_snapshot, 'created_at',p.created_at
)::text) AS legacy_fingerprint
FROM payments AS p
WHERE p.id IN (
 '76000000-0000-4000-8000-000000000201'::uuid,
 '76000000-0000-4000-8000-000000000202'::uuid,
 '76000000-0000-4000-8000-000000000203'::uuid
)
ORDER BY p.id;
