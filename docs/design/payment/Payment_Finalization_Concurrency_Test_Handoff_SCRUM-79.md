# Payment Finalization Concurrency Test Handoff (SCRUM-79)

## Scope and coverage

`backend/test/payment-finalization-concurrency.integration-spec.ts` calls the production `PaymentFinalizationService.finalizeInTransaction` inside real Prisma transactions against PostgreSQL. The 13 cases cover:

1. Sequential replay and concurrent replay of the same gateway event.
2. IPN and QueryDR SUCCESS evidence for the same VNPay Payment.
3. Distinct SUCCESS events, SUCCESS/FAILED in both terminal orders, and a second Payment SUCCESS after an accepted SUCCESS.
4. SUCCESS after an Order was cancelled, including replay without another resource release.
5. SUCCESS versus expiration with each lock winner.
6. `paidAt = expiresAt` while inside Grace, and rejection at/after Grace.
7. A transaction rollback after coupon consumption blocks on a real user-row lock, followed by a successful retry.

The cases assert terminal Payment/Order state, event disposition/evidence, one accepted SUCCESS, coupon state/count, loyalty points and reserved inventory. Test-owned rows are tracked by generated IDs and deleted in FK order; Prisma is disconnected and the environment override is removed in `finally`.

## Concurrency and rollback evidence

The race helper holds the Order row with `SELECT ... FOR UPDATE`, starts a second transaction, and observes that backend in `pg_stat_activity` with `wait_event_type = 'Lock'` before releasing the first transaction. It is used by seven Order-lock race cases. The rollback case similarly observes a wait on the `users` row after coupon consumption, checks persisted state against the pre-transaction baseline, then retries and asserts one gateway event and one set of accepted side effects.

Expiry values are created from `clock_timestamp()` with margins (30 seconds, 60 seconds, or 6 minutes); assertions verify the DB clock is on the intended side of Grace. The tests do not sleep around a timing boundary.

## Reported execution result

The following is reported by the user from a direct PowerShell run; it was not run by Codex tools in this session:

- Database: `brewlite_test` at `localhost:5433`; 9 migrations, schema up to date.
- SCRUM-79 concurrency suite: 13 passed.
- Six related integration regression suites: 119 passed.
- Total: 132 passed, 0 failed, 0 skipped.

The service-level tests use verified gateway outcomes. They do not test an IPN endpoint, HMAC verification, or QueryDR HTTP.

## Rerun in PowerShell

Set `AUTH_TEST_DATABASE_URL` and `ORDERS_TEST_DATABASE_URL` in the PowerShell process to the dedicated test database, without printing their values.

Chạy các lệnh sau từ thư mục `backend/` của repository hoặc worktree đang kiểm thử.

```powershell
$env:PAYMENT_CONCURRENCY_TESTS = '1'
npm run test:integration -- test/payment-finalization-concurrency.integration-spec.ts
npm run test:integration -- test/payments-postgres.integration-spec.ts test/promotions-postgres.integration-spec.ts test/inventory-postgres.integration-spec.ts test/orders.integration-spec.ts test/order-lifecycle.integration-spec.ts test/internal-orders.integration-spec.ts
```

Keep `PAYMENT_CONCURRENCY_TESTS=1` for the regression command so the existing gated PostgreSQL concurrency cases run too. Confirm the target database and migration status before running; do not migrate or reset it as part of this handoff.
