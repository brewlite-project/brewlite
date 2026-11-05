# SCRUM-92 / P2-18 — Verify Docker Clean Setup & Integration

- **Task**: `SCRUM-92` (`P2-18 – Verify Docker Clean Setup & Integration`)
- **Branch**: `SCRUM-92-p-2-18-verify-docker-clean-setup-integration` (synced with `origin/dev` @ `ee3284d`; initial discovery run recorded at `f3a0285`)
- **Date**: 2026-11-04 (Updated 2026-11-06)
- **Environment**: Windows 11, Docker Engine `29.9.2`, Docker Compose `v5.6.1`, Node.js `v22+`
- **Dependencies verified on `dev`**:
  - `P2-06` (`SCRUM-80` — Prisma migrations & guarded demo seed)
  - `P2-10` (`SCRUM-84` — `POST /payments/zero-amount` settlement & idempotency)
  - `P2-11` (`SCRUM-85` — `MockPaymentGuard` environment access policy in `NODE_ENV=production`)
  - `P2-13` (`SCRUM-96` — VNPay local HTTP return URL config `VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL` & reconciliation scheduler config)
  - `P2-15` (`SCRUM-89` — `backend/Dockerfile` multi-stage `build`, `migrate`, `production`)
  - `P2-16` (`SCRUM-90` — `frontend/Dockerfile` standalone + `/api/backend/*` reverse proxy)
  - `P2-17` (`SCRUM-91` — `docker-compose.yml`, `compose.env.example`, `scripts/compose-preflight-env.sh`, `docs/Docker_Compose.md`)

---

## 1. Reproducible Clean Setup Workflow (Git Bash & Windows PowerShell)

### 1.1. Prepare `compose.env` (No Machine-Specific Dependencies)

Copy `compose.env.example` to `compose.env` (ignored by Git) and populate local random values for `POSTGRES_PASSWORD`, `DATABASE_URL` (`@postgres:5432/brewlite_compose`), `JWT_SECRET` ($\ge 32$ bytes), and `INTERNAL_SECRET`.

Both `scripts/compose-preflight-env.sh` and `scripts/compose-preflight-env.ps1` verify all **24** Compose-interpolated environment variables (`DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_HOST_PORT`, `BACKEND_HOST_PORT`, `FRONTEND_HOST_PORT`, `JWT_SECRET`, `INTERNAL_SECRET`, `ORDER_EXPIRATION_ENABLED`, `ORDER_EXPIRATION_BATCH_SIZE`, `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_PAYMENT_URL`, `VNPAY_RETURN_URL`, `VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL`, `VNPAY_QUERYDR_URL`, `VNPAY_QUERYDR_TIMEOUT_MS`, `PAYMENT_RECONCILIATION_ENABLED`, `PAYMENT_RECONCILIATION_INTERVAL_MS`, `PAYMENT_RECONCILIATION_BATCH_SIZE`, `PAYMENT_RECONCILIATION_LEASE_MS`, `PAYMENT_RECONCILIATION_COOLDOWN_MS`, `PAYMENT_RECONCILIATION_IP_ADDR`, plus `COMPOSE_PROJECT_NAME`).

- **Git Bash / Linux / macOS**:
  ```bash
  cp compose.env.example compose.env
  bash scripts/compose-preflight-env.sh
  ```
- **Windows PowerShell**:
  ```powershell
  Copy-Item compose.env.example compose.env
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  ```

**Sanitized Output**:
```text
Compose preflight passed: no conflicting environment variables detected.
```

---

### 1.2. Build & Start Stack + Deterministic Migration Gate Before Seed

- **Git Bash / Linux / macOS**:
  ```bash
  bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env up --build -d
  bash scripts/compose-preflight-env.sh && \
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$(docker compose --env-file compose.env ps -a -q migrate)")" = "exited:0" && \
    docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
  ```
