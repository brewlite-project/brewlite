# SCRUM-92 / P2-18 — Verify Docker Clean Setup & Integration

- **Task**: `SCRUM-92` (`P2-18 – Verify Docker Clean Setup & Integration`)
- **Branch**: `SCRUM-92-p-2-18-verify-docker-clean-setup-integration` (based on `dev` @ `04dcd26`)
- **Date**: 2026-11-03
- **Environment**: Windows 11, Docker Engine `29.9.2`, Docker Compose `v5.6.1`, Node.js `v22+`
- **Dependencies verified on `dev`**:
  - `P2-06` (`SCRUM-80` — Prisma migrations & guarded demo seed)
  - `P2-15` (`SCRUM-89` — `backend/Dockerfile` multi-stage `build`, `migrate`, `production`)
  - `P2-16` (`SCRUM-90` — `frontend/Dockerfile` standalone + `/api/backend/*` reverse proxy)
  - `P2-17` (`SCRUM-91` — `docker-compose.yml`, `compose.env.example`, `scripts/compose-preflight-env.sh`, `docs/Docker_Compose.md`)

---

## 1. Reproducible Clean Setup Workflow (Git Bash & Windows PowerShell)

### 1.1. Prepare `compose.env` (No Machine-Specific Dependencies)

Copy `compose.env.example` to `compose.env` (ignored by Git) and populate local random values for `POSTGRES_PASSWORD`, `DATABASE_URL` (`@postgres:5432/brewlite_compose`), `JWT_SECRET` ($\ge 32$ bytes), and `INTERNAL_SECRET`.

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

## 2. Reproducible Verification Evidence (Exact Commands & Sanitized Outputs)

All steps below can be re-executed at any time on either **Git Bash** or **Windows PowerShell** via the repository verification script:

```bash
node scripts/scrum92/verify_compose_e2e.mjs
```

### 2.1. Container / Service Status

**Command**:
```bash
docker compose --env-file compose.env ps -a
```

**Sanitized Output**:
```text
Container health states: {"migrateState":"exited:0","pgHealth":"running:healthy","beHealth":"running:healthy","feHealth":"running:healthy"}
NAME                          IMAGE                       COMMAND                  SERVICE    CREATED          STATUS                     PORTS
brewlite_compose-backend-1    brewlite_compose-backend    "docker-entrypoint.s…"   backend    46 minutes ago   Up 3 minutes (healthy)     127.0.0.1:3001->3001/tcp
brewlite_compose-frontend-1   brewlite_compose-frontend   "docker-entrypoint.s…"   frontend   54 minutes ago   Up 3 minutes (healthy)     0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp
brewlite_compose-migrate-1    brewlite_compose-migrate    "docker-entrypoint.s…"   migrate    54 minutes ago   Exited (0) 3 minutes ago   
brewlite_compose-postgres-1   postgres:18-alpine          "docker-entrypoint.s…"   postgres   52 minutes ago   Up 3 minutes (healthy)     127.0.0.1:15432->5432/tcp
```

---

### 2.2. Migration Logs, Guarded Demo Seed & Database Counts

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

**Command (Guarded Demo Seed & SQL Verification)**:
```bash
docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
docker compose --env-file compose.env exec -T postgres psql -X -v ON_ERROR_STOP=1 -U brewlite -d brewlite_compose -c 'SELECT current_database() AS database_name, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed_migrations, (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM toppings) AS toppings;'
```

**Sanitized Output**:
```text
> backend@0.0.1 db:seed
> tsx prisma/seed.ts

Seed completed: 9 menu products, 5 toppings

  database_name   | completed_migrations | categories | products | toppings 
------------------+----------------------+------------+----------+----------
 brewlite_compose |                    9 |          4 |        9 |        5
(1 row)
```

---

### 2.3. Smoke Check & `FE → BE → DB` Catalog via Reverse Proxy

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[2]` and `[3]`)**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api-docs
curl -s http://localhost:3000/api/backend/products
curl -s http://localhost:3000/api/backend/products/a3000000-0000-4000-8000-000000000001
```

