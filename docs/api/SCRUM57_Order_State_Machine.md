# SCRUM-57 – Internal Order State Machine

Implements API Contract v3.0 section 5 (SG-03, S-01, S-02).

## Configuration and request

Set `INTERNAL_SECRET` in `backend/.env` to a separate, randomly generated secret.
Do not commit the value, log it, or expose it to frontend code. Missing/empty
configuration disables access to this endpoint (403). Restart the backend after
changing environment configuration. Swagger `/api-docs` exposes the `internal-key`
authorization scheme with header `X-Internal-Key`; it contains no real secret.

```http
POST /internal/orders/<order-uuid>/advance
X-Internal-Key: <your-local-secret>
Content-Type: application/json

{ "from": "PAID" }
```

HTTP 200 returns `{ "id": "<order-uuid>", "previousStatus": "PAID", "status": "PREPARING" }`.
Only `PAID → PREPARING → READY → COMPLETED` is supported. The server determines
the next state. Extra body fields, including a target status, are ignored.
Customer JWT alone does not authorize this endpoint. No customer ownership
parameter is accepted: this is an internal operation protected by the shared key.

Errors use the standard `{ statusCode, message, error, code }` envelope:

| HTTP | Code | Condition |
| --- | --- | --- |
| 400 | VALIDATION_ERROR | Invalid UUID or missing/invalid `from` enum |
| 403 | FORBIDDEN | Missing/incorrect internal key; checked before Order lookup |
| 404 | NOT_FOUND | Order does not exist |
| 409 | INVALID_TRANSITION | Stale `from`, unsupported state, or terminal state |
| 500 | INTERNAL_ERROR | Unexpected database/transaction failure, including lock timeout |

## Transaction behavior

`InternalKeyGuard → InternalOrdersController → OrderStateService → Prisma → PostgreSQL`.
The service uses an interactive transaction with Read Committed isolation,
parameterized `SELECT ... FOR UPDATE`, then reads the current status after acquiring
the Order lock. It compares `from` and updates one step. Concurrent requests with
the same `from` produce one 200 and one 409 when the lock is acquired within the
timeout. Lock waiting is bounded to 1500 ms and the transaction to 8 seconds, as
in Payment. A timeout rolls back and returns a safe 500; the caller can read the
current state and retry. An outdated `from` never advances again.

Internal advance changes Order status and its normal `updatedAt` only. It does
not mutate stock, coupons, points, payment records, or order item snapshots.
Unpaid expiry does not prevent fulfillment of an already paid order.

Scheduler/expiration, customer cancellation, and Admin/Barista UI are outside
SCRUM-57 scope. No schema change or migration is required.

## Verification

```sh
npm run build
npm test
npm run test:e2e
npm run test:integration -- test/internal-orders.integration-spec.ts
```

Integration tests require `ORDERS_TEST_DATABASE_URL` pointing to a migrated,
disposable PostgreSQL database. They create UUID-scoped fixtures and clean only
their own rows. They exercise concurrent HTTP requests, committed state changes,
rollback after an actual update, and unchanged inventory/coupon/loyalty data.
E2E tests use mocked Prisma to cover the full state matrix, access control,
request validation, error responses, and Swagger schemas.

Verified locally on 2026-10-27: backend build, `tsc --noEmit`, lint, 121 unit
tests, 202 E2E tests (including 72 internal advance cases), and 81 integration
tests (including 6 internal advance cases) passed. Integration ran against a
separate temporary PostgreSQL 18 instance with all 7 existing migrations and
`PAYMENT_CONCURRENCY_TESTS=1`; the project's existing database was not modified.
