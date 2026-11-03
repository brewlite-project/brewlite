# SCRUM-92 / P2-18 — Verify Docker Clean Setup & Integration

- **Task**: `SCRUM-92` (`P2-18 – Verify Docker Clean Setup & Integration`)
- **Branch**: `SCRUM-92-p-2-18-verify-docker-clean-setup-integration` (branched from `dev` @ `04dcd26`)
- **Date**: 2026-11-03
- **Dependencies verified on `dev`**:
  - `P2-06` (`SCRUM-80` — Prisma migrations & guarded demo seed)
  - `P2-15` (`SCRUM-89` — `backend/Dockerfile` multi-stage `build`, `migrate`, `production`)
  - `P2-16` (`SCRUM-90` — `frontend/Dockerfile` standalone + `/api/backend/*` reverse proxy)
  - `P2-17` (`SCRUM-91` — `docker-compose.yml`, `compose.env.example`, `scripts/compose-preflight-env.sh`, `docs/Docker_Compose.md`)

---

## 1. Clean Setup Reproduction Steps (No Machine-Specific Env Dependencies)

1. **Tạo `compose.env` độc lập từ `compose.env.example`**:
   - Sao chép `compose.env.example` sang `compose.env` (file local, đã được `.gitignore` loại trừ).
   - Khởi tạo các giá trị ngẫu nhiên cục bộ cho `POSTGRES_PASSWORD`, `DATABASE_URL` (`@postgres:5432/brewlite_compose`), `JWT_SECRET` ($\ge 32$ bytes), `INTERNAL_SECRET`. Hoàn toàn không phụ thuộc vào bất kỳ biến môi trường có sẵn nào trên máy cá nhân.
2. **Chạy Preflight & Build/Start Compose từ Source**:
   ```bash
   bash scripts/compose-preflight-env.sh
   docker compose --env-file compose.env up --build -d
   docker compose --env-file compose.env ps
   ```
3. **Kiểm tra trạng thái Migration & Chạy Guarded Demo Seed**:
   ```bash
   docker compose --env-file compose.env exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database() AS database_name, (SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL) AS completed_migrations, (SELECT count(*) FROM products) AS product_count;"'
   docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
   ```

---

## 2. Verification Evidence

### 2.1. Service Health & Startup Sequence

| Container | Image / Target | Port Mapping | Status | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `brewlite_compose-postgres-1` | `postgres:18-alpine` | `127.0.0.1:15432->5432/tcp` | `Up (healthy)` | Healthcheck `pg_isready` |
| `brewlite_compose-migrate-1` | `brewlite_compose-migrate` (`migrate` stage) | *(internal only)* | `Exited (0)` | Applied 9 Prisma migrations cleanly |
| `brewlite_compose-backend-1` | `brewlite_compose-backend` (`production` stage) | `127.0.0.1:3001->3001/tcp` | `Up (healthy)` | Started after `migrate` exited `0` |
| `brewlite_compose-frontend-1` | `brewlite_compose-frontend` (`runner` stage) | `0.0.0.0:3000->3000/tcp` | `Up (healthy)` | Started after `backend` became healthy |

### 2.2. Database Migration & Seed Counts

- Trước khi seed:
  - `database_name = brewlite_compose`
  - `completed_migrations = 9`
  - `product_count = 0`
- Sau khi chạy `docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed`:
  - `categories = 4`
  - `products = 9`
  - `toppings = 5`

### 2.3. End-to-End Integration Test (`FE -> /api/backend/* -> BE -> PostgreSQL`)

Toàn bộ các luồng tích hợp đi qua reverse proxy của Frontend (`http://localhost:3000/api/backend/*` $\rightarrow$ `http://backend:3001/*`) đã được kiểm chứng tự động:

1. **Smoke Check**:
   - `GET http://localhost:3000/` $\rightarrow$ `200 OK`
   - `GET http://localhost:3001/` $\rightarrow$ `200 OK` (`Hello World!`)
   - `GET http://localhost:3001/api-docs` $\rightarrow$ `200 OK` (Swagger UI)
   - `GET http://localhost:3000/images/bac-xiu-kem-beo-phin.jpg` $\rightarrow$ `200 OK`
