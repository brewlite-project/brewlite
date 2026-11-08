# BrewLite – VNPay Phase 2 Change Request & Decision Log

**Document ID:** BL-CR-VNPAY-001
**Version:** 1.0
**Status:** Approved – Business Rules Baseline
**Owner:** Hoàng Khang – Project Leader
**Phase:** Phase 2 – Assignment 1 Stabilization & VNPay Integration
**Baseline:** BrewLite API Contract v3.0, Requirements Specification v3.0, User Stories & Acceptance Criteria v2.2, Use Case Specification v3.0.

---

## 1. Change Overview

### 1.1. Background

BrewLite Phase 1 triển khai Mock Payment nội bộ nhằm hoàn thành luồng đặt hàng và thanh toán theo yêu cầu Assignment 1.

Mock Payment hỗ trợ:

- Thanh toán giả lập qua CARD/WALLET.
- Payment SUCCESS/FAILED.
- Idempotency và concurrency protection.
- Order lifecycle.
- Inventory reservation/release.
- Coupon consumption/release.
- Loyalty accumulation.
- Order Confirmation và Order History.

Trong Phase 2, BrewLite mở rộng hệ thống bằng cách tích hợp VNPay Sandbox làm payment provider mặc định.

Mock Payment tiếp tục được giữ để phục vụ automated testing và demo dự phòng có kiểm soát.

### 1.2. Business Goals

1. Cho phép Customer thực hiện thanh toán qua VNPay Sandbox.
2. Nhận và xác minh kết quả thanh toán từ VNPay.
3. Đảm bảo Payment, Order, Inventory, Coupon và Loyalty nhất quán.
4. Không làm hỏng core flow đã hoàn thành trong Phase 1.
5. Đảm bảo có thể demo bằng Docker và môi trường Sandbox.
6. Giữ khả năng kiểm thử độc lập bằng Mock Payment.

### 1.3. Scope

**In Scope – Phase 2**

- VNPay Sandbox integration.
- Payment Provider architecture.
- Payment initiation và redirect.
- VNPay Return URL.
- IPN verification và xử lý kết quả.
- Payment persistence và idempotency.
- Retry và reconciliation trong phạm vi được phê duyệt.
- Order expiration consistency.
- Frontend Payment/Confirmation integration.
- Database migration cần thiết.
- Regression và integration testing.
- Đồng bộ API Contract, Requirements, US/AC, Use Case, ERD và các diagram liên quan.

**Preserved**

- Product Catalog.
- Authentication/JWT.
- Cart.
- Server-side pricing.
- Existing Order business invariants.
- Mock Payment cho test/demo.

**Deferred – Phase 3**

- Forgot Password / Reset Password.
- Admin/Barista UI.
- Production payment activation.
- Deployment chính thức.
- Advanced monitoring và CI/CD.

### 1.4. Change Principles

1. Không thay đổi business rules đã approved nếu chưa có quyết định thay thế rõ ràng.
2. Không tin dữ liệu giá tiền hoặc kết quả thanh toán do frontend tự quyết định.
3. Không ghi nhận Payment SUCCESS hai lần.
4. Không tạo side effects trùng cho Coupon, Inventory hoặc Loyalty.
5. Không tự động chuyển Payment đang chờ VNPay sang Mock.
6. Mock Payment không được truy cập trong môi trường không cho phép.
7. Các quyết định chưa được phê duyệt phải ghi trạng thái Proposed hoặc Open.
8. API Contract v3.0 tiếp tục là baseline cho Phase 1 cho đến khi contract mới được phê duyệt.

---

## 2. Decision Log

| ID    | Decision                           | Status   |
| ----- | ---------------------------------- | -------- |
| BR-01 | Payment Provider Strategy          | Approved |
| BR-02 | Payment Attempt State Model        | Approved |
| BR-03 | Order Expiration & Gateway Timeout | Approved |
| BR-04 | IPN, Security & Idempotency        | Approved |
| BR-05 | Retry & Reconciliation             | Approved |
| BR-06 | Zero-VND Orders & Mock Fallback    | Approved |

---

### BR-01 – Payment Provider Strategy

**Status:** Approved
**Decision:** Option A – Backend-controlled Payment Providers

#### Business Rules

