# BrewLite – VNPay Sandbox Environment & Integration Guide

> **Document ID:** BL-GUIDE-VNPAY-SANDBOX-001  
> **Phiên bản:** Draft v1.1 – 30/10/2026 (đối chiếu `payments.zip` và `.env.example`)  
> **Task:** Phase 2 – Document VNPay Sandbox Integration Setup  
> **Đường dẫn trong repository:** `docs/integration/VNPay_Sandbox_Setup.md`  
> **Trạng thái:** **DRAFT / ĐÃ KIỂM TRA PAYMENT PHASE 1; VNPay PHASE 2 CHƯA CÓ TRONG SOURCE ĐƯỢC CUNG CẤP** / Chưa APPROVED  
> **Phạm vi:** VNPay Sandbox trên NestJS Backend, Next.js Frontend và PostgreSQL; **không hướng dẫn kích hoạt production**.

## 1. Mục đích, nguồn và giới hạn

Tài liệu hướng dẫn thành viên BrewLite chuẩn bị môi trường, vận hành luồng thanh toán VNPay Sandbox và thu thập bằng chứng kiểm thử mà không tiết lộ thông tin bí mật. Tài liệu này **không khẳng định** các endpoint hoặc biến cấu hình chưa được xác minh đã tồn tại trong source code. Bản v1.1 đã đối chiếu **các file được cung cấp**: `payments.zip` (thư mục Payment) và `backend/.env.example`; không xem đó là toàn bộ repository.

**Nguồn nghiệp vụ nội bộ:**

- `docs/decisions/VNPay_Phase2_Change_Request.md` – BL-CR-VNPAY-001 v1.0; BR-01 đến BR-06 được Project Leader phê duyệt.
- *BrewLite Requirements Specification v3.1 – VNPay Phase 2* (30/10/2026): FR-PAY-007 đến FR-PAY-012, mục 7.7.1; ngoại lệ IPN; kiểm chứng tích hợp.
- *BrewLite API Contract v3.0*: baseline Phase 1 cho Mock Payment. **Không mặc định đây là API Contract VNPay Phase 2**.
- *BrewLite US/AC v2.3 đồng bộ Requirements v3.1*: dùng để truy vết điều kiện nghiệm thu Phase 2.

**Tài liệu chính thức từ VNPay và tunnel:**