- **Windows PowerShell**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
  if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
  docker compose --env-file compose.env up --build -d

  $migrateId = docker compose --env-file compose.env ps -a -q migrate
  $migrateState = if ($migrateId) { docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' $migrateId } else { '' }
  if ($migrateState -ne 'exited:0') { throw "Migration container has not completed cleanly (state=$migrateState)" }

  docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
  ```

---

## 2. Isolated E2E Verification Architecture & Historical Runtime Evidence

### 2.0. Isolation, Fail-Closed Revalidation & Cleanup Recovery Guarantees (`scripts/scrum92/verify_compose_e2e.mjs`)

To guarantee that running automated E2E verification **never** disrupts an active `brewlite_compose` dev stack or touches shared dev data:

1. **Mandatory Isolated Project, Volume, Database & Host Ports**:
   - Always passes `-p brewlite_scrum92_e2e` to `docker compose`.
   - Uses isolated named volume `brewlite_scrum92_e2e_brewlite_pgdata`, isolated database `brewlite_seed_scrum92_e2e` (accepted by `isSeedDatabaseAllowed()` in `backend/prisma/seed.ts`), and dedicated host ports (`FRONTEND_HOST_PORT=13000`, `BACKEND_HOST_PORT=13001`, `POSTGRES_HOST_PORT=15492`). Because host ports are completely separate from `brewlite_compose` (`3000`/`3001`/`15432`), you do **not** need to stop your active dev stack to run E2E verification.
2. **Fail-Closed Revalidation Before Every Scoped / Lifecycle Action**:
   - `assertIsolatedComposeTarget()` and `assertIsolatedPostgresTarget()` inspect `com.docker.compose.project`, mounted volume name at `/var/lib/postgresql`, `POSTGRES_DB`, and `SELECT current_database()` immediately before seeding, before `stop -> start`, after `start`, before `down`, and before `finally` cleanup.
3. **Guaranteed Postgres Recovery Before Cleanup in `finally`**:
   - If `stop -> start` or readiness fails mid-way in Step `[8]`, `ensureIsolatedPostgresReadyForCleanup()` in `finally` checks the isolated `postgres` container state, automatically runs `docker compose -p brewlite_scrum92_e2e start postgres`, waits for `running:healthy`, revalidates project/volume/DB metadata fail-closed, and then executes the exact-ID SQL cleanup. Cleanup errors are never swallowed.
4. **Deterministic Persistence Snapshot (Scheduler Guard)**:
   - Sets `ORDER_EXPIRATION_ENABLED=false` and `PAYMENT_RECONCILIATION_ENABLED=false` in the isolated stack and verifies both container env vars via `docker inspect` before running.
5. **Collision-Safe Coupon Fixture, `--keep-artifacts` & `--cleanup-artifacts` Recovery Flow**:
   - Uses fixed coupon ID `c9200000-0000-4000-8000-000000000092` (`SCRUM92FREE`) without `ON CONFLICT DO UPDATE`. Refuses to run if `SCRUM92FREE` or `c9200000-0000-4000-8000-000000000092` already exists in the DB.
   - Tracks exact entity UUIDs (`userIds`, `orderIds`, `paymentIds`, `couponId`) in a temporary state file (`os.tmpdir()/brewlite-scrum92-e2e-artifacts.json`) as records are created.
   - By default, `finally` restores reserved product stock, deletes **only** those exact IDs, and removes the temporary state file.
   - If you run with `--keep-artifacts` (to inspect test rows manually) and later want to re-run without hitting the coupon collision guard, run the scoped recovery cleanup command:
     ```bash
     node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts
     ```

**Commands**:
```bash
# 1. Start isolated stack (-p brewlite_scrum92_e2e on ports 13000/13001/15492) and run full E2E + restart verification + finally cleanup:
node scripts/scrum92/verify_compose_e2e.mjs --up

# 2. Re-run against already-running isolated stack:
node scripts/scrum92/verify_compose_e2e.mjs

# 3. Optional: preserve created test records in isolated DB, then clean them up before next run:
node scripts/scrum92/verify_compose_e2e.mjs --keep-artifacts
node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts

# 4. Stop isolated stack when finished:
node scripts/scrum92/verify_compose_e2e.mjs --down
```

---

> [!NOTE]
> **Historical Evidence Note**: Sections `2.1`–`2.7` below record the sanitized runtime outputs captured during the initial clean-setup verification run on `2026-11-04` (at `dev` commit `f3a0285`, before the isolated `-p brewlite_scrum92_e2e` project name and dedicated ports `13000`/`13001`/`15492` were enforced). When running `node scripts/scrum92/verify_compose_e2e.mjs --up`, container names use prefix `brewlite_scrum92_e2e-*` and `database_name` reports `brewlite_seed_scrum92_e2e`.

### 2.1. Container / Service Status (Historical Evidence @ `f3a0285`)

**Command**:
```bash
docker compose --env-file compose.env ps -a
```

**Sanitized Output**:
```text
Container health states: {"migrateState":"exited:0","pgHealth":"running:healthy","beHealth":"running:healthy","feHealth":"running:healthy"}
NAME                          IMAGE                       COMMAND                  SERVICE    CREATED              STATUS                          PORTS
brewlite_compose-backend-1    brewlite_compose-backend    "docker-entrypoint.s…"   backend    About a minute ago   Up About a minute (healthy)     127.0.0.1:3001->3001/tcp
brewlite_compose-frontend-1   brewlite_compose-frontend   "docker-entrypoint.s…"   frontend   15 hours ago         Up About a minute (healthy)     0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp
brewlite_compose-migrate-1    brewlite_compose-migrate    "docker-entrypoint.s…"   migrate    About a minute ago   Exited (0) About a minute ago
brewlite_compose-postgres-1   postgres:18-alpine          "docker-entrypoint.s…"   postgres   15 hours ago         Up About a minute (healthy)     127.0.0.1:15432->5432/tcp
```

---

### 2.2. Migration Logs, Guarded Demo Seed & Database Counts (Historical Evidence @ `f3a0285`)

**Command (Migration Logs)**:
```bash
docker compose --env-file compose.env logs migrate
```

**Sanitized Output**:
```text
migrate-1  | > backend@0.0.1 db:migrate
migrate-1  | > prisma migrate deploy --config prisma7.config.ts
migrate-1  |
migrate-1  | Loaded Prisma config from prisma7.config.ts.
migrate-1  | Prisma schema loaded from prisma/schema.prisma.
migrate-1  | Datasource "db": PostgreSQL database "brewlite_compose", schema "public" at "postgres:5432"
migrate-1  |
migrate-1  | 9 migrations found in prisma/migrations
migrate-1  |
migrate-1  | Applying migration `20261020143341_init_product_catalog`
migrate-1  | Applying migration `20261021153059_extend_user_order_orderitem`
migrate-1  | Applying migration `20261022011000_scrum36_active_order_coupon_constraints`
migrate-1  | Applying migration `20261022013000_add_coupon_redemptions`
migrate-1  | Applying migration `20261023130000_product_catalog_schema_upgrade`
migrate-1  | Applying migration `20261024010000_order_item_one_size_constraint`
migrate-1  | Applying migration `20261026065408_add_payment_schema`
migrate-1  | Applying migration `20261031190000_scrum76_payment_pending_enum`
migrate-1  | Applying migration `20261031190100_scrum76_payment_gateway_delta`
migrate-1  |
migrate-1  | All migrations have been successfully applied.
migrate-1  | ...
migrate-1  | No pending migrations to apply.
```

**Command (Guarded Demo Seed & SQL Verification via Container Environment Variables)**:
```bash
docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
docker compose --env-file compose.env exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database() AS database_name, (SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed_migrations, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM toppings) AS toppings, (SELECT stock FROM products WHERE id = '\''a3000000-0000-4000-8000-000000000001'\'') AS sample_product_stock;"'
```

**Sanitized Output**:
```text
> backend@0.0.1 db:seed
> tsx prisma/seed.ts

Seed completed: 9 menu products, 5 toppings

  database_name   | completed_migrations | categories | products | toppings | sample_product_stock
------------------+----------------------+------------+----------+----------+----------------------
 brewlite_compose |                    9 |          4 |        9 |        5 |                   25
(1 row)
```

---

### 2.3. Smoke Check & `FE → BE → DB` Catalog via Reverse Proxy

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[2]` and `[3]`)**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:13000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:13001/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:13001/api-docs
curl -s http://localhost:13000/api/backend/products
curl -s http://localhost:13000/api/backend/products/a3000000-0000-4000-8000-000000000001
```

**Sanitized Output**:
```json
{"frontendHomeStatus":200,"backendLivenessStatus":200,"swaggerDocsStatus":200,"staticProductImageStatus":200}
{"endpoint":"GET /api/backend/products","status":200,"productCount":9,"sampleProduct":{"id":"a3000000-0000-4000-8000-000000000001","name":"Bạc Xỉu Kem Béo Phin","isAvailable":true,"selectedSize":"S","firstTopping":{"id":"b2000000-0000-4000-8000-000000000002","name":"Kem cheese"}}}
```

---

### 2.4. Auth Flow via Reverse Proxy (`POST /auth/register` → `POST /auth/login` → `GET /auth/me`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` step `[4]`)**:
- `POST http://localhost:13000/api/backend/auth/register`
- `POST http://localhost:13000/api/backend/auth/login`
- `GET http://localhost:13000/api/backend/auth/me` (with `Authorization: Bearer <REDACTED_JWT>`)