1. VNPay Sandbox là payment provider mặc định của BrewLite trong Phase 2.
2. Mock Payment được giữ để phục vụ automated testing và demo dự phòng.
3. Backend quyết định provider nào được phép sử dụng dựa trên cấu hình môi trường.
4. Frontend không được tự ý kích hoạt Mock Payment khi backend không cho phép.
5. Không tự động chuyển từ VNPay sang Mock khi giao dịch VNPay đang chờ hoặc chưa xác định kết quả.
6. Mọi provider phải tuân thủ các invariant chung về Payment, Order, Inventory, Coupon, Loyalty và Idempotency.
7. Mock Payment không được phép hoạt động trong production.
8. Không được ghi nhận hai Payment SUCCESS cho cùng một Order, kể cả khi sử dụng hai provider khác nhau.

#### Implementation Notes

- Payment Provider abstraction sẽ được thiết kế sau khi review Payment implementation của Phase 1.
- Cơ chế cấu hình provider phải được backend kiểm soát.
- Không hardcode VNPay credentials hoặc Mock access policy vào frontend.
- Không tự động fallback khi VNPay timeout hoặc lỗi kết nối.
- Cách chuyển provider giữa các lần thử thanh toán sẽ được xác định trong BR-05.

#### Impacted Artifacts

- Requirements Specification
- User Stories & Acceptance Criteria
- Use Case Specification
- API Contract
- Payment Architecture
- Backend Payment Module
- Frontend Payment UI
- Environment Configuration
- Testing Documentation

### BR-02 – Payment Attempt State Model

**Status:** Approved
**Decision:** Option A – Three Payment States

#### Business Rules

1. Payment Attempt sử dụng ba trạng thái:
   - PENDING
   - SUCCESS
   - FAILED

2. PENDING thể hiện giao dịch chưa có kết quả cuối cùng được xác minh.

3. SUCCESS chỉ được ghi nhận khi kết quả thanh toán thành công đã được backend xác minh.

4. FAILED chỉ được ghi nhận khi có bằng chứng hợp lệ rằng giao dịch không thành công và không còn khả năng hoàn tất thành công theo cùng attempt.

5. Payment URL hết hạn hoặc không nhận được IPN không tự động đồng nghĩa Payment FAILED.

6. Khi giao dịch chưa xác định kết quả sau thời hạn, Payment tiếp tục PENDING và phải được đối soát.

7. EXPIRED được biểu diễn dưới dạng failureReason khi gateway đã xác nhận giao dịch hết hạn và thất bại.

8. SUCCESS và FAILED là terminal states đối với Payment Attempt; không ghi đè kết quả cuối cùng.

9. Payment PENDING và Order PENDING là hai trạng thái thuộc hai state machine khác nhau.

10. Việc xử lý Order expiration, late IPN và reconciliation sẽ được chốt trong BR-03 và BR-05.

#### Design Notes

- Không thêm Payment Status EXPIRED.
- Không đồng nhất timeout với Payment FAILED.
- Cần lưu metadata phục vụ xác minh và đối soát giao dịch VNPay.
- Database schema và API response chi tiết sẽ được chốt sau khi review implementation hiện tại.
- Payment state và Order state phải được đồng bộ bằng business rules và transaction an toàn.

### BR-03 – Order Expiration & VNPay Gateway Timeout

**Status:** Approved
**Decision:** Option C – Bounded Grace Period (5 minutes)

#### 1. Order Expiration

1. Order expiresAt mặc định bằng createdAt + 15 phút.
2. VNPay payment initiation chỉ được thực hiện khi Order còn hạn và trạng thái hợp lệ.
3. VNPay payment URL không được có hạn thanh toán vượt order.expiresAt.
4. Grace Period không gia hạn quyền thanh toán của Customer.
5. Sau order.expiresAt, backend từ chối tạo Payment Attempt mới.

#### 2. Bounded Grace Period

6. Khi Order hết hạn mà không có VNPay Attempt PENDING, Scheduler xử lý CANCELLED và release inventory/coupon theo baseline hiện tại.

7. Khi Order hết hạn và có VNPay Attempt PENDING, hệ thống tạm hoãn CANCELLED trong Grace Period để tiếp nhận IPN hoặc QueryDR.

8. Grace Period có giới hạn và được tính từ order.expiresAt.

9. GRACE_PERIOD_MINUTES = 5. Grace Period bắt đầu tại
   order.expiresAt và kết thúc tại order.expiresAt + 5 phút.
   Grace chỉ phục vụ xác minh kết quả thanh toán đã phát sinh,
   không gia hạn quyền thanh toán của Customer.

10. Trong Grace Period, Order vẫn giữ inventory/coupon và tiếp tục được xem là active. Không được tạo Order active thứ hai cho cùng Customer.

#### 3. Payment Finalization

11. Payment SUCCESS chỉ được xác nhận khi backend kiểm chứng được kết quả hợp lệ của VNPay.

