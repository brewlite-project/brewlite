# BrewLite – API Contract v4.0 (VNPay Phase 2)

| Thuộc tính | Giá trị |
|---|---|
| Version | v4.0 – Review 3 Corrected Candidate |
| Status | **NOT APPROVED — REVIEW 3 COMPLETE, EXTERNAL DEPENDENCIES OPEN** – chờ xác minh nguồn/ERD và Leader approval |
| Date | 31/10/2026 |
| Owner | HKhang – Project Leader / VNPay Backend |
| Sprint | Phase 2: 31/10/2026–03/11/2026 |
| Business baseline | `BrewLite_VNPay_Phase2_Change_Request_Approved_v1.0.md` (BR-01…BR-06) |
| Architecture baseline | `docs/design/payment/BrewLite_Payment_Architecture_Phase2_v1.0.md` |
| Compatibility baseline | `BrewLite_API_Contract_v3.0.md` |

> **Phạm vi phê duyệt:** `APPROVED – API DESIGN BASELINE` là chuẩn thiết kế để nhóm triển khai, căn cứ xác nhận của Project Leader rằng BR/Requirements, US/AC v2.3, UC v3.1 và ERD/DBML v0.2.2 là nguồn Approved, đồng thời xác nhận `round_half_up`. `IMPLEMENTATION VERIFY` (ký HMAC trên Sandbox, migration thực tế, concurrency và E2E) là điều kiện nghiệm thu code, **không** được trình bày là đã chạy hoặc đạt. Quy tắc trong phụ lục chuẩn hóa cuối cùng ưu tiên hơn các đoạn kế thừa v3.0 nếu có xung đột được nêu rõ.

## 1. Scope, precedence và nguyên tắc chung

Trong phạm vi: VNPay Initiation, IPN, Payment Status, ZERO_AMOUNT, Mock compatibility, Order History, internal QueryDR/reconciliation, error contract và các quy tắc transaction. Refund tự động, production payment và admin refund UI **ngoài phạm vi Phase 2**.

**Precedence:** Approved BR-01…06 + Requirements v3.1 + quyết định BL-DEC-PRICING-001 → US/AC v2.3 và UC v3.1 đã được Leader xác nhận → v4.0 cho API/DTO/HTTP mới → ERD/DBML v0.2.2 Approved cho shape dữ liệu → v3.0 chỉ ở vùng không bị thay thế. Trường hợp xung đột không giải bằng cách suy đoán code hiện có; phải mở change record. Quy tắc `round_half_up` thay thế `floor` **chỉ ở công thức giá theo size**, không đổi phép `floor(totalVnd/10000)` tính điểm thưởng.

- Customer API dùng Bearer JWT; `userId=JWT.sub`; tài nguyên người khác và không tồn tại cùng `404 NOT_FOUND`.
- Không tin `amountVnd`, `userId`, `status`, `provider`, `payment outcome` từ frontend. Tiền tệ JSON number VND safe integer; DB tính bằng BigInt/số nguyên.
- Payment attempts: `PENDING | SUCCESS | FAILED`; SUCCESS và FAILED terminal. Order giữ `PENDING | PAYMENT_FAILED | PAID | PREPARING | READY | COMPLETED | CANCELLED`; không thêm trạng thái GRACE.
- Provider: `VNPAY | MOCK | ZERO_AMOUNT`; phân biệt provider với legacy `method=CARD|WALLET`.
- Một Order tối đa một Payment SUCCESS; tối đa một VNPay PENDING; không khởi tạo Mock/ZERO_AMOUNT khi còn VNPay PENDING/uncertain/financial exception. Không tự FAILED do timeout/hết URL/mất IPN.
- TTL Order = 15 phút; chỉ VNPay PENDING được Grace thêm 5 phút **để xác minh thanh toán đã phát sinh đúng hạn**, không tạo attempt mới sau TTL. Sau Grace chưa rõ: CANCELLED/release đúng một lần; Payment tiếp tục PENDING để đối soát.
- IPN và QueryDR cùng Finalization; Return URL không là chứng cứ thanh toán. Late financial SUCCESS không hồi sinh CANCELLED Order.

## 2. Shared error envelope & HTTP conventions [LOCKED]

```json
{"statusCode":409,"error":"Conflict","code":"PAYMENT_IN_PROGRESS","message":"A payment attempt is still being processed"}
```

`message` có thể là `string|string[]` theo v3.0. Mã cơ bản: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 INVALID_TRANSITION`, `409 IDEMPOTENCY_KEY_CONFLICT`, `409 PAYMENT_IN_PROGRESS`, `500 INTERNAL_ERROR`. New v4 codes: `409 ORDER_EXPIRED` (chỉ API mới), `409 ZERO_AMOUNT_REQUIRED` (VNPay API nhận Order 0đ), `409 ORDER_NOT_ZERO_AMOUNT` (ZERO_AMOUNT API nhận Order >0đ), `409 FINANCIAL_EXCEPTION_REQUIRES_REVIEW`, `403 MOCK_PAYMENT_DISABLED`. **Mock legacy vẫn dùng `409 INVALID_TRANSITION` cho Order hết hạn**, theo v3.0.

`Idempotency-Key` 8–64 ký tự theo v3.0; unique `(userId, key)` trên toàn bộ Payment API; canonical request hash gồm loại operation/provider và accepted payload để không nhập nhằng giữa endpoints. Cùng key cùng request trả replay, cùng key request khác trả conflict; kiểm tra ownership trước khi tiết lộ replay. Cạnh tranh đang xử lý cùng key có thể trả `409 PAYMENT_IN_PROGRESS`; không tạo FAILED giả. Replay không tạo side effects mới. **V4 phải lưu tách immutable `initiationSnapshot` của VNPay khỏi `finalOutcomeSnapshot`/state hiện tại; HTTP 200 replay không được trình bày một PENDING giả nếu attempt thực tế đã terminal.** Response replay VNPay phải công bố `paymentStatus` và `orderStatus` hiện tại hoặc trường `currentStatus` phân biệt rõ snapshot; `paymentUrl` cũ là dữ liệu tham chiếu, không phải cấp phép redirect. Cùng một key ở hai endpoint khác nhau là payload khác và phải conflict.

## 3. API-01 – VNPay Initiation [LOCKED design; gateway VERIFY]

`POST /payments/vnpay/initiate` • Bearer JWT • `Idempotency-Key` required • `Content-Type: application/json`.

Request:
```json
{"orderId":"550e8400-e29b-41d4-a716-446655440000"}
```

**201 Created** cho attempt mới (các trường dưới đây là bộ tối thiểu; không giả định đã hoàn tất schema Swagger):
```json
{
  "paymentId":"92e27d8c-e9d5-4da4-9b16-78116f631c9b",
  "orderId":"550e8400-e29b-41d4-a716-446655440000",
  "provider":"VNPAY","paymentStatus":"PENDING","orderStatus":"PENDING",
  "amountVnd":85000,"paymentUrl":"https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?...",
  "expiresAt":"2026-10-31T03:15:00.000Z"
}
```

`Idempotency-Replayed: false` lần đầu; replay cùng key/request `200`, header `true`, trả **cùng attempt và các thông số initiation bất biến**, nhưng `paymentStatus`/`orderStatus` phải phản ánh **trạng thái hiện tại** tại thời điểm replay; không trả `PENDING` cũ khi đã SUCCESS/FAILED/CANCELLED. `paymentUrl` **không được frontend dùng để redirect nếu đã hết hạn hoặc attempt đã terminal/Order đã CANCELLED**; không cấp URL có hiệu lực mới khi replay. Lưu URL hoặc nguyên liệu canonical bất biến đủ tái dựng URL giống hệt. Nếu client chỉ cần trạng thái hiện tại, dùng API-03.

Checks sau khóa Order: owner, PENDING/PAYMENT_FAILED, `DB now < expiresAt`, positive `totalVnd`, chưa có SUCCESS, chưa có VNPay PENDING/uncertain hoặc financial exception. VNPay Attempt mới tạo `vnp_TxnRef` duy nhất, riêng biệt cho mỗi retry; không truyền `vnp_BankCode` ở v4 mặc định. Gateway amount = total VND ×100, expiry không vượt Order expiry; merchant timezone/URL canonicalization/HMAC phải VERIFY theo PAY 2.1.0. Không gọi gateway HTTP bên trong transaction; browser redirect sau commit.

Errors: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409` (`ORDER_EXPIRED`, `INVALID_TRANSITION`, `ZERO_AMOUNT_REQUIRED`, `PAYMENT_IN_PROGRESS`, `IDEMPOTENCY_KEY_CONFLICT`, `FINANCIAL_EXCEPTION_REQUIRES_REVIEW`), `500 INTERNAL_ERROR`.