2. **Catalog (`GET /api/backend/products` & `GET /api/backend/products/:id`)**:
   - Trả về đúng 9 sản phẩm đã seed và đầy đủ `sizes` (`S/M/L`), `toppings`.
3. **Authentication (`POST /api/backend/auth/register` $\rightarrow$ `POST /api/backend/auth/login` $\rightarrow$ `GET /api/backend/auth/me`)**:
   - Đăng ký tài khoản mới (`201 Created`, Argon2id native module hoạt động ổn định trong `node:26-bookworm-slim`), đăng nhập nhận JWT (`200 OK`), truy vấn hồ sơ (`loyaltyPoints = 0`).
4. **Order Creation (`POST /api/backend/orders`)**:
   - Tạo đơn hàng `2x Bạc Xỉu Kem Béo Phin (Size S + Kem Phô Mai Macchiato)` $\rightarrow$ `201 Created`, trạng thái `PENDING`, `totalVnd = 104000`.
5. **Mock Payment & Idempotency (`POST /api/backend/payments`)**:
   - Lần 1 (thẻ đuôi `0002`): `200 OK`, `paymentStatus = FAILED`, `orderStatus = PAYMENT_FAILED`, `errorCode = PAYMENT_DECLINED`.
   - Lần 2 (retry với `Idempotency-Key` mới, thẻ đuôi `1234`): `200 OK`, `paymentStatus = SUCCESS`, `orderStatus = PAID`, `pointsEarned = 10`.
   - Lần 3 (gửi lại cùng `Idempotency-Key` lần 2): `200 OK`, header `idempotency-replayed: true`, không tạo bản ghi `Payment` trùng lặp.
6. **Order History & Loyalty (`GET /api/backend/orders/me` & `GET /api/backend/auth/me`)**:
   - Đơn hàng hiển thị `status = PAID`, `payment.status = SUCCESS`, hồ sơ người dùng cập nhật `loyaltyPoints = 10`.
7. **Restart & Persistence (`docker compose stop` $\rightarrow$ `docker compose start`)**:
   - Dừng toàn bộ containers bằng `docker compose --env-file compose.env stop` và bật lại bằng `docker compose --env-file compose.env start`.
   - Kiểm tra lại với cùng JWT token: đơn hàng `PAID`, bản ghi `Payment` `SUCCESS`, và `loyaltyPoints = 10` được bảo toàn 100% trong volume `brewlite_compose_brewlite_pgdata`.
8. **VNPay Sandbox Initiation (`POST /api/backend/payments/vnpay/initiate`)**:
   - Khởi tạo giao dịch VNPay trên đơn `PENDING` mới $\rightarrow$ `201 Created` (`provider = VNPAY`, `paymentStatus = PENDING`, trả về `paymentUrl` ký HMAC-SHA512 trỏ tới `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?...`).
   - Gọi lại cùng `Idempotency-Key` $\rightarrow$ `200 OK` kèm header `idempotency-replayed: true`.

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

### Issue #4 [Minor — Developer Experience trên Windows & Tài liệu `README.md`]:

- **Module / Owner**: `P2-17` (`SCRUM-91` — `README.md`, `docs/Docker_Compose.md`).
- **Chi tiết**:
  1. Trên Windows, các lệnh chứa `bash scripts/compose-preflight-env.sh` và chuỗi nháy đơn `'psql -U "$POSTGRES_USER" ...'` cần được chạy trong **Git Bash** (theo đúng thiết kế của `docs/Docker_Compose.md`). Nếu chạy trực tiếp trong Windows PowerShell mà máy chưa cài distro WSL Linux, lệnh `bash` sẽ gọi `C:\Windows\System32\bash.exe` (WSL launcher) và báo `WSL_E_DEFAULT_DISTRO_NOT_FOUND`.
  2. `README.md` ở thư mục gốc trước `SCRUM-92` vẫn hiển thị câu lệnh cũ `docker compose up --build` (thiếu bước tạo `compose.env` và thiếu `--env-file compose.env`). Đã cập nhật lại `README.md` trong `SCRUM-92`.