12. Để Order được chuyển PAID, thời điểm thanh toán đã xác minh phải không muộn hơn order.expiresAt.

13. SUCCESS hợp lệ được xác minh trong Grace Period có thể chuyển Order sang PAID nếu Order chưa CANCELLED và tất cả business invariants vẫn được bảo đảm.

14. Payment FAILED cuối cùng được xác minh thì Order hết hạn có thể chuyển CANCELLED và release tài nguyên nguyên tử.

15. Thiếu IPN hoặc Payment URL hết hạn không tự động làm Payment chuyển FAILED.

#### 4. Grace Period Expiration

16. Khi Grace Period kết thúc mà kết quả vẫn chưa xác định, Scheduler chuyển Order sang CANCELLED và release inventory/coupon đúng một lần.

17. Payment Attempt chưa có kết quả cuối cùng vẫn có thể giữ PENDING để tiếp tục reconciliation.

18. Hệ thống không được suy diễn Payment FAILED chỉ từ việc hết Grace Period.

#### 5. Late Success

19. Nếu VNPay xác nhận giao dịch SUCCESS sau khi Order đã CANCELLED, backend không tự động phục hồi Order sang PAID.

20. Hệ thống phải lưu bằng chứng giao dịch từ VNPay và đánh dấu ngoại lệ để đối soát.

21. Không tự động consume coupon, cộng Loyalty hoặc tiếp tục fulfillment cho Order đã CANCELLED.

22. Refund hoặc xử lý tài chính sau khi Order CANCELLED là quy trình riêng; không tự động thực hiện nếu chưa được thiết kế và phê duyệt.

#### 6. Concurrency & Safety

23. Scheduler, Payment finalization và Create Order phải sử dụng cơ chế concurrency control nhất quán.

24. Mọi thay đổi Order, inventory và coupon phải tuân thủ atomic transaction.

25. Không được release inventory/coupon quá một lần.

26. Không được tạo hai Payment SUCCESS hoặc cộng Loyalty hai lần cho cùng Order.

27. Các giao dịch chưa xác định kết quả phải có cơ chế theo dõi và reconciliation phù hợp.

#### Technical Impact

- Order Expiration Scheduler
- Create Order active-order validation
- Payment finalization
- VNPay IPN handler
- Payment reconciliation
- PostgreSQL/Prisma persistence
- API Contract
- Requirements / User Stories / Use Case
- Sequence and Activity Diagrams
- Concurrency / Integration Tests

### BR-04 – IPN Security & Idempotency

**Status:** Approved
**Decision:** Verified VNPay IPN with Atomic, Idempotent Payment Finalization

#### 1. IPN Endpoint & Authentication

1. VNPay IPN endpoint: GET /payments/vnpay/ipn.
2. Endpoint phải được truy cập qua HTTPS ở môi trường tích hợp.
3. IPN không yêu cầu Customer JWT.
4. Backend phải xác minh chữ ký HMAC-SHA512 theo đặc tả VNPay trước khi tin tưởng dữ liệu IPN.
5. VNPay HashSecret chỉ được lưu phía backend bằng cấu hình bí mật.
6. Không commit HashSecret, thông tin đăng nhập hoặc dữ liệu bí mật vào Git.
7. Backend phải xác minh vnp_TmnCode khớp merchant đã cấu hình.

#### 2. Transaction Validation

8. Mỗi VNPay Payment Attempt phải có vnp_TxnRef riêng, duy nhất.
9. vnp_TxnRef phải liên kết được với đúng Payment Attempt đã lưu.
10. vnp_Amount phải khớp số tiền Payment/Order snapshot, theo quy tắc đơn vị tiền của VNPay.
11. Chỉ chấp nhận kết quả SUCCESS khi vnp_ResponseCode = 00 và vnp_TransactionStatus = 00, đồng thời chữ ký và thông tin giao dịch hợp lệ.
12. Thông báo không hợp lệ không được thay đổi Payment, Order, Inventory, Coupon hoặc Loyalty.
13. Không sử dụng Return URL từ trình duyệt làm nguồn xác nhận thanh toán duy nhất.

#### 3. Idempotency & Concurrency

