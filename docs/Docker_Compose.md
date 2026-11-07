# BrewLite Docker Compose (SCRUM-91 / P2-17 & SCRUM-92 / P2-18)

## Scope and isolation

The main Compose stack runs four services: `postgres`, `migrate`, `backend`, and
`frontend`. It is separate from the SCRUM-80 verification stack:

- Compose project: `brewlite_compose`
- PostgreSQL database: `brewlite_compose`
- named volume: `brewlite_compose_brewlite_pgdata`
- host database port: `127.0.0.1:${POSTGRES_HOST_PORT:-15432}` (default `15432`, outside the Windows Hyper-V/WinNAT reserved ephemeral range `49152-65535`)
- host backend port: `127.0.0.1:${BACKEND_HOST_PORT:-3001}` (default `3001`)
- host frontend port: `${FRONTEND_HOST_PORT:-3000}` (default `3000`)

Do not point this stack at a development, test, shared, or production database.
It does not reuse SCRUM-80's project, database, port `55480`, or volume.

PostgreSQL 18 stores its data under `/var/lib/postgresql/18/docker`; the named
volume deliberately mounts its parent path `/var/lib/postgresql`.

## Prepare local environment

From the repository root, create a local file from the sample:

- **Git Bash / Linux / macOS**:
  ```bash
  cp compose.env.example compose.env
  ```
- **Windows PowerShell**:
  ```powershell
  Copy-Item compose.env.example compose.env
  ```

Replace every required placeholder with locally generated values.
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` must match their
respective values in `DATABASE_URL`. Keep `DATABASE_URL` aimed at the Compose
service hostname `postgres` and internal port `5432`, never `localhost` or the
host-published port. URL-encode the password portion in `DATABASE_URL` when it
contains reserved URL characters:

```text
DATABASE_URL=postgresql://brewlite:<URL-ENCODED-PASSWORD>@postgres:5432/brewlite_compose?schema=public
```

`compose.env` is ignored by Git. Do not copy existing `.env` files, credentials,
JWT secrets, or VNPay secrets into documentation, issues, or PR evidence.

`--env-file compose.env` supplies values for Compose interpolation. Values are
only passed into a container when `docker-compose.yml` explicitly declares them
under that service's `environment:` block. In particular, no secret is supplied
to `frontend`, and no `NEXT_PUBLIC_*` variable is used.

Exported variables in the current shell have higher interpolation precedence than
`compose.env`. Before every Compose command, run the preflight from the
repository root:

- **Git Bash / Linux / macOS**:
  ```bash
  bash scripts/compose-preflight-env.sh
  ```
- **Windows PowerShell**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  ```

It exits non-zero and prints only conflicting variable names when an exported
variable could override the Compose configuration. It never prints or changes a
secret value. Follow its `unset ...` (or `Remove-Item Env:\...`) instruction,
then rerun the preflight.

## Build and start

Run from the repository root:

- **Git Bash / Linux / macOS**:
  ```bash
  bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env up --build -d
  bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env ps -a
  ```
- **Windows PowerShell**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
  docker compose --env-file compose.env up --build -d
  docker compose --env-file compose.env ps -a
  ```

After changing a Dockerfile, Compose file, or dependencies, run
`docker compose --env-file compose.env up --build -d` (with preflight)
again. `docker compose start` starts existing containers and does not build a
new image.

Startup sequence is:

1. `postgres` becomes healthy through `pg_isready`.
2. `migrate` runs `npm run db:migrate` once and exits successfully (`Exited (0)`).
3. `backend` starts after migration success.
4. `frontend` starts after backend health is reported healthy.

The migration image uses the `migrate` target in `backend/Dockerfile`. That stage
contains Prisma CLI, `prisma7.config.ts`, `schema.prisma`, and all migration
files. The production runtime target remains pruned and does not run migrations.
The `migrate` service can run again when its container is recreated. `prisma
migrate deploy` applies only pending migrations; migrations already recorded as
completed are not applied again.

## Manual demo catalog seed

Seed is manual and may be run only after `migrate` has completed successfully (`exited:0`).
It is not part of `docker compose up`, so starting the stack never inserts demo
catalog data automatically.

Before seeding, deterministically verify that `migrate` has exited with code `0` and that the Compose PostgreSQL container reports the
expected database, nine completed migrations, and no existing products:

- **Git Bash / Linux / macOS**:
  ```bash
  bash scripts/compose-preflight-env.sh && \
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$(docker compose --env-file compose.env ps -a -q migrate)")" = "exited:0" && \
    docker compose --env-file compose.env exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database() AS database_name, (SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL) AS completed_migrations, (SELECT count(*) FROM products) AS product_count;"'
  ```
- **Windows PowerShell**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
  $migrateId = docker compose --env-file compose.env ps -a -q migrate
  if (-not $migrateId -or (docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' $migrateId) -ne 'exited:0') {
    throw "Migration container has not completed with exit code 0"
  }
  'SELECT current_database() AS database_name, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL) AS completed_migrations, (SELECT count(*) FROM products) AS product_count;' | docker compose --env-file compose.env exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  ```

