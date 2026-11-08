# SCRUM-76 / P2-02 — Phase 2 Payment Prisma Schema & Migration (Review Kit)

**Status: SOURCE-COMPLETE / STATIC-REVIEWED / NOT APPLIED / DB VERIFICATION PENDING**
**Date:** 2026-10-31
**Target:** `SCRUM-76-P2-02-Extend-Payment-Prisma-Schema-Create-Migration`
**Scope:** Prisma schema, additive PostgreSQL migrations, SQL constraint tests, preserving Phase 1 Mock data. This is not the VNPay Gateway, frontend, IPN, QueryDR worker or finalization implementation.

## 1. Inputs actually reviewed

- `schema(1).prisma`: 11 existing Prisma models, Payment SUCCESS/FAILED and required method/responseSnapshot.
- `migrations(1).zip`: 7 Phase 1 SQL migrations, including active Order and one SUCCESS/Order partial UNIQUE indexes.
- `payments(1).zip`: Mock Payments controller/service, replay, tests and response snapshot reader.
- `orders.zip`, `inventory-policy.ts`: Order creation, history and shared expiration primitive; see cutover warnings.
- `package.json`: Prisma CLI and client `^7.10.1`, `db:validate` and `db:generate` scripts.
- `prisma7.config.ts`: schema/migration paths and `DATABASE_URL` / `SHADOW_DATABASE_URL`.
- `BrewLite_API_Contract_v4.0.md`: Review 3 Corrected Candidate, API-01..API-07, MC/OH and migration acceptance.
- `BrewLite_Payment_Architecture_Phase2_v1.0(1).md`: Final Review Candidate, shared finalization and scheduler boundaries.
- ERD/Prisma Delta v0.2.2 and DBML v0.2.2 (read-only reference copies in `reference/`).

**Approval discrepancy to resolve:** API Contract v4.0 header says `NOT APPROVED — REVIEW 3 COMPLETE, EXTERNAL DEPENDENCIES OPEN`, while its scope note says `APPROVED – API DESIGN BASELINE` based on Leader's reported decision. This kit uses its specified storage requirements, but does NOT assert signed-off production/implementation approval.

## 2. Deliverables

- `backend/prisma/schema.prisma`: proposed full schema (12 models: 11 old + new `PaymentGatewayEvent`). No existing Order/Catalog/Auth/Coupon models changed.
- `backend/prisma/migrations/20261031190000_scrum76_payment_pending_enum/migration.sql`: add `PaymentStatus.PENDING` **BEFORE SUCCESS** to preserve Prisma enum ordering; separately committed migration avoids using newly added enum value before commit.
- `backend/prisma/migrations/20261031190100_scrum76_payment_gateway_delta/migration.sql`: add providers, reconciliation and gateway event model, indexes, checks, Mock backfill and persisted `updated_at`. This second migration uses a **single PostgreSQL transaction** so a failing CHECK rolls back the whole physical delta.
- The original seven migration folders and `migration_lock.toml` are included only for offline reproducibility / fresh disposable test DB. Do NOT replace historical migration files already in the repository.
- `tests/01_preflight_phase1.sql`: READ ONLY inventory of Phase 1 database.
- `tests/02_postflight_assertions.sql`: READ ONLY checks for enum, partial unique indexes, 19 Payment/Gateway Event constraints, FK, Mock backfill.
- `tests/03_constraints_rollback.sql`: INSERT-based positive/negative fixture test, **ROLLBACK** at end; use disposable DB only.
- `tests/static_audit.py`: offline structural comparison with reference DBML.

### Designed persistence invariants

- Payment provider `MOCK | VNPAY | ZERO_AMOUNT` required; no permanent default on `provider` after historical backfill.
- `PaymentStatus` `PENDING | SUCCESS | FAILED`, terminal SUCCESS/FAILED; no EXPIRED enum.
- `method` and `response_snapshot` nullable physically; Mock requires both via CHECK; VNPay must have SQL NULL response snapshot.
- `payments.updated_at` persisted, historical Mock initialized from `created_at`; **service explicitly touches timestamps using DB time** in future Phase 2 updates (no `@updatedAt` or triggers).
- `payment_gateway_events`: verified observations only, FK RESTRICT, unique `(payment_id,source,event_identity)`, no raw secrets.
- Keep old `uq_orders_one_active_per_user` and `uq_payments_one_success_per_order`; add `uq_payments_one_pending_vnpay_per_order` filtered to provider VNPAY + status PENDING.
- Reconciliation state & lease metadata on `payments` only; no reconciliation table.
- DB CHECKs do NOT verify HMAC, match cross-table amount/user/deadline or make gateway events append-only. These require Backend/transaction tests.
- **Do not misinterpret `Payment.SUCCESS` as always implying `Order.PAID`.** Late financial SUCCESS and missing trusted paid timestamp still require approved finalization logic.

## 3. Essential cutover block: Mock writer must change BEFORE applying to shared DB

**The existing `payments.service.ts` currently creates Mock Payment rows without `provider`.** The new schema deliberately sets `payments.provider NOT NULL` **without a permanent DEFAULT**. Therefore existing Mock writes would fail immediately after this migration unless Backend code is deployed alongside the schema. The Phase 2 `PaymentsService` integration owner must explicitly write `provider: 'MOCK'` (and use explicit DB timestamp touch policy for subsequent mutations), while preserving existing mock `requestHash`, `responseSnapshot`, replay DTO and HTTP 200 behavior. The current `OrdersService.getMine()` reads all selected SUCCESS/FAILED via Mock `readPaymentSnapshot`; it cannot safely read VNPay/ZERO_AMOUNT without the Phase 2 provider-aware Order History projection (separate owner/task).