**Sanitized Output**:
```json
{"frontendHomeStatus":200,"backendLivenessStatus":200,"swaggerDocsStatus":200,"staticProductImageStatus":200}
{"endpoint":"GET /api/backend/products","status":200,"productCount":9,"sampleProduct":{"id":"a3000000-0000-4000-8000-000000000001","name":"Bạc Xỉu Kem Béo Phin","selectedSize":"S","firstTopping":{"id":"b2000000-0000-4000-8000-000000000002","name":"Kem cheese"}}}
```

---

### 2.4. Auth Flow via Reverse Proxy (`POST /auth/register` → `POST /auth/login` → `GET /auth/me`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` step `[4]`)**:
- `POST http://localhost:3000/api/backend/auth/register`
- `POST http://localhost:3000/api/backend/auth/login`
- `GET http://localhost:3000/api/backend/auth/me` (with `Authorization: Bearer <REDACTED_JWT>`)

**Sanitized Output**:
```json
{"registerStatus":201,"loginStatus":200,"accessToken":"<REDACTED_JWT>","meProfile":{"id":"fdb49a39-98d4-4b6c-9021-58343d151e9f","email":"scrum92.verify.1793719683677@brewlite.vn","fullName":"SCRUM-92 Clean Verifier","loyaltyPoints":0}}
```

---

### 2.5. Create Order via Reverse Proxy (`POST /api/backend/orders`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` step `[5]`)**:
- `POST http://localhost:3000/api/backend/orders` with `{"items":[{"productId":"a3000000-0000-4000-8000-000000000001","size":"S","quantity":2,"toppingIds":["b2000000-0000-4000-8000-000000000002"]}]}`

**Sanitized Output**:
```json
{"status":201,"orderId":"b397ac19-af17-4e6e-a628-4a80ade97193","orderStatus":"PENDING","subtotalVnd":104000,"totalVnd":104000}
```

---

### 2.6. Payment Flow via Reverse Proxy (`POST /api/backend/payments` & `POST /api/backend/payments/vnpay/initiate`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[6]` and `[6b]`)**:
1. `POST http://localhost:3000/api/backend/payments` with declined card `4111111111110002` $\rightarrow$ `FAILED` / `PAYMENT_FAILED` / `PAYMENT_DECLINED`.
2. `POST http://localhost:3000/api/backend/payments` with new `Idempotency-Key` and valid card `4111111111111234` $\rightarrow$ `SUCCESS` / `PAID` / `pointsEarned: 10`.
3. Repeat step 2 with identical `Idempotency-Key` $\rightarrow$ `200 OK` with header `idempotency-replayed: true` and same `paymentId`.
4. `POST http://localhost:3000/api/backend/payments/vnpay/initiate` on a new `PENDING` order $\rightarrow$ `201 Created` (`provider: "VNPAY"`, `paymentStatus: "PENDING"`), followed by idempotent replay $\rightarrow$ `200 OK` (`idempotency-replayed: true`).

**Sanitized Output**:
```json
{"failedAttempt":{"paymentId":"a4e69fa8-73fb-4369-bec0-dd820968dfb8","paymentStatus":"FAILED","orderStatus":"PAYMENT_FAILED","failureReason":"PAYMENT_DECLINED"},"retrySuccess":{"paymentId":"0301c0af-e5bb-46c7-83f3-b160d351c48d","paymentStatus":"SUCCESS","orderStatus":"PAID","pointsEarned":10},"idempotentReplay":{"status":200,"idempotencyReplayedHeader":"true","samePaymentId":true}}
{"initiateStatus":201,"replayStatus":200,"idempotencyReplayedHeader":"true","provider":"VNPAY","paymentStatus":"PENDING","orderStatus":"PENDING","sanitizedPaymentUrl":"https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_Amount=4200000&vnp_Command=pay&vnp_CreateDate=20261103222804&vnp_CurrCode=VND&vnp_ExpireDate=20261103224304&vnp_IpAddr=172.18.0.4&vnp_Locale=vn&vnp_OrderInfo=Thanh+toan+don+hang+b2f7e23e-93b9-44dc-893e-7c15f4d24489&vnp_OrderType=other&vnp_ReturnUrl=https%3A%2F%2Flocalhost%3A3000%2Forder-confirmation&vnp_TmnCode=%3CREDACTED_TMN_CODE%3E&vnp_TxnRef=d85d77be84ae4cadac02c6c0539d0c60&vnp_Version=2.1.0&vnp_SecureHash=%3CREDACTED_SECURE_HASH%3E"}
```

