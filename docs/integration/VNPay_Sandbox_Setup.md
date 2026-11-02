# BrewLite – VNPay Sandbox Environment & Integration Guide

> **Document ID:** BL-GUIDE-VNPAY-SANDBOX-001
> **Phiên bản:** v1.3 – 02/11/2026 (runtime/implementation-gated review)
> **Task:** Phase 2 – Document VNPay Sandbox Integration Setup
> **Đường dẫn trong repository:** `docs/integration/VNPay_Sandbox_Setup.md`
> **Trạng thái:** **REVIEW CANDIDATE – IMPLEMENTED NOW / REQUIRED BEFORE E2E TÁCH RIÊNG; FULL VNPay E2E BLOCKED**
> **Phạm vi:** VNPay Sandbox trên NestJS Backend, Next.js Frontend và PostgreSQL; **không hướng dẫn kích hoạt production**.

## 1. Mục đích, nguồn và giới hạn

Tài liệu hướng dẫn thành viên BrewLite chuẩn bị môi trường, kiểm tra **những phần thực sự có thể chạy hiện tại** và chuẩn bị điều kiện để làm VNPay Sandbox E2E về sau mà không tiết lộ bí mật. Guide áp dụng cho thiết kế Phase 2 hiện tại. **API Contract v4.0 là nguồn của đường dẫn/DTO thiết kế, KHÔNG phải chứng cứ endpoint đã triển khai. Bảng trạng thái bên dưới dựa trên nhận xét review runtime của `dev` ngày 02/11/2026; người chạy phải đối chiếu lại source/Swagger/HTTP ở commit `dev` mới nhất trước khi cập nhật trạng thái.** Bản audit Payment Phase 1 cũ chỉ còn là nguồn tham khảo legacy Mock.

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

## 2. Thiết kế mục tiêu (KHÔNG phải flow E2E đang chạy) và các quy tắc

> **DESIGN ONLY – BLOCKED FOR END-TO-END:** Sơ đồ sau mô tả flow đích; IPN, Status API và QueryDR vẫn chưa được implement trên `dev` theo kết quả review hiện tại. Chỉ phần VNPay initiate có endpoint. Không dùng sơ đồ này làm minh chứng giao dịch đã hoàn tất.

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

### 2.1. Runtime readiness trên `dev` (snapshot theo reviewer 02/11/2026)

**Implemented now** chỉ khẳng định endpoint/component đã có trong source `dev` theo review; **không tự đồng nghĩa** với Sandbox transaction success, business validation PASS hay E2E readiness.

| Component | Runtime status | Có thể làm ngay? | Gate trước E2E |
|---|---|---|---|
| `POST /payments/vnpay/initiate` | **IMPLEMENTED NOW** | Có thể kiểm tra route, auth, request validation, attempt/URL generation trên database test, nếu cấu hình merchant hợp lệ | Vẫn cần verified IPN/finalization + server-truth read để xác nhận outcome |
| `GET /payments/:paymentId/status` | **NOT IMPLEMENTED / BLOCKED** | **Không gọi/poll** như API đang hoạt động | Implement owner auth + DB truth + projection rồi integration test |
| `GET /payments/vnpay/ipn` (public IPN) | **NOT IMPLEMENTED / BLOCKED** | **Không mở tunnel để test callback thật** khi chưa có handler | Implement route public không JWT, signature/merchant/amount validation, idempotent finalization + test |
| QueryDR client / scheduler | **NOT IMPLEMENTED / BLOCKED** | **Không chạy reconciliation QueryDR** | Implement signer, response verification, shared finalization, scheduled retries + test |
| `POST /payments/zero-amount` | **NOT IMPLEMENTED / BLOCKED** | **Không gọi API này** | Implement internal 0 VND finalization + idempotency + test |

**Required before E2E:** 4 phần `Status`, `IPN`, `QueryDR` và `ZERO_AMOUNT` cần các task tương ứng hoàn thiện và có test. Đặc biệt Status/IPN/QueryDR là các dependency để xác nhận VNPay payment outcome an toàn; ZERO_AMOUNT là nhánh nghiệp vụ độc lập cần test riêng trước khi tuyên bố phạm vi Phase 2 hoàn thành. Chưa có đủ dependency thì **E2E = BLOCKED**, không đánh dấu PASS.

