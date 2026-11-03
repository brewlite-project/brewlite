# BrewLite Docker Compose (SCRUM-91 / P2-17)

## Scope and isolation

The main Compose stack runs four services: `postgres`, `migrate`, `backend`, and
`frontend`. It is separate from the SCRUM-80 verification stack:

- Compose project: `brewlite_compose`
- PostgreSQL database: `brewlite_compose`
- named volume: `brewlite_compose_brewlite_pgdata`
- host database port: `127.0.0.1:55432`

Do not point this stack at a development, test, shared, or production database.
It does not reuse SCRUM-80's project, database, port `55480`, or volume.

PostgreSQL 18 stores its data under `/var/lib/postgresql/18/docker`; the named
volume deliberately mounts its parent path `/var/lib/postgresql`.

## Prepare local environment

From the repository root, create a local file from the sample:

```bash
cp compose.env.example compose.env
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

Exported variables in Git Bash have higher interpolation precedence than
`compose.env`. Before every Compose command, run the preflight from the
repository root:

```bash
bash scripts/compose-preflight-env.sh
```

It exits non-zero and prints only conflicting variable names when an exported
variable could override the Compose configuration. It never prints or changes a
secret value. Follow its `unset ...` instruction, then rerun the preflight.

## Build and start

Run from the repository root:

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env up --build -d
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env ps
```

After changing a Dockerfile, Compose file, or dependencies, run
`bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env up --build -d`
again. `docker compose start` starts existing containers and does not build a
new image.

Startup sequence is:

1. `postgres` becomes healthy through `pg_isready`.
2. `migrate` runs `npm run db:migrate` once and exits successfully.
3. `backend` starts after migration success.
4. `frontend` starts after backend health is reported healthy.

The migration image uses the `migrate` target in `backend/Dockerfile`. That stage
contains Prisma CLI, `prisma7.config.ts`, `schema.prisma`, and all migration
files. The production runtime target remains pruned and does not run migrations.
The `migrate` service can run again when its container is recreated. `prisma
migrate deploy` applies only pending migrations; migrations already recorded as
completed are not applied again.

## Logs, status, and smoke checks

```bash
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env ps
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
- Docker build and runtime behavior must be proven by the clean-run work in
  P2-18; this document does not claim that Docker tests have passed.
