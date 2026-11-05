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

## Run safely on Compose dev

1. Confirm exact Docker service names with `docker compose config --services` from repo root, and DB name and host **without printing the password**. Confirm `brewlite_compose` database is a designated nonproduction DB, and tables already exist.
2. In development Compose backend with dev dependencies installed (`tsx` needed):

```bash
# Run from repository root; 'backend' is an example service name. Check compose config first.
docker compose exec \
  -e NODE_ENV=development \
  -e SEED_PROMO_ENV=dev-compose \
  -e SEED_PROMO_ALLOWED_DATABASE=brewlite_compose \
  -e SEED_PROMO_CONFIRM=SEED_PROMO_brewlite_compose \
  backend npm run db:seed:promotion
```

This assumes `DATABASE_URL` already exists inside container with host `postgres:5432`, database `brewlite_compose`. If the Compose runtime image lacks `tsx`, **do not alter production image** to run it: use a dedicated dev tooling container with same network+dependencies. A host-side run is allowed only with a local database mapping `localhost:5432`, plus the same explicit guard vars.

The seed rejects production/staging/unknown `NODE_ENV`, unexpected PostgreSQL host/port, DB not named `brewlite_compose`, missing acknowledgements and missing/malformed URL. It checks `current_database()` before writing. The `SEED_PROMO_CONFIRM` value is an opt-in acknowledgement, not a security credential.

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