**Sanitized Output**:
```json
{"registerStatus":201,"loginStatus":200,"accessToken":"<REDACTED_JWT>","meProfile":{"id":"fe8a0c32-026e-402c-abc2-a53c2fc78483","email":"scrum92.verify.1793772125411@brewlite.vn","fullName":"SCRUM-92 Clean Verifier","loyaltyPoints":0}}
```

---

### 2.5. Create Order via Reverse Proxy (`POST /api/backend/orders`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` step `[5]`)**:
- `POST http://localhost:13000/api/backend/orders` with `{"items":[{"productId":"a3000000-0000-4000-8000-000000000001","size":"S","quantity":2,"toppingIds":["b2000000-0000-4000-8000-000000000002"]}]}`

**Sanitized Output**:
```json
{"status":201,"orderId":"abddf914-e053-4a2f-984a-23a70072622d","orderStatus":"PENDING","subtotalVnd":104000,"totalVnd":104000}
```

---

### 2.6. Payment Flow via Reverse Proxy (`POST /payments`, `POST /payments/zero-amount` & `POST /payments/vnpay/initiate`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[6]` and `[6b]`)**:
1. `POST http://localhost:13000/api/backend/payments` (Mock) in Compose (`NODE_ENV=production`) $\rightarrow$ `403 Forbidden` (`code: "MOCK_PAYMENT_DISABLED"`, per `SCRUM-85` / `P2-11`).
2. `POST http://localhost:13000/api/backend/payments/zero-amount` on positive order (`104000 VND`) $\rightarrow$ `409 Conflict` (`code: "ORDER_NOT_ZERO_AMOUNT"`, per `SCRUM-84` / `P2-10`).
3. `POST http://localhost:13000/api/backend/payments/zero-amount` on a `0 VND` order $\rightarrow$ `201 Created` (`provider: "ZERO_AMOUNT"`, `paymentStatus: "SUCCESS"`, `orderStatus: "PAID"`), followed by idempotent replay with identical `Idempotency-Key` $\rightarrow$ `200 OK` (`idempotency-replayed: true`).
4. `POST http://localhost:13000/api/backend/payments/vnpay/initiate` on the `104000 VND` `PENDING` order $\rightarrow$ `201 Created` (`provider: "VNPAY"`, `paymentStatus: "PENDING"`), followed by idempotent replay $\rightarrow$ `200 OK` (`idempotency-replayed: true`).

