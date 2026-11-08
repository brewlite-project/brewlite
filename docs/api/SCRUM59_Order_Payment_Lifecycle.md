# SCRUM-59 – Integrate Order–Payment Lifecycle

Triển khai theo API Contract v3.0 mục 3, 5–7, dùng lại SCRUM-57 (internal advance)
và SCRUM-58 (transaction giữ/hoàn stock). Không đổi request/response của các API
đã có; không thêm endpoint Scheduler, bảng, migration hoặc package mới.

## Hành vi đã nối

| Sự kiện | Order | Stock / coupon / điểm |
| --- | --- | --- |
| Tạo đơn | PENDING | Giữ stock và coupon HELD trong transaction |
| Mock Payment FAILED | PAYMENT_FAILED | Giữ nguyên stock/coupon, không cộng điểm |
| Retry trước hạn | PAID hoặc PAYMENT_FAILED | Không giữ thêm stock/coupon; không gia hạn expiresAt |
| Payment SUCCESS | PAID | Coupon CONSUMED; cộng floor(totalVnd/10000) điểm đúng một lần |
| Internal advance | PREPARING → READY → COMPLETED | Không đổi tài nguyên hoặc điểm |
| Hết hạn khi còn PENDING/PAYMENT_FAILED | CANCELLED | Hoàn stock và coupon HELD đúng một lần, không đổi điểm |
| Replay cùng key/payload | Giữ nguyên trạng thái hiện tại | Trả snapshot cũ, không lặp side effect |

Payment mới vẫn tự từ chối Order hết hạn, kể cả trước lượt Scheduler tiếp theo.
Payment replay hợp lệ vẫn trả snapshot cũ khi Order đã hoàn tất, hết hạn hoặc bị
hủy. `GET /orders/me` trả trạng thái Order hiện tại cùng Payment theo contract.
Đơn 0 VND vẫn qua Mock Payment, nhận 0 điểm.

## Scheduler và cấu hình

Trong `backend/.env`, có thể cấu hình:

```dotenv
ORDER_EXPIRATION_ENABLED=true
ORDER_EXPIRATION_BATCH_SIZE=50
```

- Mặc định bật; lần quét đầu sau 60 giây kể từ khi Nest bootstrap, sau đó mỗi
  60 giây. Không cần thêm hai biến này nếu dùng mặc định.
- `enabled` chỉ nhận `true` hoặc `false`; batch size là số nguyên 1..1000. Đây là
  cấu hình vận hành, không phải giới hạn số Order theo nghiệp vụ.
- Batch size giới hạn số ID đọc mỗi lần; một lượt quét đi qua nhiều batch.
- TTL đơn chưa thanh toán giữ nguyên **15 phút**. Scheduler không gia hạn TTL.
  Test tạo deadline trong database fixture, không đổi mặc định production/demo.
- `INTERNAL_SECRET` của SCRUM-57 vẫn cần cho API advance. Secret không được đưa
  vào frontend hoặc commit. Scheduler không gọi HTTP và không cần internal key.
- Khởi động lại backend sau khi thay cấu hình. Khi tắt Scheduler, Payment vẫn
  kiểm tra hạn; Create Order vẫn có cleanup đơn hết hạn của SCRUM-58.

## Transaction và concurrency

`OrderExpirationService → runInventoryTransaction → expireOrderInTransaction → Prisma/PostgreSQL`.

Mỗi lượt quét chốt cutoff từ `clock_timestamp()` trên Database, giữ chính xác
timestamp bằng chuỗi PostgreSQL. Query chỉ lấy PENDING/PAYMENT_FAILED có
`expires_at <= cutoff`. Dùng keyset theo UUID để đi qua các batch, kể cả khi một
Order lỗi, nên không lặp vô hạn hoặc bỏ đói các batch sau. Các Order vừa hết hạn
sau cutoff sẽ được xét ở lượt kế tiếp.

Mỗi Order có transaction riêng: khóa Order → đọc lại state/hạn theo DB clock →
CANCELLED + cancelledAt → hoàn Product theo thứ tự ID → trả coupon HELD. Một lỗi
làm rollback toàn bộ thay đổi của Order đó; các Order đã commit vẫn giữ kết quả.
Lượt quét sau thử lại Order lỗi. Log chỉ chứa thông báo an toàn và Order ID, không
ghi SQL, kết nối database, token, secret hoặc raw payment data.

