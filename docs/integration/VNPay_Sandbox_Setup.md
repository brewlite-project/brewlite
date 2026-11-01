# BrewLite – VNPay Sandbox Environment & Integration Guide

> **Document ID:** BL-GUIDE-VNPAY-SANDBOX-001
> **Phiên bản:** v1.2 – 01/11/2026 (review changes theo API Contract v4.0/current `dev`)
> **Task:** Phase 2 – Document VNPay Sandbox Integration Setup
> **Đường dẫn trong repository:** `docs/integration/VNPay_Sandbox_Setup.md`
> **Trạng thái:** **UPDATED REVIEW CANDIDATE – Contract v4.0 Review 3; thực thi Sandbox/E2E vẫn cần VERIFY**
> **Phạm vi:** VNPay Sandbox trên NestJS Backend, Next.js Frontend và PostgreSQL; **không hướng dẫn kích hoạt production**.

## 1. Mục đích, nguồn và giới hạn

Tài liệu hướng dẫn thành viên BrewLite chuẩn bị môi trường, vận hành luồng thanh toán VNPay Sandbox và thu thập bằng chứng kiểm thử mà không tiết lộ thông tin bí mật. Guide áp dụng cho thiết kế Phase 2 hiện tại. **API Contract v4.0 là nguồn của đường dẫn/DTO được chốt trong thiết kế; việc một route đã hoạt động trên branch cụ thể cần kiểm tra bằng Swagger/source và HTTP/Sandbox test.** Bản audit Payment Phase 1 cũ chỉ còn là nguồn tham khảo legacy Mock.

**Nguồn nghiệp vụ nội bộ:**

- `docs/decisions/VNPay_Phase2_Change_Request.md` – BL-CR-VNPAY-001 v1.0; BR-01 đến BR-06 được Project Leader phê duyệt.
- *BrewLite Requirements Specification v3.1 – VNPay Phase 2* (30/10/2026): FR-PAY-007 đến FR-PAY-012, mục 7.7.1; ngoại lệ IPN; kiểm chứng tích hợp.
- `docs/api/BrewLite_API_Contract_v4.0.md` – Review 3 Corrected Candidate tại bản được cung cấp, định nghĩa API-01…API-07 của Phase 2; trạng thái phê duyệt phải đối chiếu Leader/PR mới nhất.
- *BrewLite API Contract v3.0* – chỉ áp dụng cho Mock/Order History legacy không bị v4.0 thay thế.
- *BrewLite US/AC v2.3 đồng bộ Requirements v3.1*: dùng để truy vết điều kiện nghiệm thu Phase 2.

**Tài liệu chính thức từ VNPay và tunnel:**

