# SCRUM-82 / P2-08 – Payment Reconciliation Scheduler

**Source baseline:** `SCRUM82_backend_snapshot.zip` (`git archive` ZIP comment: `04dcd26045d7ed4a5ce21b806d30d6c261db1552`).
**Target:** branch `SCRUM-82-P2-08-Implement-Payment-Reconciliation-Scheduler` based on `origin/dev`.
**Status:** implementation patch / static syntax review complete; **backend build, PostgreSQL integration and VNPay Sandbox runs NOT yet observed**.
**Dependencies on the snapshot:** P2-04 `VnpayQueryDrClient`, P2-07 `PaymentFinalizationService`, existing Order expiration primitive.

## Intended behavior (BR-03 + BR-05 / API Contract v4.0)

- E = immutable `Order.expiresAt` (Order TTL 15 minutes), G = E+5m, H = G+60m.
- VNPay initiation persists `Payment(PENDING,SCHEDULED,nextQueryAt=E,reconcileUntil=H)`.
- A due PENDING payment gets at most one QueryDR claim while its unexpired PostgreSQL lease is owned by a worker; a new requestId and claimToken are persisted.
- **In the same short transaction as claim**, persist `nextQueryAt = min(H, max(G, dbNow + cooldownMs))`; cooldown is at least 10 minutes. No catch-up burst after worker restart or a failed HTTP request.
- **Order row lock precedes Payment row lock** for claim and horizon transitions, consistent with shared Finalization. The HTTP QueryDR request runs **after** claim commits, with no DB transaction held.
- On a verified SUCCESS/FAILED response, invoke the existing shared `PaymentFinalizationService`; do not reimplement payment or order financial side effects in the scheduler.
- QueryDR UNKNOWN, HTTP timeout, invalid response or transient errors **never auto-FAILED** a Payment. Keep `PENDING` and persist only a safe short error category, not raw gateway content.
- Grace expiry: shared `expireOrderInTransaction` cancels/releases an eligible active Order at/after G, but **does not** convert its unresolved VNPay Payment to FAILED. The existing Order Expiration job also runs independently.
- At/after H, no new QueryDR claims. Mark unresolved `PENDING` payment `REQUIRES_REVIEW`, `reviewReason=AUTO_RECONCILIATION_EXHAUSTED`, `nextQueryAt=NULL`, release expired leases. An in-flight lease begun before H may finish; its verified response still passes through the shared finalizer.
- A worker holding an old/stale token cannot clear a newer claim. IPN/QueryDR races are serialized through the preexisting finalizer and its Order→Payment locks.

## Changes in this patch

| File | Purpose |
|---|---|
| `backend/src/payments/payment-reconciliation.config.ts` | Enabled/tick/batch/lease/cooldown/IP config and runtime validation |
| `backend/src/payments/payment-reconciliation.scheduler.ts` | Bounded due scan, tick lifecycle, claim/network/finalizer orchestration |
| `backend/src/payments/vnpay-querydr.service.ts` | Order-first DB locks, due/cooldown claim, horizon transition, token-fenced lease release; preserves four-argument legacy `releaseClaim` callers |
| `backend/src/payments/payments.module.ts` | Nest DI registration |
| `backend/.env.example` | Opt-in operational settings, no credentials |
| `backend/src/payments/*.spec.ts` (3 files) | Unit tests for configuration, orchestration and lease transitions |
| `backend/test/payment-reconciliation.integration-spec.ts` | PostgreSQL test of concurrent claims, Grace cleanup, horizon and retry/no burst |

No historical migration or Prisma schema is changed. No public HTTP endpoint is added.

## Required environment (backend/.env)

Use your existing secure, untracked `backend/.env` and fill the existing QueryDR variables:

```dotenv
VNPAY_TMN_CODE=<your-sandbox-merchant-code>
VNPAY_HASH_SECRET=<backend-only-sandbox-secret>
VNPAY_QUERYDR_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_QUERYDR_TIMEOUT_MS=15000

# Keep false until DB/tests/gateway verification pass.
PAYMENT_RECONCILIATION_ENABLED=false
PAYMENT_RECONCILIATION_INTERVAL_MS=60000
PAYMENT_RECONCILIATION_BATCH_SIZE=50
PAYMENT_RECONCILIATION_LEASE_MS=60000
PAYMENT_RECONCILIATION_COOLDOWN_MS=600000
PAYMENT_RECONCILIATION_IP_ADDR=<IP-address-of-your-backend-for-VNPay>
```

- Never commit `.env`, real `VNPAY_HASH_SECRET`, signed URLs, access tokens or gateway payloads. Do not expose these in test logs.
- Leave `PAYMENT_RECONCILIATION_ENABLED=false` for source-only verification; set `true` only on the designated **test** backend with verified Sandbox QueryDR credentials. When enabled, a valid IP, QueryDR config and a lease at least `timeoutMs+13000` are mandatory.
- HTTP timeout 15s and lease 60s are **technical test defaults, not merchant-approved final tuning**. Check merchant rate limits, networking and runtime concurrency before production.
- Each application replica runs its own tick, but only DB-claimed payments may call QueryDR. Disable the scheduler in all contexts that should not send gateway requests.

## Validate, generate and build (Git Bash or PowerShell)

From repository root:

```text
cd backend
npm ci
npm run db:validate
npm run db:generate
npm run build
npm test
```

These commands must pass before requesting a PR review. The source snapshot was extracted into a separate working directory, not into the user's Git repo.

## Optional isolated PostgreSQL integration

Integration tests **refuse non-allowlisted DB hosts**. Use only a dedicated migrated `localhost:5433/brewlite_test` (never a shared development DB or production database). Set `AUTH_TEST_DATABASE_URL` to its real connection string *locally*. Example Git Bash command for a new, empty, dedicated test database:

```bash
# Prerequisite: localhost:5433/brewlite_test already exists and is intended only for tests.
cd backend
DATABASE_URL="$AUTH_TEST_DATABASE_URL" npm run db:migrate
npm run test:integration -- test/payment-reconciliation.integration-spec.ts
```

PowerShell (same test DB):

```powershell
cd backend
$old = $env:DATABASE_URL
try {
  $env:DATABASE_URL = $env:AUTH_TEST_DATABASE_URL
  npm run db:migrate
} finally { $env:DATABASE_URL = $old }
npm run test:integration -- test/payment-reconciliation.integration-spec.ts
```

Confirm the URI before migration. `migrate deploy` is used (not `migrate reset`); never run it against a shared database without a designated approval. Existing integration tests in the repository enforce the same localhost:5433/brewlite_test allowlist.

## Acceptance checklist

- [ ] Prisma validate/generate/build PASS on the target branch.
- [ ] Unit tests PASS (configuration, lease/cooldown, safe errors, overlap, horizon).
- [ ] PostgreSQL integration PASS in isolated test DB, including concurrent claims and no duplicate RequestId.
- [ ] E→G QueryDR, after-G grace cleanup/Order CANCELLED while Payment PENDING.
- [ ] VERIFIED SUCCESS and FAILED through QueryDR are handled by the **shared** Finalization Service (including IPN race, with no duplicated stock/coupon/loyalty effects).
- [ ] UNKNOWN/HTTP timeout keeps Payment PENDING with future nextQueryAt.
- [ ] H transition to REQUIRES_REVIEW, never FAILED solely due to elapsed time.
- [ ] Crash/restart, stale lease, multi-worker race, merchant rate limit and HMAC Sandbox integration verified before enabling the job for a shared test environment.

**Known verification gap at handoff:** The patch was syntax-parsed but not built/tested with NestJS dependencies in this environment (`npm ci` could not retrieve all packages). Unit/PG/Sandbox PASS must only be claimed after seeing logs from the user's machine. No Gateway calls or schema migrations were executed in producing this patch.