**Sanitized Output**:
```json
{"mockProductionPolicy":{"status":403,"code":"MOCK_PAYMENT_DISABLED"},"zeroAmountPositiveOrderRejection":{"status":409,"code":"ORDER_NOT_ZERO_AMOUNT"},"zeroAmountSettlement":{"status":201,"orderId":"bb1ee46d-74b9-473f-815b-a0b91d71ef92","paymentId":"361fad08-20d4-44c4-b9ce-9d083d635dd3","provider":"ZERO_AMOUNT","paymentStatus":"SUCCESS","orderStatus":"PAID","amountVnd":0},"zeroAmountReplay":{"status":200,"idempotencyReplayedHeader":"true","samePaymentId":true}}
{"initiateStatus":201,"replayStatus":200,"idempotencyReplayedHeader":"true","provider":"VNPAY","paymentStatus":"PENDING","orderStatus":"PENDING","sanitizedPaymentUrl":"https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_Amount=10400000&vnp_Command=pay&vnp_CreateDate=20261104130206&vnp_CurrCode=VND&vnp_ExpireDate=20261104131705&vnp_IpAddr=172.18.0.4&vnp_Locale=vn&vnp_OrderInfo=Thanh+toan+don+hang+abddf914-e053-4a2f-984a-23a70072622d&vnp_OrderType=other&vnp_ReturnUrl=https%3A%2F%2Flocalhost%3A3000%2Forder-confirmation&vnp_TmnCode=%3CREDACTED_TMN_CODE%3E&vnp_TxnRef=8c77ee61707d4fc68d7c56e57434baf4&vnp_Version=2.1.0&vnp_SecureHash=%3CREDACTED_SECURE_HASH%3E"}
```

