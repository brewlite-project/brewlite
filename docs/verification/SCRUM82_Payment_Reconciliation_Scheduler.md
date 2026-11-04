# SCRUM-82 / P2-08 – Payment Reconciliation Scheduler

**Source baseline:** `SCRUM82_backend_snapshot.zip` (`git archive` commit `04dcd26045d7ed4a5ce21b806d30d6c261db1552`).  
**Target branch / PR:** `SCRUM-82-P2-08-Implement-Payment-Reconciliation-Scheduler` / [PR #133](https://github.com/brewlite-project/brewlite/pull/133), targeting `dev`.  
**Dependencies:** P2-04 `PaymentFinalizationService` (shared payment finalization); P2-07 `VnpayQueryDrClient` (QueryDR client); existing shared Order-expiration primitive.  
**Verification status (implementer logs, 2026-11-03):** Prisma Client generation PASS; **247/247 unit tests** (30/30 files), including **7/7 configuration tests**; **14/14 isolated PostgreSQL reconciliation integration tests** PASS. Reviewer reports code/static checks PASS and no remaining Major/Blocker. **Backend build exit status and live VNPay Sandbox E2E are not evidenced in the supplied logs; final independent reviewer runtime verification is pending.**

## 1. Intended behavior (BR-03 + BR-05 / API Contract v4.0)

- **Time boundaries:** E = immutable `Order.expiresAt` (15-minute order TTL); G = E + 5 minutes (Grace boundary); H = G + 60 minutes (reconciliation horizon).
- VNPay initiation persists `Payment(PENDING, SCHEDULED, nextQueryAt=E, reconcileUntil=H)`.
- For a due `PENDING` Payment, only a worker holding a valid, unexpired PostgreSQL lease may dispatch QueryDR. The claim persists a fresh `requestId` and `claimToken`.
- **At claim time, in the same short DB transaction:** advance `nextQueryAt = min(H, max(G, dbNow + cooldownMs))`. The cooldown is **at least 10 minutes** to prevent retry bursts after timeout, crash or restart.
- **Consistent lock order:** lock Order first, then Payment, as in shared Finalization. Commit the claim before sending QueryDR HTTP. **No DB transaction or row lock is held while awaiting HTTP.**
- **Verified QueryDR SUCCESS/FAILED:** pass the verified outcome to the existing `PaymentFinalizationService`; the scheduler does not duplicate financial/loyalty/inventory/coupon side effects.
- **UNKNOWN, network error, HTTP timeout, invalid gateway response:** retain `Payment.PENDING`, persist only a sanitized error category, and respect the stored retry schedule. Never infer `FAILED` from a missing or inconclusive gateway result.
- **Grace expiry (at/after G):** shared `expireOrderInTransaction` may cancel an eligible active Order and release reserved inventory. The unresolved VNPay Payment remains `PENDING`. The independent Order Expiration job continues to run.
- **Horizon (at/after H):** start no new QueryDR claims. For unresolved `PENDING` payments, record `REQUIRES_REVIEW`, `reviewReason=AUTO_RECONCILIATION_EXHAUSTED`, clear `nextQueryAt`, and release expired leases. A valid in-flight claim started before H may still return; its verified result goes through shared Finalization.
- **Race safety:** a stale `claimToken` cannot release another worker's lease. Concurrent IPN/QueryDR finalization follows Order → Payment locking and existing idempotency behavior. Late financial success does not resurrect a cancelled Order.

## 2. Implementation scope

| File | Responsibility |
|---|---|
| `backend/src/payments/payment-reconciliation.config.ts` | Scheduler settings and runtime validation; **production fail-fast** if disabled/misconfigured |
| `backend/src/payments/payment-reconciliation.scheduler.ts` | Bounded due-payment scan, scheduler lifecycle, claim/HTTP/finalizer workflow, per-candidate isolation |
| `backend/src/payments/vnpay-querydr.service.ts` | Order-first locking, lease claim, durable retry, horizon transition, token-fenced release and shared finalization path |
| `backend/src/payments/payments.module.ts` | Nest provider registration |
| `backend/.env.example` | Documented environment variable names and safe placeholders |
| `backend/src/payments/payment-reconciliation.config.spec.ts` | Configuration validation and production fail-fast tests |
| `backend/src/payments/payment-reconciliation.scheduler.spec.ts` | Scheduling/orchestration tests |
| `backend/src/payments/vnpay-querydr.service.spec.ts` | Claim/release and QueryDR-service behavior tests |
| `backend/test/payment-reconciliation.integration-spec.ts` | 14 isolated PostgreSQL scenarios, including finalization, HTTP/DB-lock boundaries and concurrency |

No Prisma schema change, migration or new public HTTP endpoint is introduced by SCRUM-82.

## 3. Runtime configuration (`backend/.env`)

**Policy:** Production **must** run a correctly configured reconciliation scheduler. A missing/false/invalid `PAYMENT_RECONCILIATION_ENABLED` or incomplete QueryDR configuration must cause **startup to fail** rather than quietly disable reconciliation. Only development/test environments may run with reconciliation explicitly disabled. If `NODE_ENV` is missing or unrecognized, a missing enable flag also fails validation; do not treat an unknown runtime as development.

Store actual credentials only in your secure, untracked environment/secrets system. The following are **separate examples**, not two blocks to paste together into one `.env`.

### 3.1 Local development / isolated tests — disabled explicitly

```dotenv
NODE_ENV=development

# Safe local default: no automatic gateway reconciliation requests.
PAYMENT_RECONCILIATION_ENABLED=false
PAYMENT_RECONCILIATION_INTERVAL_MS=60000
PAYMENT_RECONCILIATION_BATCH_SIZE=50
PAYMENT_RECONCILIATION_LEASE_MS=60000
PAYMENT_RECONCILIATION_COOLDOWN_MS=600000

# Not required while disabled; configure only for dedicated QueryDR testing.
# PAYMENT_RECONCILIATION_IP_ADDR=127.0.0.1
# VNPAY_TMN_CODE=<sandbox-merchant-code>
# VNPAY_HASH_SECRET=<sandbox-secret>
# VNPAY_QUERYDR_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
# VNPAY_QUERYDR_TIMEOUT_MS=15000
```

For the isolated PostgreSQL integration suite, use `NODE_ENV=test` when configuring a test process if necessary; the tests use a dedicated allowlisted DB and mock QueryDR transport. Explicit `false` is allowed in **development/test**, not production. To exercise the scheduler against Sandbox from a **dedicated non-production backend**, deliberately set `PAYMENT_RECONCILIATION_ENABLED=true` and supply valid Sandbox credentials, endpoint and backend IP.

### 3.2 Production — enabled and validated (mandatory)

```dotenv
NODE_ENV=production

# Mandatory: cannot be omitted or set to false in production.
PAYMENT_RECONCILIATION_ENABLED=true
PAYMENT_RECONCILIATION_INTERVAL_MS=60000
PAYMENT_RECONCILIATION_BATCH_SIZE=50
PAYMENT_RECONCILIATION_LEASE_MS=60000
PAYMENT_RECONCILIATION_COOLDOWN_MS=600000
PAYMENT_RECONCILIATION_IP_ADDR=<valid-production-backend-IP>

# Replace with approved production merchant credentials and QueryDR endpoint.
VNPAY_TMN_CODE=<production-merchant-code>
VNPAY_HASH_SECRET=<secure-backend-only-production-secret>
VNPAY_QUERYDR_URL=<approved-production-querydr-https-url>
VNPAY_QUERYDR_TIMEOUT_MS=15000
```

**Important:** The angle-bracketed values are placeholders, **not valid deployable settings**. Replace them with actual approved values from the deployment secrets configuration. **Do not use Sandbox credentials or a Sandbox URL for production.** In enabled mode the configuration validates the server IP, signed QueryDR settings and a lease at least `VNPAY_QUERYDR_TIMEOUT_MS + 13000` milliseconds. The cooldown is at least 600,000 ms (10 minutes). The 15-second timeout, 60-second lease, one-minute tick and batch size of 50 are **technical example settings**, not merchant-approved production tuning; validate rate limits, network reachability and multi-replica concurrency before rollout.

**Operational rules:**

- Never commit `backend/.env`, real `VNPAY_HASH_SECRET`, tokens, signed URLs or raw gateway responses. Do not expose them in verification logs.
- Each application replica may run a tick; PostgreSQL claim/lease fencing controls which replica may dispatch QueryDR. Do not disable production scheduler as a workaround for invalid configuration; fix the configuration before deployment.
- In **dev/test**, disable explicitly when requests to Sandbox are not intended. In **production**, invalid/incomplete configuration must block startup and be treated as a deployment failure.

## 4. Build and static verification

From the repository root:

```bash
cd backend
npm ci
npm run db:validate
npm run db:generate
npm run build
npm test
npx vitest run src/payments/payment-reconciliation.config.spec.ts
```

Run these commands on the target branch before approving deployment. `npm run build` is required even though its successful exit status was **not present in the logs supplied for this documentation update**. Reviewer has separately reported code/static checks as PASS.

## 5. Isolated PostgreSQL integration

The integration test enforces the dedicated database target **`localhost:5433/brewlite_test`**. Never use `brewlite_db`, a shared staging database or a production database. Confirm the actual target without printing credentials.

Git Bash (after setting `AUTH_TEST_DATABASE_URL` locally to the dedicated test DB):

```bash
cd backend
# Confirm URL targets exactly localhost:5433/brewlite_test before migrating.
DATABASE_URL="$AUTH_TEST_DATABASE_URL" npm run db:migrate
npm run test:integration -- test/payment-reconciliation.integration-spec.ts
```

PowerShell:

```powershell
cd backend
# Confirm AUTH_TEST_DATABASE_URL targets exactly localhost:5433/brewlite_test.
$old = $env:DATABASE_URL
try {
  $env:DATABASE_URL = $env:AUTH_TEST_DATABASE_URL
  npm run db:migrate
} finally {
  $env:DATABASE_URL = $old
}
npm run test:integration -- test/payment-reconciliation.integration-spec.ts
```

Apply migrations to an intentionally isolated test database only. Do not run `prisma migrate reset` on any shared environment. QueryDR transport is mocked in the PostgreSQL integration suite: this is **not** an actual call to VNPay Sandbox.

## 6. Verified evidence (implementer terminal logs, 2026-11-03)

| Check | Observed result | Scope |
|---|---|---|
| `npm run db:generate` | **PASS** | Prisma Client 7.10.1 generated |
| Focused reconciliation tests (initial implementation) | **16/16 PASS** | Three unit-test files; subset of full suite, not additional tests |
| `npx vitest run src/payments/payment-reconciliation.config.spec.ts` (PR #133 remediation) | **7/7 PASS** | Explicit dev/test disable, invalid config, production fail-fast and unknown runtime |
| `npm test` (after remediation) | **247/247 PASS**, 30/30 files | Backend unit suite, includes the focused tests |
| `npm run test:integration -- test/payment-reconciliation.integration-spec.ts` (after remediation) | **14/14 PASS**, one file | Isolated PostgreSQL + mocked QueryDR transport; concurrency and finalization scenarios |
| `npm run build` | **Not evidenced in supplied terminal logs** | Confirm build exit code separately |
| Live VNPay Sandbox QueryDR / HMAC E2E | **Not yet evidenced** | Requires explicit Sandbox run, credentials and operational approval |
| Independent reviewer runtime/concurrency re-run | **Pending** | Reviewer plans isolated PostgreSQL verification after docs-only update |

These results are from the implementer's logs; they are **not** a claim that an independent reviewer has completed the final run. The Vite `vite-tsconfig-paths` deprecation warning does not change the PASS results.

### PostgreSQL integration coverage — 14/14 PASS in implementer logs

1. Two workers cannot claim the same due Payment simultaneously; persisted cooldown survives worker crash.
2. After Grace, shared expiration cancels Order and leaves unresolved Payment `PENDING`.
3. At horizon, Payment enters manual review without becoming `FAILED` or resurrecting Order.
4. Inconclusive QueryDR retry is persisted without overlapping HTTP.
5. Verified QueryDR **SUCCESS** uses real shared Finalization and credits loyalty only once.
6. Verified QueryDR **FAILED** uses real shared Finalization without loyalty award or premature Order cancellation.
7. Verified **UNKNOWN** records evidence and schedules retry; Payment remains `PENDING`.
8. QueryDR network exception records a sanitized retry without changing Payment to `FAILED`.
9. Two independent scheduler workers never dispatch overlapping QueryDR for one claimed Payment.
10. While HTTP is pending, another PostgreSQL transaction can acquire Order and Payment row locks.
11. A verified IPN wins during QueryDR HTTP; shared finalization does not double-award loyalty.
12. Expiration racing QueryDR keeps Order `CANCELLED`; late financial SUCCESS is recorded for review.
13. Late SUCCESS for a cancelled Order does not resurrect it or award loyalty.
14. A failed candidate does not block healthy Payments in subsequent scheduler scan batches.

**Boundaries:** PostgreSQL concurrency and shared Finalization are exercised with a mocked/verified QueryDR transport interface; IPN-race test uses a signed test callback. These tests establish application behavior **but not real merchant gateway connectivity, merchant rate limits, Sandbox HMAC E2E, or production performance.**

## 7. Acceptance checklist

- [x] Prisma Client generation observed PASS.
- [x] Backend unit suite observed **247/247 PASS**; config fail-fast suite **7/7 PASS**.
- [x] Isolated PostgreSQL integration observed **14/14 PASS** on implementer's machine.
- [x] QueryDR SUCCESS/FAILED via shared Finalization, UNKNOWN/network retry, IPN and expiration races, multi-scheduler lease, HTTP outside DB locks, late SUCCESS and batch isolation covered by isolated PostgreSQL tests.
- [x] After-G expiration and H manual-review transitions covered by isolated PostgreSQL tests; unresolved Payment is not auto-FAILED.
- [ ] Successful target-branch `npm run build` log attached to PR evidence (not present in the supplied logs).
- [ ] Independent reviewer re-runs the isolated 14-case PostgreSQL suite and reviews final results.
- [ ] Actual Sandbox QueryDR/HMAC, merchant rate limits, restart/stale-lease operational behavior and rollout configuration verified where required before shared-environment/production enablement.

**PR #133 docs-only follow-up:** Split local/test and production configuration examples and remove misleading advice to set `PAYMENT_RECONCILIATION_ENABLED=false` in production. Code and test files are unchanged by this documentation revision. Final PR approval/merge remains the reviewer's decision.
