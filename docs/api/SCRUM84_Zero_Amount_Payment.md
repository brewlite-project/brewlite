# SCRUM-84 / P2-10 – ZERO_AMOUNT Payment

Triển khai API-04 theo API Contract v4.0 và BR-06, dùng
`PaymentFinalizationService` của SCRUM-78. Tài liệu này ghi nhận phạm vi code;
không thay đổi trạng thái phê duyệt của Contract v4.0.

## API

```http
POST /payments/zero-amount
Authorization: Bearer <JWT>
Idempotency-Key: <8–64 ký tự>
Content-Type: application/json
```

```json
{ "orderId": "550e8400-e29b-41d4-a716-446655440000" }
```

Chỉ `orderId` được sử dụng từ body. Owner lấy từ JWT đã xác minh; tổng tiền lấy
từ Order snapshot trong database. UUID được chuẩn hóa chữ thường trước khi hash
request và điều phối key.

Lần đầu: HTTP 201, `Idempotency-Replayed: false`. Replay cùng key/request: HTTP
200, `Idempotency-Replayed: true`, cùng response snapshot:

```json
{
  "paymentId": "f52a8613-64e7-4f83-af30-e390bd32eb49",
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "ZERO_AMOUNT",
  "paymentStatus": "SUCCESS",
  "orderStatus": "PAID",
  "amountVnd": 0,
  "pointsEarned": 0,
  "createdAt": "2026-11-03T00:00:00.000Z"
}
```

Không có `paymentUrl` hoặc HTTP redirect. Không gọi VNPay/Mock; không cần cấu
hình VNPay và hoạt động độc lập với cờ bật/tắt Mock.

## Transaction và idempotency

`JwtAuthGuard → ZeroAmountPaymentController → ZeroAmountPaymentService → Shared Finalization → Prisma/PostgreSQL`.

- Validate body/key; xác minh Order thuộc JWT owner trước mọi thông tin về key.
- Hash canonical request với operation ZERO_AMOUNT; dùng chung namespace
  `(userId, Idempotency-Key)` và advisory lock identity với Mock/VNPay.
- Shared Finalization khóa Order, đọc lại trạng thái/amount và DB clock; kiểm tra
  replay trước khi từ chối trạng thái hoặc expiry. Không mở nested transaction.
- Chỉ hoàn tất attempt mới khi Order còn hạn và `totalVnd = 0`; không có SUCCESS,
  PENDING/uncertain hoặc financial exception. ZERO_AMOUNT không có Grace.
- Tạo Payment SUCCESS, Order PAID, coupon HELD → CONSUMED trong cùng transaction;
  stock đã reserve được giữ nguyên, không tăng Loyalty, `pointsEarned = 0`.
- Replay trả snapshot nguyên bản kể cả Order đã hết hạn hoặc chuyển sang trạng
  thái fulfillment. Không tạo Payment hay thực hiện side effects lần nữa.
- Busy key hoặc lock/serialization contention trả 409 PAYMENT_IN_PROGRESS; client
  retry cùng key. Lỗi transaction rollback toàn bộ, không tạo Payment FAILED giả.
- Không có schema/migration mới trong P2-10.

## Error contract

| HTTP | Code                                | Trường hợp                                        |
| ---- | ----------------------------------- | ------------------------------------------------- |
| 400  | VALIDATION_ERROR                    | Body/UUID hoặc key không hợp lệ                   |
| 401  | UNAUTHORIZED                        | JWT thiếu/sai/hết hạn                             |
| 404  | NOT_FOUND                           | Order không tồn tại hoặc thuộc người khác         |
| 409  | ORDER_NOT_ZERO_AMOUNT               | Attempt mới cho Order có totalVnd > 0             |
| 409  | ORDER_EXPIRED                       | Attempt mới tại/sau expiresAt                     |
| 409  | INVALID_TRANSITION                  | Trạng thái không đủ điều kiện hoặc đã có SUCCESS  |
| 409  | IDEMPOTENCY_KEY_CONFLICT            | Key đã dùng cho Order/request/provider khác       |
| 409  | PAYMENT_IN_PROGRESS                 | Attempt chưa rõ kết quả hoặc đang cạnh tranh lock |
| 409  | FINANCIAL_EXCEPTION_REQUIRES_REVIEW | Payment có ngoại lệ/cần review                    |
| 500  | INTERNAL_ERROR                      | Lỗi nội bộ; rollback và không trả SQL/credential  |

## Kiểm thử

Đã chạy ngày 03/11/2026 trên branch SCRUM-84:

- Build, TypeScript check và lint: pass.
- Toàn bộ unit: 241 passed; toàn bộ integration: 186 passed;
  toàn bộ E2E: 211 passed, không có case bị skip.
- Riêng P2-10: 20 unit, 25 PostgreSQL integration và 9 HTTP/JWT/Swagger E2E.
- Database test tạm tại `localhost:5433/brewlite_test` được áp dụng đủ 9 migration
  hiện có và kiểm tra migration status trước khi chạy; không tạo migration mới.

Chạy từ `backend/`, đặt `AUTH_TEST_DATABASE_URL` và `ORDERS_TEST_DATABASE_URL`
trong process tới database test riêng `localhost:5433/brewlite_test` đã migrate.
Không dùng database demo/production: Scheduler test quét Order hết hạn.

```powershell
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:e2e
$env:PAYMENT_CONCURRENCY_TESTS = '1'
npm run test:integration
```

Test mới bao gồm HTTP/JWT/Swagger; zero Order có/không coupon; amount/ownership và
key validation; expiry và replay sau fulfillment; namespace key qua providers;
legacy Mock FAILED 0đ; rollback sau Payment/Coupon writes; request cùng/khác key;
Order lock timeout thật; Scheduler cạnh tranh với completion theo cả hai thứ tự.
Race test quan sát PostgreSQL lock waits và dùng transaction thật. Timestamp
fixture rút ngắn thời gian chờ; giữ nguyên TTL nghiệp vụ production/demo.

## Dependency: API-06 Order History

Handoff SCRUM-78 ghi nhận `GET /orders/me` dùng Mock snapshot parser cho
ZERO_AMOUNT, có thể trả HTTP 500. P2-10 cung cấp endpoint settlement và không
thay đổi Order History/presentation mapper. Owner API-06 cần nối read model và
kiểm thử history cho ZERO_AMOUNT; không xem test endpoint PAID là bằng chứng
history đã hoạt động. Mock environment policy thuộc task P2-11.