---

### 2.7. Restart & Persistence Verification (`docker compose -p brewlite_scrum92_e2e stop` → `start`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[7]` and `[8]`)**:
```bash
# Snapshot before restart via API (/api/backend/orders/me, /api/backend/payments/zero-amount replay) and SQL
docker compose -p brewlite_scrum92_e2e --env-file compose.env stop
docker compose -p brewlite_scrum92_e2e --env-file compose.env start
# Wait for migrate=exited:0 and postgres/backend/frontend=running:healthy, then re-query API and SQL
```

**Sanitized Output (Before vs After Restart)**:
```text
=== [7] Pre-Restart Snapshot (API & PostgreSQL) ===
Pre-Restart API Snapshot: {"primaryOrder":{"orderId":"abddf914-e053-4a2f-984a-23a70072622d","orderStatus":"PENDING","totalVnd":104000},"zeroAmountPaidOrder":{"orderId":"bb1ee46d-74b9-473f-815b-a0b91d71ef92","paymentId":"361fad08-20d4-44c4-b9ce-9d083d635dd3","orderStatus":"PAID","paymentStatus":"SUCCESS"}}
Pre-Restart SQL Snapshot:
               order_id               | order_status | total_vnd |              payment_id              |  provider   | payment_status
--------------------------------------+--------------+-----------+--------------------------------------+-------------+----------------
 abddf914-e053-4a2f-984a-23a70072622d | PENDING      |    104000 | 8c77ee61-707d-4fc6-8d7c-56e57434baf4 | VNPAY       | PENDING
 bb1ee46d-74b9-473f-815b-a0b91d71ef92 | PAID         |         0 | 361fad08-20d4-44c4-b9ce-9d083d635dd3 | ZERO_AMOUNT | SUCCESS
(2 rows)

=== [8] Restart Isolated Stack (docker compose -p brewlite_scrum92_e2e stop -> start) ===
Post-Restart Container States: {"migrateState":"exited:0","pgHealth":"running:healthy","beHealth":"running:healthy","feHealth":"running:healthy"}
Post-Restart API Snapshot: {"primaryOrder":{"orderId":"abddf914-e053-4a2f-984a-23a70072622d","orderStatus":"PENDING","totalVnd":104000},"zeroAmountPaidOrder":{"orderId":"bb1ee46d-74b9-473f-815b-a0b91d71ef92","paymentId":"361fad08-20d4-44c4-b9ce-9d083d635dd3","orderStatus":"PAID","paymentStatus":"SUCCESS"}}
Post-Restart SQL Snapshot:
               order_id               | order_status | total_vnd |              payment_id              |  provider   | payment_status
--------------------------------------+--------------+-----------+--------------------------------------+-------------+----------------
 abddf914-e053-4a2f-984a-23a70072622d | PENDING      |    104000 | 8c77ee61-707d-4fc6-8d7c-56e57434baf4 | VNPAY       | PENDING
 bb1ee46d-74b9-473f-815b-a0b91d71ef92 | PAID         |         0 | 361fad08-20d4-44c4-b9ce-9d083d635dd3 | ZERO_AMOUNT | SUCCESS
(2 rows)

[SCRUM-92] ALL VERIFICATION CHECKS PASSED.
```

