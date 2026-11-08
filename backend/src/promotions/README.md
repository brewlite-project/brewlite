# SCRUM-56 Promotion and Loyalty

Nền: dev 30b949f, đã gồm SCRUM-54, SCRUM-55 và GET /orders/me. Nguồn nghiệp vụ:
API Contract v3.0 §3, §7; Requirements FR-PRO-001..004; AC-US-PRO-01..04.
Không thay schema, migrations, dependencies hoặc request/response shape. Không thêm
coupon preview, Customer cancel, đổi điểm hoặc GET /auth/me (owner Thụy).

## Luồng tạo Order và thanh toán

POST /orders chuẩn hóa coupon theo DTO hiện có; kiểm tra tồn tại, thời hạn UTC và
minSubtotal trên subtotal server. Coupon sai trả 400 INVALID_COUPON. Stock được giữ
trước quota, theo thứ tự Product ID hiện có. Nếu thiếu cả stock và quota, trả
409 INSUFFICIENT_STOCK. Sau đó reserveCoupon lấy Coupon FOR UPDATE, đọc lại cấu
hình/điều kiện/quota và đếm HELD + CONSUMED của user; RELEASED không tính. Hết
usageLimit hoặc perUserLimit trả 409 COUPON_UNAVAILABLE. Chỉ tăng activeUsageCount
một lần và tạo Order + HELD redemption trong cùng transaction READ COMMITTED.
Bất kỳ lỗi nào cũng rollback stock, quota, Order và redemption chưa commit.

calculateDiscount dùng BigInt: FIXED giới hạn subtotal; PERCENT half-up đến VND,
áp maxDiscountVnd rồi giới hạn subtotal. Coupon code/discount/total được lưu vào
Order. Sửa coupon sau đó không thay các snapshots đã lưu.

POST /payments dùng calculateLoyaltyPoints trên totalVnd đã trừ giảm giá:
floor(totalVnd / 10000), có kiểm tra giới hạn Int của PostgreSQL. Giữ transaction
và idempotency của SCRUM-54/55: SUCCESS đổi PAID, ghi pointsEarned, consume HELD và
increment số dư một lần; FAILED giữ HELD/stock và không cộng điểm; replay không
lặp hiệu ứng. Total 0 vẫn qua Mock Payment, nhận 0 điểm.

## Lifecycle đã tích hợp trên dev

SCRUM-58/59 gọi releaseHeldCoupon qua expireOrderInTransaction trong cùng
transaction với khóa Order, kiểm tra thời hạn, chuyển CANCELLED và hoàn stock.
OrderExpirationService chạy luồng này theo batch; Create Order cũng dùng chung
primitive khi xử lý đơn cũ hết hạn. Không thêm Customer cancel API (deferred).

Các test trong test/order-lifecycle.integration-spec.ts kiểm tra Scheduler thật,
trả quota/stock đúng một lần, rollback và cạnh tranh Payment–Scheduler.
Test harness trong promotions-postgres.integration-spec.ts chỉ kiểm tra helper.

INVALID_COUPON giữ HTTP 400 và error envelope v3.0, với message phân biệt:
- Coupon does not exist
- Coupon is not active yet
- Coupon has expired
- Order subtotal does not meet coupon minimum

Quota tổng/per-user vẫn trả HTTP 409 COUPON_UNAVAILABLE.

## Kiểm tra

Đã chạy tại môi trường triển khai ngày 2026-10-27:

- Prisma validate/generate: PASS; áp đủ 7 migrations trên database nhúng mới: PASS.
- TypeScript --noEmit, lint, build: PASS; lint không còn warning.
- Unit: 121/121 PASS.
- E2E: 130/130 PASS, gồm cập nhật quota errors và thêm stock priority/revalidation.
- Integration toàn bộ trên PGlite: 65 PASS, 10 SKIPPED.
- Riêng promotions-postgres.integration-spec.ts: 25 PASS, 3 SKIPPED (28 tests).
  PGlite không chứng minh concurrency nhiều connection PostgreSQL thật.

Cần chạy trên PostgreSQL thật đã migrate, trong backend, với AUTH_TEST_DATABASE_URL
là URL database test của bạn (không commit URL/mật khẩu):

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
$env:PAYMENT_CONCURRENCY_TESTS = "1"
npm.cmd run test:integration -- test/promotions-postgres.integration-spec.ts test/payments-postgres.integration-spec.ts
```

Kỳ vọng promotions 28/28 + payments 29/29 = 57/57, không skip. Ba test concurrency
mới: hai Customer tranh lượt coupon cuối, hai Create Order cùng user và hai lần
trả coupon của cùng Order. Nếu chạy toàn bộ integration, cần đặt thêm
ORDERS_TEST_DATABASE_URL tới database test đã migrate; kỳ vọng 75/75 không skip.
Test chỉ cleanup các fixture riêng đã tạo; không reset/drop database.

Chưa có kết quả PostgreSQL native cho thay đổi task 56. Không coi test skipped
là pass hoặc tuyên bố toàn lifecycle đã hoàn tất trước khi tích hợp Scheduler.

## Sửa lỗi timezone khi tích hợp Order và Payment

Trong adapter-pg 7.10.1 hiện dùng, DateTime đầu vào được serialize theo UTC nhưng
không kèm offset; parser timestamptz đầu ra giả định session UTC. Session UTC+7
có thể khiến expiresAt đọc lệch so với clock_timestamp(), Payment từ chối Order
vừa tạo với 409 INVALID_TRANSITION. Đã tái hiện 16 test fail trong môi trường
nhúng UTC+7, khớp nhóm lỗi do người dùng báo.

PrismaService cấu hình options: '-c timezone=UTC' cho từng kết nối PostgreSQL.
Đây là session setting, không đổi schema hay timezone của Windows/server chung.
Test đầu tiên kiểm tra offset session bằng 0, Order chưa expired theo clock DB
và expiresAt cách createdAt đúng 15 phút; không sửa fixture để né expiry check.
Bản cập nhật thêm backend/src/prisma/prisma.service.ts vào gói source.

PostgreSQL nhúng không áp dụng startup options như server native; kiểm tra tại
môi trường UTC đã chạy PASS. Cần chạy lại 57/57 trên PostgreSQL thật để xác nhận
startup options được áp dụng ở từng connection; không coi test native đã pass.