### 2.2. Các route/luồng theo API Contract v4.0 — DESIGN, không phải danh sách route đã chạy

| API / thành phần | Contract v4.0 quy định | Runtime/gate |
|---|---|---|
| `POST /payments/vnpay/initiate` | JWT + `Idempotency-Key`, body `{ "orderId": "<UUID>" }`; 201 mới / 200 replay; attempt VNPay PENDING, URL Sandbox | **IMPLEMENTED NOW**; chỉ smoke/integration scope initiation, chưa chứng minh payment completed |
| `GET /payments/vnpay/ipn` | GET public không Customer JWT; verify HMAC-SHA512, merchant/TxnRef/amount; commit finalization mới ACK | **BLOCKED** – design only |
| `GET /payments/:paymentId/status` | JWT, ownership, server DB truth, `paymentStatus`, `orderStatus`, `resolution`, `requiresReview`, `canRetry` | **BLOCKED** – design only, không thể poll ngay |
| `POST /payments/zero-amount` | JWT + Idempotency-Key; Order 0 VND, SUCCESS nội bộ, không gọi gateway | **BLOCKED** – design only |
| `POST /payments` | Mock legacy theo policy, không auto-fallback từ VNPay PENDING | Legacy scope; verify source/gates riêng, không dùng chứng minh VNPay E2E |
| `GET /orders/me` | History additive theo Contract v4.0 | Đối chiếu runtime hiện tại; không thay thế Status API nếu thiếu outcome authoritative |
| QueryDR | Internal merchant → gateway POST, response signature & `vnp_TransactionStatus`, shared finalization | **BLOCKED** – design only; không có QueryDR client để chạy |

**Ví dụ Contract (không phải bằng chứng đã test hoặc yêu cầu bắt buộc chạy E2E):**

```http
POST /payments/vnpay/initiate
Authorization: Bearer <CUSTOMER_JWT>
Idempotency-Key: <UNIQUE_KEY_8_TO_64_CHARS>
Content-Type: application/json

{"orderId":"<ORDER_UUID>"}
```

Về thiết kế: initiation trả `paymentId`/`paymentUrl`, có replay cùng attempt; Status API tương lai sẽ đọc trạng thái từ DB và không gọi QueryDR trong request; ZERO_AMOUNT API tương lai xử lý Order 0 VND hoàn toàn nội bộ. **Không đưa ví dụ response dự kiến vào kết quả runtime PASS.**

### 2.3. Các điểm tích hợp bắt buộc (design requirements)

- Route IPN phải nhận request server-to-server **không Customer JWT**; các route customer vẫn dùng JWT và kiểm tra quyền sở hữu.
- Backend phải khóa Order theo thứ tự nhất quán, không gọi HTTP gateway trong transaction, dùng chung finalization cho IPN và QueryDR.
- Payment PENDING không tự thành FAILED do timeout. Kết thúc Grace, Order có thể CANCELLED còn Payment PENDING để reconciliation.
- Không lưu HashSecret, full raw callback, bearer token hoặc thẻ thật vào log/PR.
- `resolution`, `canRetry`, `requiresReview` là **API projection**, không phải PaymentStatus mới; exception phải xét evidence toàn Order.

## 3. Chuẩn bị môi trường

### 3.1. Điều kiện trước khi chạy

- Có Git, Node.js/npm phù hợp `backend/package.json` và PostgreSQL test/dev đang hoạt động. **Không** trỏ `DATABASE_URL` tới production hay DB chung của nhóm khi chưa được phê duyệt migration.
- Có merchant credentials VNPay **Sandbox** nếu kiểm tra bước initiation và URL ký. Không dùng credential thật/production; không commit `.env`.
- Full transaction E2E vẫn **BLOCKED** khi IPN, server Status và QueryDR chưa được triển khai; **không cần mở tunnel** ở bước fresh-clone.
- Port minh họa: Backend `http://localhost:3001`, Frontend `http://localhost:3000`. Xác minh `PORT`, route prefix và frontend router của bản `dev` đang dùng.

