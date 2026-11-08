# BrewLite backend Docker handoff (SCRUM-89)

This document covers the NestJS backend image only. It does not add or change
the repository Compose file. The current root `docker-compose.yml` is empty;
HKhang can integrate this image into the system Compose task separately.

## Image and build context

- Base: official `node:26-bookworm-slim` for both stages. Node 26 is Active LTS
  as of 2026-11-01, Prisma's lockfile engine range accepts Node 26, and the
  official image publishes the Bookworm slim tag. See the
  [Node.js release schedule](https://github.com/nodejs/Release#release-schedule),
  [official Node image tags](https://hub.docker.com/_/node), and
  [Prisma system requirements](https://www.prisma.io/docs/orm/reference/system-requirements).
- Debian Bookworm uses glibc. This avoids Alpine's musl compatibility risk for
  the Argon2 native addon and keeps Prisma's supported Linux runtime libraries
  available. The compiler toolchain is installed only in the build stage; the
  runtime stage installs only shared libraries.
- Run the build from `backend/`; that directory owns both `Dockerfile` and
  `.dockerignore`. The image does not use host `node_modules`, `dist`, or
  `src/generated/prisma`.
- The build runs `npm ci`, Prisma Client generation with
  `prisma7.config.ts`, Nest compilation, then prunes dev dependencies. The
  generated client is compiled into `dist/generated/prisma`; runtime includes
  the production dependencies (`@prisma/client`, `@prisma/adapter-pg`, `pg`,
  `argon2`, Nest runtime packages, and `dotenv`) but not Prisma CLI, Nest CLI,
  `tsx`, or TypeScript.
- `DATABASE_URL` in the generate layer is a non-secret placeholder used only
  to parse the Prisma config. It is not an image `ENV`, is not used to connect,
  and is not a runtime default.

## Build and run (PowerShell)

Prepare an env file outside the image/build context. It must contain real
runtime values locally; do not commit it or put it in Docker build arguments.
The required keys are `DATABASE_URL` and `JWT_SECRET` (at least 32 UTF-8
bytes). Example shape only:

```dotenv
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<database>?schema=public
JWT_SECRET=<random-secret-at-least-32-bytes>
```

Build and start:

```powershell
Push-Location backend
try {
    docker build --pull -t brewlite-backend:local .
} finally {
    Pop-Location
}

$runtimeEnvFile = Read-Host 'Full path to the runtime env file outside the build context'
docker run -d --name brewlite-backend-local `
    --env-file $runtimeEnvFile `
    -p 3001:3001 `
    brewlite-backend:local
```

The application listens on `PORT`, defaulting to the existing project port
3001. `EXPOSE 3001` documents that default; it does not override a supplied
`PORT`. Check that the container remains running, then call both routes:

```powershell
docker ps --filter 'name=brewlite-backend-local'
Invoke-RestMethod http://localhost:3001/
Invoke-RestMethod http://localhost:3001/products
```

`GET /` returns `Hello World!` and checks HTTP liveness only. `GET /products`
executes a Prisma query; after migrations, an empty database is valid and
returns an empty `items` array. It is the DB connectivity smoke check. View
logs and stop the container with:

```powershell
docker logs --tail 100 brewlite-backend-local
docker stop --time 30 brewlite-backend-local
```

Remove only this task's test container when it is no longer needed:

```powershell
docker rm brewlite-backend-local
```

The image runs as the built-in non-root `node` user. Verify this and verify no
env file was copied with:

```powershell
docker image inspect brewlite-backend:local --format '{{.Config.User}}'
docker run --rm --entrypoint sh brewlite-backend:local -c 'test ! -e /app/.env && test ! -e /app/.env.example'
```

The `CMD` uses exec form (`node dist/main.js`), and `main.ts` enables Nest
shutdown hooks. `docker stop --time 30` therefore sends SIGTERM to Node and
allows Nest lifecycle hooks, including Prisma disconnect, to run. The SCRUM-89
smoke test confirmed the backend container exited with code 0 after this stop.

## Runtime configuration and PostgreSQL addressing

| Variable | Requirement | Behavior |
| --- | --- | --- |
| `DATABASE_URL` | Required | Prisma PostgreSQL adapter connection string. Prisma connects during Nest startup. |
| `JWT_SECRET` | Required | At least 32 bytes; there is no fallback secret. |
| `PORT` | Optional | HTTP port; defaults to 3001. Publish the same port with `-p`. |
| `INTERNAL_SECRET` | Optional at boot | Required to use the internal Order advance endpoint; the Guard fails closed without it. |
| `ORDER_EXPIRATION_ENABLED` | Optional | Defaults to `true`; accepts only `true` or `false`. |
| `ORDER_EXPIRATION_BATCH_SIZE` | Optional | Defaults to `50`; valid range is 1–1000. |

When PostgreSQL runs directly on the Windows host, use
`host.docker.internal` in the container URL and the host's published port (for
example, 5433 if that is the configured host port). Do not use `localhost` in
the container to address a host PostgreSQL service. When PostgreSQL is another
container on the same Docker network, use its Compose service/container name
and its internal port (normally `postgres:5432`), not the host-published port.

Prisma connects as part of Nest startup, so HKhang's Compose configuration
should wait for PostgreSQL readiness (for example, `depends_on` with a
PostgreSQL health condition). No app health endpoint or Docker `HEALTHCHECK`
has been added. `/` is liveness; `/products` is the DB query check.

## Migration strategy

The app image does not run migrations during build or startup, and it does not
contain Prisma CLI. Although `prisma` is a dev dependency, npm retains it as an
optional peer of `@prisma/client`; the Docker build removes it explicitly after
client generation and compilation. Apply committed migrations as a deliberate
step from the backend checkout using the existing project config and an
explicitly selected database target:

```powershell
Push-Location backend
try {
    if (-not $env:DATABASE_URL) { throw 'Set DATABASE_URL to the approved migration target first.' }
    npm run db:migrate
    if ($LASTEXITCODE -ne 0) { throw 'Prisma migrate deploy failed.' }
} finally {
    Pop-Location
}
```

Set the environment variable privately before running the command, then remove
it from the shell when done. Confirm the database target first. SCRUM-89 applied
the existing migrations only to an isolated, temporary smoke-test database; it
did not reset or seed any database. A migrated but unseeded database is
sufficient for the `/products` smoke check.

## Troubleshooting and HKhang handoff

- `JWT_SECRET must be configured with at least 32 bytes`: provide the runtime
  secret; no Dockerfile default is set.
- `DATABASE_URL is not configured`: pass the runtime URL. If PostgreSQL is
  local to Windows, use `host.docker.internal`; if in Compose, use the DB
  service name and internal port.
- Nest startup fails while PostgreSQL is unavailable: apply migrations first
  and make Compose wait for the database readiness check. The service does not
  start listening until Prisma connects.
- `GET /` works but `GET /products` fails: the root route is not a DB check;
  inspect the backend log and confirm the URL points to a reachable,
  migrated PostgreSQL database.
- The runtime target is `runtime`, command `node dist/main.js`, port 3001,
  production-only `node_modules`, and non-root user `node`. Pass runtime env
  through Compose/runtime orchestration, not build `ARG`, image `ENV`, labels,
  or image layers. Migrations remain an explicit deployment step outside app
  startup.

## Verification status

- Host `npm run db:generate` completed with a non-secret placeholder URL; it did
  not connect to a database.
- Host `npm run db:validate` and production-only
  `npx tsc --noEmit -p tsconfig.build.json --incremental false` passed.
- Host `npm run build` and `npm run lint -- --deny-warnings` passed.
- `npx tsc --noEmit` remains blocked by two existing dev-branch test fixture
  type errors: Payment creates in `test/orders.integration-spec.ts` and
  `test/payments-postgres.integration-spec.ts` omit the required SCRUM-76
  `provider` field. These are outside Docker files and no TypeScript source was
  changed for this task.
- Docker CLI 29.9.2 connected to Docker Desktop Engine 29.9.2 on the
  `desktop-linux` context. `docker build --pull -t brewlite-backend:local .`
  passed from `backend/`.
- Image inspection passed: configured user is `node` (UID 1000), the only
  app-specific image env is `NODE_ENV=production`, and `/app/.env`,
  `/app/.env.example`, and the Prisma CLI package are absent. The CLI is an
  optional peer that npm retained during pruning, so the Dockerfile removes it
  explicitly after generation and build.
- Starting the image with `JWT_SECRET` but no `DATABASE_URL` exited with code 1
  and reported the missing database configuration.
- PostgreSQL 16 smoke test passed on an isolated bridge network and an empty
  database named `brewlite_scrum89_smoke`. All nine migrations present on this
  branch were applied with `npm run db:migrate`; no seed was run. The backend
  stayed up as UID 1000, `GET /` returned HTTP 200 (`Hello World!`), and
  `GET /products` returned HTTP 200 with an empty `items` array.
- `docker stop --time 30` completed with container exit code 0. The SCRUM-89
  PostgreSQL/backend containers and network were removed after the smoke test;
  no volume was created, and the application database was not used.
- npm reported 5 vulnerabilities (2 moderate, 3 high) in the production
  dependency tree during prune. They were not audited or changed as part of
  SCRUM-89.
