# BrewLite — VNPay Sandbox Setup and Runtime Status

> **Phạm vi:** hướng dẫn tích hợp VNPay Sandbox ở backend NestJS, frontend Next.js và PostgreSQL. Không dùng production merchant hoặc thanh toán thật.
> **Snapshot code:** fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0, kiểm tra ngày 06/11/2026.
> **Đối chiếu sau sync:** task branch đã merge `origin/dev` tới `1a67a0c` tại `eef344c`; upstream delta chỉ thêm coupon seed dev/test, không đổi payment source, Compose, Dockerfile, migration hoặc lockfile. Runtime evidence bên dưới ghi rõ commit `fb293e2` thực sự được chạy.
> **Nguồn thiết kế:** [API Contract v4.0](../api/BrewLite_API_Contract_v4.0.md), [Requirements v3.1](../docs_Phase2/BrewLite_Requirements_Specification_v3.1.docx), [US/AC Phase 2](../docs_Phase2/BrewLite_User_Stories_Acceptance_Criteria_Phase2.docx), [ADR QueryDR](../decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md).

Contract v4 §14 chốt các tài liệu nghiệp vụ Phase 2 là approved inputs; metadata review/candidate ở một số đầu tài liệu chưa đồng bộ. Không sửa baseline đã duyệt chỉ để phù hợp source. Tài liệu này phân biệt route có trong code, automated test và Sandbox E2E.

## 1. Runtime status

| Thành phần | Code tại snapshot | Bằng chứng / giới hạn |
| --- | --- | --- |
| POST /payments/vnpay/initiate | Có controller/service; ký URL Sandbox và tạo Payment PENDING | Unit/integration coverage không chứng minh thanh toán Sandbox đã hoàn tất |
| GET /payments/vnpay/ipn | Có public controller; verify callback và gọi shared finalization | ADR ngày 03/11 báo IPN Sandbox từng trả RspCode 00, Payment SUCCESS, Order PAID; SCRUM-94 không chạy lại giao dịch này |
| QueryDR client/scheduler | Có client, response verification, lease/cooldown và reconciliation scheduler | ADR ghi Sandbox trả 99/Unexpected error không kèm signed transaction response; QueryDR Sandbox E2E được chuyển SCRUM-95 |
| POST /payments/zero-amount | Có controller/service và shared finalization | Automated test hiện có; không phải Sandbox payment |
| Shared payment finalization | Dùng transaction/locking, nhận evidence từ các nguồn, xử lý duplicate/conflict/financial exception | Automated test không đồng nghĩa với VNPay E2E |
| GET /payments/:paymentId/status | **Chưa có backend route/controller tại snapshot** | Contract và frontend payment service tham chiếu endpoint; Return flow chưa đọc được authoritative state qua route này |

Implementation không đồng nghĩa với business acceptance. Mock hoặc mocked gateway response không được tính là Sandbox PASS.

## 2. Payment flow và điều kiện

~~~text
Customer → Next.js → NestJS → PostgreSQL
                         ├── VNPay initiation: signed URL, Payment PENDING
Browser ← Return URL ← VNPay
VNPay ── public HTTPS IPN → NestJS → shared finalization → PostgreSQL
NestJS ── QueryDR POST → VNPay; verified response → shared finalization
Frontend ← server status endpoint (required by UI; currently missing)
~~~

Return URL chỉ điều hướng trình duyệt. Không dùng query string hoặc VNPay return parameters để kết luận Payment SUCCESS. Backend chỉ finalize khi có evidence đã được xác minh; IPN/QueryDR dùng chung finalization. Finalization khóa Order/Payment trong transaction và phải bảo toàn idempotency, terminal state và side effects.

Payment status: PENDING, SUCCESS, FAILED. Order status: PENDING, PAYMENT_FAILED, PAID, PREPARING, READY, COMPLETED, CANCELLED. Duplicate evidence không lặp coupon, Loyalty, inventory hoặc order/payment effects. Một verified success xung đột terminal state/late/cancelled có thể tạo financial exception/requires review; không hồi sinh Order.

Order expires sau 15 phút. Grace 5 phút dành cho xác minh attempt đã bắt đầu; timeout hoặc URL hết hạn không tự chứng minh FAILED. Hết Grace, scheduler/query xử lý reconciliation theo policy. QueryDR response code 00 chỉ cho biết request QueryDR được xử lý; phải kiểm tra transaction status, signature và correlation. Nếu không có evidence đủ tin cậy, giữ trạng thái unresolved/review.