### 3.2. Fresh-clone database/backend: đúng thứ tự cấu hình → migrate → generate → start

**Git Bash — từ thư mục bất kỳ, clone `dev` mới nhất vào một thư mục mới** (hoặc chỉ `git fetch origin` và `git pull --ff-only origin dev` nếu đang ở local `dev` sạch):

```bash
git clone --branch dev https://github.com/brewlite-project/brewlite.git
cd brewlite/backend
npm ci

# Trong repository baseline được cung cấp, .env.example nằm tại repository root.
# Nếu dev mới nhất di chuyển file mẫu, xác định vị trí rồi mới copy.
cp ../.env.example .env
# EDIT backend/.env: thay DATABASE_URL bằng PostgreSQL test/dev thực tế.
# Giữ JWT_SECRET, INTERNAL_SECRET khác nhau và không commit .env.

npm run db:validate
npm run db:migrate       # package.json: prisma migrate deploy --config prisma7.config.ts
npx prisma migrate status --config prisma7.config.ts
npm run db:generate
npm run build            # optional readiness check; bắt lỗi compile trước khi start
npm run start:dev
```

**PowerShell — thực hiện tương đương trong một workspace fresh-clone:**

```powershell
git clone --branch dev https://github.com/brewlite-project/brewlite.git
Set-Location brewlite/backend
npm ci
Copy-Item ../.env.example .env
# EDIT backend/.env: DATABASE_URL must target an approved disposable/dev DB.
npm run db:validate
npm run db:migrate
npx prisma migrate status --config prisma7.config.ts
npm run db:generate
npm run build
npm run start:dev
```

**Database gate:** Chỉ chạy `npm run db:migrate` sau khi kiểm tra database name/host trong `backend/.env`, PostgreSQL sẵn sàng và tài khoản được phép migrate; `deploy` **không tạo database server tự động** và không được dùng để reset dữ liệu. `prisma7.config.ts` dùng `DATABASE_URL` từ môi trường/dotenv. Nếu migration báo drift, P1000/P1001, pending error hoặc schema không khớp, **dừng và xác minh** thay vì `migrate reset`, `db push` hoặc `migrate resolve` tùy tiện. `npm run db:generate` chạy **sau** migrate như checklist reviewer yêu cầu. Bước seed nếu cần demo: đối chiếu `backend/prisma/seed.ts` và chỉ chạy `npm run db:seed` trên database test sau khi được phép.

**Kiểm tra runtime hiện tại:** Dùng Swagger/source/controller ở commit `dev` mới nhất để xác nhận `POST /payments/vnpay/initiate`; chỉ test nó trên Order test còn hạn và merchant Sandbox hợp lệ. Chưa thể chạy GET Status, IPN callback, QueryDR hay ZERO_AMOUNT khi các route/client vẫn thiếu. Một response `404` tại `/` chỉ cho biết root chưa có handler, **không** xác nhận endpoint VNPay hoạt động.

### 3.3. Biến môi trường mẫu an toàn

**Đã xác minh từ `.env.example` được cung cấp (tên biến đang tồn tại trong snapshot; kiểm tra lại trên `dev` mới nhất):**

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

## 4. Required before E2E: public HTTPS IPN — **BLOCKED / FUTURE SETUP**

**Hiện tại KHÔNG thực hiện bước mở tunnel để test IPN**: theo reviewer, `GET /payments/vnpay/ipn` chưa implement. URL tunnel trả HTTPS 200/404/502 không chứng minh Backend xác minh chữ ký hoặc finalize Payment. Không đăng ký callback thật để coi như đã hoàn thành Phase 2.

Khi task IPN đã merge vào `dev` và có test signature/merchant/amount/idempotency, mới thực hiện checklist thiết kế sau trên **database test riêng**:

1. Xác nhận route `GET /payments/vnpay/ipn` có tồn tại trong source, không Customer JWT, và handler verify HMAC-SHA512 + merchant identity + TxnRef/amount/outcome trước DB finalization.
2. Chuẩn bị public HTTPS endpoint ổn định cho Merchant → Backend. Có thể dùng Cloudflare Quick Tunnel cho test ngắn hạn hoặc hostname HTTPS do nhóm quản lý; xác nhận VNPay merchant Sandbox chấp nhận địa chỉ đó. `localhost` không thể nhận callback từ VNPay server.
3. Đảm bảo tunnel chuyển tới đúng `PORT` backend, không phơi production/shared DB và không để tunnel chạy ngoài thời gian test.
4. Dùng kịch bản IPN hợp lệ/sai signature/duplicate với fixture test đã được review; xác nhận callback chỉ ACK sau commit và không tạo side effect trùng.
5. Chỉ sau khi IPN PASS mới bật testing redirect đầy đủ, kết hợp với server Status API và QueryDR khi task tương ứng đã sẵn sàng.

Thông tin đọc thêm, **chưa phải lệnh setup bắt buộc của runtime hiện tại**: [VNPay PAY/IPN](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [Cloudflare Download](https://developers.cloudflare.com/tunnel/downloads/). Không sử dụng curl tự ký hoặc query params của browser làm callback chứng minh SUCCESS.

## 5. Phân biệt Return URL, IPN và QueryDR

| Đặc điểm | Return URL | IPN URL | QueryDR |
|---|---|---|---|
| Ai gọi? | Trình duyệt Customer bị redirect | Server VNPay → Backend Merchant | Backend Merchant → VNPay |
| Endpoint ở BrewLite | `/order-confirmation` (cần xác minh route trên `dev`) | `GET /payments/vnpay/ipn` **DESIGN ONLY – NOT IMPLEMENTED** | Internal client **NOT IMPLEMENTED** |
| Cần Customer JWT? | Không giả định; Frontend dùng session và API riêng để xem Order | **Không** | Không có Customer JWT trong request server-to-server |
| Bảo mật | Không tin query string là quyết định cuối cùng | HMAC-SHA512 + merchant + TxnRef + amount + trạng thái | Ký request, verify response, đối chiếu TransactionStatus |
| Tác dụng chính | Hiển thị chờ/hoàn tất theo trạng thái server | Cập nhật finalization idempotent sau xác minh | Đối soát khi IPN chưa đủ/đến muộn |
| Có thể tự xác nhận PAID? | **Không** | Có, nhưng chỉ sau verify và commit | Có, sau verify và finalization chung |

**Return URL:** Nếu `vnp_ResponseCode` trong URL browser báo `00` nhưng Payment chưa được backend verify, frontend **hiển thị “Đang xác minh thanh toán”**, không tự xóa giỏ hoặc báo `PAID`. Theo thiết kế, Frontend **sẽ phải dùng** `GET /payments/:paymentId/status` (API-03) với JWT để đọc server truth. **Hiện route Status chưa implement**, nên không được trình bày việc polling là đã hoạt động. `GET /orders/me` nếu có thể dùng cho History theo runtime thì cũng **không mặc nhiên thay thế** payment-status proof/finalization còn thiếu. `resolution`/`requiresReview` và `canRetry` được suy ra từ DB trên toàn Order; URL Return chỉ là navigation signal, tuyệt đối không tự xác nhận SUCCESS/FAILED.

**IPN – REQUIRED BEFORE E2E, NOT IMPLEMENTED:** Khi được triển khai, VNPay gọi `GET /payments/vnpay/ipn` qua HTTPS; backend verify chữ ký, `vnp_TmnCode`, `vnp_TxnRef` → saved Attempt, `vnp_Amount` khớp `totalVnd × 100`, cùng `vnp_ResponseCode=00` **và** `vnp_TransactionStatus=00` mới xem xét SUCCESS. Finalization phải khoá/đọc lại và commit an toàn; trả JSON `RspCode`, `Message` theo spec. Với IPN đã được xử lý, trả mã *already processed* theo VNPay; không nhân đôi side effects.

**QueryDR – REQUIRED BEFORE E2E, CLIENT NOT IMPLEMENTED:** Khi được triển khai, backend gọi `POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction` với `vnp_Command=querydr`, ký request theo spec và verify chữ ký response. **`vnp_ResponseCode=00` chỉ là trạng thái xử lý yêu cầu QueryDR**, không tự chứng minh Payment SUCCESS; phải xét `vnp_TransactionStatus` và các trường đối chiếu. Không giữ transaction DB mở trong lúc HTTP QueryDR.

### 5.1. IPN retry từ VNPay (chỉ dùng để thiết kế/test sau khi implement)

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

**Reconciliation schedule (BR-05 – DESIGN ONLY, scheduler/client chưa implement):** kích hoạt khi `expiresAt` với VNPay PENDING; trong Grace tiếp tục IPN/QueryDR; **sau Grace**, đối soát mỗi 10 phút, tối đa trong 60 phút. Sau cửa sổ này vẫn chưa rõ thì đánh dấu **manual review**, không tự ghi FAILED. Scheduler/QueryDR phải chống chạy trùng và rate-limit.

## 6. Implemented now vs. Required before E2E: test plan tách biệt

### 6.1. Implemented now — chỉ smoke/integration cho `POST /payments/vnpay/initiate`

**Có thể chạy sau Bước 3.2**, nếu source/route trên `dev` mới nhất vẫn có initiation và đã được cấu hình merchant Sandbox:

1. Khởi động PostgreSQL test và Backend bằng fresh-clone guide; đối chiếu Swagger/controller để xác nhận `POST /payments/vnpay/initiate` cùng DTO/guard/Idempotency-Key hiện có.
2. Đăng nhập bằng Customer test, tạo Order test còn hạn có `totalVnd > 0`; token và URL có chữ ký không đưa vào log công khai.
3. Gửi `POST /payments/vnpay/initiate` theo contract với JWT, `Idempotency-Key` và `{ "orderId": "<UUID>" }`. Kiểm tra response/DB theo runtime thật: attempt PENDING, idempotency/replay, ownership, expiry, cấu hình Sandbox; ghi PASS chỉ cho case thực sự chạy.
4. Không tự tuyên bố Payment/Order đã SUCCESS/PAID. **Không test end-to-end thanh toán thực hoặc chuyển hướng đến bước xác nhận thành công** khi IPN và Status API chưa hoàn tất.
5. Có thể kiểm tra validation errors/replay cho initiation với database test, nhưng không coi đó là full VNPay SIT PASS.

### 6.2. Required before E2E — các task còn BLOCKED

| Dependency | Thực trạng theo reviewer | Khi nào được thử |
|---|---|---|
| Server-truth `GET /payments/:paymentId/status` | Chưa implement | Sau khi controller + ownership + projection + integration test merge |
| Public IPN `GET /payments/vnpay/ipn` | Chưa implement | Sau khi signature/correlation/finalization + HTTPS endpoint test merge |
| QueryDR client/scheduler | Chưa implement | Sau khi có signer/response validation + retry/scheduling + shared finalization |
| `POST /payments/zero-amount` | Chưa implement | Sau khi internal SUCCESS/loyalty/idempotency test merge |

**Future-only E2E checklist, KHÔNG chạy được hiện tại:**

- [ ] Thanh toán Sandbox từ initiation → gateway test card → Return URL hiển thị đang xác minh; **Return URL là navigation signal, không phải bằng chứng SUCCESS**.
- [ ] Public HTTPS IPN đã xác thực và commit finalization idempotently.
- [ ] Frontend gọi server Status API đã triển khai để đọc `Payment`/`Order` truth; chỉ báo `PAID` khi backend xác nhận.
- [ ] QueryDR được triển khai và dùng khi IPN thiếu/chậm; không suy SUCCESS từ `vnp_ResponseCode` đơn lẻ.
- [ ] ZERO_AMOUNT xử lý nội bộ, không gọi gateway và chỉ chạy sau khi endpoint được implement.
- [ ] Repeat, race, late-success, financial exception và reconciliation được kiểm tra trên DB disposable.

**Full VNPay E2E status hiện tại: BLOCKED (not tested / not PASS).**

## 7. VNPay SIT Testing – cách dùng và checklist

**SIT Status:** `BLOCKED` cho end-to-end hiện tại vì Status/IPN/QueryDR/ZERO_AMOUNT chưa implement; cần log test Sandbox của branch hiện tại trước khi ghi PASS. Không đánh dấu PASS các case VNP-01 đến VNP-20 chỉ vì Mock tests đã chạy được.

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

**SIT Evidence:** Các case VNP-01…05 chỉ có thể chuyển từ NOT RUN sang PASS khi đã có test result initiation thực tế; các case yêu cầu IPN/Status/QueryDR/ZERO_AMOUNT hiện **BLOCKED**. Không ghi PASS cho case khi mới có lệnh/script hoặc mock; cần log/test result từ Sandbox hoặc kiểm thử integration trên database disposable. Khi gặp case không thể thực hiện vì thiếu endpoint/merchant credentials, đánh dấu **BLOCKED**, không tự sửa test kỳ vọng.

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

## 10. Verification sau khi sync latest `dev`

Từ clone mới nhất của `dev`, xác minh controller/module thực tế, route prefix và thư mục `frontend` trước khi coi một route hoạt động. Trong `backend` dùng scripts hiện có trong `package.json`:

```bash
# Git Bash, sau khi vào repository root
cd backend
npm ci
# Configure backend/.env DATABASE_URL to test PostgreSQL first.
npm run db:validate
npm run db:migrate
npx prisma migrate status --config prisma7.config.ts
npm run db:generate
npm run build
npm run start:dev
```

```powershell
# PowerShell, sau khi vào repository root
Set-Location backend
npm ci
# Configure backend/.env DATABASE_URL to test PostgreSQL first.
npm run db:validate
npm run db:migrate
npx prisma migrate status --config prisma7.config.ts
npm run db:generate
npm run build
npm run start:dev
```

Frontend nếu cần khởi động được cấu hình trong `frontend/.env.local` với `NEXT_PUBLIC_API_URL=http://localhost:3001` (**không có secret**) và chỉ điều hướng `/order-confirmation` nếu route thực sự có trong source `dev` hiện tại. **Do chưa có Status API, giao diện không được lấy query của Return URL để tự coi thanh toán SUCCESS.**

Tài liệu tự tham chiếu: `docs/integration/VNPay_Sandbox_Setup.md`. API design: `docs/api/BrewLite_API_Contract_v4.0.md` (đối chiếu vị trí thực tế trong `dev`). Không dùng bản tài liệu cũ như bằng chứng API đã implement.

## 11. Tiêu chí bàn giao – PR #121: VNPay Sandbox Setup Guide

- [x] Phân biệt **Implemented now** (VNPay initiate) với **Required before E2E / BLOCKED** (Status, public IPN, QueryDR, ZERO_AMOUNT) theo review runtime 02/11/2026.
- [x] Các phần IPN/Status/QueryDR/ZERO_AMOUNT được viết như **design/future tasks**, không phải setup steps chạy ngay.
- [x] Fresh-clone: `DATABASE_URL` → `npm run db:migrate` → `npm run db:generate` → `npm run start:dev`, có `migrate status` và kiểm tra target DB.
- [x] Secrets/env và Return URL trust boundary được giữ nguyên; Return URL không được quyết định success.
- [x] Bỏ tham chiếu PR cũ; thay tiêu chí/tên PR đúng scope **PR #121 – VNPay Sandbox Setup Guide**.
- [ ] Thực hiện `git fetch origin && git merge origin/dev` (hoặc rebase có chủ đích) trên branch VNPay Setup **trước khi commit/push**. Việc sync remote phải do người có repo access thực hiện; file này không xác nhận đã sync.
- [ ] Reviewer kiểm tra runtime implementation tại commit `dev` hiện hành; chỉ thay đổi cột status khi có route/source/test chứng minh.
- [ ] PR #121 được review và approve; E2E remains BLOCKED until implementation tasks merge.