## 4. API-02 – VNPay IPN [LOCKED invariants; exact protocol VERIFY]

`GET /payments/vnpay/ipn` • gọi bởi VNPay • không Customer JWT • HMAC-SHA512 + `vnp_TmnCode` + `vnp_TxnRef` + `vnp_Amount` + status proof bắt buộc.

Luồng: validate query/canonical signature → tìm Attempt → kiểm merchant/amount/correlation → chuẩn hóa outcome → `PaymentFinalizationService` cùng transaction/Order lock → trả JSON `{ "RspCode":"...", "Message":"..." }` theo tài liệu VNPay sau commit. Không coi Return URL hoặc một `vnp_ResponseCode=00` đứng riêng là SUCCESS.

Outcome:
- Có đủ chứng cứ SUCCESS và trusted pay time ≤ `order.expiresAt`, Order vẫn active trong Grace → Payment SUCCESS, Order PAID, consume coupon/loyalty đúng một lần.
- Terminal failure đã xác minh → Payment FAILED; Order PAYMENT_FAILED nếu còn hạn, hoặc cleanup CANCELLED nếu quá hạn.
- PENDING/uncertain → giữ PENDING, reconciliation; không mở retry.
- Tài chính SUCCESS đến sau khi Order CANCELLED hoặc giao dịch sau TTL → lưu evidence/exception; không PAID/fulfill, không auto refund; xử lý Order cleanup an toàn.
- Thiếu bằng chứng thời điểm đáng tin → không tự PAID; giữ trạng thái đủ để reconciliation/review và không bỏ rơi Order sau Grace.
- Terminal conflict / financial SUCCESS thứ hai trong cùng Order → **không** ghi Payment SUCCESS thứ hai làm hỏng partial unique index; persist gateway evidence trong bảng/record ngoại lệ bền vững; không overwrite terminal status, không double side effects.

**Bảng RspCode/Message đã được chuẩn hóa ở Phụ lục A.** Mã 00/02 kết thúc retry IPN theo tài liệu PAY; các mã 01/04/97/99 có thể được gửi lại. Không trả 00/02 trước khi trạng thái hoặc evidence cần thiết đã commit bền vững; IPN duplicate phải idempotent. Chữ ký byte-level và các phản hồi thực tế vẫn là integration VERIFY.

## 5. API-03 – Payment Status [LOCKED]

`GET /payments/:paymentId/status` • Bearer JWT • ownership (payment không tồn tại/khác owner đều 404), `paymentId` UUID không hợp lệ → 400 • chỉ đọc DB (không gọi QueryDR) • 200. Khi route Express/NestJS đăng ký, định tuyến tĩnh như `/payments/vnpay/ipn` phải được tránh xung đột với đường động; áp dụng route/schema validation rõ ràng.

Response fields thống nhất:
```json
{
 "paymentId":"92e27d8c-e9d5-4da4-9b16-78116f631c9b",
 "orderId":"550e8400-e29b-41d4-a716-446655440000",
 "provider":"VNPAY","paymentStatus":"PENDING","orderStatus":"CANCELLED",
 "amountVnd":85000,"resolution":"RECONCILING","requiresReview":false,
 "canRetry":false,"createdAt":"2026-10-31T03:02:00.000Z",
 "orderExpiresAt":"2026-10-31T03:15:00.000Z",
 "lastUpdatedAt":"2026-10-31T03:21:00.000Z"
}
```

Resolution dẫn xuất, không phải Payment.status: `PROCESSING`, `RECONCILING`, `PAYMENT_ACCEPTED`, `FAILED`, `FINANCIAL_EXCEPTION`, `REQUIRES_REVIEW`. Exception từ evidence record phải được ưu tiên hiển thị kể cả Payment đại diện SUCCESS bình thường. `canRetry=true` chỉ khi Order owner/còn hạn/eligible, không SUCCESS, không PENDING/uncertain, không exception, và **đã có FAILED terminal gần nhất**; trường hợp Order chưa từng có attempt không phải "retry" và phải trả `false`. Với `provider=ZERO_AMOUNT`, `canRetry=false`. Khi có evidence ngoài Payment, presentation mapper phải ưu tiên exception và không yêu cầu Payment.status=SUCCESS để thể hiện ngoại lệ. Frontend có thể poll có giới hạn, tuyệt đối không tự FAILED khi polling timeout. Errors: 400 invalid UUID, 401, 404 hidden ownership, 500.

## 6. API-04 – ZERO_AMOUNT [LOCKED]

`POST /payments/zero-amount` • Bearer JWT • `Idempotency-Key` required.

Request: `{ "orderId":"<UUID>" }`. Backend xác thực `totalVnd===0` bằng Order snapshot sau Order lock; Order còn hạn; không SUCCESS/PENDING/uncertain/exception. Không dùng Gateway/Mock. Gọi shared Finalization **trong cùng một transaction, không nested transaction**: tạo Payment SUCCESS provider ZERO_AMOUNT amount=0, Order PAID, coupon HELD→CONSUMED, `pointsEarned=0`, không reserve inventory lần hai.