1. [VNPay – Thanh toán PAY / Payment URL, Return URL, IPN](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html)
2. [VNPay – QueryDR & Refund API](https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr%26refund.html)
3. [VNPay – Downloads, tech spec và kịch bản SIT](https://sandbox.vnpayment.vn/apis/downloads/)
4. [VNPay – Sandbox demo và dữ liệu thẻ test công khai](https://sandbox.vnpayment.vn/apis/vnpay-demo/)
5. [Cloudflare – Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
6. [Cloudflare – tải `cloudflared` cho Windows](https://developers.cloudflare.com/tunnel/downloads/)

> **Nguồn chân lý khi có xung đột:** business rule được Approved → Requirements v3.1 → API Contract Phase 2 sau khi được phê duyệt → implementation đã được review. Không tự sửa BR để làm cho code hiện tại dễ chạy. Nếu VNPay Sandbox có hành vi không phù hợp với BR đã Approved, lập change proposal để Project Leader quyết định.

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

### 2.1. Trạng thái đã xác minh từ source được cung cấp (30/10/2026)

| Thành phần | Bằng chứng trong code/config | Trạng thái | Việc cần làm |
|---|---|---|---|
| `POST /payments` | `payments.controller.ts`: `@Controller('payments')`, `@Post()`, `@HttpCode(200)`; áp `JwtAuthGuard` ở **cấp controller** | **ĐÃ CÓ – Mock Phase 1** | Tiếp tục dùng để regression, không coi là VNPay initiation |
| JWT, request idempotency | `@ApiBearerAuth()`, `Idempotency-Key`, `IdempotencyKeyPipe`; `PaymentsService.execute()` | **ĐÃ CÓ – Mock** | Giữ bất biến; mở rộng thành contract initiation VNPay sau khi duyệt |
| Mock processor | `payments.module.ts`: `PaymentProcessor` → `PaymentsService`; `MockPaymentService.evaluate()` kết luận `SUCCESS/FAILED` ngay | **ĐÃ CÓ – Mock**, chưa có lựa chọn provider từ env | Thiết kế VNPay strategy/backend-controlled provider sau review |
| Payment DTO | `CreatePaymentDto`: `orderId`, `method=CARD/WALLET`, `paymentDetails`; response chỉ `SUCCESS/FAILED` và `PAID/PAYMENT_FAILED` | **ĐÃ CÓ – Mock**, không chứa payment URL/PENDING | VNPay DTO/contract riêng cần chốt |
| `GET /payments/vnpay/ipn` | **Không có** trong `payments.controller.ts`/archive | **CHƯA CÓ** | Tạo endpoint HTTPS public, không Customer JWT, verify callback |
| VNPay initiation / redirect / Return | Không có provider VNPay, URL creator, route VNPay trong archive | **CHƯA CÓ trong source được gửi** | Chờ implementation và Frontend routes |
| QueryDR / reconciliation | Không có client QueryDR/handler trong archive | **CHƯA CÓ trong source được gửi** | Phải triển khai trước SIT |
| ZERO_AMOUNT nội bộ | Không thấy handler ZERO_AMOUNT; `PaymentsService` hiện chấp nhận amount 0 nhưng vẫn xử lý qua Mock | **CHƯA ĐỒNG BỘ BR-06** | Không gọi Mock cho Order 0 VND trong Phase 2; cần handler riêng |
| Port Backend | `.env.example` có `PORT=3001` | **ĐÃ XÁC MINH – ví dụ repo** | Kiểm tra lại cổng lúc khởi động |
| Cấu hình VNPay / policy Mock | `.env.example` **không có** `VNPAY_*`, `PAYMENT_PROVIDER`, `MOCK_PAYMENT_ENABLED` | **CHƯA CÓ** | Thống nhất tên biến và code đọc config trước khi cấu hình |
| Frontend, `main.ts`, `package.json`, Docker compose | Không được gửi trong archive hiện tại | **CHƯA KIỂM CHỨNG** | Cần source tương ứng để xác minh route/scripts |

> **Cảnh báo cho người chạy theo guide:** Với source hiện tại, Swagger có thể hiển thị `POST /payments`, nhưng đó là **thanh toán Mock đồng bộ**. Chưa thể thực hiện bước tạo VNPay URL, nhận IPN hay QueryDR bằng các file này; các bước VNPay tiếp theo là **hướng dẫn triển khai/kiểm thử sau khi phụ thuộc hoàn tất**, chưa phải lệnh chạy thành công ngay.

### 2.2. Ghi chú kỹ thuật khi mở rộng Payment Module

- `PaymentsController` hiện có `@UseGuards(JwtAuthGuard)` ở **cấp class**. Nếu thêm `GET /payments/vnpay/ipn` vào controller này mà không thiết kế cơ chế public exception rõ ràng, callback không có JWT từ VNPay sẽ bị chặn `401`. Nên tách một controller IPN public được bảo vệ bằng kiểm tra HMAC-SHA512, merchant, TxnRef, amount và persisted attempt; hoặc có chiến lược guard tương đương được review. **Không bỏ JWT Guard khỏi `POST /payments` hiện có.**
- `PaymentsService` đang dùng PostgreSQL transactions, Order lock, advisory lock và Payment snapshot để bảo vệ Mock idempotency. Đây là **logic Phase 1 đã tồn tại**, không phải bằng chứng VNPay IPN/QueryDR finalization đã được triển khai. Reuse phải qua review transaction, unique SUCCESS/Order và race conditions.
- Mock response xác nhận `SUCCESS/FAILED` ngay; VNPay cần Attempt `PENDING` và kết quả bất đồng bộ. **Không dùng DTO Mock hiện có làm mô tả contract VNPay**.
- Hiện không có env bật/tắt Mock theo provider. Không tuyên bố code đã enforce `Mock disabled in production`; đây vẫn là yêu cầu BR-01/BR-06 cần test khi implement.
- `payments/README.md` mô tả SCRUM-54/55 và các bộ test Phase 1. Archive không chứa đầy đủ test/Orders/Scheduler/Prisma schema để xác minh end-to-end; README là mô tả thiết kế, không thay thế kết quả chạy test.

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
cd /d/Projects/brewlite/backend
npm ci
# Xem package.json/README để xác nhận script phù hợp, thường là:
npm run start:dev
```

Ở terminal khác, kiểm tra cổng Backend (**`.env.example` đặt `PORT=3001`**):

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

**Không có biến VNPay nào trong `.env.example` này.** Các biến sau là *đề xuất tên*, không phải tên đã được Payment Module hiện tại hỗ trợ. Chỉ thêm vào template sau khi nhóm chốt config contract và implement backend đọc các biến đó.

> **CẢNH BÁO:** Các tên `VNPAY_*`, `PAYMENT_PROVIDER`, `MOCK_PAYMENT_ENABLED` dưới đây là **bộ tên đề xuất để minh họa tài liệu**, **KHÔNG hiện diện trong `.env.example` được gửi và chưa có code đọc chúng trong Payment Module**. Không được sao chép nguyên khối vào `.env.example` rồi coi là cấu hình đã hoạt động; đối chiếu với `backend/src/...` config và chuẩn hóa theo code trước.

```dotenv
# EXAMPLE ONLY – not a verified BrewLite configuration contract
PAYMENT_PROVIDER=VNPAY
MOCK_PAYMENT_ENABLED=false
VNPAY_ENVIRONMENT=sandbox
VNPAY_TMN_CODE=<sandbox-merchant-id-from-secret-manager>
VNPAY_HASH_SECRET=<inject-locally-never-commit>
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_QUERYDR_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=http://localhost:3000/<approved-return-route>
VNPAY_IPN_URL=https://<temporary-tunnel-host>/payments/vnpay/ipn
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
| Endpoint ở BrewLite | **Chưa chốt**, route Frontend/Backend phụ thuộc thiết kế | `GET /payments/vnpay/ipn` đã chốt | Internal service, **không tự tạo public endpoint** |
| Cần Customer JWT? | Không giả định; Frontend dùng session và API riêng để xem Order | **Không** | Không có Customer JWT trong request server-to-server |
| Bảo mật | Không tin query string là quyết định cuối cùng | HMAC-SHA512 + merchant + TxnRef + amount + trạng thái | Ký request, verify response, đối chiếu TransactionStatus |
| Tác dụng chính | Hiển thị chờ/hoàn tất theo trạng thái server | Cập nhật finalization idempotent sau xác minh | Đối soát khi IPN chưa đủ/đến muộn |
| Có thể tự xác nhận PAID? | **Không** | Có, nhưng chỉ sau verify và commit | Có, sau verify và finalization chung |

**Return URL:** Nếu `vnp_ResponseCode` trong URL browser báo `00` nhưng Payment chưa được backend verify, frontend **hiển thị “Đang xác minh thanh toán”**, không tự xóa giỏ hoặc báo `PAID`. Dùng API trạng thái/History đã phê duyệt để đọc kết quả cuối. Nếu không có API trạng thái Phase 2 được duyệt, ghi **BLOCKED – pending contract**, không tự thiết kế endpoint mới trong guide.

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

> **TRẠNG THÁI VỚI ARCHIVE ĐƯỢC GỬI: BLOCKED.** Không tìm thấy initiation, IPN, QueryDR hoặc ZERO_AMOUNT nội bộ trong `payments.zip`; vì thế **không thể chạy giao dịch VNPay Sandbox end-to-end bằng source này**. Chỉ làm theo hướng dẫn bên dưới sau khi team bổ sung và review các phụ thuộc.

> **Điều kiện:** các route/DTO VNPay Phase 2 phải được implement và review; đã cấu hình merchant Sandbox, ký request, Return URL, public HTTPS IPN; có dữ liệu test. Phần dưới mô tả luồng thao tác **theo nghiệp vụ**, không giả định tên endpoint initiation chưa duyệt.

1. **Chuẩn bị backend và dữ liệu test:** chạy NestJS, PostgreSQL, Frontend, tunnel; xác nhận Swagger và log khởi động. Chỉ dùng Customer demo, không dùng dữ liệu thật.
2. **Đăng nhập:** thực hiện `POST /auth/login` để nhận JWT (API Phase 1 đã có). Không đưa JWT vào ảnh hoặc tài liệu; ở Swagger chỉ paste token cục bộ.
3. **Tạo Order:** dùng API tạo Order đã có trong contract (`POST /orders`) với sản phẩm còn tồn. Kiểm tra Order của đúng Customer, totalVnd **lớn hơn 0 và đáp ứng ngưỡng tối thiểu của VNPay**, trạng thái chờ, `expiresAt` còn đủ thời gian. Không nhận tổng từ Frontend.
4. **Khởi tạo VNPay:** gọi **endpoint initiation thực tế đã được duyệt** với JWT, `Idempotency-Key` duy nhất và Order của chính Customer. Backend phải kiểm tra Order và provider, lưu Attempt PENDING/TxnRef, rồi cấp payment URL phù hợp. Nếu cùng key/payload được gửi lại do network timeout, backend phải nhận ra attempt cũ, không tạo attempt thứ hai.
5. **Redirect:** mở payment URL đã được Backend cấp trên browser. URL phải thuộc domain Sandbox chính thức và còn hạn theo Order. Không tự tạo/ký URL trên Frontend.
6. **Nhập dữ liệu thẻ test:** chỉ dùng **dữ liệu công khai do VNPay cấp** tại https://sandbox.vnpayment.vn/apis/vnpay-demo/; không dùng thẻ hay tiền thật. Không ghi OTP/card details vào repo hay screenshot share public.
7. **Return URL:** sau thao tác thanh toán, Customer trở về giao diện. FE hiển thị “Đang xử lý/Đang xác minh” cho đến khi đọc được kết quả đáng tin cậy từ Backend. Query string Return không được tự ghi PAID/FAILED.
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

**SIT Status tại thời điểm review source:** `NOT RUN / BLOCKED – VNPay integration missing from uploaded Payment Module`. Không đánh dấu PASS các case VNP-01 đến VNP-20 chỉ vì Mock tests đã chạy được.

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

## 10. Các thông tin cần nhóm cung cấp để chốt tài liệu

**Đã nhận và kiểm tra:** `payments.zip` (15 mục bao gồm folder và 14 file Payment Phase 1) và `.env.example` (8 tên biến). Không tìm thấy code tích hợp VNPay trong archive này; danh sách bằng chứng cụ thể ở §2.1–2.2.

**Cần bổ sung để chốt các lệnh/đường dẫn còn mở:**

1. Source **Phase 2 sau khi implement** (VNPay provider, initiation, public IPN controller, QueryDR, finalization, ZERO_AMOUNT) cùng tests để xác nhận guide phản ánh code thật.
2. `backend/src/main.ts`, `backend/package.json`, các config provider và README chạy Backend để đối chiếu route prefix, Swagger, scripts và các biến `.env` đã implement.
3. `docker-compose.yml`/`compose.yaml` và README triển khai để xác minh các lệnh Docker.
4. Next.js Return/Confirmation routes và phương thức FE đọc kết quả Order; **không tự suy đoán path**.
5. API Contract Phase 2 **đã được phê duyệt** để chốt initiation request/response, error code, replay contract và trạng thái.
6. Xác nhận merchant Sandbox và cách cấu hình public IPN URL (chỉ cần **có/chưa có**, không gửi credentials).

**Phụ thuộc còn Open:** chính sách Customer chủ động hủy khi còn VNPay Attempt PENDING chưa biết kết quả; tuyệt đối không tự tạo hướng dẫn hủy và hoàn tiền. Nếu merchant/gateway có giới hạn về `vnp_ExpireDate` gây xung đột với TTL Order, lập proposal xin quyết định thay vì tự thay BR-03.

## 11. Tiêu chí bàn giao task tài liệu

- [x] Có khung hướng dẫn Environment + biến mẫu không chứa secret.
- [x] Giải thích public HTTPS tunnel tới Backend local; phân biệt Return/IPN/QueryDR.
- [x] Mô tả giao dịch Sandbox, dữ liệu test và cách dùng SIT.
- [x] Có Security Checklist, Troubleshooting và trace BR-01–BR-06.
- [x] Đã audit Payment Module Phase 1, xác nhận `POST /payments` là Mock, `PORT=3001`, liệt kê env đang có; **không thấy implementation VNPay trong archive**.
- [ ] Đối chiếu **tên env Phase 2, route initiation, IPN, FE Return, scripts/command** với source Backend/Frontend sau khi triển khai.
- [ ] Đối chiếu API Contract Phase 2 sau khi được duyệt.
- [ ] Chạy thử tunnel + một Sandbox giao dịch thực + ghi evidence (đơn test, callback, DB assertions) trên database disposable.
- [ ] Review kỹ thuật/QA và phê duyệt nội dung hướng dẫn.

**Phân biệt:** hoàn thành bản nháp tài liệu ≠ hoàn tất VNPay integration hoặc SIT. Không ghi mục kiểm thử thực tế là PASS nếu chưa chạy.

### Checklist bàn giao cho reviewer (bản source audit)

- [x] Ghi rõ baseline `POST /payments` đang là **Mock CARD/WALLET**, dùng JWT và `Idempotency-Key`.
- [x] Phân định `PAYMENT_PROVIDER`, `VNPAY_*`, `MOCK_PAYMENT_ENABLED` là **tên đề xuất**, chưa được code hỗ trợ.
- [x] Nêu được rủi ro `JwtAuthGuard` cấp controller khi thêm IPN không có JWT.
- [x] Phân định ZERO_AMOUNT Phase 2 là **chưa implement** dù Mock Phase 1 có thể xử lý amount bằng 0.
- [ ] Có source/contract Phase 2 hoàn thiện và test evidence để đánh dấu integration ready.