Khóa và retry dùng lại SCRUM-58: Read Committed, lock timeout 1500 ms, transaction
timeout 8 giây, maxWait 2 giây; tối đa 3 lần cho lỗi transaction đã bị hủy do
deadlock/serialization/lock timeout. Không tự retry kết quả commit không chắc chắn.

- Payment đã commit PAID: Scheduler đọc lại sau Order lock và không hủy.
- Scheduler đã commit CANCELLED: Payment mới đọc lại và trả 409 INVALID_TRANSITION.
- Payment FAILED sát hạn: Scheduler có thể hủy sau khi Payment commit; attempt
  FAILED vẫn được lưu, replay key đó không giữ/hoàn tài nguyên lần nữa.
- Create Order cleanup và Scheduler dùng chung primitive, nên không hoàn trùng.
- Một instance gộp các lời gọi quét đang chồng nhau vào cùng Promise. Nhiều
  instance vẫn an toàn nhờ Order row lock/recheck và dấu mốc CANCELLED nguyên tử.
- Khi đóng app, dừng timer và không bắt đầu Order tiếp theo; chờ transaction đang
  chạy kết thúc trước khi PrismaModule ngắt kết nối. Main đã bật shutdown hooks.

## Kiểm thử

Chạy trong `backend`:

```powershell
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:e2e
# ORDERS_TEST_DATABASE_URL trỏ tới PostgreSQL test riêng đã migrate.
npm run test:integration -- test/order-lifecycle.integration-spec.ts
```

Để chạy toàn bộ integration, cấu hình cả AUTH_TEST_DATABASE_URL và
ORDERS_TEST_DATABASE_URL, bật PAYMENT_CONCURRENCY_TESTS=1. Không dùng database demo
hoặc production vì Scheduler test quét các Order hết hạn trong database test.
Fixture tạo UUID riêng và chỉ cleanup các row của chính suite.

19 unit test mới kiểm tra config, lịch mỗi phút, chống chạy chồng, lỗi quét,
tiếp tục batch sau lỗi, log an toàn và shutdown. 13 integration test mới dùng
HTTP Order/Payment/Advance/History cùng Scheduler và PostgreSQL thật, gồm:

- Create → SUCCESS → COMPLETED → History; replay không cộng điểm lại.
- FAILED → retry SUCCESS giữ expiry, stock và coupon; replay attempt FAILED cũ.
- FAILED hết hạn → CANCELLED; replay cũ được phép, Payment mới bị chặn.
- Payment trước lượt quét vẫn kiểm tra expiry; 0-VND SUCCESS không cộng điểm.
- Quét nhiều batch, hai instance và quét lặp; đơn còn hạn/đã PAID không bị hủy.
- Lỗi coupon cleanup rollback Order/stock, các batch sau tiếp tục và lượt sau hồi phục.
- Create Order cạnh tranh với Scheduler khi dọn đơn cũ.
- Payment và Scheduler phải chờ lock theo cả hai chiều. Test chỉ giữ thời điểm
  COMMIT bằng barrier; transaction, truy vấn, Payment và Scheduler đều chạy thật.
- Nest bootstrap kích hoạt timer; Nest shutdown chờ transaction rồi mới disconnect.

Các test trên xác minh luồng backend. Kiểm thử UI FE qua trình duyệt và nghiệm thu
Jira/PR là các bước riêng. Customer cancel, refund, gateway thật và Inventory
Movement audit optional không thuộc thay đổi này.

Đã kiểm tra ngày 2026-10-27: build, `tsc --noEmit`, lint, 149 unit test, 202 E2E
test và 119 integration test đều pass. Trong đó có 19 unit test và 13 integration
test mới của SCRUM-59. Integration chạy trên PostgreSQL 18 tạm riêng, áp dụng
7 migration hiện có và bật `PAYMENT_CONCURRENCY_TESTS=1`. Không chỉnh `.env` hay
database đang dùng của ứng dụng.

## Phụ thuộc và PR

Branch SCRUM-59 đã tích hợp SCRUM-57/58 local theo phê duyệt. PR vào `dev`; nên
merge PR SCRUM-58 trước khi review phần diff riêng của SCRUM-59. Việc có code
phụ thuộc trong branch không đồng nghĩa PR SCRUM-58 đã được merge vào `dev`.
