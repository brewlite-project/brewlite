## Seed demo Customer users (local development only)

`backend/prisma/seed-users.ts` inserts **two** demo Customers for Auth (SCRUM-41) and Checkout (SCRUM-43) integration testing. It is separate from `prisma/seed.ts` and does **not** seed or modify Product Catalog data, existing User records, orders, or loyalty points.

### Safety rules

- PostgreSQL host must be local (`localhost`, `127.0.0.1`, or `::1`). Remote/production connections are rejected, regardless of `NODE_ENV`.
- Database name in `DATABASE_URL` must **exactly equal** `SEED_DEMO_ALLOWED_DATABASE`; names containing `prod`, `production`, `staging`, `stage`, or `live` as separate name segments are rejected.
- The script queries PostgreSQL `current_database()`, prints the destination and demo emails, and requires the operator to type **`SEED <database_name>`** interactively before writing.
- Existing accounts are never updated or deleted. Repeated runs skip conflicting UUID/email rows via `skipDuplicates`. This is a development helper, **not** an automatic app startup task or a production seed.

### Run from Git Bash

```bash
cd /d/Projects/brewlite/backend

# Ensure backend/.env DATABASE_URL points to the intended LOCAL development DB.
# Example database: brewlite_dev_v2 (your actual local name may differ).
npx --no-install prisma migrate status --config prisma7.config.ts

# Explicitly allow exactly the database you want to modify:
export SEED_DEMO_ALLOWED_DATABASE=brewlite_dev_v2

# Enter a demo password without showing it in command history or terminal:
read -rsp 'Demo password (8+ characters): ' SEED_DEMO_USER_PASSWORD
echo
export SEED_DEMO_USER_PASSWORD

npx --no-install tsx prisma/seed-users.ts
# Check printed host/database. Type: SEED brewlite_dev_v2

unset SEED_DEMO_USER_PASSWORD SEED_DEMO_ALLOWED_DATABASE
```

**Do not** run the Product Catalog seed (`npx prisma db seed`) as a substitute for this separate script. Never put real or shared passwords in source control or README. `.env` and local credentials must remain uncommitted. Demo accounts are not for production.

### Verify in PostgreSQL (read-only)

```bash
psql -h localhost -p 5432 -U postgres -d brewlite_dev_v2 \
  -c "SELECT email, full_name, loyalty_points, (password_hash LIKE '\$argon2id\$%') AS is_argon2id FROM users WHERE email IN ('demo.customer1@brewlite.test','demo.customer2@brewlite.test') ORDER BY email;"
```

Expect two rows with `loyalty_points = 0` **for newly created accounts** and `is_argon2id = t`. If a matching account existed previously, its password hash and loyalty balance intentionally remain unchanged. Run the script twice to confirm that the second run skips existing accounts (it will still require confirmation).

### Validation before PR

```bash
cd /d/Projects/brewlite/backend
npm run db:validate
npm run db:generate
npm run build
cd ..
git diff --check
git status --short
```