---

### 2.7. Restart & Persistence Verification (`docker compose stop` → `docker compose start`)

**Command (executed by `node scripts/scrum92/verify_compose_e2e.mjs` steps `[7]` and `[8]`)**:
```bash
# Snapshot before restart via API (/api/backend/orders/me, /api/backend/auth/me) and SQL (psql)
docker compose --env-file compose.env stop
docker compose --env-file compose.env start
# Wait for migrate=exited:0 and postgres/backend/frontend=running:healthy, then re-query API and SQL
```

**Sanitized Output (Before vs After Restart)**:
```text
=== [7] Pre-Restart Snapshot (API & PostgreSQL) ===
Pre-Restart API Snapshot: {"orderId":"b397ac19-af17-4e6e-a628-4a80ade97193","orderStatus":"PAID","totalVnd":104000,"paymentId":"0301c0af-e5bb-46c7-83f3-b160d351c48d","paymentStatus":"SUCCESS","loyaltyPoints":10}
Pre-Restart SQL Snapshot:
               order_id               | order_status | total_vnd | payment_attempts | winning_payment_status | loyalty_points 
--------------------------------------+--------------+-----------+------------------+------------------------+----------------
 b397ac19-af17-4e6e-a628-4a80ade97193 | PAID         |    104000 |                2 | SUCCESS                |             10
(1 row)

=== [8] Restart Stack (docker compose stop -> start) & Post-Restart Persistence Check ===
Post-Restart Container States: {"migrateState":"exited:0","pgHealth":"running:healthy","beHealth":"running:healthy","feHealth":"running:healthy"}
Post-Restart API Snapshot: {"orderId":"b397ac19-af17-4e6e-a628-4a80ade97193","orderStatus":"PAID","totalVnd":104000,"paymentId":"0301c0af-e5bb-46c7-83f3-b160d351c48d","paymentStatus":"SUCCESS","loyaltyPoints":10}
Post-Restart SQL Snapshot:
               order_id               | order_status | total_vnd | payment_attempts | winning_payment_status | loyalty_points 
--------------------------------------+--------------+-----------+------------------+------------------------+----------------
 b397ac19-af17-4e6e-a628-4a80ade97193 | PAID         |    104000 |                2 | SUCCESS                |             10
(1 row)

[SCRUM-92] ALL VERIFICATION CHECKS PASSED.
```

---

## 3. Issues Discovered, Reproduction Steps & Module Owner Reports

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
  - Cập nhật `docker-compose.yml` từ `"127.0.0.1:55432:5432"` thành `"127.0.0.1:${POSTGRES_HOST_PORT:-15432}:5432"` (mặc định `15432`, nằm ngoài vùng ephemeral `49152–65535` của Windows và cho phép cấu hình qua `POSTGRES_HOST_PORT` trong `compose.env`).

---

### Issue #2 [Major — Cross-Module Config Conflict]: `VNPAY_RETURN_URL=http://localhost:3000/order-confirmation` gây lỗi 500 trong Docker Compose

- **Module / Owner**: `P2-03` (`SCRUM-77` — `backend/src/payments/vnpay.config.ts`) & `P2-15` (`SCRUM-89` — `backend/Dockerfile`).
- **Mức độ**: **Major** (ảnh hưởng luồng VNPay Sandbox trong môi trường Docker Compose local).
- **Bước tái hiện**:
  1. Cấu hình `VNPAY_RETURN_URL=http://localhost:3000/order-confirmation` trong `compose.env` theo đúng tài liệu `docs/integration/VNPay_Sandbox_Setup.md` (dòng 214).
  2. Khởi chạy Docker Compose và gọi `POST /api/backend/payments/vnpay/initiate`.
  3. Backend trả về `HTTP 500 INTERNAL_ERROR` (`Invalid VNPAY_RETURN_URL configuration`).