201 first, 200 replay; response:
```json
{"paymentId":"f52a8613-64e7-4f83-af30-e390bd32eb49","orderId":"550e8400-e29b-41d4-a716-446655440000","provider":"ZERO_AMOUNT","paymentStatus":"SUCCESS","orderStatus":"PAID","amountVnd":0,"pointsEarned":0,"createdAt":"2026-10-31T03:06:00.000Z"}
```

`409 ORDER_NOT_ZERO_AMOUNT` cho Order >0; `409 ORDER_EXPIRED` sau TTL; các lỗi shared envelope khác theo mục 2. Grace không gia hạn ZERO_AMOUNT.

## 7. API-05 – Mock Compatibility [LOCKED MC-01…MC-06]

`POST /payments` **giữ request, response snapshot, HTTP 200 cho Mock SUCCESS/FAILED, error v3.0 ngoại trừ override Phase 2 được liệt kê** (`CARD` 16 digits / `WALLET` 10 digits). Idempotency replay 200 kể cả Order hết hạn, nếu backend cho phép Mock và đúng owner/key/request.

**New environment policy:** `MOCK_PAYMENT_ENABLED=true` **và** `NODE_ENV !== production`, mặc định disabled/fail-closed; production luôn disabled. Disabled → `403 MOCK_PAYMENT_DISABLED`.

**New cross-provider gate:** khi VNPay PENDING/uncertain → `409 PAYMENT_IN_PROGRESS`; khi có evidence/financial exception → `409 FINANCIAL_EXCEPTION_REQUIRES_REVIEW`; check sau Order lock. VNPay FAILED cuối cùng cho phép Mock attempt mới chỉ nếu Order còn hạn và mọi điều kiện khác thỏa. Shared Finalization duy trì snapshot Mock legacy, không fake data. **BR-06 thay v3.0 về Order 0đ**: Order 0đ chỉ dùng ZERO_AMOUNT, không dùng Mock; Mock trả `409 INVALID_TRANSITION` để giữ legacy error contract.

## 8. API-06 – Order History [LOCKED OH-01…OH-08]

`GET /orders/me` • Bearer JWT • giữ nguyên v3.0 `items/meta`, sorting `createdAt DESC,id DESC`, both-or-none pagination. **Không truyền `page` và `limit`: trả toàn bộ Order của chủ thể, `meta.page=null`, `meta.limit=null`, `meta.totalPages=null` theo v3.0.** Có phân trang: bắt buộc cả hai, `page` là positive safe integer, `limit=1..100`; chỉ truyền một trong hai hoặc giá trị sai → `400 VALIDATION_ERROR`. Trang ngoài phạm vi → 200, `items=[]`. Errors 400/401/500. Giữ tất cả Order/Product/Topping/Coupon snapshots.

PaymentSummary **additive**: `payment=null` vẫn hợp lệ nếu chưa có attempt; giữ legacy keys `id,status,method,methodLast4,amountVnd,mockReference,failureReason,createdAt`; thêm `provider,resolution,requiresReview,canRetry`. VNPay/ZERO_AMOUNT: `method`, `methodLast4`, `mockReference` có thể null; legacy Mock giữ nguyên. Payment representative: SUCCESS → PENDING → latest FAILED → null; cùng mức ưu tiên thì lấy mới nhất theo `createdAt DESC,id DESC` (đặc biệt với nhiều FAILED). Thêm `hasFinancialException` trên Order vì representative Payment có thể che evidence giao dịch khác. Financial exception ưu tiên trong Presentation Mapper dùng chung API-03. Không dùng `readPaymentSnapshot` Mock cho VNPay JSON; không N+1, không QueryDR từ History.

## 9. API-07 – Internal QueryDR & Reconciliation [LOCKED algorithm; gateway VERIFY]

VNPay PAY 2.1.0 merchant external JSON POST `/merchant_webapi/api/transaction`, `vnp_Command=querydr`; server-to-server, không expose Customer endpoint. Gateway endpoint/fields/HMAC canonical signature phải VERIFY chính thức, tách khỏi payment URL signer. `vnp_RequestId` unique, TxnRef/TransactionDate gốc phải được lưu; request `CreateDate` là giờ query, không thay thế transaction date.

`vnp_ResponseCode=00` = query request được xử lý, chưa phải payment SUCCESS; đọc `vnp_TransactionStatus`. `91` transaction not found và `94` query duplicate không tự FAILED; timeout, wrong signature, gateway 99 không auto FAILED. Chỉ terminal verified outcome → shared Finalization. Status 01 chưa hoàn tất; các mã đảo/đáng ngờ/không biết → review, không mở retry. Exact code mapping/merchant rate limit là VERIFY. **Phụ lục B đã có mẫu JSON, công thức request/response hash theo tài liệu VNPay PAY công khai và outcome mapping.** Cần test vectors/merchant credentials và Sandbox để xác minh encoding, trường tùy chọn, thiếu field và hành vi thật trước khi merge phần gateway.

Schedule: tại `order.expiresAt` với PENDING có ít nhất một eligible QueryDR trong Grace 5m nếu gateway rate limit cho phép; đến `expiresAt+5m` vẫn unknown → Order CANCELLED/release, Payment PENDING; tiếp tục 10 phút/chu kỳ trong **60 phút sau Grace** rồi `REQUIRES_REVIEW`, Payment vẫn PENDING. IPN đến sau horizon vẫn có thể được ghi nhận theo finalization. Claim/lease bền vững, có expiry, không nhiều worker xử lý cùng lúc; gateway HTTP ngoài DB transaction; response verify trước finalization.

## 10. Cross-cutting transaction, financial exception và safety [LOCKED]

1. Điều phối idempotency key (nếu cần) trước Order row lock, sau đó lock/read Payment attempt; nhất quán giữa Initiation, Mock, ZERO_AMOUNT, IPN, QueryDR, Expiration. Không dùng nhiều lock order không tương thích; DB test deadlocks/races bắt buộc.
2. Các side effects (Payment/Order/Coupon/Inventory/Loyalty/evidence) phải commit atomic khi cùng một finalization. Không double award, không double release.
3. `expireOrderInTransaction(tx,orderId)` được gọi bởi cả Create Order lazy cleanup và Scheduler, phải kiểm tra VNPay PENDING và Grace **bên trong transaction sau lock**. Không chỉ sửa Scheduler.
4. `Payment.SUCCESS + Order.CANCELLED` được phép trong late verified financial outcome **nếu không vi phạm one-success constraint**; nếu đã có một SUCCESS khác, ghi evidence/exception riêng thay vì Payment SUCCESS thứ hai.
5. Nếu SUCCESS tài chính có payDate đáng tin **sau TTL**, không PAID; nếu thiếu chứng cứ thời gian, không tự PAID hoặc tự đổi sang FAILED; cần reconciliation/review, Order cleanup không bị bỏ kẹt.
6. Financial exception phải được lưu bền vững, hiển thị trong API-03/06; không tự refund. **FIN-REFUND-01:** cần quy trình đối soát/hoàn tiền thủ công; chỉ thông báo đã hoàn tiền khi có bằng chứng bên VNPay/ngân hàng.
7. Mock/CARD/WALLET legacy snapshots phải tiếp tục đọc được sau migration. PostgreSQL partial unique index phải thực thi one SUCCESS/Order, one PENDING VNPay/Order, active Order/User.