1. [VNPay – Thanh toán PAY / Payment URL, Return URL, IPN](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html)
2. [VNPay – QueryDR & Refund API](https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr%26refund.html)
3. [VNPay – Downloads, tech spec và kịch bản SIT](https://sandbox.vnpayment.vn/apis/downloads/)
4. [VNPay – Sandbox demo và dữ liệu thẻ test công khai](https://sandbox.vnpayment.vn/apis/vnpay-demo/)
5. [Cloudflare – Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
6. [Cloudflare – tải `cloudflared` cho Windows](https://developers.cloudflare.com/tunnel/downloads/)

> **Nguồn chân lý khi có xung đột:** BR-01…BR-06 + Requirements v3.1 Approved → US/AC v2.3 / UC v3.1 → API Contract v4.0 cho API/DTO Phase 2 → ERD/Prisma Delta v0.2.2 cho cấu trúc DB → v3.0 chỉ ở phần legacy không bị thay thế. Không tự sửa BR để làm cho code hiện tại dễ chạy. Nếu VNPay Sandbox có hành vi không phù hợp với BR đã Approved, lập change proposal để Project Leader quyết định.

## 2. Tổng quan tích hợp và các quy tắc không được vi phạm

```text
Customer (Next.js)
    | 1. Đăng nhập JWT / tạo Order PENDING
    | 2. Khởi tạo thanh toán với Idempotency-Key
    v
BrewLite Backend (NestJS) ----- PostgreSQL (Payment Attempt PENDING)
    | 3. Chọn provider VNPay, lấy totalVnd từ Order snapshot
    | 4. Tạo Payment URL đã ký, giới hạn theo order.expiresAt
    v
VNPay Sandbox (trình duyệt được redirect)
    |                         |
    | 5a. Browser Return URL  | 5b. HTTPS IPN (server-to-server, không JWT)
    v                         v
Next.js: "Đang xác minh"     NestJS: verify HMAC, merchant, ref, amount, status
    |                         |
    |                         v
    |                  Atomic Payment Finalization <-- QueryDR khi cần đối soát
    |                         |
    +--- đọc trạng thái ------+--> PAID / PAYMENT_FAILED / PENDING / CANCELLED
```

Các quy tắc bắt buộc:

- **BR-01:** VNPay Sandbox là provider mặc định Phase 2. Mock chỉ dành cho automated test/demo được backend cho phép; **không tự fallback sang Mock** khi VNPay PENDING/unknown, Mock bị tắt ở production.
- **BR-02:** Payment Attempt có `PENDING`, `SUCCESS`, `FAILED`. Chỉ ghi `FAILED` khi có bằng chứng thất bại cuối cùng đã được xác minh; timeout, hết Payment URL hoặc thiếu IPN **không** đủ căn cứ.
- **BR-03:** `Order.expiresAt = Order.createdAt + 15 phút`. Grace Period 5 phút sau expiresAt chỉ để xác minh attempt đã bắt đầu, không gia hạn quyền thanh toán. Payment URL **không được vượt** expiresAt.
- **BR-04:** `GET /payments/vnpay/ipn` phải truy cập được bằng HTTPS công khai, **không yêu cầu Customer JWT**, nhưng backend phải xác minh chữ ký **HMAC-SHA512**, `vnp_TmnCode`, `vnp_TxnRef`, `vnp_Amount` và trạng thái giao dịch. Không ACK xử lý thành công trước commit.
- **BR-05:** Mỗi Order tối đa một VNPay Attempt PENDING. Retry chỉ khi attempt cũ **FAILED cuối cùng**, Order còn hạn và hợp lệ, với `Idempotency-Key` và `vnp_TxnRef` mới. IPN và QueryDR dùng chung finalization; không giữ DB transaction mở trong lúc HTTP gọi gateway.
- **BR-06:** `totalVnd = 0` được xử lý bằng `ZERO_AMOUNT` nội bộ; không tạo URL VNPay/Mock; tạo Payment SUCCESS 0 VND và cộng 0 Loyalty khi hợp lệ.

### 2.1. API Phase 2 theo API Contract v4.0 (đối chiếu implementation khi chạy)

| API / thành phần | Contract v4.0 | Kiểm chứng khi sử dụng |
|---|---|---|
| `POST /payments/vnpay/initiate` | JWT + `Idempotency-Key`, body `{ "orderId": "<UUID>" }`; 201 mới / 200 replay; tạo attempt VNPAY PENDING và trả URL Sandbox | Swagger/source/controller, merchant config, idempotency/replay, trạng thái hiện tại sau replay |
| `GET /payments/vnpay/ipn` | GET public không Customer JWT, bắt buộc verify HMAC-SHA512 / merchant / TxnRef / amount / outcome; trả `RspCode`/`Message` sau commit | Route, public HTTPS tunnel, test callback hợp lệ/sai chữ ký và duplicate |
| `GET /payments/:paymentId/status` | JWT; đọc DB (không gọi QueryDR); trả `paymentStatus`, `orderStatus`, `resolution`, `requiresReview`, `canRetry`, `lastUpdatedAt` | API-03 response, ownership 404, DB projection theo toàn Order và gateway event |
| `POST /payments/zero-amount` | JWT + Idempotency-Key; chỉ Order 0 VND, nội bộ SUCCESS, không gọi gateway/Mock | API-04, zero points, shared finalization, retry/idempotency |
| `POST /payments` | Legacy Mock CARD/WALLET; chỉ khi `MOCK_PAYMENT_ENABLED=true` và không production; không fallback từ VNPay pending | Gate policy, response snapshot tương thích, không trả Mock trong production |
| `GET /orders/me` | History additive `PaymentSummary`, Order `hasFinancialException`; giữ snapshots legacy | Payment representative và evidence toàn Order, không QueryDR trong History |
| QueryDR | Internal POST tới gateway PAY 2.1.0; khác canonical signer với Payment URL; không phải Customer API | Response checksum, TransactionStatus, scheduler, rate limit, Sandbox vectors |

**Ví dụ lời gọi Contract v4.0** (không thay thế Swagger/implementation verification):

```http
POST /payments/vnpay/initiate
Authorization: Bearer <CUSTOMER_JWT>
Idempotency-Key: <UNIQUE_KEY_8_TO_64_CHARS>
Content-Type: application/json

{"orderId":"<ORDER_UUID>"}
```

API-01: lần đầu `201` với `paymentId`, `orderId`, `provider=VNPAY`, `paymentStatus=PENDING`, `orderStatus`, `amountVnd`, `paymentUrl`, `expiresAt`; replay `200` cùng attempt nhưng trạng thái thanh toán/Order phải là **hiện tại**, không tái cấp URL hết hạn.

API-03: `GET /payments/:paymentId/status` với JWT trả dữ liệu từ DB như `paymentStatus`, `orderStatus`, `resolution`, `requiresReview`, `canRetry`, `lastUpdatedAt`, `orderExpiresAt`; không gọi QueryDR đồng bộ trong request. Frontend không tự đổi FAILED vì hết thời gian polling.

API-04: `POST /payments/zero-amount` với JWT, `Idempotency-Key` và body `{ "orderId": "<ORDER_UUID>" }` chỉ áp dụng khi snapshot Order chính xác 0 VND, trả SUCCESS nội bộ; không redirect hoặc gọi VNPay/Mock.

**Trạng thái:** Bảng thể hiện **contract/API thiết kế**, không chứng minh mọi controller đang chạy trên branch hiện tại. `docs/api/BrewLite_API_Contract_v4.0.md` từ bản đã nhận ghi `Review 3 Corrected Candidate` / các gateway VERIFY còn mở. Cần kiểm tra code/route hiện hành, không tự ghi `IMPLEMENTED` hoặc `SIT PASS`.

### 2.2. Các điểm tích hợp bắt buộc

- Route IPN phải nhận request server-to-server **không Customer JWT**; các route customer vẫn dùng JWT và kiểm tra quyền sở hữu.
- Backend phải khóa Order theo thứ tự nhất quán, không gọi HTTP gateway trong transaction, dùng chung finalization cho IPN và QueryDR.
- Payment PENDING không tự thành FAILED do timeout. Kết thúc Grace, Order có thể CANCELLED còn Payment PENDING để reconciliation.
- Không lưu HashSecret, full raw callback, bearer token hoặc thẻ thật vào log/PR.
- `resolution`, `canRetry`, `requiresReview` là **API projection**, không phải PaymentStatus mới; exception phải xét evidence toàn Order.

## 3. Chuẩn bị môi trường

### 3.1. Điều kiện trước khi chạy

- Windows + Git Bash; Node.js/npm tương thích với project; PostgreSQL/Prisma theo README của repository.
- Backend NestJS và Frontend Next.js khởi động được trên máy phát triển. **Port minh họa**: Backend `http://localhost:3001`, Frontend `http://localhost:3000`; kiểm tra thực tế trước khi sử dụng.
- Có database **test/disposable**, không chạy trên database sản xuất/chung của nhóm. Đã migrate/seed theo đúng quy trình và có Customer/Order phục vụ demo.
- Đã được cấp merchant VNPay **Sandbox**: `vnp_TmnCode`, `vnp_HashSecret`/secret key và quyền cấu hình IPN URL. Nếu secret từng bị lộ, **rotate trước khi tích hợp** (Decision Log §3).
- Có công cụ tunnel HTTPS công khai tạm thời cho IPN, hoặc một endpoint HTTPS ổn định được nhóm kiểm soát.
- Đã xác nhận backend **thực sự implement** provider VNPay, initiation, IPN và trạng thái Order/Payment trước khi thử thanh toán. Chỉ có tài liệu hoặc endpoint Swagger không có nghĩa là đã tích hợp.

### 3.2. Xác minh Backend local và phân biệt Mock/VNPay

Chạy trong Git Bash (đường dẫn theo workspace hiện tại của thành viên):

```bash
cd backend
npm ci
npm run db:validate
npm run db:generate
npm run start:dev
```

Từ thư mục gốc repository, mở terminal khác và kiểm tra cổng Backend (`PORT=3001` trong template được cung cấp; xác nhận cấu hình thực tế):

```bash
curl -i http://localhost:3001
```

Phản hồi `404` tại `/` vẫn có thể cho thấy server đang chạy; **không** đủ xác nhận API VNPay. `POST /payments` đã được chứng minh trong source là Mock Phase 1 (JWT + `Idempotency-Key` 8–64 ký tự, DTO CARD/WALLET, HTTP 200 SUCCESS/FAILED). Không dùng API Mock để thử VNPay redirect. Dùng endpoint health thực tế hoặc Swagger để xác minh controller. Nếu dự án chạy Docker, dùng `docker compose` theo README và xác nhận port mapping thay vì mặc định 3001.

### 3.3. Biến môi trường mẫu an toàn

**Đã xác minh từ `.env.example` gửi kèm (tên biến đang tồn tại):**

| Tên biến | Vai trò theo comment trong file | Ghi chú |
|---|---|---|
| `DATABASE_URL` | PostgreSQL cho Backend | Giữ bí mật URL có password; không chép giá trị thực vào tài liệu |
| `PORT` | Port Backend; mẫu hiện là `3001` | Port được khai báo; chưa đối chiếu `main.ts` |
| `JWT_SECRET` | Khóa JWT | Tạo ngẫu nhiên và lưu cục bộ, không commit |
| `INTERNAL_SECRET` | Khóa API chuyển trạng thái Order nội bộ | Khác JWT và VNPay HashSecret |
| `ORDER_EXPIRATION_ENABLED` | Bật/tắt background expiration | Mẫu hiện là `true`; chưa kiểm chứng Scheduler source |
| `ORDER_EXPIRATION_BATCH_SIZE` | Giới hạn batch quét | Mẫu hiện là `50` |
| `AUTH_TEST_DATABASE_URL`, `ORDERS_TEST_DATABASE_URL` | Các URL database kiểm thử riêng | Không sử dụng database chung/production cho SIT |

**Config names:** Template Backend được cung cấp chưa chứa `VNPAY_*`; Contract v4.0 khóa chính sách Mock nhưng không tự xác nhận tất cả tên biến. Đối chiếu tên thực tế của từng key với `backend/src` trước khi chạy. Với Next.js, `NEXT_PUBLIC_API_URL` là **địa chỉ Backend công khai với browser** (không chứa secret).

> **CẢNH BÁO:** Tên `VNPAY_*`, `PAYMENT_PROVIDER` dưới đây là ví dụ cấu hình, **không** phải bằng chứng Backend đang đọc các key đó. `MOCK_PAYMENT_ENABLED` là tên policy trong Contract v4.0 nhưng vẫn cần VERIFY implementation. Không đưa secret thật vào tài liệu/Git.

```dotenv
# EXAMPLE ONLY – not a verified BrewLite configuration contract
PAYMENT_PROVIDER=VNPAY
MOCK_PAYMENT_ENABLED=false
VNPAY_ENVIRONMENT=sandbox
VNPAY_TMN_CODE=<sandbox-merchant-id-from-secret-manager>
VNPAY_HASH_SECRET=<inject-locally-never-commit>
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_QUERYDR_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=http://localhost:3000/order-confirmation
VNPAY_IPN_URL=https://<temporary-tunnel-host>/payments/vnpay/ipn
```

**`frontend/.env.local`** (browser-visible, không đặt secrets):

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
```

**Giải thích:**

| Cấu hình minh họa | Vai trò | Công khai? |
|---|---|---|
| `VNPAY_ENVIRONMENT` | Chỉ Sandbox trong Phase 2 | Tên và giá trị môi trường có thể public |
| `VNPAY_TMN_CODE` | Merchant identity VNPay cấp | Không commit giá trị cấu hình merchant của nhóm nếu chưa được phép |
| `VNPAY_HASH_SECRET` | Key ký/xác minh HMAC-SHA512 | **Tuyệt đối không** commit, gửi chat, xuất Swagger hoặc log |
| `VNPAY_PAYMENT_URL` | Gateway browser redirect | URL Sandbox chính thức có thể công khai |
| `VNPAY_QUERYDR_URL` | Server-to-server QueryDR POST | URL Sandbox chính thức có thể công khai |
| `VNPAY_RETURN_URL` | Browser quay về frontend | Chỉ định route đã thực sự tồn tại |
| `VNPAY_IPN_URL` | Gateway gọi public HTTPS vào NestJS | Phải đăng ký/cấu hình với VNPay; không nhất thiết là tham số trong Payment URL |
| `MOCK_PAYMENT_ENABLED` | Policy do backend kiểm soát | Bị vô hiệu trong production, không nhận quyết định từ frontend |

Không đặt giá trị thật vào file hướng dẫn, `.env.example`, `NEXT_PUBLIC_*`, `Dockerfile`, screenshot, README hoặc GitHub Issues. `.env` thật phải được ignore; nếu bị lộ, rotate secret và xử lý lịch sử Git phù hợp, không chỉ xóa dòng ở commit mới.

### 3.4. Điều kiện đúng khi tạo URL thanh toán

Theo tài liệu VNPay PAY v2.1.0:

- Gateway URL Sandbox: `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html`.
- `vnp_Version=2.1.0`, `vnp_Command=pay`, `vnp_CurrCode=VND` và các trường bắt buộc theo tech spec.
- `vnp_Amount = totalVnd * 100`, xuất phát từ Order đã lưu **trên backend**, không dùng amount do browser gửi. Ví dụ Order 50.000 VND ⇒ `vnp_Amount=5000000`.
- `vnp_CreateDate` và `vnp_ExpireDate` theo định dạng `yyyyMMddHHmmss`, múi giờ VNPay quy định **GMT+7**; dùng timestamp có timezone rõ ràng, không trộn UTC-naive với giờ Việt Nam.
- `vnp_TxnRef` là duy nhất cho từng attempt và liên kết được với bản ghi Payment Attempt; không tái sử dụng khi retry.
- `vnp_ExpireDate` phải **không muộn hơn** `Order.expiresAt` theo BR-03. Nếu thời lượng tối thiểu của gateway mâu thuẫn với thời gian Order còn lại, **không tự gia hạn Order**; cần xác minh hành vi Sandbox và đưa vướng mắc ra review thiết kế.
- Tạo HMAC-SHA512 dựa trên chuỗi tham số và encoding/canonicalization **đúng đặc tả VNPay**; không dùng `JSON.stringify` hay thứ tự key tùy ý để ký.
- Sau khi backend persist Attempt PENDING và trả URL hợp lệ, frontend mới redirect; **chỉ dùng `https://sandbox.vnpayment.vn/...`** làm đích thanh toán, tránh open redirect tới domain tùy ý.
- VNPay PAY có mức thanh toán tối thiểu được tài liệu FAQ nêu là **5.000 VND**; không thử gửi đơn 0 VND lên gateway. Nếu số dương dưới mức cổng hỗ trợ, cần xác nhận chính sách sản phẩm với owner, không tự coi là ZERO_AMOUNT.

## 4. Mở public HTTPS IPN tới Backend local

### 4.1. Vì sao cần tunnel?

`localhost:3001` trên laptop chỉ máy đó truy cập được. VNPay server **không thể gọi** `http://localhost:3001/payments/vnpay/ipn`. BR-04 yêu cầu callback HTTPS công khai. Dùng tunnel cho **môi trường demo/test**, không dùng quick tunnel để vận hành production.

**Cách minh họa: Cloudflare Quick Tunnel** (không cần tên miền hoặc tài khoản Cloudflare, nhưng cần cài `cloudflared`):

1. Cài `cloudflared` Windows từ trang chính thức: https://developers.cloudflare.com/tunnel/downloads/; kiểm tra `cloudflared --version`.
2. Khởi động Backend trên port đã xác nhận (ví dụ 3001).
3. Mở một Git Bash khác và chạy:

```bash
cloudflared tunnel --url http://localhost:3001
```

4. Terminal trả một địa chỉ HTTPS **ngẫu nhiên**, ví dụ minh họa `https://<generated>.trycloudflare.com` (đây **không phải** địa chỉ cố định của nhóm).
5. Cấu hình IPN công khai thành `https://<generated>.trycloudflare.com/payments/vnpay/ipn` tại **nơi đăng ký IPN URL với VNPay** theo tài khoản Sandbox hoặc theo hướng dẫn hỗ trợ merchant. Đồng bộ cấu hình Backend nếu code có tham số tương ứng.
6. Để tunnel và Backend chạy trong suốt lúc kiểm thử. Nếu khởi động lại quick tunnel, hostname có thể đổi; khi đó phải cập nhật IPN URL đã đăng ký.

**Kiểm tra đường đi HTTPS:**

```bash
curl -i 'https://<generated>.trycloudflare.com/payments/vnpay/ipn'
```

Không có chữ ký hợp lệ, endpoint phải **không cập nhật dữ liệu**. Tùy hợp đồng IPN, backend có thể trả HTTP 200 kèm JSON `RspCode` lỗi (ví dụ lỗi chữ ký/thiếu tham số), không nhất thiết HTTP 401. Nếu trả `404`, cần kiểm tra route; nếu `502`, kiểm tra backend/port. **Không dùng request `curl` thủ công này để giả làm callback VNPay thành công.**

**Lưu ý bảo mật:** Quick Tunnel tạo đường dẫn công khai vào local Backend; ai biết URL đều có thể gọi các API được expose. Chỉ dùng database test, giữ JWT/ownership/validation, giới hạn CORS đúng nguồn và ngừng tunnel sau demo. Không bảo vệ IPN bằng login/challenge mà VNPay không vượt qua được; xác thực IPN bằng signature và các kiểm tra nghiệp vụ. Tránh log toàn bộ query URL nếu chứa dữ liệu giao dịch nhạy cảm.

### 4.2. Nếu dùng tunnel khác (ngrok, stable domain)

Có thể sử dụng ngrok hay tên miền HTTPS do nhóm quản lý; cần xác nhận policy đăng ký IPN và bất kỳ điều kiện allowlist/SSL của VNPay. Mọi lựa chọn phải đáp ứng: **HTTPS public, host ổn định trong phiên test, chuyển tiếp đúng backend port, endpoint không đòi JWT**, và không làm thay đổi quy tắc ký/verify IPN.

## 5. Phân biệt Return URL, IPN và QueryDR

| Đặc điểm | Return URL | IPN URL | QueryDR |
|---|---|---|---|
| Ai gọi? | Trình duyệt Customer bị redirect | Server VNPay → Backend Merchant | Backend Merchant → VNPay |
| Endpoint ở BrewLite | `/order-confirmation` (đối chiếu `frontend/app/order-confirmation/page.tsx` và callback navigation) | `GET /payments/vnpay/ipn` đã chốt | Internal service, **không tự tạo public endpoint** |
| Cần Customer JWT? | Không giả định; Frontend dùng session và API riêng để xem Order | **Không** | Không có Customer JWT trong request server-to-server |
| Bảo mật | Không tin query string là quyết định cuối cùng | HMAC-SHA512 + merchant + TxnRef + amount + trạng thái | Ký request, verify response, đối chiếu TransactionStatus |
| Tác dụng chính | Hiển thị chờ/hoàn tất theo trạng thái server | Cập nhật finalization idempotent sau xác minh | Đối soát khi IPN chưa đủ/đến muộn |
| Có thể tự xác nhận PAID? | **Không** | Có, nhưng chỉ sau verify và commit | Có, sau verify và finalization chung |

**Return URL:** Nếu `vnp_ResponseCode` trong URL browser báo `00` nhưng Payment chưa được backend verify, frontend **hiển thị “Đang xác minh thanh toán”**, không tự xóa giỏ hoặc báo `PAID`. Frontend phải dùng **`GET /payments/:paymentId/status` (API-03)** với JWT để đọc sự thật từ server, hoặc `GET /orders/me` cho History. `resolution`/`requiresReview` và `canRetry` được suy ra từ DB trên toàn Order; URL Return chỉ là navigation signal, tuyệt đối không tự xác nhận SUCCESS/FAILED.

**IPN:** VNPay gọi `GET /payments/vnpay/ipn` qua HTTPS; backend verify chữ ký, `vnp_TmnCode`, `vnp_TxnRef` → saved Attempt, `vnp_Amount` khớp `totalVnd × 100`, cùng `vnp_ResponseCode=00` **và** `vnp_TransactionStatus=00` mới xem xét SUCCESS. Finalization phải khoá/đọc lại và commit an toàn; trả JSON `RspCode`, `Message` theo spec. Với IPN đã được xử lý, trả mã *already processed* theo VNPay; không nhân đôi side effects.

**QueryDR:** Gọi `POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction` với `vnp_Command=querydr`, ký request theo spec và verify chữ ký response. **`vnp_ResponseCode=00` chỉ là trạng thái xử lý yêu cầu QueryDR**, không tự chứng minh Payment SUCCESS; phải xét `vnp_TransactionStatus` và các trường đối chiếu. Không giữ transaction DB mở trong lúc HTTP QueryDR.

### 5.1. IPN retry từ VNPay

Theo trang VNPay PAY: mã IPN merchant trả `RspCode=00` hoặc `02` là trường hợp VNPay coi đã xử lý; các mã `01`, `04`, `97`, `99` hoặc timeout có thể kích hoạt retry. VNPay mô tả tối đa 10 lần, khoảng cách 5 phút trong tài liệu tham khảo. **Không** thiết kế nghiệp vụ dựa trên việc IPN nhất định sẽ tới đúng một lần; phải idempotent và sử dụng QueryDR khi thiếu thông tin.

### 5.2. Order và Payment là hai state machine riêng

| Thời điểm / kết quả | Order | VNPay Attempt | Quy tắc |
|---|---|---|---|
| Trước `expiresAt` | PENDING (hoặc trạng thái hợp lệ theo state machine) | PENDING | Không tạo thêm VNPay PENDING; Customer chờ gateway |
| Đạt `expiresAt`, không có VNPay PENDING | Scheduler CANCELLED/release | Không có PENDING VNPay | Release stock/coupon đúng một lần |
| Đạt `expiresAt`, còn VNPay PENDING | Vẫn active trong Grace 5 phút | PENDING | Chặn attempt mới, không tạo Order active thứ hai |
| Đã có bằng chứng SUCCESS hợp lệ, thanh toán thực hiện không muộn hơn expiresAt, verify trong Grace | Có thể PAID nếu chưa CANCELLED và mọi invariant còn đúng | SUCCESS sau finalization | Consume coupon/cộng Loyalty đúng một lần |
| Kết thúc Grace chưa rõ kết quả | Scheduler CANCELLED/release tại lần quét hợp lệ | Vẫn có thể PENDING | Tiếp tục QueryDR; không tự đánh FAILED |
| SUCCESS xác minh sau khi Order đã CANCELLED | **Không hồi sinh PAID** | Lưu bằng chứng/ngoại lệ | Không consume coupon, cộng điểm hay tự refund |

**Reconciliation schedule (BR-05):** kích hoạt khi `expiresAt` với VNPay PENDING; trong Grace tiếp tục IPN/QueryDR; **sau Grace**, đối soát mỗi 10 phút, tối đa trong 60 phút. Sau cửa sổ này vẫn chưa rõ thì đánh dấu **manual review**, không tự ghi FAILED. Scheduler/QueryDR phải chống chạy trùng và rate-limit.

## 6. Hướng dẫn chạy thử một giao dịch Sandbox

> **GATE:** Contract v4.0 định nghĩa đầy đủ API-01…API-07. Trước khi đánh dấu giao dịch Sandbox PASS, phải xác minh controller thực thi, merchant credentials, IPN tunnel, finalization, QueryDR và kết quả E2E trên branch đang chạy; guide không thay thế bằng chứng tích hợp.

> **Điều kiện:** các route/DTO VNPay Phase 2 phải được implement và review; đã cấu hình merchant Sandbox, ký request, Return URL, public HTTPS IPN; có dữ liệu test. Phần dưới theo đường dẫn API Contract v4.0; request/response và lỗi thực tế vẫn phải kiểm tra với code/current branch.

1. **Chuẩn bị backend và dữ liệu test:** chạy NestJS, PostgreSQL, Frontend, tunnel; xác nhận Swagger và log khởi động. Chỉ dùng Customer demo, không dùng dữ liệu thật.
2. **Đăng nhập:** thực hiện `POST /auth/login` để nhận JWT (API Phase 1 đã có). Không đưa JWT vào ảnh hoặc tài liệu; ở Swagger chỉ paste token cục bộ.
3. **Tạo Order:** dùng API tạo Order đã có trong contract (`POST /orders`) với sản phẩm còn tồn. Kiểm tra Order của đúng Customer, totalVnd **lớn hơn 0 và đáp ứng ngưỡng tối thiểu của VNPay**, trạng thái chờ, `expiresAt` còn đủ thời gian. Không nhận tổng từ Frontend.
4. **Khởi tạo VNPay:** gọi `POST /payments/vnpay/initiate` với JWT, `Idempotency-Key` duy nhất và body `{ "orderId": "<UUID>" }` cho Order của chính Customer. Backend phải kiểm tra Order và provider, lưu Attempt PENDING/TxnRef, rồi cấp payment URL phù hợp. Nếu cùng key/payload được gửi lại do network timeout, backend phải nhận ra attempt cũ, không tạo attempt thứ hai.
5. **Redirect:** mở payment URL đã được Backend cấp trên browser. URL phải thuộc domain Sandbox chính thức và còn hạn theo Order. Không tự tạo/ký URL trên Frontend.
6. **Nhập dữ liệu thẻ test:** chỉ dùng **dữ liệu công khai do VNPay cấp** tại https://sandbox.vnpayment.vn/apis/vnpay-demo/; không dùng thẻ hay tiền thật. Không ghi OTP/card details vào repo hay screenshot share public.
7. **Return URL:** browser trở về `/order-confirmation` (đối chiếu route `frontend/app/order-confirmation/page.tsx`). URL chỉ báo điều hướng; FE dùng Payment ID từ state đáng tin cậy để gọi `GET /payments/:paymentId/status` với JWT; trong `PROCESSING/RECONCILING` giữ thông báo đang xác minh. Không tự ghi PAID/FAILED dựa vào `vnp_ResponseCode` của URL.
8. **Xác minh callback:** xem log Backend **đã lọc bí mật**, xác nhận IPN đã được verify và finalization commit. Nếu không có IPN, sử dụng QueryDR theo scheduler/chính sách (không tự cập nhật bằng tay để làm cho demo PASS).
9. **Đối chiếu:** kiểm tra Payment/Order trạng thái cuối, coupon HELD→CONSUMED nếu PAID, loyalty cộng một lần, stock không bị trừ thêm và thông tin History/Confirmation đúng snapshot. Không đưa DB credential/token vào bằng chứng.
10. **Chạy lại trường hợp replay:** kiểm tra request cùng key và IPN/QueryDR lặp không tạo Attempt hoặc Payment SUCCESS mới; không tiêu thụ coupon/loyalty/stock lặp.

### 6.1. Kịch bản đặc biệt phải có

- **Payment URL hoặc kết nối timeout:** Attempt chưa biết kết quả vẫn PENDING; không tự FAILED, không auto-fallback Mock.
- **VNPay FAILED cuối cùng được xác minh:** nếu Order còn hạn và đủ điều kiện, chuyển xử lý theo state machine để Customer có thể retry; retry dùng key/TxnRef mới. Nếu Order đã hết hạn, xử lý CANCELLED/release theo BR-03.
- **Zero-VND Order:** Order totalVnd = 0 → backend xử lý `ZERO_AMOUNT` nội bộ, **không gọi VNPay** và cộng 0 loyalty.
- **Late SUCCESS sau CANCELLED:** chỉ lưu bằng chứng và flag exception; không tự hồi sinh Order hoặc tự refund.
- **IPN sai chữ ký, sai amount, sai merchant hoặc không tìm thấy TxnRef:** từ chối thay đổi nghiệp vụ; trả mã IPN phù hợp theo spec.

## 7. VNPay SIT Testing – cách dùng và checklist

**SIT Status:** `NOT VERIFIED` trong tài liệu này; cần log test Sandbox của branch hiện tại trước khi ghi PASS. Không đánh dấu PASS các case VNP-01 đến VNP-20 chỉ vì Mock tests đã chạy được.

**SIT (System Integration Testing)** nhằm kiểm tra hành vi kết nối của Merchant với VNPay, khác với Unit Test Mock trong BrewLite. VNPay có mục tải **“Kịch bản test case - SIT”** tại https://sandbox.vnpayment.vn/apis/downloads/. Hãy dùng mẫu SIT mới nhất do VNPay cấp cho merchant và đối chiếu phiên bản API PAY. Không tự coi bảng kiểm thử dưới đây là biên bản SIT đã được VNPay xác nhận.

Ghi bằng chứng cho mỗi case: **Test ID, thời điểm (Asia/Ho_Chi_Minh), Order ID đã ẩn bớt, TxnRef đã ẩn bớt, Attempt status, Order status, IPN/QueryDR outcome, screenshot không có secrets, DB assertion và PASS/FAIL**.

| ID | Kịch bản SIT / Integration | Kết quả mong đợi |
|---|---|---|
| VNP-01 | Initiation JWT hợp lệ, Order chính chủ còn hạn | Attempt PENDING, TxnRef mới, URL Sandbox hợp lệ |
| VNP-02 | Request thiếu JWT / Order của người khác | Từ chối đúng contract; không tạo attempt |
| VNP-03 | Initiation replay cùng Idempotency-Key + payload | Nhận diện attempt cũ; không duplicate |
| VNP-04 | Cùng key khác payload | Từ chối an toàn; không thay đổi dữ liệu |
| VNP-05 | Key khác khi đã có VNPay PENDING | Không tạo PENDING thứ hai |
| VNP-06 | Browser redirect và Return URL thành công nhưng backend chưa verify | UI “Đang xác minh”; không tự PAID |
| VNP-07 | IPN thành công với chữ ký/merchant/ref/amount hợp lệ | Một Payment SUCCESS, Order PAID nếu đủ điều kiện, side effects một lần |
| VNP-08 | IPN HMAC sai/merchant sai/amount sai/TxnRef lạ | Không mutate nghiệp vụ; phản hồi IPN theo spec |
| VNP-09 | VNPay gọi lại IPN đã xử lý | Already processed/idempotent, không nhân đôi side effects |
| VNP-10 | QueryDR xác minh kết quả (kể cả khi IPN đã xử lý trước) | Verify request/response; shared finalization, không ghi đè terminal |
| VNP-11 | QueryDR `ResponseCode=00`, `TransactionStatus` chưa thành công | Không coi là Payment SUCCESS |
| VNP-12 | Gateway timeout / Payment URL hết hạn | Không tự đổi Payment thành FAILED, phải reconciliation |
| VNP-13 | Retry sau FAILED cuối cùng, Order còn hạn | New key + TxnRef, không giữ tồn/coupon lần hai |
| VNP-14 | Order expiresAt, có VNPay PENDING | Grace 5 phút, active, không order/attempt mới |
| VNP-15 | Qua cuối Grace vẫn chưa rõ kết quả | CANCELLED/release một lần; attempt có thể PENDING |
| VNP-16 | Late SUCCESS sau Order CANCELLED | Lưu ngoại lệ; không hồi sinh PAID, không auto-refund |
| VNP-17 | ZERO_AMOUNT | Không gateway call; Payment SUCCESS 0 VND, loyalty +0 |
| VNP-18 | Mock bị tắt / provider fallback khi VNPay unknown | Không thể tự chuyển Mock, không side effects |
| VNP-19 | Scheduler/IPN/QueryDR chạy cạnh tranh | Bảo toàn duy nhất SUCCESS, stock/coupon/loyalty |
| VNP-20 | Bất kỳ lỗi HTTP gateway giữa tiến trình | Không giữ DB transaction qua HTTP, có hướng reconcile |

**SIT Evidence:** Không ghi PASS cho case khi mới có lệnh/script hoặc mock; cần log/test result từ Sandbox hoặc kiểm thử integration trên database disposable. Khi gặp case không thể thực hiện vì thiếu endpoint/merchant credentials, đánh dấu **BLOCKED**, không tự sửa test kỳ vọng.

## 8. Checklist bảo mật và vận hành

Trước khi mở tunnel/giao dịch:

- [ ] VNPay chạy **Sandbox**; chưa bật production; đã có merchant credentials phù hợp với domain/ứng dụng thử.
- [ ] HashSecret từng lộ đã được **rotate** và xác nhận credential mới trong hệ thống secret cục bộ.
- [ ] `.env` thật, token, card details, cookies, API keys không được commit, chụp ảnh chia sẻ hay ghi vào log; `.gitignore` bảo vệ được file chứa secret.
- [ ] Backend ký chính xác HMAC-SHA512 theo spec, verify bằng phép so sánh an toàn thích hợp, reject callback sai.
- [ ] `vnp_TmnCode`, `TxnRef`, `vnp_Amount`, payment time và status được kiểm tra trước khi mutate.
- [ ] IPN HTTPS public, không Customer JWT; callback chỉ tin sau xác minh đầy đủ.
- [ ] Không dùng Return URL để tự cập nhật `PAID`/cộng Loyalty.
- [ ] `totalVnd` lấy từ Order snapshot, `vnp_Amount` chuyển đúng ×100 và không âm.
- [ ] Không sinh attempt mới khi VNPay PENDING, không auto-fallback Mock.
- [ ] Một Payment SUCCESS tối đa/Order qua mọi provider; xử lý IPN/QueryDR/replay an toàn.
- [ ] Grace 5 phút không gia hạn quyền trả tiền; late SUCCESS ghi nhận để đối soát.
- [ ] Không chạy tunnel trên database chung/production, không cho Quick Tunnel hoạt động ngoài giờ test.
- [ ] Không bật debug logging lộ full URL có checksum, header Authorization, raw callback hoặc secret.
- [ ] Manual refund / xử lý tiền thật **ngoài phạm vi Phase 2**.

## 9. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Hướng xử lý an toàn |
|---|---|---|
| Không tạo được Payment URL | Thiếu cấu hình merchant, chữ ký sai, Order hết hạn/không thuộc Customer | Kiểm tra config key **bằng trạng thái có/không**, Order/TTL và canonicalization; không in secret |
| VNPay trả lỗi signature | Sai thứ tự trường, encoding, secret merchant khác, ký sai version | Đối chiếu tech spec 2.1.0; verify TmnCode và canonical string bằng dữ liệu đã redacted |
| Gateway không gọi IPN | Đăng ký hostname cũ, tunnel tắt, DNS/HTTPS, sai route/port | Kiểm tra callback URL trong merchant config, `cloudflared` terminal, HTTP response công khai |
| Tunnel có URL nhưng callback trả 502 | Backend local tắt hoặc chọn sai port | `curl` local, xem port binding, khởi động lại server; không vô hiệu verify để thử |
| IPN trả 401 | Bị áp Customer JWT Guard nhầm | Public route có kiểm soát, verify chữ ký/merchant thay JWT |
| IPN trả 404 | Sai path `GET /payments/vnpay/ipn`, prefix hoặc controller chưa implement | Đối chiếu `main.ts`, controller và URL merchant; không tự đổi route đã Approved |
| IPN trả JSON `RspCode` lỗi | Chữ ký, ref, amount, trạng thái không hợp lệ hoặc lỗi DB | Đọc log đã ẩn thông tin, so sánh dữ liệu đã lưu; **không** trả mã thành công giả |
| Browser Return báo thành công nhưng UI chờ | IPN chậm/mất, QueryDR chưa có kết quả | Poll/read trạng thái server theo API đã duyệt; giữ PENDING và reconcile |
| Sau timeout tạo attempt trùng | FE sinh key mới khi initiation cũ chưa rõ, backend thiếu unique/lock | Replay đúng key; enforce tối đa 1 PENDING/Order; integration test race |
| Gateway báo lỗi thời gian/URL hết hạn | Lệch timezone, `vnp_ExpireDate > order.expiresAt`, tạo URL sát TTL | Dùng Asia/Ho_Chi_Minh, timestamp chuẩn; **không** gia hạn Order để né lỗi |
| QueryDR trả `ResponseCode=00` nhưng thanh toán chưa hoàn tất | Nhầm request status với transaction status | Kiểm tra `vnp_TransactionStatus`, signature, ref, amount; không tự SUCCESS |
| Duplicate IPN cộng điểm hai lần | Finalization thiếu khóa/unique/idempotency | Rà DB transaction, unique SUCCESS/Order; không sửa dữ liệu production bằng tay |
| Merchant không cho đăng ký IPN URL ngẫu nhiên | Sandbox merchant cần domain/cấu hình ổn định | Dùng tên miền HTTPS test cố định do nhóm quản lý hoặc liên hệ VNPay Sandbox support |

## 10. Checklist VERIFY trước khi chạy theo current `dev`

Kiểm tra route `frontend/app/order-confirmation/page.tsx` và phương thức nhận Payment ID an toàn; không tin thông tin thanh toán do Return URL đưa lên. Kiểm tra `frontend/.env.local` chứa `NEXT_PUBLIC_API_URL` trỏ tới Backend, không chứa secrets.

Trong repository root, dùng **đường dẫn tương đối**:

```bash
# Git Bash – chạy khi đã đứng ở repository root
cd backend
npm ci
npm run db:validate
npm run db:generate
npm run start:dev
```

```powershell
# PowerShell – chạy khi đã đứng ở repository root
Set-Location backend
npm ci
npm run db:validate
npm run db:generate
npm run start:dev
```

Trong một terminal riêng từ repository root, frontend chạy bằng `cd frontend` (Git Bash) hoặc `Set-Location frontend` (PowerShell), cấu hình `NEXT_PUBLIC_API_URL=http://localhost:3001` trong `frontend/.env.local`, sau đó `npm ci` và `npm run dev`. Cổng chỉ là ví dụ cho môi trường local được kiểm tra.

Đường dẫn tài liệu hiện tại trong Git: `docs/integration/VNPay_Sandbox_Setup.md`. Nguồn Contract v4.0 trong Git: `docs/api/BrewLite_API_Contract_v4.0.md`.

**Các cổng chưa khẳng định PASS:** triển khai đầy đủ API-01/02/03/04, HMAC/IPN/QueryDR Sandbox, callback E2E, verification timestamp, merchant rate limit. Nếu chưa thể chạy, đánh dấu BLOCKED kèm lý do, không tự khẳng định thiếu thiết kế Phase 2 hoặc tự ghi PASS.

## 11. Tiêu chí bàn giao Guide PR #109

- [x] Cập nhật Contract v4.0, 3 API chủ chốt và public IPN.
- [x] Return URL là navigation signal; status đọc server truth qua API-03.
- [x] Dùng repo-relative commands; hướng dẫn Git Bash/PowerShell; `NEXT_PUBLIC_API_URL`.
- [x] Route `/order-confirmation` và self-path guide được nêu rõ.
- [x] Không ghi nhận SIT/merchant E2E là PASS khi chưa có bằng chứng.
- [ ] Reviewer đối chiếu tên biến VNPay thực tế trong `backend/src` và kết quả Sandbox/CI hiện hành.
- [ ] Technical review + approval PR #109.