- **Nguyên nhân gốc rễ**:
  - `backend/Dockerfile` thiết lập `ENV NODE_ENV=production` trong stage runtime.
  - Hàm `requireReturnUrl()` trong `backend/src/payments/vnpay.config.ts` (dòng 68–73) kiểm tra `const isDevelopment = process.env.NODE_ENV !== 'production'` và từ chối giao thức `http:` ngay cả khi hostname là `localhost` hoặc `127.0.0.1` nếu `NODE_ENV === 'production'`.
  - Nếu người dùng đổi `VNPAY_RETURN_URL` thành `https://localhost:3000/order-confirmation` để vượt qua bước validate của backend thì khi trình duyệt redirect từ VNPay Sandbox về `https://localhost:3000/...` sẽ bị lỗi SSL (`ERR_SSL_PROTOCOL_ERROR`) do container `frontend` phục vụ HTTP trên cổng `3000`.
- **Kiến nghị gửi Owner Module (`P2-03` / `Payments`)**:
  - Trong `backend/src/payments/vnpay.config.ts`, cho phép `http://localhost` và `http://127.0.0.1` khi chạy local/sandbox (ví dụ kiểm tra hostname loopback kết hợp với việc `VNPAY_PAYMENT_URL` đang trỏ tới `sandbox.vnpayment.vn` hoặc bổ sung biến cấu hình rõ ràng), thay vì chỉ dựa vào `NODE_ENV !== 'production'`.

---

### Issue #3 [Major — Cross-Module Integration]: `GET /orders/me` trên `dev` (`04dcd26`) gặp lỗi 500 khi đơn hàng có giao dịch `VNPAY` (`responseSnapshot = null`)

- **Module / Owner**: `P2-14` (`SCRUM-88` — `backend/src/orders/orders.service.ts`).
- **Mức độ**: **Major**.
- **Bước tái hiện**:
  1. Trên nhánh `dev` (`04dcd26`), tạo đơn hàng và gọi `POST /payments/vnpay/initiate` (tạo bản ghi `Payment` với `provider = VNPAY`, `status = PENDING`, `responseSnapshot = null`), hoặc hoàn tất thanh toán VNPay (`status = SUCCESS`, `responseSnapshot = null`).
  2. Gọi `GET /orders/me`.
  3. Khi `Payment` VNPay chuyển sang `SUCCESS`/`FAILED`, `OrdersService.getMine()` trên `dev` gọi `readPaymentSnapshot(payment.responseSnapshot)` và throw `InternalServerErrorException('Invalid payment response snapshot')` do giao dịch VNPay không lưu `responseSnapshot` của Mock Card/Wallet. Ngoài ra `getMine()` trên `dev` chỉ lọc `status IN ('SUCCESS', 'FAILED')` nên bỏ sót giao dịch `PENDING`.
- **Trạng thái xử lý**:
  - Đã được sửa trong nhánh `SCRUM-88-p-2-14-complete-payment-confirmation-order-history-integration` (`P2-14`). Sau khi `SCRUM-88` được merge vào `dev`, `GET /orders/me` sẽ hỗ trợ đầy đủ `VNPAY`, `MOCK`, `ZERO_AMOUNT` và trạng thái `PENDING`.

---

### Issue #4 [Minor — Developer Experience trên Windows & Tài liệu `README.md` — Fixed in `SCRUM-92`]:

- **Module / Owner**: `P2-17` (`SCRUM-91` — `README.md`, `docs/Docker_Compose.md`).
- **Chi tiết & Giải pháp đã áp dụng**:
  1. Bổ sung script [`scripts/compose-preflight-env.ps1`](../../scripts/compose-preflight-env.ps1) tương đương với `scripts/compose-preflight-env.sh` để người dùng Windows PowerShell không gặp lỗi `WSL_E_DEFAULT_DISTRO_NOT_FOUND` khi máy chưa cài WSL distro.
  2. Cập nhật [`README.md`](../../README.md) và [`docs/Docker_Compose.md`](../Docker_Compose.md) với hướng dẫn đầy đủ cho cả **Git Bash** và **Windows PowerShell**, kèm bước kiểm tra deterministic trạng thái container `migrate` (`exited:0`) trước khi chạy `db:seed`.
  3. Bổ sung script kiểm thử E2E tự động [`scripts/scrum92/verify_compose_e2e.mjs`](../../scripts/scrum92/verify_compose_e2e.mjs) chạy được trên cả Git Bash và PowerShell.
