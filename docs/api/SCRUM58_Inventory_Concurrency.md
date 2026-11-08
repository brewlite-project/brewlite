# SCRUM-58 – Inventory Concurrency Control

Triển khai theo API Contract v3.0 mục 6–7 và quy tắc `POST /orders` kế thừa.
Giữ nguyên request/response thành công, JWT ownership và mã lỗi nghiệp vụ.
Không cần migration mới: sử dụng constraint `stock >= 0` và partial unique index
`uq_orders_one_active_per_user` đã có trong migrations.

## Luồng giữ tồn kho

`JwtAuthGuard → OrdersController → OrdersService → Prisma transaction → PostgreSQL`.

- Canonicalize User/Product UUID thành lowercase. Gom quantity của cùng Product,
  kể cả nhiều size, rồi cập nhật theo thứ tự Product ID cố định.
- Khóa advisory theo User cho Create Order để hai request cùng khách không giữ
  stock hai lần. Request sau đọc lại active Order; nếu còn hạn trả
  `409 PENDING_ORDER_EXISTS`. Không khóa row User vì Payment cập nhật loyalty
  theo thứ tự Order → User.
- `UPDATE ... WHERE stock >= quantity` giảm stock nguyên tử. PostgreSQL khóa
  dòng và kiểm tra lại điều kiện sau khi chờ transaction cạnh tranh. Thiếu hàng
  trả `409 INSUFFICIENT_STOCK`, giữ nguyên `details` của contract.
- Giữ stock, giữ quota coupon và tạo Order/items/snapshots trong cùng transaction.
  Nếu bất kỳ bước nào lỗi, rollback toàn bộ phần chưa commit. Payment FAILED/retry
  không hoàn hoặc trừ thêm stock.

## Hoàn tồn kho và cleanup trước Create Order

`expireOrderInTransaction(tx, orderId)` là hàm dùng chung cho Create Order và
Scheduler SCRUM-59. Hàm chỉ được gọi bên trong transaction:

1. Khóa Order bằng `SELECT ... FOR UPDATE`.
2. Đọc lại trạng thái, kiểm tra `expiresAt <= clock_timestamp()` sau lock.
3. Chỉ với PENDING/PAYMENT_FAILED đã hết hạn: chuyển CANCELLED và ghi cancelledAt.
4. Gom quantity từ OrderItem snapshot, hoàn Product theo cùng thứ tự ID.
5. Gọi helper `releaseHeldCoupon` để trả lượt HELD; commit tất cả cùng transaction.

Trạng thái CANCELLED là dấu mốc hoàn tài nguyên một lần. Gọi lặp hoặc chạy đồng
thời không tăng stock/coupon lần nữa. PAID và các trạng thái fulfillment không
bị hủy; không sửa Payment/loyalty. Lỗi hoàn Product hoặc coupon làm rollback cả
trạng thái CANCELLED và mọi thay đổi của transaction.

Create Order kiểm tra đơn cũ trước khi giữ hàng mới. Nếu cần cleanup, transaction
cleanup **commit riêng trước**, rồi transaction mới lấy lại khóa theo User và
kiểm tra active Order lần nữa. Điều này tránh giữ khóa Coupon cũ rồi chờ Product
của giỏ mới (ngược thứ tự khóa chung). Cleanup thất bại thì không tạo Order mới.
Cleanup đã commit không bị hoàn tác nếu giỏ mới lỗi; Order cũ đã hết hạn vẫn
CANCELLED và tài nguyên đã được trả lại.

## Bàn giao SCRUM-59

Scheduler có thể gọi cho **từng Order trong một transaction riêng**:

```ts
await runInventoryTransaction(prisma, (tx) =>
  expireOrderInTransaction(tx, orderId),
);
```

Hai hàm nằm ở `backend/src/orders/inventory-transaction.ts` và
`backend/src/orders/inventory-policy.ts`. Hàm expiration trả trạng thái sau xử lý
hoặc null nếu Order không còn tồn tại. Không tự đổi CANCELLED trước khi gọi hàm,
không hoàn stock/coupon bên ngoài hàm và không nuốt lỗi rồi commit transaction.

Thứ tự khóa: Create advisory theo User → Order cũ nếu có → Product theo ID →
Coupon → CouponRedemption. Khi tạo mới: Create advisory → Product → Coupon.
Payment giữ nguyên thứ tự khóa hiện tại. Scheduler không cần khóa advisory User,
nhưng phải dùng Order lock/recheck của hàm chung.