14. Các kết quả từ IPN và QueryDR phải được xử lý qua cùng cơ chế Payment Finalization.
15. Một Payment Attempt chỉ được hoàn tất nghiệp vụ một lần.
16. Một Order không được ghi nhận hai Payment SUCCESS.
17. Inventory, Coupon và Loyalty side effects không được thực hiện trùng lặp.
18. Payment Finalization, Scheduler và Order mutations phải có transaction và concurrency control phù hợp.
19. Việc kiểm tra Payment/Order status phải được thực hiện lại trong transaction sau khi khóa dữ liệu.
20. IPN gửi lặp không được làm thay đổi kết quả nghiệp vụ đã hoàn tất.
21. Khi Payment đã được xử lý bởi QueryDR, IPN đến sau phải được nhận diện là kết quả đã xử lý, không tạo side effects mới.

#### 4. IPN Response

22. Backend trả JSON RspCode và Message theo đặc tả VNPay.
23. Không trả kết quả đã ghi nhận thành công trước khi dữ liệu bắt buộc được commit.
24. Với IPN hợp lệ đã được xử lý, backend trả mã already-processed theo quy định VNPay.
25. Lỗi xử lý tạm thời không được ghi nhận như kết quả Payment FAILED.
26. Các trường hợp chữ ký sai, không tìm thấy giao dịch, sai số tiền và lỗi nội bộ phải được xử lý theo mã phản hồi VNPay tương ứng.
27. IPN hợp lệ cho Order đã CANCELLED phải được ghi nhận để đối soát ngoại lệ theo BR-03, không được tự hồi sinh Order.

#### 5. Security & Observability

28. Không ghi HashSecret hoặc dữ liệu bí mật vào application logs.
29. Có log an toàn phục vụ truy vết Payment Attempt, IPN và QueryDR.
30. Không dựa riêng vào IP address để xác thực nguồn IPN.
31. Không tin dữ liệu thanh toán do frontend cung cấp khi xác nhận Payment SUCCESS.

#### Technical Impact

- NestJS Payment Module
- VNPay IPN Controller
- VNPay Signature Verification
- Payment Finalization Service
- Prisma/PostgreSQL Transaction & Locking
- Payment Attempt Persistence
- Scheduler
- API Contract
- Integration & Security Tests

### BR-05 – Payment Retry & Reconciliation

**Status:** Approved
**Decision:** Option B – Controlled Retry & Reconciliation

#### Payment Retry

1. Mỗi Order chỉ được có tối đa một VNPay Payment Attempt PENDING tại một thời điểm.
2. Nếu đã có PENDING attempt, backend không tạo attempt mới.
3. Retry chỉ được phép khi attempt trước đã FAILED cuối cùng, Order còn hạn và chưa CANCELLED/PAID.
4. Mỗi retry hợp lệ tạo Payment Attempt mới với vnp_TxnRef duy nhất.
5. Không cho phép retry khi Payment SUCCESS hoặc kết quả còn chưa xác định.
6. Payment URL hết hạn không tự động cho phép retry khi attempt vẫn PENDING.
7. Backend phải kiểm tra lại trạng thái trong transaction trước khi tạo attempt mới.

#### Reconciliation

8. IPN và QueryDR phải sử dụng chung cơ chế Payment Finalization.
9. QueryDR request/response phải tuân thủ đặc tả chữ ký và định danh giao dịch của VNPay.
10. vnp_ResponseCode của QueryDR không thay thế vnp_TransactionStatus.
11. Timeout hoặc kết quả chưa hoàn tất không được tự động chuyển Payment FAILED.
12. Khi Order đạt expiresAt và có VNPay PENDING, hệ thống kích hoạt reconciliation.
13. Trong Grace Period 5 phút, hệ thống tiếp tục nhận IPN và kiểm tra kết quả QueryDR.
14. Sau Grace, Order có thể CANCELLED theo BR-03 nhưng Payment chưa rõ kết quả tiếp tục PENDING.
15. Sau Grace, hệ thống thử đối soát mỗi 10 phút, tối đa trong 60 phút.
16. Sau thời hạn tự động đối soát, giao dịch chưa rõ kết quả phải được đánh dấu cần xử lý thủ công; không tự chuyển FAILED.
17. Reconciliation phải chống chạy trùng và giới hạn tần suất truy vấn.
18. Không giữ database transaction mở trong lúc gọi HTTP API của VNPay.

#### Exceptional Results

19. Late SUCCESS sau CANCELLED phải được ghi nhận để xử lý ngoại lệ, không tự phục hồi Order.
20. Các trạng thái nghi ngờ gian lận, giao dịch đảo hoặc chưa hoàn tất không được đơn giản hóa thành FAILED để cho phép retry.
21. Không tự động refund trong Phase 2.
22. Kết quả đã final không được ghi đè bởi thông báo cũ hoặc trùng.
23. Không thực hiện Inventory, Coupon hoặc Loyalty side effects trùng.
24. Nếu VNPay gửi kết quả mâu thuẫn với trạng thái terminal đã được xác minh, backend không tự ghi đè Payment status.
25. Hệ thống phải lưu thông tin kết quả mâu thuẫn, đánh dấu giao dịch cần đối soát và ngăn thực hiện các business side effects trùng lặp.

