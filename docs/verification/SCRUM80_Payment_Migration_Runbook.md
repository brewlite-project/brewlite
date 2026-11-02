# SCRUM-80 / PR #120 – Portable migration verification runbook

## Purpose & safety

Verification reproduces Phase 1 -> Phase 2 with **exactly seven baseline and two SCRUM-76 migrations**. Run against a dedicated **Docker Compose PostgreSQL only**, never the shared or production DB. The helper targets **`127.0.0.1:55480`** and the isolated databases `brewlite_scrum80_verify` / `brewlite_scrum80_legacy_verify` only. No existing migration is modified.

## Copy test scripts to repository before running

Unzip the review kit and copy **all four SQL files `06`–`09`**, both `scripts/scrum80/*.mjs` and the updated verification docs into their matching repository-relative paths. Do not run test scripts straight from an extracted ZIP folder without copying its SQL fixtures. `node --check` verifies syntax only; a real workflow must print `[SCRUM80]` progress and SQL PASS results.

## Prerequisites

From the **repository root** (no machine-specific drive paths):

- Node.js/npm dependencies installed in `backend/` (`cd backend && npm ci` or PowerShell `Set-Location backend; npm ci`).
- Docker Desktop Engine running, Compose file `compose.scrum80.test.yml` checked in from SCRUM-80.
- Local `.env.scrum80.local` in root containing only `SCRUM80_DB_PASSWORD=<your-local-generated-password>`. It is **not** committed. Ensure it is ignored with local `.git/info/exclude` or `.gitignore` (do not commit an actual password).
- Docker image `postgres:18-alpine` and exposed test port `127.0.0.1:55480` per the isolated Compose file.

## Create a local test-only password (works in both shells)

From repository root run once (Node is already a Backend dependency). The command **does not overwrite an existing file**:

```text
node -e "const fs=require('node:fs'),c=require('node:crypto');if(!fs.existsSync('.env.scrum80.local'))fs.writeFileSync('.env.scrum80.local','SCRUM80_DB_PASSWORD='+c.randomBytes(24).toString('hex')+'\n')"
```

Keep `.env.scrum80.local` untracked and ignored, for example add `/.env.scrum80.local` to `.git/info/exclude` through your editor. Do not print its contents into PR evidence.

## Git Bash: start isolated container

```bash
# Run from repository root (check: ls backend/package.json)
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml config --services
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml up -d postgres
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml ps
```

## PowerShell: start isolated container

```powershell
# Run from repository root (check: Test-Path backend/package.json)
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml config --services
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml up -d postgres
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml ps
```

Wait for `postgres` to be healthy before running scripts. Confirm no production connection string is being used.

## Both Git Bash and PowerShell: bootstrap CLEAN default Compose database first

On a fresh Compose volume, `brewlite_scrum80_verify` exists **without tables or migrations**. `run_db_checks.mjs` intentionally refuses that state. After `up -d postgres`, run the guarded bootstrap runner from the repository root:

```text
node scripts/scrum80/bootstrap_default_db.mjs
```

This checks the isolated Compose service/port and exact database name **before** Prisma calls, reads `SCRUM80_DB_PASSWORD` from the local ignored file, builds `DATABASE_URL` for Docker port `55480`, then runs **Prisma migrate deploy → migrate status → deploy again** using the repository's `backend/prisma7.config.ts`. It refuses migration histories outside the exact nine expected migrations, never drops tables or resets volumes. The second deploy is a non-destructive repeatability check. `migrate status` is not a substitute for applying migrations.

Only then run:

```text
node scripts/scrum80/run_db_checks.mjs
```

For a repeat on the same volume, run `bootstrap_default_db.mjs` and `run_db_checks.mjs` again; no reset is required. For an actual **fresh** database, use a new isolated Compose project/volume only after explicitly deciding what to do with existing fixture data. **Do not use `down -v` on a volume containing valuable data.**

## Both Git Bash and PowerShell: Phase 1 -> Phase 2

The scripts resolve the repo root from their own location. Do not `cd` to a hard-coded machine path. The first run will create only the dedicated legacy test database and **refuse to overwrite an existing one**.

```text
node scripts/scrum80/run_phase1_upgrade.mjs
```

The runner performs `prisma migrate deploy --config <temporary-phase1-config>`, inserts synthetic FAILED/SUCCESS Mock, captures and compares legacy fingerprints, then executes `prisma migrate deploy --config prisma7.config.ts`, `prisma migrate status`, post-upgrade SQL assertion and repeat-deploy verification. Each migrate stage is guarded against a wrong DB **before** running.

## Both Git Bash and PowerShell: CHECK and UNIQUE verification

```text
node scripts/scrum80/run_db_checks.mjs
node scripts/scrum80/run_db_checks.mjs --legacy
```

This runs `05_p2_06_index_catalog.sql`, `04_p2_06_unique_constraints.sql`, and new `06_p2_06_check_constraints.sql` inside Docker using input streams and `psql -v ON_ERROR_STOP=1` for exact DB target. It works without local `psql` binaries and without Bash-only `<` redirection.

## Explicit safe clean rerun (only legacy fixture DB)

The initial run refuses `brewlite_scrum80_legacy_verify` if it already exists. To deliberately recreate **only that dedicated DB**, run from the same repo root:

```text
node scripts/scrum80/run_phase1_upgrade.mjs --reset-legacy-db
```

This explicit flag permits `DROP DATABASE ... WITH (FORCE)` **only** on the hard-coded Docker test database `brewlite_scrum80_legacy_verify` after verifying the Compose service and test port. It does **not** delete the entire Docker volume, reset the shared DB, or reset `brewlite_scrum80_verify`. Data previously placed in this *isolated legacy test database* will be deleted by the flag; never use this database for anything but the fixture.

To stop test containers without data loss (works in either shell):

```text
docker compose --env-file .env.scrum80.local -f compose.scrum80.test.yml stop postgres
```

**Do not run** `docker compose down -v`, `prisma migrate reset`, or `prisma db push` on any shared environment.

## Reviewer evidence and expected results

Capture terminal output including: exact database; seven Phase 1 migrations then two Phase 2 migrations; `3/3 MOCK, 1 SUCCESS, 2 FAILED`; three unchanged fingerprints; nine migrations up-to-date; `No pending migrations to apply`; 5 UNIQUE indexes; 32 targeted CHECK negative cases plus 6 explicit positive DML updates (and one valid VNPAY FAILED fixture); each DML suite `ROLLBACK`. Redact secrets before attachment and update `SCRUM80_Payment_Migration_Verification.md` from PENDING to PASS **only after actual execution**.
