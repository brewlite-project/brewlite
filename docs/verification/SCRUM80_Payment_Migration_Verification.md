# SCRUM-80 / P2-06 – Payment Migration & Database Constraint Verification

**Update:** 2026-11-01 – PR #120 REQUEST CHANGES remediation candidate
**Scope:** verification only. No changes to `schema.prisma` or existing migration SQL.
**Baseline:** 7 Phase 1 migrations + 2 SCRUM-76 migrations (9 in total).
**Status:** previous local/Docker results reported PASS; **new PR #120 workflow and CHECK DML tests are NOT YET EXECUTED on PostgreSQL**.

## 1. Existing observed evidence (from SCRUM-76 / SCRUM-80 terminal logs)

| Test | Evidence observed | Status |
|---|---|---|
| Fresh migration | All 9 migrations on local test DB and Docker test DB | PASS previously |
| Legacy Phase 1 -> Phase 2 | Three fixture Mock Payments (one SUCCESS, two FAILED); `provider=MOCK`, `updated_at=created_at` | PASS previously |
| Legacy fingerprint | Three MD5 fingerprint rows equal before/after | PASS previously |
| Five UNIQUE indexes | Correct `pg_index` metadata + DML UNIQUE errors `23505` | PASS previously, local & Docker |
| Docker repeat `migrate deploy` | `No pending migrations to apply` | PASS previously |
| Catalog seed | `Seed completed: 9 menu products, 5 toppings` | Command PASS; database counts/repeat seed unverified |
| Prisma validate/generate and unit tests | Build PASS; 163/163 tests PASS on earlier source | Previous baseline, not current HEAD |

## 2. PR #120 requested additional evidence

| Major request | Delivered file | Re-execution status |
|---|---|---|
| Reproducible 7 -> 9 upgrade | `scripts/scrum80/run_phase1_upgrade.mjs`, three SQL fixtures `07`..`09` | **PENDING local run** |
| DML negative/positive CHECK tests | `backend/prisma/tests/06_p2_06_check_constraints.sql` (32 negative DML cases, positive fixtures, rollback) | **PENDING local run** |
| Portable guarded runbook | `docs/verification/SCRUM80_Payment_Migration_Runbook.md`, `scripts/scrum80/run_db_checks.mjs` | Static/syntax checked; **PENDING local run** |

### What the upgrade script verifies

1. Check the Compose service and bound port `127.0.0.1:55480` before any DDL.
2. Refuse an existing `brewlite_scrum80_legacy_verify` DB unless `--reset-legacy-db` was explicitly supplied.
3. Create temporary Phase 1 migration-only config and apply exactly seven migrations.
4. Insert three synthetic Phase 1 Mock rows, run `08_legacy_fingerprint.sql`, capture three fingerprints.
5. Validate target DB, expected seven migrations and absence of Phase 2 provider column **before** switching to main config.
6. Apply SCRUM-76 migration #8 and #9, assert `provider=MOCK`, `updated_at=created_at`, statuses and snapshots; compare exact fingerprints.
7. Confirm nine migrations and verify repeated deploy is non-destructive; clean up temporary migration/config files in `finally`.

### CHECK DML test matrix

- `ck_payments_amount_nonnegative`: baseline amount >= 0.
- `ck_payments_provider_shape`: MOCK shape, zero amount and VNPAY payload misuse.
- `ck_payments_nonmock_mask`: no Mock data on ZERO_AMOUNT.
- `ck_payments_gateway_shape`: VNPAY date/correlation metadata.
- `ck_payments_vnp_terminal`: PENDING/terminal finalization requirements.
- `ck_payments_json_objects`: snapshot JSON objects.
- `ck_payments_query_attempts`, `ck_payments_reconcile_shape`, `ck_payments_claim_pair`, `ck_payments_query_history`: scheduler/lease/counters.
- `ck_payments_financial_review`: exception requires review state.
- `ck_gateway_events_identity`, `ck_gateway_events_source`, `ck_gateway_events_amount`, `ck_gateway_events_terminal_evidence`, `ck_gateway_events_exception`, `ck_gateway_events_evidence`, `ck_gateway_events_disposition_outcome`: verified event evidence.

The SQL DML assertions require **SQLSTATE `32514` and the intended CHECK constraint name**; all fixture writes are inside `BEGIN ... ROLLBACK`.

## 3. Reproduce and attach reviewer evidence

From repository root on Git Bash **or** PowerShell:

```text
node scripts/scrum80/run_phase1_upgrade.mjs
node scripts/scrum80/run_db_checks.mjs
node scripts/scrum80/run_db_checks.mjs --legacy
```

For a clean second run against the **same isolated** legacy DB (explicit opt-in):

```text
node scripts/scrum80/run_phase1_upgrade.mjs --reset-legacy-db
```

Record the command, timestamp, commit SHA, Docker image/version, database name, printed PASS assertions, and any FAIL. Do **not** copy `.env.scrum80.local` or gateway credentials. Do not mark new tests PASS until the user actually runs them.

## 4. Constraints and open gates

- PostgreSQL tests do not establish gateway signature correctness, HTTP/E2E concurrency, shared finalization, refund, or real VNPay Sandbox result.
- Historical preservation is demonstrated with **three synthetic Mock rows**, not the production customer dataset.
- Test-only reset never touches `brewlite_db`, and **never** uses `docker compose down -v`.
- Require reviewer re-run, CI/real Docker evidence, and PR #120 re-review before status Done.

## PR #120 follow-up coverage (2026-11-02; pending runtime re-run)

- Expanded `06_p2_06_check_constraints.sql` to **32 negative `expect_check` calls** (each checks SQLSTATE `32514` and exact constraint name), **6 positive `expect_valid` calls**, and a valid terminal `VNPAY FAILED` insert; this is a static source count, **not yet a PostgreSQL PASS**.
- Added five missing VNPAY gateway metadata-null cases; ZERO_AMOUNT missing response; REQUIRES_REVIEW/reason positive and negative; claim/lease pair; valid QueryDR history and invalid request id.
- Added `scripts/scrum80/bootstrap_default_db.mjs`: guarded clean Compose default DB -> migrate deploy -> migrate status -> repeated deploy; **not yet run on the user's Docker**.
- Earlier runtime PASS evidence applies to the **prior** CHECK test version only; rerun the expanded test suite on default and legacy databases before reporting new tests PASS.
