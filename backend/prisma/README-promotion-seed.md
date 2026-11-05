# Demo promotion seed

`seed-promotion.ts` is an opt-in, local-only seed for coupon demos. Run it only
against a dedicated PostgreSQL test database that has already been migrated.
It is not the regular `npm run db:seed` command; that command invokes the menu
seed in `prisma/seed.ts`.

From PowerShell in `backend/`, set process-only values and run the standalone
script:

```powershell
$env:DATABASE_URL = '<local PostgreSQL test database URL>'
$env:SEED_PROMO_ALLOWED_DATABASE = '<exact database name from DATABASE_URL>'
npx tsx prisma/seed-promotion.ts
```

The script verifies the database name against `SEED_PROMO_ALLOWED_DATABASE`,
requires a local host (`localhost`, `127.0.0.1`, or `::1`), checks the connected
database, then asks for `SEED PROMO <database-name>` before inserting. Do not
commit or print the connection URL. Do not use a demo or production database.

It inserts `WELCOME20`, `GIAM50K`, `FREE100`, `EXPIRED10`, and keeps the existing
`BREWLITE10K` and `QUOTA1K` demo codes. `EXPIRED10` is expired at seed time;
the others get a 30-day window. Insertion uses `createMany(skipDuplicates)`:
reruns leave existing coupon dates, configuration, `activeUsageCount`, and all
redemptions untouched. No reset/drop command is part of this workflow.