ZERO_AMOUNT hoàn tất Order hợp lệ 0 VND nội bộ; không gọi VNPay/Mock và không cộng Loyalty. Mock Phase 1 vẫn được bảo toàn cho automated/local demo khi backend cho phép; nó không phải fallback cho VNPay unknown/pending.

## 3. Cấu hình Sandbox

Cấu hình chỉ ở backend/.env hoặc secret store riêng. Repository có backend/.env.example; thay DATABASE_URL bằng PostgreSQL disposable của bạn trước khi chạy migration. Không dùng brewlite_db, brewlite_seed_hoang, database dùng chung, production credential hoặc HashSecret từ nơi khác.

| Biến | Yêu cầu |
| --- | --- |
| DATABASE_URL | DB PostgreSQL test/dev đã migrate; kiểm tra host, port, name trước mọi lệnh ghi |
| JWT_SECRET | Backend private, ngẫu nhiên, tối thiểu 32 bytes |
| INTERNAL_SECRET | Secret riêng, backend private |
| PORT | Backend host mặc định 3001 |
| VNPAY_TMN_CODE | Merchant Sandbox code |
| VNPAY_HASH_SECRET | Secret Sandbox; backend only, không log |
| VNPAY_PAYMENT_URL | Sandbox payment URL; sample trong .env.example |
| VNPAY_RETURN_URL | Frontend Return URL, ví dụ http://localhost:3000/payment nếu local HTTP được cho phép |
| VNPAY_QUERYDR_URL | Sandbox QueryDR endpoint |
| VNPAY_QUERYDR_TIMEOUT_MS | Timeout phù hợp với lease reconciliation |
| VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL | Compose production runtime chỉ cho phép HTTP Return trên localhost khi true; dùng HTTPS cho public endpoint |
| PAYMENT_RECONCILIATION_ENABLED | Local development không test scheduler: false; production runtime bắt buộc cấu hình true cùng các giá trị QueryDR/IP/lease hợp lệ |
| PAYMENT_RECONCILIATION_IP_ADDR và PAYMENT_RECONCILIATION_* | IP backend, interval/batch/lease/cooldown theo config |

Không thấy source đọc VNPAY_IPN_URL; không thêm biến này làm cấu hình backend. Khai báo callback IPN trên VNPay Sandbox merchant settings trỏ đến public HTTPS URL kết thúc ở GET /payments/vnpay/ipn. Giữ callback URL ngoài log nếu URL có query/signature.

Frontend host env: NEXT_PUBLIC_API_URL là public/build-time; BACKEND_INTERNAL_URL là server-side runtime. Host local dùng http://127.0.0.1:3001; Compose network dùng http://backend:3001. Return URL thường là frontend /payment, không trỏ trực tiếp tới API.

## 4. Local setup và initiation

Cách cài dependencies, generate client, migrate, seed đúng allowlist, chạy host app hoặc Compose nằm trong [README](../../README.md). Chạy test trên database riêng đã migrate. Không bật PAYMENT_RECONCILIATION_ENABLED nếu chưa có QueryDR config hợp lệ. Trước khi chạy backend trên port 3001, kiểm tra port; không dừng service đang dùng.

Initiation cần JWT Customer, Order còn hợp lệ và Idempotency-Key. Gửi JWT qua cơ chế xác thực của client; không chép giá trị hoặc Authorization header vào tài liệu/log.

~~~http
POST /payments/vnpay/initiate
Idempotency-Key: <unique-key>
Content-Type: application/json

{"orderId":"<test-order-uuid>"}
~~~

Kiểm tra status code, Payment record và response snapshot trong DB test. Không ghi paymentUrl/signed query string vào log/evidence. Chỉ thử redirect khi merchant Sandbox được cấp và Order dùng dữ liệu test. Return không finalize payment.

## 5. Public HTTPS IPN

VNPay không thể gọi localhost/private address. Nếu backend chạy local, cần một HTTPS tunnel được cho phép hoặc deploy backend test có public HTTPS; route phải forward nguyên query string tới port backend và giữ đúng path /payments/vnpay/ipn. Cấu hình public endpoint trong merchant Sandbox. Không cài tool mới hoặc mở tunnel nếu chưa có quyền và sandbox merchant.