`runInventoryTransaction` dùng Read Committed, lock timeout 1500 ms, transaction
timeout 8 giây, maxWait 2 giây; tối đa 3 lần thử cho deadlock, serialization hoặc
lock timeout đã hủy transaction (`40P01`, `40001`, `55P03`, Prisma `P2034`). Mỗi lần
thử đọc lại toàn bộ state. Không retry lỗi nghiệp vụ, unique violation hoặc lỗi
kết nối có kết quả commit không chắc chắn. Create Order trả 500 INTERNAL_ERROR
an toàn nếu hết lượt retry; không giả báo thiếu stock khi Database đang bận.

## Kiểm thử

```powershell
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:e2e
# ORDERS_TEST_DATABASE_URL phải trỏ tới PostgreSQL test riêng đã migrate.
npm run test:integration -- test/inventory-postgres.integration-spec.ts
```

Suite SCRUM-58 kiểm tra trên PostgreSQL thật: tranh chấp ly cuối, size/UUID khác
case, hai request cùng User, giỏ đảo thứ tự Product, rollback multi-product,
stock sau khi writer commit/rollback, constraint DB, hoàn stock/coupon một lần,
cleanup đơn cũ trước tạo mới, cleanup lỗi, Create Order cạnh tranh với primitive
expiration, Payment FAILED/retry, Payment cạnh tranh với expiration, và retry
sau lỗi serialization thật mà không nhân đôi stock/Order.

Kết quả lần triển khai ban đầu ngày 2026-10-27: build, TypeScript và lint pass; 130 unit test,
130 E2E test và 100 integration test pass. Trong đó có 9 unit test retry mới và
25 integration test SCRUM-58. Integration chạy trên PostgreSQL 18 tạm riêng,
áp dụng 7 migration hiện có và bật `PAYMENT_CONCURRENCY_TESTS=1`. Không thay đổi
database hoặc `.env` của ứng dụng.

### Bổ sung theo review: rollback khi coupon bị từ chối

`backend/test/inventory-postgres.integration-spec.ts` bổ sung 3 test:

- Hết quota tổng: một Order đã thanh toán dùng hết quota coupon; khách khác
  tạo Order với hai Product và nhận `409 COUPON_UNAVAILABLE`.
- Hết quota theo User: quota tổng vẫn còn, nhưng User đã có một redemption
  CONSUMED và đạt `perUserLimit`; lần tạo tiếp theo nhận cùng lỗi 409.
- Hết lượt retry: PostgreSQL phát lỗi `40001` sau khi callback đã giữ stock,
  tăng quota và tạo Order/OrderItem/CouponRedemption trong từng lần thử.
  Sau đúng 3 lần thử, API trả `500 INTERNAL_ERROR`.

Hai test quota quan sát stock bên trong transaction ngay khi service từ chối
coupon, trước khi Prisma rollback, để xác nhận cả hai Product đã được trừ stock.
Sau request, stock, số Order/OrderItem/CouponRedemption và `active_usage_count`
phải bằng trạng thái trước request. Test retry cũng kiểm tra các bản ghi và quota
đã được ghi trong từng lần thử, rồi xác nhận không có side effect được lưu lại.
Wrapper `$transaction` vẫn chạy transaction, SQL và callback thật; case retry
chủ động dùng `RAISE EXCEPTION ... ERRCODE = '40001'` trong PostgreSQL để gây lỗi
ổn định, không cần chờ một serialization conflict ngẫu nhiên.

Kết quả sau bổ sung trên branch SCRUM-58 đã cập nhật từ `dev`, ngày 2026-10-27:
build, TypeScript và lint pass; **109/109 integration test pass**, trong đó
**28/28 test inventory**. Chạy trên PostgreSQL 18 test riêng với 7 migration và
`PAYMENT_CONCURRENCY_TESTS=1`. Lần bổ sung này chỉ sửa test và tài liệu;
unit/E2E không chạy lại.

**Deferred / Future improvement:** lịch chạy Scheduler mỗi phút, batch scan và
test với Scheduler thực thuộc SCRUM-59; Inventory Movement audit FR-INV-004 là
SHOULD/optional, chưa đưa vào task này. Không bổ sung endpoint hoặc bảng mới.
