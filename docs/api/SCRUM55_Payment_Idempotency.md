# SCRUM-55 — Payment Idempotency

## Nền triển khai

API Contract v3.0, phần POST /payments và idempotency. Delta này dựa trên
SCRUM-54-payment-foundation commit 46986c9, không thay schema, migrations,
dependency, request/response shape hoặc error codes. SCRUM-54 cần có trong dev
trước khi mở PR riêng SCRUM-55 vào dev.

## Hành vi

- Idempotency-Key bắt buộc 8–64 ký tự, giữ nguyên casing. Namespace theo user từ JWT.
- Canonical payload chỉ gồm orderId lowercase, method và credential được validate.
  Thứ tự property, field bị ignore không làm đổi requestHash; đổi accepted value thì đổi hash.
- Ownership được kiểm tra trước mọi lookup/replay/conflict/key busy.
- Cùng key/cùng payload trả snapshot đã commit với Idempotency-Replayed: true,
  kể cả Order hết hạn, đã chuyển trạng thái hoặc FAILED rồi có attempt khác SUCCESS.
- Cùng key/khác payload: 409 IDEMPOTENCY_KEY_CONFLICT; key bận chưa có snapshot:
  409 PAYMENT_IN_PROGRESS. Kết quả đã commit không cần lấy advisory lock.
- Sau lookup ban đầu vẫn kiểm tra lại sau key lock và Order FOR UPDATE. Khi try-lock
  thất bại, đọc lại snapshot để xử lý writer vừa commit. Chuẩn hóa user UUID bảo đảm
  JWT viết hoa/thường dùng cùng lock identity và database unique constraint.
- Transaction và unique constraints sẵn có bảo vệ one SUCCESS/order và một row/user/key.
  Replay không chạy mock, không tạo attempt mới, không cộng lại điểm/consume lại coupon.
  Technical failure rollback toàn bộ và cho phép retry key cũ.

## File thay đổi

- backend/src/payments/payments.service.ts
- backend/src/payments/payment-idempotency.spec.ts (mới)
- backend/test/payments-postgres.integration-spec.ts
- backend/src/payments/README.md
- docs/api/SCRUM55_Payment_Idempotency.md (mới)

## Kết quả kiểm tra tại môi trường triển khai

- Prisma generate, TypeScript --noEmit, lint, build: PASS.
- Unit: 97/97 PASS; E2E: 120/120 PASS.
- Apply đủ 7 migrations lên DB PostgreSQL nhúng mới: PASS.
- Integration toàn bộ trên PGlite: 36 PASS, 7 concurrency tests SKIPPED.
  Riêng Payment: 22 PASS, 7 SKIPPED. PGlite không chứng minh concurrent locks
  trên nhiều connection PostgreSQL thật. Không coi các test SKIPPED là PASS.

## Cần chạy trên PostgreSQL trước khi nghiệm thu

Dùng database test đã migrate. Không đưa URL/mật khẩu vào commit.
Trong backend, AUTH_TEST_DATABASE_URL phải được thiết lập cho database test:

```powershell
$env:PAYMENT_CONCURRENCY_TESTS = "1"
npx.cmd vitest run --config ./vitest.config.integration.ts test/payments-postgres.integration-spec.ts
```

Kỳ vọng 29/29 Payment integration PASS, không skip. Kiểm tra 7 ca concurrency:
receipt đã commit dù advisory key bị giữ; Order lock timeout rồi retry; hai payload
khác nhau cùng key; cùng key song song; khác key cùng Order; busy key rollback;
Order bị CANCELLED trong lúc Payment đợi lock. Các test tạo/cleanup fixture riêng.

Không commit/push trong lần triển khai này. Không tự đánh dấu Jira Done; cần
PostgreSQL concurrency PASS và review. Toàn lifecycle với Scheduler của nhóm là
kiểm tra tích hợp tiếp theo, không được giả lập thành kết quả đã nghiệm thu.