## 11. Migration / schema acceptance [APPROVED DESIGN; IMPLEMENTATION VERIFY]

ERD/Prisma Delta v0.2.2 + DBML được Leader xác nhận Approved làm thiết kế cho Thụy + CKhang triển khai: provider backfill MOCK; PaymentStatus PENDING; PaymentMethod nullable/extended; `vnpTxnRef` unique; gateway proofs; immutable init replay data; reconciliation scheduling/lease and status; financial evidence/exception persistent storage; pending-compatible response snapshots; constraints unique one success/order and pending VNPay/order. Đối chiếu migration SQL thật vì Prisma schema không thể hiện toàn bộ partial indexes. DB seed v3.0 và historical Mock payments phải migrate/read thành công.

## 12. Security & external integration gates [IMPLEMENTATION VERIFY]

- HMAC-SHA512 ký URL/IPN/QueryDR bằng canonical serialization **đúng theo từng API của VNPay PAY 2.1.0**; không dùng một helper serialization sai cho tất cả.
- Không đưa HashSecret, JWT, internal key, full raw IPN/URL hoặc card number vào source/log/screenshot; rotate HashSecret từng lộ trước khi tích hợp.
- IPN dùng public HTTPS qua ngrok khi development, không yêu cầu Customer JWT; verify merchant+amount+signature+txnRef trước mutation.
- Kiểm chứng `vnp_ExpireDate` khi Order còn rất ít thời gian, VNPay transaction status/RspCode/IPN duplicate, QueryDR limits và signature bằng Sandbox. Nếu Sandbox khác giả định, cập nhật Contract bằng change record, không âm thầm đổi BR.

## 13. Ownership and tests

| Owner | Phụ trách |
|---|---|
| HKhang | API Contract, VNPay Gateway/Initiation/IPN/QueryDR Client |
| Thụy | Prisma delta, migration/constraints, reconciliation scheduler |
| Hoàng | Shared finalization, concurrency/integration tests, Mock compatibility refactor |
| CKhang | Expiration/Grace, ZERO_AMOUNT, Mock environment/cross-provider guard |
| Khánh | VNPay checkout, redirect, Payment Status UX |
| Lập | Order History/Confirmation mapper and E2E regression |

**Blocking tests:** same/different idempotency key concurrent; cross-provider PENDING gate; replay after expiry; valid/invalid IPN signature, amount, merchant, TxnRef; duplicate/conflicting IPN; IPN-vs-QueryDR-vs-Scheduler races; payDate before/after TTL; missing payDate; late financial success after CANCELLED; second verified SUCCESS evidence without unique constraint violation; Order create lazy expiry during Grace; QueryDR 91/94/timeout/crash/reclaim; zero amount exact; mock disabled prod; legacy history preserved; migration from nonempty Phase1 DB; Docker+ngrok Sandbox callback.


## Phụ lục A – IPN response decision table [LOCKED DESIGN; merchant signature VERIFY]

VNPay PAY IPN GET, trả HTTP 200 + JSON `{RspCode, Message}` khi ứng dụng đã xử lý được request ở tầng giao thức. Mã `00`/`02` kết thúc retry của VNPay; `01`/`04`/`97`/`99` cho phép gateway retry (theo tài liệu PAY). **Chỉ xác nhận 00 sau khi sự kiện đã commit bền vững.** Không dùng 02 để che xung đột chưa lưu evidence.

| Điều kiện sau xác thực / transaction | RspCode | Message | DB side effect |
|---|---|---|---|
| Chữ ký sai | `97` | `Invalid signature` | Không sửa |
| Thiếu field bắt buộc, tham số trùng/không rõ ràng, payload không thể phân tích an toàn | `99` | `Invalid request` | Không sửa |
| Chữ ký đúng nhưng `vnp_TmnCode` không đúng cấu hình | `99` | `Merchant mismatch` | Không sửa; cảnh báo bảo mật (không sử dụng 01 để giả đã tra Order) |
| TxnRef chưa từng được hệ thống tạo | `01` | `Order not found` | Không sửa, ghi log phi nhạy cảm |
| TxnRef khớp, nhưng amount không khớp `amountVnd×100` | `04` | `Invalid amount` | Không sửa Payment/Order; lưu sự kiện bảo mật có kiểm soát nếu khả thi |
| Outcome hợp lệ, attempt PENDING, finalization/exception committed | `00` | `Confirm Success` | Commit chính xác một lần; 00 không có nghĩa Order PAID |
| Callback trùng *cùng outcome*, dữ liệu đã commit trước đó | `02` | `Order already confirmed` | Không side effects lặp |
| Terminal outcome khác outcome đã ghi; evidence xung đột đã commit | `00` | `Confirm Success` | Giữ terminal cũ, persist discrepancy duy nhất theo source event |
| Confirmed financial success nhưng Order CANCELLED/expired; evidence/exception đã commit | `00` | `Confirm Success` | Không resurrect Order, không award/consume |
| Finalization lỗi, transaction rollback, không thể lưu evidence | `99` | `Unknown error` | Không ACK thành công; cho retry |

**Không nhận 00 khi chưa kiểm tra** signature, TMN, txnRef, amount, outcome. Xác thực strict: duplicate query key, giá trị không đúng type hoặc mã sai chuẩn bị từ chối; HMAC verify theo đúng canonicalization VNPay. `vnp_ResponseCode=00` **và** `vnp_TransactionStatus=00` cùng bằng chứng transaction mới là gateway SUCCESS; không áp dụng logic OR trong sample code nếu trái invariant của BR-04. Kết quả đảo/nghi ngờ cần evidence/review; chưa đủ bằng chứng thì vẫn không tự PAYMENT_FAILED. Nếu `vnp_PayDate` thiếu hoặc không tin cậy, lưu evidence trạng thái chưa xác quyết, không tự PAID. Cần test đối chiếu chữ ký/canonical bytes và merchant response trong Sandbox trước code merge.

## Phụ lục B – QueryDR wire contract, result classification [DESIGN APPROVED; GATEWAY VERIFY]

External target: `POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction`, JSON, `vnp_Command=querydr`. Đây là **mẫu cấu trúc/kiểu giá trị**, không phải test vector chữ ký đã được VNPay xác nhận:

```json
{
  "vnp_RequestId": "BLQ20261031T101500001",
  "vnp_Version": "2.1.0",
  "vnp_Command": "querydr",
  "vnp_TmnCode": "MERCHANT_CODE",
  "vnp_TxnRef": "BLPAYMENT00001",
  "vnp_OrderInfo": "Kiem tra giao dich BLPAYMENT00001",
  "vnp_TransactionDate": "20261031100000",
  "vnp_CreateDate": "20261031101500",
  "vnp_IpAddr": "203.0.113.10",
  "vnp_SecureHash": "<HMAC_SHA512_PLACEHOLDER>"
}
```