#### Technical Impact

- Payment Attempt persistence
- VNPay Payment Initiation
- Payment Finalization Service
- QueryDR Integration
- Reconciliation Scheduler
- Order Expiration Scheduler
- Database Constraints
- API Contract
- Integration Tests

### BR-06 – Zero-VND Orders & Mock Fallback

**Status:** Approved
**Decision:** Option B – Zero-Amount Internal Settlement

#### Zero-Amount Orders

1. Order có totalVnd = 0 được xử lý bằng phương thức ZERO_AMOUNT.
2. ZERO_AMOUNT là cơ chế hoàn tất thanh toán nội bộ, không phải VNPay hoặc Mock Payment.
3. Backend phải xác minh totalVnd từ Order đã lưu.
4. Không gọi VNPay API khi totalVnd = 0.
5. ZERO_AMOUNT tạo Payment SUCCESS với amountVnd = 0.
6. Order được chuyển sang PAID bằng Payment Finalization chung.
7. Inventory, Coupon và Loyalty tuân thủ các business invariants hiện có.
8. ZERO_AMOUNT phải hoạt động độc lập với cấu hình bật/tắt Mock.
9. Không được ghi nhận hai Payment SUCCESS cho cùng Order.
10. ZERO_AMOUNT chỉ được hoàn tất khi Order còn đủ điều kiện thanh toán theo BR-03.

#### Mock Payment

11. Mock Payment chỉ phục vụ automated testing và demo dự phòng.
12. Backend kiểm soát việc bật/tắt Mock theo môi trường.
13. Mock Payment bị vô hiệu hóa trong production.
14. Không tự động fallback từ VNPay PENDING hoặc chưa rõ kết quả sang Mock.
15. Mock bị vô hiệu hóa phải từ chối request mà không thay đổi dữ liệu nghiệp vụ.
16. Mock và VNPay sử dụng các quy tắc Payment Finalization chung.
17. Không cho phép Mock tạo Payment SUCCESS trùng với provider khác.

#### Technical Impact

- Payment Provider Architecture
- Zero-Amount Payment Handler
- Payment Finalization Service
- Backend Environment Configuration
- Prisma Schema
- API Contract
- Requirements / User Stories / Use Case
- Automated & Integration Tests

## 3. Technical Verification & Implementation Dependencies

All six Business Rules (BR-01 through BR-06) have been
approved by the Project Leader.

The following items are implementation dependencies and
verification requirements, not unapproved business decisions.

1. Review the existing Phase 1 Payment implementation,
   Order Scheduler and Prisma schema.

2. Verify VNPay Sandbox behavior for vnp_ExpireDate,
   transaction timestamps, IPN and QueryDR.

3. Configure and test the public HTTPS IPN endpoint.

4. Rotate the previously exposed VNPay HashSecret
   before using it for integration.

5. Design persistence for Payment Attempts,
   reconciliation exceptions and ZERO_AMOUNT.

6. Verify transaction locking and uniqueness constraints
   against the existing PostgreSQL schema.

7. Ensure Late SUCCESS after Order CANCELLED is
   recorded without restoring the Order or executing
   duplicate business side effects.

8. Update Requirements, User Stories, Use Case,
   API Contract, ERD and related diagrams.

9. Complete integration and regression testing before
   declaring the VNPay implementation ready.

---

## 4. Approval

**Approval status:** Approved – Business Rules Baseline.
**Approved by:** Project Leader (HKhang).
**Approved scope:** Change overview, Phase 2 business-policy direction, and BR-01 through BR-06 as the authoritative business-rule baseline for subsequent specification and implementation design.
**Not yet verified:** Cross-document consistency against API Contract v3.0, Requirements Specification, User Stories & Acceptance Criteria, Use Case Specification, Prisma schema and actual backend implementation; VNPay Sandbox API behavior and integration tests.

**Implementation control:** The team may use these approved business rules to prepare implementation tasks and technical designs. Dependent code changes must satisfy the verification requirements in Section 3; no incompatibility with the existing architecture or VNPay API is automatically approved. If a verification reveals an infeasible assumption or contradiction, record it as a change proposal for Project Leader approval before altering these business rules. Do not treat this approval as acceptance of completed VNPay integration.