Backend handler cần được verify qua source/tests/runtime: không JWT; kiểm tra HMAC-SHA512, merchant code, TxnRef, amount x100, response/transaction status; commit finalization trước ACK. Kiểm tra ACK và Payment/Order/Event trong DB tạm. Không log toàn bộ callback, authorization, secret hoặc signed URL.

ADR ADR-P2-QueryDR-Sandbox-E2E-Deferred.md ghi một giao dịch IPN thực trước đây: 42.000 VND, HTTPS/ngrok, RspCode=00, Payment SUCCESS, Order PAID, gateway event FINALIZED. Đây là kết quả do ADR báo cáo, không phải lượt SCRUM-94 tự thực hiện.

## 6. QueryDR và giới hạn E2E

QueryDR là server-to-server POST. Backend ký request, xác minh chữ ký response và merchant/ref/amount/transaction status trước khi dùng evidence. Không gọi QueryDR từ trình duyệt. Scheduler quản lý retry/lease/cooldown; không giữ transaction DB trong lúc chờ HTTP gateway.

ADR đã duyệt ghi Sandbox trả vnp_ResponseCode=99 / Unexpected error không kèm full signed response; nguyên nhân chưa được kết luận và E2E QueryDR chuyển sang SCRUM-95. Automated client/scheduler test không xóa giới hạn này. Không đánh dấu QueryDR E2E PASS đến khi nhận response Sandbox đầy đủ có chữ ký hợp lệ và lưu evidence đã lọc nhạy cảm.

Frontend hiện tham chiếu GET /payments/:paymentId/status, nhưng route backend chưa có ở snapshot này. Do đó full Return → server status → UI outcome còn BLOCKED, kể cả khi IPN handler đã được triển khai.

## 7. Test và ghi evidence

Chạy riêng từng lớp theo scripts trong package.json:

- Backend unit/service: npm test.
- Backend Nest/API tests: npm run test:e2e; đây không phải browser test.
- PostgreSQL integration: npm run test:integration trên DB disposable đã migrate; kiểm tra suite nào dùng localhost:5433/brewlite_test trước khi chạy.
- Concurrency: bật PAYMENT_CONCURRENCY_TESTS=1 chỉ với isolated PostgreSQL test target.
- Frontend Node/JSDOM: npm test; đây không chứng minh giao diện thật.
- Sandbox: merchant Sandbox, public HTTPS IPN, Return route và status authority cần cùng hoạt động.

Mỗi evidence ghi case/lệnh, expected, actual PASS/FAIL/BLOCKED, ngày, commit, môi trường, số tests passed/failed/skipped và file output đã lọc. Không ghi password, token, cookie, Authorization, HashSecret, customer PII hoặc signed payment URL. Không dùng ảnh mockup làm screenshot runtime. Xem [SCRUM-94 evidence](../verification/SCRUM94_Verification_Evidence.md) để biết lượt kiểm tra hiện tại.

## 8. Lỗi thường gặp

| Lỗi | Hướng xử lý |
| --- | --- |
| Initiate báo cấu hình không hợp lệ | Kiểm tra Sandbox merchant/HashSecret/URL trong backend env; không in giá trị; xác minh Order và Idempotency-Key |
| IPN timeout/404 | Kiểm tra public HTTPS mapping và đúng path; đừng coi HTTP 200/404 đơn lẻ là xác minh finalization |
| Browser Return báo thanh toán thành công nhưng DB còn pending | Không tin Return query; kiểm tra IPN/QueryDR evidence. Status route backend hiện thiếu |
| POST /api/backend/* trả 502 | Một lượt host smoke ghi POST đăng ký qua proxy là 502, direct là 201; Next host rerun với BACKEND_INTERNAL_URL=http://127.0.0.1:3002 và Compose rerun với backend:3001 đều nhận 201 cả proxy/direct. Lỗi cũ chưa tái hiện, nguyên nhân/owner chưa xác định. Đối chiếu method/path và môi trường; xem [evidence SCRUM-94](../verification/SCRUM94_Verification_Evidence.md). |
| QueryDR 99 | Không suy ra Payment FAILED/SUCCESS; giữ unresolved theo policy và theo dõi SCRUM-95 |
| Reconciliation làm backend không start | Production cần PAYMENT_RECONCILIATION_ENABLED=true và QueryDR/IP/lease cấu hình hợp lệ; không tắt để lách gate |