---

## 3. Issues Discovered During Initial Clean-Run (`f3a0285`) & Current Status (`ee3284d`)

### Issue #1 [Blocker P0 — Fixed in `SCRUM-92`]: Cổng host `127.0.0.1:55432` của `postgres` bị Windows Hyper-V/WinNAT chặn cứng

- **Module / Owner**: `P2-17` (`SCRUM-91` — `docker-compose.yml`).
- **Mức độ**: **Blocker (P0)** trên Windows Docker Desktop (WSL2/Hyper-V).
- **Bước tái hiện**:
  1. Trên máy Windows bật Docker Desktop (Hyper-V/WSL2), giữ nguyên `127.0.0.1:55432:5432` trong `docker-compose.yml`.
  2. Chạy `docker compose --env-file compose.env up --build -d`.
  3. Container `postgres` không thể khởi chạy với lỗi:
     `Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:55432 -> 127.0.0.1:0: listen tcp4 127.0.0.1:55432: bind: An attempt was made to access a socket in a way forbidden by its access permissions.`
- **Nguyên nhân gốc rễ**:
  - Kiểm tra `netsh interface ipv4 show excludedportrange protocol=tcp` cho thấy Windows WinNAT/Hyper-V tự động reserve nhiều dải cổng nằm trong vùng dynamic ephemeral ports (`49152–65535`), bao gồm dải `55334–55433` (chứa cổng `55432`).
- **Giải pháp đã áp dụng trong `SCRUM-92`**:
  - Cập nhật `docker-compose.yml` từ `"127.0.0.1:55432:5432"` thành `"127.0.0.1:${POSTGRES_HOST_PORT:-15432}:5432"` (mặc định `15432`, nằm ngoài vùng ephemeral `49152–65535` của Windows và cho phép cấu hình qua `POSTGRES_HOST_PORT`), đồng thời cho phép cấu hình `BACKEND_HOST_PORT` và `FRONTEND_HOST_PORT` để stack E2E cô lập (`-p brewlite_scrum92_e2e`) chạy trên bộ cổng riêng `13000`/`13001`/`15492`.

---

### Issue #2 [Major — Discovered @ `f3a0285`, Resolved on `dev` @ `ee3284d`]: `VNPAY_RETURN_URL=http://localhost:3000/order-confirmation` gây lỗi 500 trong Docker Compose

