# SCRUM-85 / P2-11 — Mock Payment Environment Access Policy

Triển khai policy cho `POST /payments` theo API Contract v4.0, API-05 và
Phụ lục E. Giữ Mock v3.0 cho test/demo; không thay đổi API Contract, schema,
migration hoặc thêm giao diện Customer.

## Environment policy

| NODE_ENV | MOCK_PAYMENT_ENABLED | Kết quả với JWT hợp lệ |
| --- | --- | --- |
| Khác `production` | Chuỗi chính xác `true` | Cho phép xử lý Mock |
| Khác `production` | Thiếu, rỗng, `false` hoặc giá trị khác | 403 MOCK_PAYMENT_DISABLED |
| `production` | Bất kỳ giá trị nào, kể cả `true` | 403 MOCK_PAYMENT_DISABLED |

Fail-closed: không trim/coerce flag; `TRUE`, `1`, `yes` hoặc `true ` không bật Mock.
Quyền chỉ lấy từ environment backend, không lấy từ body/header phía client.

JWT Guard chạy trước Mock Guard; JWT thiếu/sai vẫn trả 401 UNAUTHORIZED.
Với JWT hợp lệ, policy được kiểm tra trước validation body/key, DB lookup,
idempotency replay và side effects. Lời gọi trực tiếp PaymentsService cũng bị
kiểm tra bằng cùng policy.

```json
{
  "statusCode": 403,
  "message": "Mock payment is disabled in this environment",
  "error": "Forbidden",
  "code": "MOCK_PAYMENT_DISABLED"
}
```

Khi disabled, kể cả receipt SUCCESS/FAILED đã tồn tại cũng không được trả lại;
không có `Idempotency-Replayed` header, không cập nhật dữ liệu. Khi bật lại,
replay vẫn trả snapshot gốc, kể cả Order đã hết hạn, và không lặp side effects.

## Luồng và phạm vi

`JwtAuthGuard → MockPaymentGuard → validation/PaymentsController → PaymentsService → shared Finalization → Prisma/PostgreSQL`.

- Guard chỉ gắn vào Mock `POST /payments`, không gắn cấp Controller vì Controller
  còn chứa VNPay initiation. Service kiểm tra lại trước mọi xử lý Mock.
- Giữ request/response v3.0, HTTP 200 cho Mock SUCCESS và FAILED, JWT ownership,
  idempotency, snapshot, transaction và lock order hiện có.
- Giữ cross-provider gate trong shared Finalization sau Order lock:
  PENDING/chưa rõ kết quả → 409 PAYMENT_IN_PROGRESS; financial exception hoặc
  REQUIRES_REVIEW → 409 FINANCIAL_EXCEPTION_REQUIRES_REVIEW.
- Không tự fallback khi VNPay lỗi mạng, timeout hoặc chưa xác định kết quả.
  Một Mock attempt được yêu cầu rõ ràng sau VNPay terminal FAILED chỉ được
  xử lý khi Order còn hạn và mọi điều kiện khác thỏa.
- Order 0đ tiếp tục bị Mock từ chối với 409 INVALID_TRANSITION theo BR-06.
  Cờ Mock không điều khiển VNPay hoặc ZERO_AMOUNT. ZERO_AMOUNT HTTP endpoint
  thuộc task P2-10, không thêm endpoint đó trong task này.
- Không thay đổi thuật toán Mock, schema/migration hoặc frontend.

## Cấu hình local và Docker

`backend/.env.example` mặc định `MOCK_PAYMENT_ENABLED=false`.
Để test/demo local, đặt `MOCK_PAYMENT_ENABLED=true` trong `backend/.env`, bảo đảm
`NODE_ENV` khác `production` rồi khởi động lại backend. Không commit `.env`.

Backend Docker runtime hiện có `NODE_ENV=production`, nên Mock luôn disabled
trong Compose. Không đổi Dockerfile hoặc mở Mock cho production trong task này.

## Kiểm thử

- Unit: ma trận môi trường/flag; lời gọi Service trực tiếp bị chặn trước
  validation, transaction và Mock evaluation.
- HTTP/JWT/Swagger: disabled kể cả replay, precedence trước validation,
  không tin client flag, JWT vẫn bắt buộc, Swagger 403, VNPay không bị gate và
  lỗi initiation không gọi Mock processor.
- PostgreSQL: request mới/replay disabled không đổi Payment/Order/coupon/stock/
  points; bật lại trả receipt gốc; PENDING, timeout/lỗi mạng, review/financial
  exception vẫn chặn Mock; terminal VNPay FAILED cho phép explicit Mock attempt.
- Regression: từng suite dùng Mock tự opt-in trong environment test và restore
  sau khi chạy. Không thay đổi kỳ vọng nghiệp vụ Mock Phase 1.

Chạy tại `backend/`:

```powershell
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:e2e
# Dùng PostgreSQL test riêng đã migrate, không dùng DB demo/production.
# AUTH_TEST_DATABASE_URL và ORDERS_TEST_DATABASE_URL phải trỏ DB test.
$env:PAYMENT_CONCURRENCY_TESTS = '1'
npm run test:integration
```

Suite concurrency yêu cầu DB riêng `localhost:5433/brewlite_test` và kiểm tra
migration ledger trước khi chạy.

### Kết quả xác minh ngày 03/11/2026

Branch: `SCRUM-85-P2-11-Implement-Mock-Payment-Environment-Access-Policy`.
Đã đồng bộ `origin/dev` tại `7da19aa`, gồm P2-09 và P2-10.

- `npm run build`, `npx tsc --noEmit`, `npm run lint`: pass.
- Toàn bộ unit: **263 passed**, 29 files.
- Toàn bộ HTTP E2E: **220 passed**, 9 files.
- Toàn bộ PostgreSQL integration với `PAYMENT_CONCURRENCY_TESTS=1`:
  **224 passed**, 12 files; không có test skip.
- Riêng `payments-postgres.integration-spec.ts`: **42 passed**, gồm 12 case
  mới về environment policy, receipt replay và cross-provider safety.
- P2-11 còn bổ sung 16 unit case và 9 HTTP case; regression Mock cũ giữ nguyên
  hành vi khi test suite được cấp quyền bằng environment.

Integration chạy trên cluster PostgreSQL test tạm riêng tại
`localhost:5433/brewlite_test`, áp dụng đủ 9 migration hiện có và xác minh
`prisma migrate status` báo up to date. Không dùng DB demo/production, không tạo
migration mới. Cluster test được dừng sau khi kiểm tra.

Vitest cần chạy ngoài sandbox do sandbox chặn tạo process (`spawn EPERM`).
Compose environment preflight và `docker compose config --quiet`: pass với env tạm.
Không chạy Docker/Compose E2E trong lần này vì Docker daemon chưa chạy;
production denial được kiểm tra bằng unit, HTTP và PostgreSQL integration.
