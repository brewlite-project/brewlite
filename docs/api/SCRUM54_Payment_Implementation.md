# SCRUM-54 — bản triển khai Payment để review

Source dựa trên dev bad180d và Payment migration 20261026065408_add_payment_schema.
Các file được thay: backend/src/payments/*, backend/src/app.module.ts,
backend/test/payments-foundation.e2e-spec.ts,
backend/test/payments-postgres.integration-spec.ts và tài liệu này.
Không có schema/migration/dependency/secret/generated client trong gói source.

## Nhận bản cập nhật trên máy Hoàng

Đặt SCRUM54-payments-update.zip trong D:\CNPM_PJ\brewlite.
Kiểm tra `git status`, phải ở nhánh SCRUM-54-payment-foundation, không có source
đang sửa cần giữ. Giải nén vào thư mục gốc repo (gói có sẵn thư mục backend/docs).
Bản này là source chưa commit, sẽ hiện Changes trong VS Code. Không import bundle
cũ lần nữa. Không ghi đè .env, Prisma schema, migration hoặc package files.

```powershell
Expand-Archive -LiteralPath .\SCRUM54-payments-update.zip -DestinationPath . -Force
cd backend
npm.cmd run db:generate
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
```

Chi tiết transaction và lệnh integration nằm trong backend/src/payments/README.md.
Database demo của Hoàng đã migrate; không reset. Dùng database test riêng đã có
7 migrations và đặt AUTH_TEST_DATABASE_URL cục bộ để chạy integration Payment.
Không gửi URL chứa mật khẩu vào chat, không commit .env.

## Kiểm tra đã thực hiện trong môi trường triển khai

- Prisma generate, TypeScript noEmit, lint, build: PASS.
- Unit tests: 90 PASS.
- HTTP/E2E tests: 120 PASS, dùng mock/processor double cho persistence.
- 7 migrations trên database mới PostgreSQL nhúng PGlite qua TCP: PASS.
- Integration (Prisma thật, không mock DB): 29 PASS gồm Payment 15, Auth 6,
  Order 8; 4 case concurrency Payment được skip có chủ đích.
- Môi trường PGlite chạy TZ=UTC để đồng bộ thời gian; không suy ra kiểm thử đã
  chạy trên PostgreSQL cài đặt. Runtime không có PostgreSQL server nhiều backend.
- Chưa xác minh 4 case multi-connection trên PostgreSQL thật. Bật
  PAYMENT_CONCURRENCY_TESTS=1 và chạy file Payment integration như README.
- Chưa kiểm thử phối hợp Scheduler thật/Order lifecycle của Chí Khang hoặc FE.

## Phạm vi và tình trạng task

Endpoint /payments đã bật; SUCCESS/FAILED, snapshot, replay/key conflict/busy,
ownership, DB clock/expiry, atomic PAID/FAILED, consume coupon và award points
được triển khai theo Contract v3.0. Idempotency và các hiệu ứng SUCCESS cần có
ngay để endpoint đúng contract; không tuyên bố SCRUM-55/56 hoặc Sprint 3 Done
chỉ dựa vào thay đổi SCRUM-54 này. Giữ phần pricing/quota của Create Order và
Scheduler/stock release/later transitions cho người phụ trách tương ứng.

Chưa commit/push: AGENTS.md hiện yêu cầu người dùng duyệt riêng các bước Git đó.
Review source/diff và chạy lại kiểm tra trên PostgreSQL của nhóm trước nghiệm thu.