`vnp_RequestId` mới mỗi QueryDR; `vnp_TransactionDate` = **`vnp_CreateDate` của lệnh PAY ban đầu được lưu bất biến**, không phải thời gian tạo payment record/giờ máy hiện tại; `vnp_CreateDate` mới là giờ truy vấn. `vnp_OrderInfo` phải khớp giá trị được gửi/lưu cho giao dịch gốc, không tự đặt lại ở lúc truy vấn; payload JSON minh họa ở trên chỉ mô tả định dạng. Không lưu HashSecret.

**Request HMAC-SHA512 theo tài liệu VNPay PAY QueryDR:** lấy nguyên văn giá trị từng trường (không tự thêm dấu cách), nối đúng thứ tự bằng dấu `|`:

```text
vnp_RequestId|vnp_Version|vnp_Command|vnp_TmnCode|vnp_TxnRef|vnp_TransactionDate|vnp_CreateDate|vnp_IpAddr|vnp_OrderInfo
```

`vnp_SecureHash = HMAC_SHA512(HashSecret, chuỗi trên)`. Không tái sử dụng canonicalization theo URL PAY/IPN. Phải kiểm chứng chính xác encoding dữ liệu tiếng Việt, giá trị field rỗng và test vectors trên Sandbox trước merge.

**Response HMAC-SHA512 theo tài liệu VNPay PAY QueryDR:** nối bằng `|`, đúng thứ tự (giữ các field optional như `vnp_PromotionCode`, `vnp_PromotionAmount` theo biểu diễn đặc tả):

```text
vnp_ResponseId|vnp_Command|vnp_ResponseCode|vnp_Message|vnp_TmnCode|vnp_TxnRef|vnp_Amount|vnp_BankCode|vnp_PayDate|vnp_TransactionNo|vnp_TransactionType|vnp_TransactionStatus|vnp_OrderInfo|vnp_PromotionCode|vnp_PromotionAmount
```

**Bắt buộc phân biệt** request/response chữ ký, xác nhận nguồn merchant docs cho các giá trị optional khi vắng mặt. Chỉ sau khi HMAC hợp lệ mới dùng `vnp_TransactionStatus` để quyết định tài chính. Nguồn: https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr%26refund.html.

Response example **illustrative only**, phải được đối chiếu với response thực từ merchant Sandbox:

```json
{
  "vnp_ResponseId": "RESPONSE_ID",
  "vnp_Command": "querydr",
  "vnp_ResponseCode": "00",
  "vnp_Message": "Transaction inquiry processed",
  "vnp_TmnCode": "MERCHANT_CODE",
  "vnp_TxnRef": "BLPAYMENT00001",
  "vnp_Amount": 8500000,
  "vnp_OrderInfo": "Kiem tra giao dich BLPAYMENT00001",
  "vnp_TransactionNo": "12345678",
  "vnp_BankCode": "NCB",
  "vnp_TransactionType": "01",
  "vnp_PayDate": "20261031100400",
  "vnp_TransactionStatus": "00",
  "vnp_PromotionCode": "",
  "vnp_PromotionAmount": "",
  "vnp_SecureHash": "<SIGNED_RESPONSE_PLACEHOLDER>"
}
```

**Validation steps:** HTTP response receipt → parse strict schema → verify response signature → correlate merchant, txnRef and amount → evaluate `vnp_ResponseCode` **before** `vnp_TransactionStatus` → normalize verified outcome → shared finalization under lock → update reconcile metadata. Không coi HTTP 200 hoặc `vnp_ResponseCode=00` đơn độc là payment SUCCESS.

| QueryDR response code | Quyết định |
|---|---|
| `00` | API query thành công, xét transaction status và evidence |
| `91` | Không tìm thấy giao dịch: giữ PENDING, retry lịch/review; không tự FAILED |
| `94` | Duplicate inquiry/rate-limited: retry sau giới hạn, không FAILED |
| `02` / `03` / `97` | Lỗi cấu hình, format, checksum: cảnh báo kỹ thuật, không đổi Payment |
| `99`, HTTP timeout, network error, invalid signed response | Không rõ kết quả; giữ PENDING và lên lịch retry hoặc manual review |

| Verified transaction status | Domain result |
|---|---|
| `00` và response code `00` | Financial SUCCESS; Order PAID *chỉ nếu* đủ chứng cứ thời gian và Order còn active; else exception |
| `01` | PENDING/reconcile |
| `02` | FAILED terminal chỉ khi có xác nhận đủ tin cậy cho giao dịch tương ứng |
| `04`, `07`, unknown hoặc conflicting | Evidence/REQUIRES_REVIEW; không cho retry mù |

Gateway `94` liên quan trùng truy vấn trong khoảng 5 phút theo bảng mã PAY. Scheduler chạy 10 phút/lần hậu Grace là baseline, nhưng **không cam kết** chính xác giờ tick nếu worker down hoặc API không sẵn sàng. Mỗi request timeout phải release lease theo deadline để lần sau có thể claim. Không lập lịch QueryDR trực tiếp từ mỗi lần frontend polling.

## Phụ lục C – Read model, NULLability và ví dụ API-03/API-06 [LOCKED]

**API-03 response required fields:** `paymentId:string(UUID)`, `orderId:string(UUID)`, `provider:VNPAY|MOCK|ZERO_AMOUNT`, `paymentStatus:PENDING|SUCCESS|FAILED`, `orderStatus:OrderStatus`, `amountVnd:number`, `resolution:Resolution`, `requiresReview:boolean`, `canRetry:boolean`, `createdAt:ISO8601`, `orderExpiresAt:ISO8601`, `lastUpdatedAt:ISO8601`. `resolution` chỉ là read-model derived. `lastUpdatedAt` phải phản ánh transaction update hoặc event timestamp persisted, không lấy `new Date()` cho mỗi lần GET. Nguồn persisted đã chốt: `payments.updated_at`, `orders.updated_at` và `payment_gateway_events.created_at`/`verified_at` theo event; dùng max timestamp liên quan, không dùng thời điểm đọc GET.

**API-06:** `payment:null` nếu chưa từng có attempt. Nếu có, giữ legacy payment keys, thêm provider/resolution/requiresReview/canRetry. Với provider `MOCK`, giữ đúng field/snapshot legacy; `VNPAY` hoặc `ZERO_AMOUNT` thì `method:null`, `methodLast4:null`, `mockReference:null`. `failureReason:string|null` chỉ từ verified terminal failure/snapshot; không giả lỗi FAILED cho query timeout. `hasFinancialException:boolean` lấy từ `payments.has_financial_exception` và evidence bền vững trong `payment_gateway_events`, không suy từ mỗi Payment representative.