**Do not migrate a shared/test-in-use DB before code is compatible.** Apply to disposable clone first, then plan a controlled write pause/cutover. This kit intentionally contains no Payment/Order API refactor because that is outside P2-02 and allocated to separate workstreams.

## 4. Git Bash: review and integrate into your SCRUM-76 branch

From repository root `D:/Projects/brewlite`:

```bash
# Confirm correct branch and repository status.
git branch --show-current
git status --short
git fetch origin --prune
git log --oneline HEAD..origin/dev
```

If `origin/dev` has commits not yet in the branch, reconcile/merge before copying files. Do not overwrite uncommitted changes, and do not blindly merge a branch already containing divergent SCRUM-76 code.

Extract this ZIP to a temporary local directory; copy ONLY the **new** schema and two new migration folders:

```bash
# Example after extracting into ~/Downloads/SCRUM76_P2_02_Review_Kit:
cp "$HOME/Downloads/SCRUM76_P2_02_Review_Kit/backend/prisma/schema.prisma" backend/prisma/schema.prisma
cp -r "$HOME/Downloads/SCRUM76_P2_02_Review_Kit/backend/prisma/migrations/20261031190000_scrum76_payment_pending_enum" backend/prisma/migrations/
cp -r "$HOME/Downloads/SCRUM76_P2_02_Review_Kit/backend/prisma/migrations/20261031190100_scrum76_payment_gateway_delta" backend/prisma/migrations/

git diff -- backend/prisma/schema.prisma
git status --short
```

If migration folder names already exist, compare their SQL instead of overwriting. Ensure no conflict with later migrations already merged on your branch. Do not commit the ZIP or database credentials.

## 5. Local offline/Prisma validation (after copying into repository)

From `backend/`:

```bash
npm ci
npx prisma validate --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

Prisma 7.10.1 requires the project's installed packages and config. These commands validate syntax/generate client; they do **not** prove SQL CHECKs/partial UNIQUE or preserve live data.

For static audit, from the extracted review kit root:

```bash
python tests/static_audit.py
```

## 6. Test migration on a NEW, ISOLATED PostgreSQL database

**Never point the following at the shared `brewlite_db` until code compatibility + approval.** Make a disposable database, e.g. `brewlite_scrum76_verify`, under a user with appropriate privileges. `DATABASE_URL` must reference ONLY the disposable database. Set environment variables privately, not inside committed scripts or terminal screenshots. Prisma Migrate `deploy` uses the existing 7 migrations and applies 2 new ones in order.

For an empty disposable DB:

```bash
cd backend
npx prisma migrate deploy --config prisma7.config.ts
# From repository root, psql (using the same test DATABASE_URL) can run:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f '<extracted-kit>/tests/02_postflight_assertions.sql'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f '<extracted-kit>/tests/03_constraints_rollback.sql'
```

For **nonempty Phase 1 upgrade** (required, not optional): restore a sanitized Phase 1 backup into a *different* disposable clone, with ONLY the seven existing migrations applied; use `01_preflight_phase1.sql`; record original legacy Payment IDs/status/key/hash/amount/snapshots/created_at. Then apply only the two new migrations and run postflight + rollback tests. Verify all pre-existing fields byte-for-byte/JSON structurally equal; only `provider=MOCK` and `updated_at=created_at` are intentionally added. No reset or `db push` on shared databases.

**Caution:** there may be a schema/migration mismatch or previously manual migrations on your actual database. Check `npx prisma migrate status --config prisma7.config.ts` and migrate history **before running deploy**; stop on drift rather than mark resolved arbitrarily.

## 7. Definition of Done and verification gates

| Gate | At package creation | How to complete |
|---|---|---|
| Input code/contract/migrations reviewed | YES | Source-based static review |
| Prisma schema extension written | YES | New schema file |
| 7 original migrations untouched | YES | Original bytes copied unchanged |
| Two ordered new migrations written | YES | SQL + backfill/index/CHECK |
| Static schema/DBML 19 CHECK correspondence | PASS | `python tests/static_audit.py` |
| Prisma validate | NOT RUN | Must run after `npm ci` on local machine |
| Prisma Client generate | NOT RUN | Must run on local machine |
| PostgreSQL empty DB migrate | NOT RUN | Run on disposable DB |
| PostgreSQL Phase1-data upgrade and compare | NOT RUN | Run on disposable clone with records |
| UNIQUE/CK/FK negative tests | NOT RUN | Run psql scripts on disposable DB |
| Mock API, Order History, E2E regression | BLOCKED BY BACKEND CHANGES | Separate tasks; coordinate cutover |
| Review/Approval for deploying to shared DB | PENDING | Leader/Backend approval |

## 8. Explicit out-of-scope verification

- API v4.0 specifies request replay, status and exception UI projection; those are **not** additional DB columns. `canRetry`, `requiresReview`, `resolution`, `PaymentSummary`, order-level `lastUpdatedAt` are derived over **all** Order payments and gateway events.
- The L2 rule (SUCCESS evidence with missing trusted pay time, Grace and late outcomes) requires backend finalization/race tests; schema alone cannot prove it.
- L3 lease/timeout/rate limits remain Backend/Sandbox VERIFY; the DB only stores timestamps and claim tokens, no hardcoded 60-second duration.
- `Order.updatedAt` is **not** `@updatedAt` in source; Backend must update it explicitly with DB clock, otherwise order-level lastUpdatedAt projection can be stale.
- Production credentials, live VNPay callbacks, production payment and automated refund are out of scope.

**Next user action:** validate Prisma locally on your SCRUM-76 branch, then migrate two isolated test databases, send only safe command outputs if an error occurs.