Expected values before the first demo seed are `brewlite_compose`, `9`, and `0`.
Stop and investigate if any value differs; do not use `prisma migrate reset`,
`prisma db push`, or `docker compose down -v` to prepare a database for seed.

The seed guard permits Compose only when all of these are exact: database
`brewlite_compose` (or a dedicated `brewlite_seed_*` database), hostname `postgres`, port `5432`, and
`ALLOW_COMPOSE_DEMO_SEED=true`. Pass the flag directly to the one-shot seed
container; setting it only in Git Bash or PowerShell would not pass it to the container:

- **Git Bash / Linux / macOS**:
  ```bash
  bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env build migrate
  bash scripts/compose-preflight-env.sh && \
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$(docker compose --env-file compose.env ps -a -q migrate)")" = "exited:0" && \
    docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
  ```
- **Windows PowerShell**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
  docker compose --env-file compose.env build migrate
  $migrateId = docker compose --env-file compose.env ps -a -q migrate
  if (-not $migrateId -or (docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' $migrateId) -ne 'exited:0') {
    throw "Migration container has not completed with exit code 0"
  }
  docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
  ```

The `build migrate` step is required after changing or pulling `seed.ts` so the
one-shot container uses the current guarded seed code. It does not start a
container or run the seed.

The seed transaction refuses databases containing a product outside the nine
demo product IDs. It does not delete or deactivate legacy products, reset stock,
or modify orders, payments, or other transaction data. Re-running the seed does
not duplicate rows or reset stock, but can update names and prices of the nine
sample products by design.

Verify the seeded catalog through the API and frontend:

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM toppings) AS toppings;"'
curl --fail --silent http://localhost:3000/api/backend/products | node -e 'let body=""; process.stdin.on("data", (chunk) => body += chunk).on("end", () => { const items = JSON.parse(body).items; if (!Array.isArray(items) || items.length !== 9) process.exit(1); console.log("API product count: 9"); })'
curl --fail http://localhost:3000/images/bac-xiu-kem-beo-phin.jpg
```

## Isolated E2E Verification (`SCRUM-92`)

To run the automated end-to-end integration and restart-persistence verification without stopping or touching your `brewlite_compose` development stack, use `scripts/scrum92/verify_compose_e2e.mjs`. It enforces an isolated Compose project (`-p brewlite_scrum92_e2e`), isolated volume (`brewlite_scrum92_e2e_brewlite_pgdata`), isolated database (`brewlite_seed_scrum92_e2e`), and dedicated host ports (`13000` frontend, `13001` backend, `15492` postgres), and cleans up all exact test IDs in `finally` by default:

```bash
# Start isolated E2E stack (-p brewlite_scrum92_e2e) on ports 13000/13001/15492 and run E2E verification:
node scripts/scrum92/verify_compose_e2e.mjs --up

# Optional: keep created test records in the isolated DB for manual inspection:
node scripts/scrum92/verify_compose_e2e.mjs --keep-artifacts

# Safe recovery / cleanup of exact test records after --keep-artifacts (or before re-running):
node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts

# Tear down the isolated E2E stack when finished:
node scripts/scrum92/verify_compose_e2e.mjs --down
```

Expected database counts are 4 categories, 9 products, and 5 toppings. Open
`http://localhost:3000/` in a browser and confirm that all nine products and
their images render. Do not add `ALLOW_COMPOSE_DEMO_SEED=true` to Compose,
`compose.env`, or any default environment file.

## Logs, status, and smoke checks

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env ps -a
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env logs --tail 100 postgres migrate backend frontend
curl --fail http://localhost:3000/
curl --fail http://localhost:3001/
curl --fail http://localhost:3001/api-docs
curl --fail http://localhost:3000/api/backend/products
```

Use `docker compose ... logs migrate` to confirm migration output. A successful
one-shot `migrate` container is expected to show `Exited (0)`, not `Up`.

The backend healthcheck calls `GET /`. It is a liveness check only: the endpoint
does not query PostgreSQL and is not a database-readiness guarantee.

The frontend browser path remains same-origin:

```text
browser -> http://localhost:3000/api/backend/* -> frontend -> http://backend:3001/*
```

This avoids CORS requirements for normal browser requests.

## Stop, restart, and data preservation

To stop services while preserving the named PostgreSQL volume:

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env stop
```

Start the existing stopped services again:

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env start
```

`docker compose down` removes containers and the network but normally preserves
named volumes. Do **not** use `docker compose down -v` casually: it deletes this
stack's named database volume and its data. Never use it against a database with
data that must be retained.

## Current limitations

- Some frontend service functions have server-side branches that still use
  `NEXT_PUBLIC_API_URL` / `localhost:3001` instead of `BACKEND_INTERNAL_URL`.
  Existing browser UI requests use the same-origin proxy; SSR API fetches need a
  separate frontend change and are outside P2-17.
- The backend `GET /` healthcheck is liveness only, not a full PostgreSQL
  readiness check.
- Docker build and runtime behavior have been verified by the clean-run work in
  P2-18; see `docs/verification/SCRUM92_Docker_Clean_Setup_Verification.md` for full clean-setup verification evidence, exact commands, sanitized outputs, and cross-module findings.