| Order | Payment representative | resolution | requiresReview | canRetry |
|---|---|---|---|---|
| `PENDING` | `null` | (không có payment object) | (không có payment object) | (không có payment object) |
| `PENDING` trong TTL | `PENDING` | `PROCESSING` | false | false |
| `PAYMENT_FAILED` trong TTL | `FAILED` terminal | `FAILED` | false | true nếu không còn block |
| `CANCELLED` | `PENDING` | `RECONCILING`, sau horizon `REQUIRES_REVIEW` | tương ứng metadata | false |
| `PAID/PREPARING/READY/COMPLETED` | `SUCCESS` accepted | `PAYMENT_ACCEPTED` | false | false |
| `CANCELLED` | financial SUCCESS được ghi nhận | `FINANCIAL_EXCEPTION` | true | false |
| Bất kỳ | exception evidence độc lập | `FINANCIAL_EXCEPTION` | true | false |

Payment representative: terminal SUCCESS → PENDING → latest FAILED → null; dùng timestamp + ID tie-break. Khi có evidence về giao dịch thứ hai, Payment representative vẫn theo quy tắc trên, nhưng Order `hasFinancialException=true` và presentation `resolution=FINANCIAL_EXCEPTION` dù Payment representative có thể là MOCK SUCCESS. API-03 cho Payment cụ thể cũng phải tra evidence liên quan để không che bất thường.

**Ví dụ status FAILED (API-03):**
```json
{"paymentId":"92e27d8c-e9d5-4da4-9b16-78116f631c9b","orderId":"550e8400-e29b-41d4-a716-446655440000","provider":"VNPAY","paymentStatus":"FAILED","orderStatus":"PAYMENT_FAILED","amountVnd":85000,"resolution":"FAILED","requiresReview":false,"canRetry":true,"createdAt":"2026-10-31T03:02:00.000Z","orderExpiresAt":"2026-10-31T03:15:00.000Z","lastUpdatedAt":"2026-10-31T03:06:00.000Z"}
```
**Ví dụ status financial exception (API-03):**
```json
{"paymentId":"92e27d8c-e9d5-4da4-9b16-78116f631c9b","orderId":"550e8400-e29b-41d4-a716-446655440000","provider":"VNPAY","paymentStatus":"PENDING","orderStatus":"CANCELLED","amountVnd":85000,"resolution":"FINANCIAL_EXCEPTION","requiresReview":true,"canRetry":false,"createdAt":"2026-10-31T03:02:00.000Z","orderExpiresAt":"2026-10-31T03:15:00.000Z","lastUpdatedAt":"2026-10-31T03:24:00.000Z"}
```
Trong ví dụ thứ hai, `paymentStatus=PENDING` có thể xuất hiện nếu kết quả tài chính xung đột được lưu ở evidence riêng và không được phép ghi Payment.SUCCESS vì partial unique index. **Không có nghĩa gateway chưa báo success**; resolution/evidence là nguồn giải thích. Status terminal không overwrite.

## Phụ lục D – Temporal validity, cancellation và transaction concurrency [LOCKED]

Các điều kiện kiểm tra phải được đánh giá **trong transaction sau khóa Order** và dùng `expiresAt` persisted. Time nguồn DB cho TTL, gateway pay time phải xác minh tính tin cậy. Không cập nhật `CANCELLED` rồi không release tồn kho/coupon trong cùng transaction.

| Payment outcome và chứng cứ | Order khi finalization khóa | Hành động nguyên tử |
|---|---|---|
| Verified SUCCESS + payDate tin cậy <= expiresAt | `PENDING`/`PAYMENT_FAILED`, DB now <= expiresAt+grace | Payment SUCCESS + Order PAID + coupon CONSUMED + loyalty once |
| Verified SUCCESS + payDate sau expiresAt | Order còn active | Persist financial evidence, **hủy Order + release Inventory/Coupon ngay trong transaction** nếu DB now >= expiresAt, không PAID/award; không cần đợi grace vì đã xác nhận sai hạn |
| Verified SUCCESS + payDate đúng hạn nhưng Order đã `CANCELLED` | `CANCELLED` | Persist evidence, không phục hồi hay cấp tài nguyên; ghi confirmed financial outcome vào evidence độc lập; không tự đổi Payment.status nếu policy chưa xác nhận hoặc đã có SUCCESS khác |
| SUCCESS đã được VNPay xác minh nhưng payDate thiếu/không đáng tin | Trước expiry | Persist ambiguous evidence, không tự PAID; giữ theo TTL policy; reconciliation |
| SUCCESS đã xác minh nhưng payDate thiếu/không đáng tin | Trong Grace | Không PAID; đối soát có giới hạn; sau Grace Order CANCELLED/release dù Payment có thể vẫn PENDING |
| SUCCESS đã xác minh nhưng payDate thiếu/không đáng tin | Sau Grace | Order CANCELLED/release; Payment evidence/review không được bỏ qua |
| Terminal FAILED được xác minh | Trong TTL | Payment FAILED, Order PAYMENT_FAILED; cho retry theo guards |
| Terminal FAILED | Sau TTL | Payment FAILED và Order CANCELLED/release cùng transaction |
| IPN / QueryDR đã trễ hoặc race | Bất kỳ | Lock Order trước, re-read trạng thái/payment/evidence; không overwrite terminal; no double side effects |

**Gateway financial success vs Payment.SUCCESS:** nếu confirmed success nhưng Order invalid, ghi event `FINANCIAL_EXCEPTION` bền vững, đặt `payments.has_financial_exception=true`, `reconciliationState=REQUIRES_REVIEW`, giữ Payment.status không đổi; không tự chuyển sang SUCCESS. Không tự ghi Payment.SUCCESS nếu Order đã bị CANCELLED hoặc có SUCCESS khác, dù unique index còn cho phép. Không có bằng chứng đủ về timely payment thì không fulfill. Nếu một kết quả tài chính late/suspicious đã lưu, duplicate IPN được ACK theo trạng thái *evidence committed*, không gọi finalization lại. Row lock và DB partial unique indexes là hai lớp bảo vệ bổ sung.

## Phụ lục E – Mock precedence, idempotency và error determinism [LOCKED]

Thứ tự cho `POST /payments` (legacy Mock):

1. Reject Mock nếu `NODE_ENV=production` hoặc `MOCK_PAYMENT_ENABLED!==true`: `403 MOCK_PAYMENT_DISABLED` (áp dụng kể cả replay, không làm lộ snapshot Mock trong production).
2. Authenticate JWT; validate request headers/body theo v3.0 (thứ tự HTTP guard thực tế có thể authenticate trước feature gate, nhưng không làm thay đổi kết quả khi JWT hợp lệ).
3. Xác minh Order ownership trước lookup/replay để tránh lộ giao dịch người khác.
4. Tra `(userId, Idempotency-Key)` và requestHash toàn cục; cùng key và hash → HTTP 200 replay; cùng key khác → 409 conflict; không chạy evaluation/side effects lần nữa.
5. Attempt mới: acquire Order lock, recheck TTL/status, zero amount restriction, existing PENDING/uncertain/exception and one SUCCESS; từ chối nếu có VNPay chưa xác quyết hoặc exception; không đổi legacy snapshot format.
6. Nếu được phép, chạy Mock evaluation + shared finalization trong transaction; trả HTTP 200 cho cả SUCCESS và terminal FAILED (v3.0).

