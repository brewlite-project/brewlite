# Dev Compose coupon seed (INSERT-only)

This is **not** a replacement for SCRUM-53's `prisma/seed-promotion.ts` or `src/promotions/promotion-seed-data.ts`.
It is an opt-in, development/test **only** seed for the existing `brewlite_compose` database.

## Voucher fixtures

| Code | Type | Value | Min subtotal (VND) | Max discount | Total limit | Per user |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| WELCOME20 | PERCENT | 20 | 50000 | 30000 | 100 | 1 |
| GIAM50K | FIXED | 50000 | 200000 | no cap | 50 | 1 |
| FREE100 | PERCENT | 100 | 0 | no cap | 20 | 1 |
| BREWLITE10K | FIXED | 10000 | 50000 | no cap | 100 | 1 |
| QUOTA1K | FIXED | 1000 | 0 | no cap | 1 | 1 |

- Uses Prisma schema enum names `PERCENT`, `FIXED`; money-related fields are BIGINT.
- Every new coupon gets a 90-day validity window. Repeated runs never renew old coupons.
- Existing `Coupon.code` rows are **never updated** even if existing limits differ, expired, or redeemed. Missing coupons are inserted with `createMany({skipDuplicates:true})`. No delete, reset, migration or redemption change.
- Beware preexisting SCRUM-53 records: BREWLITE10K may have `perUserLimit=2`, QUOTA1K may have `minSubtotalVnd=10000`. Script prints `REVIEW` drift but leaves them untouched; decide separately with team if the existing records need correction.

## Run against the existing local Docker Compose database (host-side)

**Do not use `docker compose exec backend npm run db:seed:promotion`.** The
production Backend image intentionally has no `tsx` devDependency and no
`prisma/` source directory. This seed runs from **host-side Node.js tooling**,
not the production runtime image. No changes to the Backend Dockerfile or
production dependencies are required.

1. From the **repository root**, make sure the expected Compose PostgreSQL is
   running (and `migrate` succeeded), and check its published port:

```bash
# Git Bash; existing Compose project, with a local untracked compose.env
cd /d/Projects/brewlite-coupon-seed
# Read-only status, no volume reset or schema changes:
docker compose --env-file compose.env ps postgres migrate
# Expected local host mapping for postgres: 127.0.0.1:55432 -> 5432
```

2. On the **host**, with Node.js and backend devDependencies installed, generate
   the Prisma Client if necessary. The launcher reads `../compose.env` by default (or an explicitly selected `SEED_PROMO_COMPOSE_ENV_FILE`), validates
   the container-side DSN `postgres:5432/brewlite_compose`, and maps it to
   `127.0.0.1:55432/brewlite_compose` for the local Windows host. It never prints
   the password and does not modify `compose.env`.

```bash
cd /d/Projects/brewlite-coupon-seed/backend
npm ci
npm run db:generate
# Explicit opt-in; execute twice to verify idempotence:
SEED_PROMO_CONFIRM=SEED_PROMO_brewlite_compose npm run db:seed:promotion
SEED_PROMO_CONFIRM=SEED_PROMO_brewlite_compose npm run db:seed:promotion
# On the second run: 0 new (if first run inserted all missing codes).
```

If your **actual local Dev Compose project** is started from the main checkout
`D:/Projects/brewlite` rather than the coupon feature worktree, point this
host-side launcher at the main checkout's untracked `compose.env`, **without
copying secrets between worktrees**:

```bash
# Git Bash, run from D:/Projects/brewlite-coupon-seed/backend
SEED_PROMO_COMPOSE_ENV_FILE=/d/Projects/brewlite/compose.env \
SEED_PROMO_CONFIRM=SEED_PROMO_brewlite_compose npm run db:seed:promotion
```

This override changes only which local Compose configuration file is read; it
**does not** relax the guard. It still requires `brewlite_compose`, the internal
`postgres:5432` URL, matching configured credentials, and the host mapping
`127.0.0.1:55432`. It fails if that DB is unreachable, its password is wrong,
or migrations have not created the `coupons` table. Verify the `postgres` service
is running and `migrate` exited successfully before using it. The published
host port must be bound to loopback, not a remote host.

The script **never** calls `prisma migrate reset`, `docker compose down -v`,
`DELETE`, or `TRUNCATE`. It uses only INSERT (with conflict ignore) and SELECT;
existing `activeUsageCount`, redemption and voucher configuration are preserved.

For an advanced **container-side** dev-tooling environment that has `tsx`, the
underlying script is still available via
`npm run db:seed:promotion:manual` with explicit guard environment variables,
using the container-internal `postgres:5432` URL. **Do not** run this manual
command inside the pruned production Backend container.

The guard accepts **only** `postgres:5432` inside Compose and
`localhost:55432` / `127.0.0.1:55432` on the host, all targeting exactly
`brewlite_compose`. Host-side port 5432 is deliberately rejected to avoid
accidentally modifying an unrelated local PostgreSQL instance. Unknown,
staging and production `NODE_ENV` values fail closed, as do missing approval
variables or unexpected host/port/database overrides.

**Important:** `brewlite_compose` on the developer's local Docker engine is
not automatically the team's shared dev database. Obtain explicit approval
and a verified target before performing a shared-environment seed.

## Verification before PR review

```bash
cd backend
npm ci
npm run db:generate
npm run build
npx vitest run prisma/seed-compose-coupons.policy.spec.ts
npm test
```

Only with explicit authorization for the *dev Compose* DB, run seed twice. Second run must report `0 new`. Use read-only SQL snapshots before and after to confirm all preexisting coupon `active_usage_count` values, `coupon_redemptions` rows, and previously existing code/validity values remain unchanged. No DB operations are needed for static verification.

**Never** run `prisma migrate reset`, `prisma db push --force-reset`, `TRUNCATE`, `DELETE`, or `npm run db:seed` as part of this coupon-seed task.