- **Module / Owner**: `P2-03` (`SCRUM-77` — `backend/src/payments/vnpay.config.ts`) & `P2-13` (`SCRUM-96`).
- **Mức độ**: **Major** (ảnh hưởng luồng VNPay Sandbox trong môi trường Docker Compose local).
- **Bước tái hiện (tại commit `f3a0285`)**:
  1. Cấu hình `VNPAY_RETURN_URL=http://localhost:3000/order-confirmation` trong `compose.env` theo đúng tài liệu `docs/integration/VNPay_Sandbox_Setup.md`.
  2. Khởi chạy Docker Compose và gọi `POST /api/backend/payments/vnpay/initiate`.
  3. Backend trả về `HTTP 500 INTERNAL_ERROR` (`Invalid VNPAY_RETURN_URL configuration`) vì `backend/Dockerfile` đặt `NODE_ENV=production`.
- **Trạng thái xử lý trên `dev` hiện tại (`ee3284d`)**:
  - Đã được giải quyết khi merge `SCRUM-96` (`P2-13`): `docker-compose.yml` và `compose.env.example` đã bổ sung cờ `VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true` cho phép `http://localhost` / `http://127.0.0.1` trong môi trường Docker Compose local khi trỏ tới VNPay Sandbox.

---

### Issue #3 [Major — Discovered @ `f3a0285`, Resolved in `SCRUM-88`]: `GET /orders/me` trên `dev` (`f3a0285`) gặp lỗi 500 khi đơn hàng có giao dịch `VNPAY` hoặc `ZERO_AMOUNT`

- **Module / Owner**: `P2-14` (`SCRUM-88` — `backend/src/orders/orders.service.ts`).
- **Mức độ**: **Major**.
- **Bước tái hiện (tại commit `f3a0285`)**:
  1. Trên nhánh `dev` (`f3a0285`), tạo đơn hàng `0 VND` và hoàn tất qua `POST /payments/zero-amount` (hoặc hoàn tất thanh toán VNPay `status = SUCCESS`, `responseSnapshot = null`).
  2. Gọi `GET /orders/me`.
  3. `OrdersService.getMine()` trên `dev` gọi `readPaymentSnapshot(payment.responseSnapshot)` (vốn chỉ chấp nhận cấu trúc snapshot của Mock Card/Wallet) và throw `InternalServerErrorException('Invalid payment response snapshot')`.
- **Trạng thái xử lý**:
  - Đã được sửa trong nhánh `SCRUM-88-p-2-14-complete-payment-confirmation-order-history-integration` (`P2-14`).

---

### Issue #4 [Minor — Developer Experience trên Windows & Tài liệu `README.md` — Fixed in `SCRUM-92`]:

- **Module / Owner**: `P2-17` (`SCRUM-91` — `README.md`, `docs/Docker_Compose.md`).
- **Chi tiết & Giải pháp đã áp dụng**:
  1. Bổ sung script [`scripts/compose-preflight-env.ps1`](../../scripts/compose-preflight-env.ps1) tương đương với `scripts/compose-preflight-env.sh` (kiểm tra đủ 24 biến nội suy của `docker-compose.yml`) để người dùng Windows PowerShell không gặp lỗi `WSL_E_DEFAULT_DISTRO_NOT_FOUND`.
  2. Cập nhật [`README.md`](../../README.md) và [`docs/Docker_Compose.md`](../Docker_Compose.md) với hướng dẫn đầy đủ cho cả **Git Bash** và **Windows PowerShell**, kèm bước kiểm tra deterministic trạng thái container `migrate` (`exited:0`) trước khi chạy `db:seed`.
  3. Bổ sung script kiểm thử E2E tự động [`scripts/scrum92/verify_compose_e2e.mjs`](../../scripts/scrum92/verify_compose_e2e.mjs) chạy trên project/volume/database/host-ports cô lập (`-p brewlite_scrum92_e2e`, `brewlite_scrum92_e2e_brewlite_pgdata`, `brewlite_seed_scrum92_e2e`, cổng `13000`/`13001`/`15492`), tự động recover `postgres` trước khi cleanup trong `finally`, và hỗ trợ `--cleanup-artifacts` để dọn dẹp an toàn sau khi dùng `--keep-artifacts`.