| Điều kiện attempt mới | HTTP/business code |
|---|---|
| Mock disabled | `403 MOCK_PAYMENT_DISABLED` |
| Không owner | `404 NOT_FOUND` |
| Key trùng nhưng request khác | `409 IDEMPOTENCY_KEY_CONFLICT` |
| VNPay PENDING/unknown | `409 PAYMENT_IN_PROGRESS` |
| Exception đã persisted | `409 FINANCIAL_EXCEPTION_REQUIRES_REVIEW` |
| Order 0 VND, đã hết hạn, PAID/CANCELLED | `409 INVALID_TRANSITION` (legacy policy) |
| Mock verified terminal FAILED | `200`, Mock failure snapshot như v3.0 |
| Mock SUCCESS | `200`, Mock success snapshot như v3.0 |

**Ghi chú:** Order History no-pagination vẫn phải trả toàn bộ như v3.0. Yêu cầu bảo mật luôn được xét trước khi lộ dữ liệu replay. Không dùng `canRetry` suy diễn để cấp quyền khi Order chưa từng có attempt.

## 14. Approved cross-document resolutions (normative)

**Baseline confirmation:** Project Leader xác nhận US/AC Phase 2 v2.3, Use Case v3.1, ERD/Prisma Delta v0.2.2 và DBML đi kèm được dùng làm Approved input; BR-01..BR-06 và Requirements v3.1 là nghiệp vụ ưu tiên. Tài liệu nguồn vẫn còn header “Candidate/Proposed”: owner cần đồng bộ *Document Control* khi commit, nhưng xác nhận của Leader là quyết định approval của nguồn trong lần xây dựng v4.0 này. Không diễn giải đây là SQL migration đã triển khai.

### 14.1 PR-01 – Pricing and loyalty (mandatory override)

- Với mọi sản phẩm có size multiplier `m` phần trăm: `sizePriceVnd = round_half_up(basePriceVnd * m / 100)`; đơn giá ly = `sizePriceVnd + sum(toppingPriceVnd)`; thành tiền dòng = đơn giá ly × quantity. Với số nguyên VND, m dương: `round_half_up(n / 100) = floor((n + 50) / 100)` khi `n = basePriceVnd*m` không âm. Không dùng JavaScript floating-point để tính tiền; dùng số nguyên/BigInt với guard phạm vi.
- Tính lại toàn bộ từ backend khi `POST /orders`. Tổng Order snapshot `totalVnd` sau coupon chính là nguồn duy nhất dùng cho Initiation (`vnp_Amount=totalVnd*100`), IPN/QueryDR amount verification, Mock và ZERO_AMOUNT. **Không tính lại giá catalog ở thời điểm IPN**.
- `floor(totalVnd/10000)` cho điểm thưởng của thanh toán có giá trị **vẫn giữ nguyên**, vì đó là phép tính loyalty độc lập. ZERO_AMOUNT luôn 0 điểm.
- v3.0 còn mô tả `floor` ở bước nhân size: **bị override có chủ đích** bởi Requirements/US/UC và Leader-approved BL-DEC-PRICING-001. Backend hiện tại cần chỉnh code/test; không tuyên bố đã deploy.

### 14.2 ORD-01 – One active Order and Grace

- Khi `POST /orders` thấy Order `PENDING`/`PAYMENT_FAILED` còn active, kể cả vừa quá `expiresAt` nhưng VNPay PENDING và `dbNow < G=expiresAt+5 phút`, trả **409 `PENDING_ORDER_EXISTS`** với Order ID theo legacy Create Order error envelope, **không** lazy-cancel và tạo Order mới.
- Mọi đường cleanup (Create Order lazy cleanup, Scheduler, Payment Finalization) gọi cùng `expireOrderInTransaction`, khóa Order trước Payment, kiểm `dbNow`, trạng thái, VNPay uncertain/Grace. Tại `dbNow >= G` không còn eligible verified timely success thì CANCELLED/release đúng một lần. Khi không có VNPay PENDING, tại `dbNow >= E` xử lý expiry thông thường.
- Boundary chuẩn: `dbNow < E` được tạo attempt mới; `E <= dbNow < G` chỉ xác minh VNPay attempt có trước E; `dbNow >= G` không finalize PAID đơn còn unresolved. Gateway paidAt `<= E` đúng hạn nhưng callback phải được commit khi Order chưa CANCELLED và `dbNow < G` (theo điều kiện bảo vệ Grace); Order đã CANCELLED tuyệt đối không resurrect.

### 14.3 DATA-01 – Approved persistent model mapping

- Extend `payments`: `provider` MOCK/VNPAY/ZERO_AMOUNT, `status` PENDING/SUCCESS/FAILED, legacy `method` nullable cho non-Mock, `responseSnapshot` nullable cho VNPay, `initiationSnapshot`, `finalOutcomeSnapshot`, `vnpTxnRef`, `vnpTmnCode`, `vnpCreateDate`, `gatewayExpiresAt`, `verifiedPaidAt`, `updatedAt`, reconciliationState NONE/SCHEDULED/RESOLVED/REQUIRES_REVIEW, `nextQueryAt`, `lastQueryAt`, `queryAttempts`, `reconcileUntil`, `claimToken`, `leaseExpiresAt`, `lastQueryRequestId`, `lastQueryError`, `reviewReason`, `hasFinancialException`.
- Thêm đúng một bảng `payment_gateway_events` append-only cho verified observations: FK `paymentId`, `source` IPN/QUERYDR, `eventIdentity`, `queryRequestId`, gateway codes/amount/paidAt, `outcome` UNKNOWN/SUCCESS/FAILED, `disposition` OBSERVED/FINALIZED/DUPLICATE/CONFLICT/FINANCIAL_EXCEPTION, evidence allowlist, receivedAt/verifiedAt/createdAt.
- Một event `outcome=SUCCESS` **không** mặc định đồng nghĩa `payments.status=SUCCESS` hoặc `orders.status=PAID`. Bất thường tài chính phải bật persisted `hasFinancialException` và `REQUIRES_REVIEW`, ngay cả khi Payment terminal trước đó là FAILED hoặc Order CANCELLED.
- Partial indexes (trên PostgreSQL migration): one SUCCESS per Order; one VNPay PENDING per Order; one active Order per User. Duy trì unique `(user_id,idempotency_key)`, unique `vnp_txn_ref`; event dedupe unique `(payment_id,source,event_identity)`; kiểm các predicate trong SQL thực tế. DBML là documentation, **không tự sinh partial index**.
- Mock legacy: backfill `provider=MOCK`, giữ dữ liệu/snapshot, `updated_at` backfill từ `created_at` mang ý nghĩa approximation lịch sử. `method`/`response_snapshot` nullable chỉ có CHECK provider-specific để không cho Mock hỏng dữ liệu.
- Contract này xác nhận *shape/semantics* theo v0.2.2, **không** xác nhận parser DBML, Prisma migrate hay Postgres đã chạy.

### 14.4 RD-01 – Single payment presentation algorithm (API-03 and API-06)

1. Authorize JWT + owner trước khi đọc; API-03 chọn Payment ID được yêu cầu, API-06 chọn representative theo `SUCCESS > PENDING > most recent FAILED > null`, tie by `createdAt DESC,id DESC`. Không nhầm Payment đại diện với trạng thái toàn Order.
2. Đọc tất cả Payment cùng Order + verified `payment_gateway_events` liên quan để tính cờ Order. `hasFinancialException` là OR của persisted flags/event FINANCIAL_EXCEPTION; **không xóa cờ khi gateway late trả kết quả tốt**.
3. `resolution` ưu tiên: FINANCIAL_EXCEPTION nếu có financial exception (ở cấp Order khi API-06, ở attempt/Order theo nguyên tắc cảnh báo toàn đơn ở API-03); REQUIRES_REVIEW nếu reconciliationState=REQUIRES_REVIEW hoặc có review-only evidence; PAYMENT_ACCEPTED nếu Payment SUCCESS và Order PAID/PREPARING/READY/COMPLETED; FAILED nếu Payment FAILED không exception; RECONCILING nếu unresolved/QueryDR đang diễn ra hoặc Order CANCELLED nhưng Payment PENDING; còn lại PROCESSING.
4. `requiresReview=true` khi resolution FINANCIAL_EXCEPTION/REQUIRES_REVIEW. `canRetry` chỉ true với FAILED terminal **gần nhất** và Order còn hạn thuộc chủ sở hữu, Order PENDING/PAYMENT_FAILED, không SUCCESS, không bất kỳ PENDING/uncertain/cảnh báo bất thường nào. ZERO_AMOUNT luôn false. Endpoint read-only không gọi gateway.
5. `lastUpdatedAt` lấy mốc persisted mới nhất của Order/Payment được quan sát và event liên quan (`orders.updated_at`, `payments.updated_at`, `payment_gateway_events.created_at`/verifiedAt theo semantics) không dùng `new Date()` ở GET.
6. API-06 giữ nguyên legacy PaymentSummary/nullable keys, `payment:null` khi chưa có attempt, `hasFinancialException` cấp Order. Khi payment đại diện SUCCESS nhưng event khác financial exception thì vẫn cảnh báo.

### 14.5 FIN-01 – Financial success, terminal conflict and IPN ACK

- IPN/QueryDR verified SUCCESS khi `verifiedPaidAt <= E` và `dbNow < G`, Order còn active, không tồn tại accepted SUCCESS khác: atomic Payment SUCCESS + Order PAID + coupon consume + loyalty once, event FINALIZED, no second stock decrement.
- VNPay confirmed SUCCESS nhưng `verifiedPaidAt > E`, Order CANCELLED, missing reliable timestamp hoặc clash with terminal outcome: persist event with outcome SUCCESS and disposition FINANCIAL_EXCEPTION / CONFLICT / OBSERVED as appropriate. Không tự nâng Order PAID; không chuyển Payment FAILED thành SUCCESS; không auto-refund. Nếu chưa qua G thì chưa đủ paidAt, tiếp tục reconciling, sau G cleanup; nếu already expired and evidence proves late, cancel immediately within same transaction.
- ACK IPN `RspCode=00` **chỉ sau** khi finalization hoặc evidence disposition đã commit. Duplicate identical committed → `02`; failed/rollback → `99`. ResponseCode của IPN không phải VNPay payment result. QueryDR và IPN cùng Order lock; event verification trước transaction; HTTP outside locks.
- Business refund: bộ phận vận hành xử lý manual reconciliation/refund, không hiển thị “đã hoàn tiền” trước khi có bằng chứng ngân hàng/gateway. Không tự động tạo trạng thái REFUNDED/REFUND_PENDING trong v4.

### 14.6 QDR-01 – Schedule, identity and exception safety

- QueryDR từ Scheduler server-to-server, mỗi claim có `claimToken`, `lastQueryRequestId` riêng; `eventIdentity` canonical SHA-256 xác định observation, unique `(paymentId,source,eventIdentity)`; event append-only, không overwrite when repeat or conflict.
- `E=Order.expiresAt`, `G=E+5m`, `H=G+60m`. Trong Grace, thực hiện một QueryDR đủ điều kiện nếu gateway cho phép. Sau Grace: mục tiêu 10 phút một lần tới trước H; tại/sau H đánh dấu REQUIRES_REVIEW và ngừng tự truy vấn. IPN late vẫn xử lý.
- Worker cũ hết lease không được ghi đè claim/lịch mới. Response verified tài chính đến muộn vẫn đưa vào shared finalization với requestId gốc để giữ evidence; không coi lease expired là lỗi giao dịch.
- Trường `vnp_TransactionDate` phải là timestamp **khởi tạo giao dịch ban đầu**, không dùng request timestamp. HMAC/canonical bytes và rate limit VNPay phải được kiểm tra bằng official merchant contract + Sandbox test trước khi merge service tích hợp.

### 14.7 API and implementation acceptance checklist

| Gate | Điều kiện | Loại |
|---|---|---|
| Contract design | Các quyết định tại mục 1–14 và phụ lục A–E là baseline triển khai; thay đổi phải đi qua change record | APPROVED design |
| Source-document metadata | Đồng bộ header US/UC/ERD/Architecture trong repo với xác nhận Approved của Leader, không nhầm với deploy | Documentation sync |
| Prisma/DBML | `prisma validate`, DBML parser, SQL migration test ở DB trống và DB Mock thật, partial index/CHECK/unique audit | Implementation verification |
| Payments gateway | VNPay URL/IPN/QueryDR HMAC byte-level signatures, payDate, `vnp_ExpireDate` near E, callbacks via HTTPS, rate limits | Integration verification |
| Concurrency | IPN vs QueryDR vs Scheduler vs Mock/Create Order, idempotency, ZERO_AMOUNT, release/coupon/loyalty once | Integration verification |
| Legacy regression | Mock/Card/Wallet existing snapshots; `GET /orders/me` no-pagination returns all; catalog pricing `round_half_up`; existing order snapshots preserved | Regression verification |

**Approval scope:** Project Leader đã xác nhận bộ tài liệu nguồn là Approved và lựa chọn `round_half_up`. Do đó các decisions v4.0 có thể được phát hành là **APPROVED – API DESIGN BASELINE**. Chỉ tuyên bố runtime, DB migration hoặc VNPay Sandbox đã chạy đúng sau khi lưu kết quả kiểm thử thực tế. Nếu một test phát hiện giao thức merchant yêu cầu khác, phải mở change request thay vì chỉnh BR âm thầm.
