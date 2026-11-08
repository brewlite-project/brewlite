# BrewLite — Assignment 1 | Ứng dụng đặt và thanh toán đồ uống

> **Đồ án môn Công nghệ phần mềm** · Trường Đại học Sài Gòn · Học kỳ I, năm học 2026–2027  
> **Công nghệ bắt buộc:** Next.js (frontend) + NestJS (backend) · **Dữ liệu:** PostgreSQL/Prisma  
> **Repository A1:** [brewlite-project/brewlite](https://github.com/brewlite-project/brewlite) · **Nhánh tích hợp:** `dev`  
> **Trạng thái tài liệu:** Bản hoàn thiện để review trước khi chốt mốc `A1-final`; **không có nghĩa toàn bộ nghiệm thu đã PASS**.

## 1. Tổng quan dự án

**BrewLite** là ứng dụng web đặt đồ uống hướng tới luồng trải nghiệm: **xem menu → chọn size/topping → quản lý giỏ hàng → đăng nhập → đặt đơn → thanh toán không dùng tiền mặt → xem xác nhận/trạng thái/lịch sử đơn**. Dự án được xây dựng trong môn Công nghệ phần mềm nhằm thực hành quy trình phân tích yêu cầu, thiết kế, triển khai, kiểm thử và cộng tác theo Agile Scrum.

### 1.1. Bài toán và mục tiêu

- **Khách hàng:** xem thực đơn và giá, cấu hình đồ uống, đặt đơn và theo dõi kết quả thanh toán/đơn hàng.
- **Cửa hàng (ngữ cảnh nghiệp vụ):** có dữ liệu sản phẩm, giá, tồn kho và trạng thái đơn; các thao tác quản trị/quầy không mặc nhiên được xem là UI đã triển khai trong MVP.
- **Nhóm phát triển:** có mã nguồn, lịch sử Git/Jira, tài liệu yêu cầu/thiết kế, bài kiểm thử và cách tái tạo môi trường chạy được.

**Phạm vi A1** lấy các yêu cầu, tiêu chí chấp nhận và Definition of Done trong đề Assignment 1 làm căn cứ; những chức năng mở rộng chỉ được ghi nhận theo mức triển khai/kiểm thử thực tế. **Phase 2** trong repo A1 bổ sung VNPay Sandbox và xử lý Payment/Order ở mức nâng cao; đây không phải môi trường nhận tiền thật hoặc hệ thống đã triển khai production.

### 1.2. Đường dẫn dự án và tài liệu

| Thành phần                   | Vị trí                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GitHub repository A1         | [brewlite-project/brewlite](https://github.com/brewlite-project/brewlite)                                                      |
| Lịch sử pull request         | [GitHub Pull Requests](https://github.com/brewlite-project/brewlite/pulls?q=is%3Apr)                                           |
| Các thay đổi README Phase 2  | [PR #143](https://github.com/brewlite-project/brewlite/pull/143)                                                               |
| Jira                         | Theo board Scrum của nhóm, dùng issue key `SCRUM-*` trong tên nhánh/PR; URL chính xác cần được nhóm xác nhận trước khi công bố |
| API Contract hiện có         | [BrewLite API Contract v4.0](docs/api/BrewLite_API_Contract_v4.0.md)                                                           |
| Bằng chứng kiểm chứng README | [SCRUM-94 Verification Evidence](docs/verification/SCRUM94_Verification_Evidence.md)                                           |

## 2. Thành viên và trách nhiệm

| Thành viên (tên nhóm đang sử dụng) | Vai trò/trách nhiệm đã biết trong A1                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N.C.H.Khang**                    | **Trưởng nhóm**; điều phối kế hoạch, quyết định kỹ thuật/API Contract, review PR, phụ trách phần xác minh VNPay Sandbox trên máy demo A1 và nghiệm thu tài liệu cuối |
| **N.Đ.Thụy**                       | Thành viên phát triển; tham gia User Stories/Acceptance Criteria, Use Case Specification và các task kỹ thuật theo Jira                                              |
| **N.K.Hoàng**                      | Thành viên phát triển; tham gia Requirements Specification và phần README/Phase 2 report (SCRUM-94)                                                                  |
| **C.N.Q.Khánh**                    | Thành viên phát triển; tham gia thiết kế Figma và giao diện frontend theo các task được giao                                                                         |
| **L.C.Khang**                      | Thành viên phát triển; tham gia ERD/Prisma và công việc dữ liệu theo các task được giao                                                                              |
| **H.V.Lập**                        | Thành viên phát triển; tham gia Activity/Sequence Diagram và các task kỹ thuật theo Jira                                                                             |

> **Cách đọc:** Bảng ghi **đầu việc tiêu biểu**, không gán độc quyền một module cho một thành viên và không thay thế lịch sử assignee/PR trên Jira/GitHub. Danh sách trên sử dụng tên gọi nội bộ; cập nhật họ tên đầy đủ/MSSV nếu giảng viên yêu cầu. Chưa có bằng chứng trong tài liệu cung cấp để gán chắc chắn ai giữ vai trò Scrum **Product Owner** hoặc **Scrum Master**: nếu nhóm đã phân công, cập nhật theo biên bản/Project Charter trước khi chốt bản nộp.

## 3. Quy trình Agile Scrum và quản lý công việc

Dự án áp dụng cách tổ chức theo Sprint, theo dõi Product Backlog/Sprint Backlog trên Jira và lưu tạo phẩm trong GitHub. Cấu trúc mục tiêu dưới đây bám theo **gợi ý 3 Sprint trong đề A1**, không tự khẳng định đây là ngày bắt đầu/kết thúc hay toàn bộ tiến độ Jira thực tế.

| Giai đoạn                | Mục tiêu trong phạm vi A1                            | Ví dụ tạo phẩm/đầu việc                                                                                     |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sprint 1                 | Nền tảng và hiển thị menu                            | Cấu trúc repo, Product API, trang menu, chi tiết sản phẩm                                                   |
| Sprint 2                 | Giỏ hàng, xác thực và tạo đơn                        | Cart state, Register/Login/JWT, Order API                                                                   |
| Sprint 3                 | Thanh toán và bàn giao                               | Mock payment, xác nhận/lịch sử đơn, Docker, nghiệp vụ Order/Payment, demo                                   |
| Phase 2 mở rộng trong A1 | Tăng cường VNPay Sandbox và tính nhất quán giao dịch | VNPay initiation/IPN/QueryDR client, shared payment finalization, kiểm thử và quyết định phạm vi nghiệm thu |

**Các tạo phẩm cần đối chiếu với Jira trước khi tuyên bố hoàn tất:** Product Backlog, Sprint Backlog, trạng thái issue, lịch sử commit/PR, increment chạy được, Sprint Review và Retrospective. Không đánh dấu các buổi họp/sự kiện Scrum là đã tổ chức nếu nhóm chưa có biên bản hoặc bằng chứng tương ứng.

### 3.1. Cách một task đi từ Jira tới GitHub

1. Chốt yêu cầu, Acceptance Criteria và assignee trên Jira; xác định tài liệu/API Contract phụ thuộc trước khi code.
2. Đồng bộ `dev`, tạo branch riêng có mã `SCRUM-*`; chỉ làm thay đổi thuộc scope task.
3. Chạy kiểm tra phù hợp (lint, test, build, migration/Compose nếu có thay đổi liên quan); không dùng kết quả ở môi trường khác để tuyên bố PASS.
4. Tạo PR **về `dev`**, mô tả thay đổi, cách kiểm thử, evidence và giới hạn còn lại; reviewer yêu cầu sửa nếu chưa đạt.
5. Khi PR đáp ứng quy định review/CI của repository, merge về `dev`, cập nhật Jira; phát hành lên `main` theo quy trình release riêng của nhóm.

**Lệnh đồng bộ được ưu tiên:**

```bash
git switch dev
git pull --ff-only origin dev
git switch -c SCRUM-123-feature-description
```

`git pull --ff-only` tránh tạo merge commit ngoài ý muốn khi chỉ đồng bộ nhánh. Nếu local branch đã phân kỳ, xử lý có chủ đích, không tự `reset --hard` để ép qua lỗi. Không commit `.env`, credential VNPay, token, dữ liệu cá nhân hoặc log chưa được lọc secret.

### 3.2. Quy ước review và Definition of Done (DoD)

Một task **chỉ được đề xuất Done** khi các điều kiện áp dụng cho task đó đã được kiểm tra:

- Đạt Acceptance Criteria và không làm hỏng luồng liên quan; thay đổi code qua build/test tương ứng.
- Có commit, PR, mô tả kiểm chứng và review; không merge bất chấp lỗi hoặc bypass chính sách branch protection.
- API có validate và xử lý lỗi; UI có trạng thái loading/empty/error nếu thuộc phạm vi task.
- Có tài liệu sử dụng/triển khai hoặc quyết định ADR nếu thay đổi hành vi/hợp đồng.
- Ghi rõ **PASS**, **FAIL**, **BLOCKED** hoặc **DEFERRED** theo đúng chứng cứ. `BLOCKED`/`DEFERRED` không được đổi tên thành `PASS`.
- Nếu thay đổi backend/frontend/Docker/env/migration, xem xét lại nhu cầu build/recreate và smoke test; thay đổi chỉ docs không mặc nhiên yêu cầu rebuild.

Đây là **checklist hướng dẫn review README và A1** phù hợp với đề; trạng thái nghiệm thu cuối cùng do Leader và quy định nhóm xác nhận qua Jira/PR.

## 4. Chức năng và phạm vi triển khai

| Nhóm chức năng           | Nội dung trong source/baseline hiện tại                         | Giới hạn khi đọc trạng thái                                                                    |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Menu / chi tiết sản phẩm | Danh sách sản phẩm, chi tiết, size/topping, dữ liệu mẫu         | Đối chiếu dữ liệu seed, UI và API tại commit chạy demo                                         |
| Cart                     | Thêm/sửa/xóa, tổng tiền/quantity ở frontend                     | Cần E2E thật để chứng minh toàn luồng browser                                                  |
| Authentication           | Register/Login, JWT, route bảo vệ                               | Không công bố credential demo trong repository                                                 |
| Order                    | Tạo đơn, trạng thái, lịch sử đơn                                | Kiểm tra consistency và expiry qua tests tương ứng                                             |
| Mock Payment             | Thanh toán giả lập phục vụ local/test/demo                      | Không đồng nghĩa VNPay Sandbox và không tự bật ở production                                    |
| VNPay Sandbox            | Initiation, IPN, QueryDR client/scheduler, shared finalization  | IPN đã có bằng chứng lịch sử; QueryDR Sandbox E2E được hoãn có ADR; UI status API còn sai lệch |
| Nghiệp vụ nâng cao       | Inventory/transaction, coupon/loyalty, idempotency, ZERO_AMOUNT | Chỉ khẳng định PASS cho trường hợp có test/evidence tương ứng                                  |

### 4.1. Đối chiếu 10 task của đề Assignment 1

| Task A1 | Yêu cầu của đề                                                    | Vị trí kiểm chứng chính                            |
| ------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| 1       | Khởi tạo repository, cấu trúc frontend/backend, README và env mẫu | Root repository, `frontend/`, `backend/`           |
| 2       | API danh sách sản phẩm                                            | `GET /products`, backend test                      |
| 3       | Trang menu và loading/empty                                       | Frontend UI, test/evidence                         |
| 4       | Chi tiết sản phẩm, size/topping và giá                            | Frontend UI, API/seed liên quan                    |
| 5       | Cart add/update/remove và tổng tiền                               | Frontend cart/tests                                |
| 6       | API tạo đơn, validate, trạng thái ban đầu                         | `POST /orders`, backend/integration tests          |
| 7       | Register/Login/JWT/guard                                          | Auth API và tests                                  |
| 8       | Mock cashless payment Ví/Thẻ                                      | `POST /payments`, payment tests                    |
| 9       | Xác nhận/lịch sử, Docker Compose, README và demo                  | `GET /orders/me`, Compose, browser demo            |
| 10      | State machine, idempotency, concurrency/inventory, coupon/loyalty | Backend tests, API Contract, verification evidence |

**Đây là ma trận đối chiếu yêu cầu, không phải bảng chấm điểm/PASS.** Tiêu chí chấp nhận chi tiết và điều kiện 1 điểm cho từng task nằm trong đề A1; trạng thái thực tế đối chiếu Jira, commit và bài kiểm thử.

**Phân loại trạng thái bắt buộc:**

- **Implemented:** tính năng/controller/service/schema có trong source.
- **Verified:** bài test hoặc demo đạt trong **môi trường được nêu cụ thể**, kèm bằng chứng.
- **Accepted/Done:** Leader/Jira/PR xác nhận theo tiêu chí nghiệm thu.

## 5. Kiến trúc tổng quan

```text
Trình duyệt người dùng
         |
         | HTTP localhost (A1) / Next.js same-origin /api/backend/*
         v
Next.js frontend (frontend/)
         |
         | REST/JSON — BACKEND_INTERNAL_URL cho server-side proxy
         v
NestJS backend (backend/)
         |                  \
         |                   \--> Mock Payment hoặc VNPay Sandbox (test)
         v
Prisma ORM
         |
         v
PostgreSQL (database + migrations/seed)
```

- Frontend và backend vẫn ở `frontend/` và `backend/` trong **A1**. Không di chuyển sang `apps/web`/`apps/api` ở repository A1.
- Môi trường host và Docker Compose dùng cấu hình URL khác nhau: hostname `backend`/`postgres` chỉ có nghĩa trong Compose network.
- VNPay **Return** là điều hướng browser; IPN/QueryDR đã xác minh mới có thể phục vụ kết luận tài chính. Không đặt `Hash Secret`/`JWT_SECRET` trong frontend hoặc source control.
- Đây là kiến trúc **local/test của A1**, không phải bằng chứng đã có URL production. Thiết kế và yêu cầu production thuộc Assignment 2.

---

## 6. Tình trạng tại baseline A1 (sau PR #143)

Source hiện có menu, đăng ký/đăng nhập JWT, tạo đơn và lịch sử đơn; coupon/loyalty; thanh toán Mock giữ tương thích Phase 1; VNPay initiation, public IPN, QueryDR client/scheduler, ZERO_AMOUNT, expiration và shared payment finalization.

Các trạng thái này cần được đọc riêng:

- **Implementation:** có controller/service/schema/script trong source.
- **Test:** automated tests chỉ chứng minh các nhánh và môi trường mà chúng chạy; Mock hoặc giả lập gateway không chứng minh Sandbox E2E.
- **Nghiệm thu:** quyết định Leader/PR/Jira. README này không tự chuyển task sang Done.

Tại code commit được kiểm tra, frontend có gọi `GET /payments/:paymentId/status` sau VNPay Return nhưng backend chưa có route đó. Một smoke trước đó ghi `POST` đăng ký qua proxy là 502, còn POST trực tiếp là 201; hai rerun hiện tại (Next host với BACKEND_INTERNAL_URL=http://127.0.0.1:3002 và Compose với backend:3001) đều trả 201 qua proxy lẫn direct. Vì vậy 502 trước đó chưa tái hiện và chưa đủ căn cứ quy cho implementation hoặc một owner; nguyên nhân vẫn chưa xác định. Chi tiết expected/actual và log an toàn nằm trong [SCRUM-94 evidence](docs/verification/SCRUM94_Verification_Evidence.md).

## 7. Stack và cấu trúc repository A1

- Node.js: Dockerfiles dùng Node 26. Một số dependency trong lockfile yêu cầu Node 22.22.2/22.22.3 trở lên; Node 22.18.0 đã phát cảnh báo EBADENGINE khi kiểm chứng. Dùng Node 26 để khớp container hoặc Node 22.22.3 trở lên.
- npm: dùng npm ci theo package-lock.json; không nâng dependency chỉ để chạy tài liệu này.
- Frontend: Next.js 16.3.8, React 19.2.8, TypeScript và Tailwind CSS.
- Backend: NestJS 12, TypeScript 6, Prisma 7.10.1.
- Database: PostgreSQL 18; Compose dùng postgres:18-alpine.
- Containers: Docker Compose; service postgres, migrate, backend, frontend.

```text
frontend/          Next.js UI, same-origin API proxy, frontend tests
backend/           NestJS API, Prisma schema/migrations/seed, backend tests
docs/api/          API contracts và handoff
docs/docs_Phase2/  Requirements, US/AC, Use Case, ERD Phase 2
docs/design/       Architecture và payment finalization
docs/decisions/    Quyết định/ADR
docs/integration/  Tài liệu tích hợp VNPay
docs/verification/ Test evidence
docker-compose.yml
compose.env.example
```

Nguồn baseline và tài liệu kỹ thuật được liệt kê ở [Tài liệu liên quan](#15-tài-liệu-liên-quan).

## 8. Chạy local trên host

### Điều kiện

Cần Git, Node.js/npm, PostgreSQL 18 và hai terminal (nếu chạy trực tiếp trên host). Xác nhận phiên bản và cổng trước khi chạy:

```bash
node --version
npm --version
psql --version
```

Dùng một database riêng cho bản demo. Không dùng database dùng chung, production, brewlite*db hoặc brewlite_seed_hoang. Tên database để chạy seed phải theo mẫu `brewlite_seed*<suffix>`, vì seed có allowlist riêng. Ví dụ dưới đây tạo database rỗng; thay my_local_postgres_role bằng role local của bạn:

```bash
createdb -h 127.0.0.1 -p 5432 -U my_local_postgres_role brewlite_seed_local
```

### Cấu hình backend

Từ thư mục repository root:

```bash
cd backend
npm ci
if [ ! -f .env ]; then cp .env.example .env; fi
```

Trong PowerShell, thay lệnh cuối bằng:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Chỉ tạo file nếu chưa có; không ghi đè cấu hình local. Mở backend/.env và thay toàn bộ giá trị mẫu. Đặc biệt, DATABASE_URL trong file mẫu trỏ tới brewlite_db tại port 5433; tuyệt đối không chạy migration hoặc seed trước khi thay bằng database disposable riêng của bạn, ví dụ brewlite_seed_local trên PostgreSQL local. URL của host dùng địa chỉ host như `127.0.0.1:<port>`; không dùng tên service Docker postgres.

Các biến:

| Biến                                                        | Phân loại                              | Mục đích                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                                                | Backend private, runtime và Prisma CLI | PostgreSQL mà backend, generate/validate/migrate/seed sử dụng. Xác minh host, port, tên DB trước mọi lệnh ghi dữ liệu.                                                                                                                                                                                         |
| JWT_SECRET                                                  | Backend private, runtime               | Chuỗi ngẫu nhiên tối thiểu 32 bytes; không đưa sang frontend.                                                                                                                                                                                                                                                  |
| INTERNAL_SECRET                                             | Backend private, runtime               | Secret riêng cho internal order advance; khác JWT_SECRET.                                                                                                                                                                                                                                                      |
| PORT                                                        | Backend runtime                        | Mặc định 3001 trên host.                                                                                                                                                                                                                                                                                       |
| MOCK_PAYMENT_ENABLED                                        | Backend runtime                        | Mặc định tắt; chỉ đặt true cho local/test/demo ngoài production. Không tự fallback từ VNPay.                                                                                                                                                                                                                   |
| ORDER_EXPIRATION_ENABLED / ORDER_EXPIRATION_BATCH_SIZE      | Backend runtime                        | Worker hết hạn đơn; cấu hình mẫu bật worker.                                                                                                                                                                                                                                                                   |
| VNPAY_TMN_CODE / VNPAY_HASH_SECRET                          | Backend private, runtime               | Merchant và HashSecret Sandbox; cần cho VNPay initiation/IPN, và cho startup khi reconciliation bật. Không commit, log hoặc đặt ở frontend.                                                                                                                                                                    |
| VNPAY_PAYMENT_URL / VNPAY_RETURN_URL                        | Backend runtime                        | URL thanh toán Sandbox và trang frontend nhận browser return; cần khi initiate payment và xử lý IPN, không phải điều kiện riêng của healthcheck/startup guard. Với Compose production runtime, HTTP localhost Return chỉ được phép khi VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true; dùng HTTPS cho endpoint public. |
| VNPAY_QUERYDR_URL / VNPAY_QUERYDR_TIMEOUT_MS                | Backend private, runtime               | Client QueryDR; cần hợp lệ ngay lúc startup khi bật reconciliation.                                                                                                                                                                                                                                            |
| VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL                           | Backend runtime, optional              | Chỉ để Compose production runtime cho phép Return URL HTTP trên localhost; không cho phép endpoint public HTTP.                                                                                                                                                                                                |
| PAYMENT*RECONCILIATION_ENABLED và PAYMENT_RECONCILIATION*\* | Backend runtime                        | Scheduler, lease, cooldown, batch và IP server. Với host local không có cấu hình Sandbox, đặt enabled=false rõ ràng; không dùng cách này cho production.                                                                                                                                                       |

Giữ các secret chỉ trong backend/.env. Không lưu JWT, cookie, Authorization header, password, HashSecret hoặc URL có chữ ký trong log/evidence.

### Generate, migrate, seed và chạy

Từ backend/ sau khi đã thay DATABASE_URL:

```bash
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
npm run start:dev
```

db:generate tạo Prisma Client theo schema; không thay migration. db:migrate chạy prisma migrate deploy và chỉ áp dụng migration chưa chạy. Không dùng migrate reset hoặc db push để sửa drift.

db:seed chỉ được chạy khi DATABASE*URL trỏ tới DB có tên brewlite_seed*<suffix>, hoặc Compose database được allowlist chính xác. Trước khi seed, xác nhận database rỗng về catalog và đã có migrations. Seed upsert 4 categories, 9 products và 5 toppings; cập nhật tên/giá/hình ảnh catalog mẫu, tạo liên kết sản phẩm–topping, giữ stock và trạng thái availability hiện có. Seed từ chối catalog có product ID ngoài danh sách mẫu; không xóa dữ liệu cũ và không sửa Order/Payment. Seed không tạo user. Seed lại có thể cập nhật giá/tên catalog mẫu. Không dùng database có dữ liệu nghiệp vụ.

Mở terminal khác từ repository root để chạy frontend:

```bash
cd frontend
npm ci
if [ ! -f .env.local ]; then cp .env.example .env.local; fi
```

Trong PowerShell, chỉ tạo file nếu chưa có:

```powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

Nếu frontend/.env.local đã tồn tại, sửa các giá trị hiện có thay vì ghi đè. Trong frontend/.env.local, khi frontend và backend chạy trên host, dùng:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
BACKEND_INTERNAL_URL=http://127.0.0.1:3001
```

Trong PowerShell, khi backend và frontend ở cùng máy:

```powershell
$env:NEXT_PUBLIC_API_URL = 'http://localhost:3001'
$env:BACKEND_INTERNAL_URL = 'http://127.0.0.1:3001'
npm run dev
```

NEXT_PUBLIC_API_URL là biến public có thể được nhúng lúc build; không đặt secret vào đây. BACKEND_INTERNAL_URL là runtime server-only cho Next Route Handler/SSR. Khi chạy trong Compose, server-side URL phải là http://backend:3001; trình duyệt dùng localhost:3000 và đường dẫn same-origin /api/backend/\*.

Khởi động frontend bằng npm run dev. Mặc định frontend ở http://localhost:3000; backend ở http://localhost:3001. Backend `GET /` là liveness, không query PostgreSQL. `GET /api-docs` mở Swagger.

Kiểm tra thủ công từ host:

```bash
curl --fail http://localhost:3001/
curl --fail http://localhost:3001/api-docs
curl --fail http://localhost:3000/api/backend/products
```

Kết quả catalog kỳ vọng gồm 9 items sau seed. Smoke Compose SCRUM-94 mới nhất nhận GET 200 và POST đăng ký 201 qua same-origin proxy; Next dev trên host với cấu hình backend đích tương ứng cũng trả POST 201, giống backend trực tiếp. Kết quả 502 từ lượt host smoke trước chưa tái hiện. Nếu gặp 502, so sánh đúng method/path, BACKEND_INTERNAL_URL và lệnh direct với proxy; xem [evidence](docs/verification/SCRUM94_Verification_Evidence.md), không suy đoán lỗi database.

## 9. Chạy bằng Docker Compose

Dockerfile dùng Node 26; Compose project mặc định brewlite_compose tạo network/container/database và named volume riêng. Host ports mặc định: frontend 3000, backend 3001, PostgreSQL loopback 15432; có thể đổi bằng FRONTEND_HOST_PORT, BACKEND_HOST_PORT, POSTGRES_HOST_PORT. Trong network, frontend gọi backend:3001 và backend kết nối postgres:5432. Không dùng hostname Docker từ host hoặc host port bên trong DATABASE_URL.

Compose dùng compose.env, không tự đọc backend/.env hoặc frontend/.env.local. Từ root, chỉ tạo compose.env nếu file chưa có; nếu đã có, cập nhật file hiện tại để tránh ghi đè cấu hình local:

```bash
if [ ! -f compose.env ]; then cp compose.env.example compose.env; fi
```

Trong PowerShell: if (!(Test-Path compose.env)) { Copy-Item compose.env.example compose.env }. Điền POSTGRES*USER, POSTGRES_PASSWORD, POSTGRES_DB, DATABASE_URL, JWT_SECRET và INTERNAL_SECRET. DATABASE_URL phải dùng postgres:5432 và khớp POSTGRES*\*.

Compose backend mặc định NODE*ENV=production và bật Payment Reconciliation. Backend startup cần PAYMENT_RECONCILIATION_ENABLED=true cùng VNPAY_TMN_CODE, VNPAY_HASH_SECRET, VNPAY_QUERYDR_URL, VNPAY_QUERYDR_TIMEOUT_MS, PAYMENT_RECONCILIATION_IP_ADDR hợp lệ và lease lớn hơn timeout tối thiểu 13 giây. VNPAY_PAYMENT_URL/VNPAY_RETURN_URL dùng khi initiate/IPN; sample không chứng minh merchant credential thật. Với Return URL HTTP localhost phải bật VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true; IPN public cần HTTPS. Compose chỉ đưa biến đã khai báo vào service environment; frontend không nhận secrets hoặc NEXT_PUBLIC*\* secrets.

Kết quả SCRUM-94 Compose mặc định là lịch sử tại source fb293e2: build image, PostgreSQL health, 9 migrations và manual seed đạt, nhưng backend production không healthy do thiếu VNPAY_TMN_CODE nên frontend bị chặn. Sau đó eef344c kiểm tra Docker targets/coupon helper riêng. Sau cập nhật dev (dba36a5), SCRUM-94 có isolated verifier tại checkout 304a7c6, dùng Docker Compose mặc định với project/DB/port riêng và cấu hình test; kết quả PASS trong phạm vi isolated verifier, không chứng minh VNPay Sandbox/production. Báo cáo SCRUM-92 có runtime evidence gắn với commit lịch sử f3a0285 và code fix ee3284d; không gán kết quả đó cho lượt hiện tại. Harness SCRUM-92 dùng VNPay values synthetic chỉ để test initiation/replay trong stack cô lập, không gọi VNPay gateway, không phải merchant credential và không phải Sandbox IPN/QueryDR E2E.

Lượt smoke ứng dụng riêng trước đó dùng development override tạm do SCRUM-94 tạo; đây không phải workflow/profile được commit trong repository. Override đặt `NODE_ENV=development`, `ORDER_EXPIRATION_ENABLED=false`, `PAYMENT_RECONCILIATION_ENABLED=false`, `MOCK_PAYMENT_ENABLED=true` và host port riêng để chạy demo không cần scheduler/credential Sandbox. Build, đăng nhập, tạo đơn, Mock, lịch sử và persistence chỉ được xác nhận trong môi trường development tạm. Không suy kết quả đó thành production hoặc Sandbox.

Tài liệu chi tiết có lệnh cho Git Bash/Linux/macOS và Windows PowerShell, gồm copy env không ghi đè, preflight, health, seed guard và persistence: xem docs/Docker_Compose.md. Preflight Bash bên dưới từ repository root kiểm tra exported variables trước Compose.

```bash
bash scripts/compose-preflight-env.sh
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env config --services
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env up --build -d
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env logs --tail 100 postgres migrate backend frontend
```

Migration service đợi PostgreSQL health rồi chạy db:migrate và phải hiện Exited (0); backend chỉ start sau migrate thành công; frontend đợi backend health. Backend/frontend healthcheck hiện chỉ gọi GET /, không xác nhận kết nối database. Đọc log của migrate và gọi GET /api/backend/products để kiểm tra ứng dụng với dữ liệu đã seed.

Seed Compose là thao tác riêng, không tự chạy khi up. Trước khi seed, dùng lệnh và checklist trong [Docker Compose guide](docs/Docker_Compose.md) để xác minh đúng project/database, 9 migrations và chưa có products. Chỉ seed DB demo riêng bằng lệnh đúng allowlist:

```bash
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
```

Seed catalog db:seed ở trên khác coupon helper dev/test. Coupon helper host-side hiện hard-code port 55432 trong khi Compose default mới là 15432; kết quả tại eef344c chạy trong network namespace task-local expose 55432 và không chứng minh helper tương thích host mapping mặc định. Không dùng helper trên DB ứng dụng/chia sẻ. Xem coupon guide trước khi dùng.

Logs, stop, start lại và kiểm tra persistence:

```bash
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env logs --tail 100 backend frontend
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env stop
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env start
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env restart
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
```

Named volume giữ PostgreSQL data qua stop/start. Không dùng down -v hoặc prune để dọn project khi chưa xác minh đúng tài nguyên; nếu xóa containers/network bằng down, phải giữ named volume cần thiết.

## 10. VNPay Sandbox

Chỉ dùng merchant Sandbox và dữ liệu test. Thiết lập VNPAY_TMN_CODE, VNPAY_HASH_SECRET, VNPAY_PAYMENT_URL, VNPAY_RETURN_URL trong backend environment riêng của người chạy. VNPAY_RETURN_URL trỏ tới frontend /payment, ví dụ http://localhost:3000/payment khi chạy local; trong runtime production phải bật VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true mới cho HTTP localhost.

POST /payments/vnpay/initiate tạo attempt VNPay PENDING và URL đã ký. Browser được redirect sang VNPay rồi quay về Return URL. Return chỉ là điều hướng trình duyệt; query parameters không phải bằng chứng thanh toán. Backend IPN và QueryDR đã xác minh là nguồn tài chính; chúng đi qua shared finalization. Không đánh dấu Payment SUCCESS chỉ vì người dùng trở về trang web.

IPN là GET /payments/vnpay/ipn và không cần Customer JWT. VNPay phải gọi được backend qua public HTTPS. Backend chạy trên laptop thường cần HTTPS tunnel hoặc backend test đã public; URL callback được khai báo trong cấu hình merchant Sandbox, không phải biến VNPAY_IPN_URL trong repo. Không mở tunnel nếu chưa có merchant/test authorization và chưa xác minh đúng route. QueryDR dùng server-side credentials, signature validation và scheduler; không gọi bằng trình duyệt.

Frontend gọi GET /payments/:paymentId/status sau Return nhưng backend hiện chưa có route; UI chưa thể đọc trạng thái authoritative và các case JWT/ownership chưa được kiểm chứng.

### Phạm vi A1 đã điều chỉnh — nguồn xác nhận

[ADR-P2-QueryDR-Sandbox-E2E-Deferred](docs/decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md) được APPROVED ngày 03/11/2026: A1 của SCRUM-81 bao gồm IPN Sandbox thật đã thử thành công, QueryDR client và automated tests; QueryDR Sandbox E2E/khôi phục khi mất IPN chuyển sang A2/SCRUM-95. ADR ghi giao dịch 42.000 VND qua HTTPS/ngrok, IPN RspCode 00, Payment SUCCESS, Order PAID, event FINALIZED và không financial exception; test counts trong ADR là historical evidence, không phải SCRUM-94 rerun. [PR #127](https://github.com/brewlite-project/brewlite/pull/127) được review APPROVED và merge; [PR #142](https://github.com/brewlite-project/brewlite/pull/142) cập nhật QueryDR parser/tests nhưng không cung cấp Sandbox E2E mới. Khang bổ sung credential/public HTTPS IPN và evidence Sandbox hiện hành theo phân công. Không tìm thấy Jira/Leader record xác nhận tổng thể A1; chỉ xác nhận được phạm vi ADR và PR history, không suy diễn trạng thái Done. Không dùng synthetic config/Mock làm Sandbox PASS.

## 11. Kịch bản demo end-to-end A1

Kịch bản demo được đề xuất để **kiểm chứng tại máy local đã chuẩn bị an toàn** (không tự hiểu là tất cả bước đã được thực hiện ở baseline README):

1. Khởi động Docker Compose hoặc host local theo cấu hình đã xác minh, kiểm tra backend, frontend và dữ liệu menu.
2. Trên trình duyệt, xem menu, chọn sản phẩm, size/topping; thêm, sửa số lượng và kiểm tra tổng tiền giỏ hàng.
3. Đăng ký/đăng nhập tài khoản test, tạo đơn; xác nhận mã đơn, tổng tiền và trạng thái ban đầu.
4. Kiểm tra thanh toán **Mock** trong môi trường được phép và xác nhận đơn/lịch sử tương ứng.
5. Với **VNPay Sandbox**: dùng merchant test được phép, backend local có public HTTPS IPN (ví dụ tunnel ngrok đã cấu hình); chạy giao dịch test, xác minh IPN, trạng thái Payment/Order ở server/DB. Không lấy browser Return hay query string làm bằng chứng đã thanh toán.
6. Kiểm tra các case đặc biệt nếu nằm trong checklist kiểm thử: ZERO_AMOUNT, payment retry/idempotency, hết hạn đơn, payment failure và QueryDR theo phạm vi ADR.
7. Lưu **bằng chứng đã lọc secret**: commit/branch, thời điểm, môi trường, bước thử, expected/actual, HTTP status, Payment/Order status và ảnh UI khi có thể.

**Chú ý:** Payment Status API `GET /payments/:paymentId/status` còn thiếu trong backend tại lần review được ghi ở SCRUM-94. Khi demo Return, kiểm tra trạng thái thực tế từ backend/DB và ghi nhận giới hạn UI; **không tuyên bố phần UI refresh/payment status PASS** nếu chưa được sửa và test. QueryDR Sandbox E2E đã được hoãn sang A2 theo ADR APPROVED, không bắt buộc chuyển thành PASS của A1.

### 11.1. Bằng chứng demo VNPay cần bổ sung bởi người chạy local

- Xác nhận đã chạy đúng commit/branch, chế độ môi trường, FE/BE URL và IPN public HTTPS.
- ID giao dịch chỉ công bố ở mức mã thử nghiệm không chứa token/chữ ký; thời gian, số tiền test và nhánh thành công/thất bại.
- `IPN RspCode`, trạng thái Payment/Order, sự kiện finalization, kết quả Return phía UI và tình trạng các chức năng còn giới hạn.
- Phân biệt bằng chứng lịch sử ở [ADR APPROVED](docs/decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md) với lượt rerun mới; không ghi rerun đã xảy ra nếu chưa chạy.

---

## 12. Kiểm thử theo lớp và bằng chứng

Chạy lệnh từ đúng thư mục package:

```bash
# Backend unit/service
cd backend
npm test

# Backend HTTP/Nest E2E (không phải browser E2E)
npm run test:e2e

# Backend PostgreSQL integration
npm run test:integration

# Frontend Node/JSDOM test suite
cd ../frontend
npm test

# Production build
npm run build
```

Backend PostgreSQL integration cần database test disposable đã migrate và các biến AUTH_TEST_DATABASE_URL / ORDERS_TEST_DATABASE_URL phù hợp. Một số suite có guard cố định `localhost:5433/brewlite_test`; không chạy trên DB dùng chung hoặc nới guard. Có thể đáp ứng guard trong Docker bằng cách chạy PostgreSQL và test runner trong cùng network namespace riêng, không publish cổng host. Lượt SCRUM-94 với `PAYMENT_CONCURRENCY_TESTS=1` đã xác minh database identity `brewlite_test`, server port 5433, 9 migrations và kết nối runner trước test; ba file concurrency-related cho kết quả 83 passed, 0 failed, 0 skipped, gồm 23 test trong các gate. Kết quả này là lần chạy riêng, chồng lấp một phần với lượt integration chọn lọc trước đó (147 passed, 10 skipped), nên không cộng hai bộ số liệu. Xem [concurrency log](docs/verification/SCRUM94_Concurrency_Test_Safe.log).

Frontend npm test chạy Node test runner với JSDOM, không phải browser thật. Suite payment-confirmation-flow khởi động backend và PostgreSQL test, cần DATABASE_URL hoặc ORDERS_TEST_DATABASE_URL cùng cổng API trống; test tạo database riêng brewlite_scrum69_test_db. Lần host chạy ban đầu thiếu biến DB nên có 2 cancelled; rerun trong Docker task-local không sửa guard và đạt 174 passed, 0 failed, 0 cancelled, 0 skipped. Không dùng kết quả này làm Browser/Sandbox E2E.

## 13. Hạn chế và rủi ro đã biết

- Backend hiện chưa có GET /payments/:paymentId/status dù API Contract v4.0 §5 và frontend payment service cần endpoint protected, owner-scoped. Probe direct/proxy 404 chạy trên source fb293e2; static inventory sau sync origin/dev dba36a5 vẫn không thấy route. JWT/ownership cases chưa chạy vì route chưa có.
- POST qua frontend same-origin proxy từng báo 502 trong host smoke, nhưng Next host và Compose rerun đều trả 201 cả direct và proxy với backend URL đúng môi trường. Lỗi cũ chưa tái hiện, nguyên nhân chưa xác định; không quy cho implementation hay gán owner.
- ADR A1 APPROVED ghi nhận IPN Sandbox thật đã thành công trong nghiệm thu SCRUM-81 lịch sử. Verifier Compose sau sync chỉ gọi local initiation/replay với config VNPay synthetic; không redirect, không gửi IPN/QueryDR hoặc gọi VNPay. Vì vậy SCRUM-94 chưa có Sandbox E2E mới; Khang bổ sung credential, public HTTPS IPN và evidence hiện hành. QueryDR Sandbox E2E chuyển sang A2/SCRUM-95 theo ADR; không dùng Mock/synthetic để claim PASS.
- Sau sync, isolated SCRUM-92 verifier chạy tại checkout HEAD 304a7c6 bằng docker-compose.yml mặc định với project/DB/cổng riêng, NODE_ENV=test, scheduler tắt và VNPay synthetic. Build/health, migration/seed, FE→BE→PostgreSQL, đăng ký/đăng nhập, tạo Order, Mock guard, ZERO_AMOUNT, initiation/replay nội bộ và persistence sau restart đạt. Không redirect/gọi gateway; không phải production hoặc Sandbox PASS. Lượt Compose thường ở fb293e2 thiếu VNPAY_TMN_CODE là kết quả lịch sử riêng. Evidence: docs/verification/SCRUM94_Verification_Evidence.md. Không tự kết luận SCRUM-92 Done.
- Kết quả test hiện hành và các phần BLOCKED được ghi tại docs/verification/SCRUM94_Verification_Evidence.md.

## 14. Troubleshooting

| Triệu chứng                                           | Cách kiểm tra                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm ci báo EBADENGINE                                 | Kiểm tra node --version; dùng Node 22.22.3+ hoặc 26 khớp Dockerfile. Không dùng npm install để thay lockfile.                                                                                                                                       |
| Prisma P1001 / không kết nối DB                       | Kiểm tra DATABASE_URL, host/port thực tế và database name; host local dùng 127.0.0.1 và port Postgres đang chạy, Compose dùng postgres:5432. Không sửa/reset DB dùng chung.                                                                         |
| db:seed từ chối chạy                                  | Seed chỉ allowlist brewlite*seed*\* hoặc Compose DB đã duyệt với flag một lần; xác nhận đúng database rỗng và không có sản phẩm ngoài catalog demo.                                                                                                 |
| Compose preflight nêu biến xung đột                   | Xóa biến export trùng theo hướng dẫn script, chạy lại preflight; không để shell ghi đè compose.env.                                                                                                                                                 |
| Compose migrate/backend không healthy                 | Xem logs postgres/migrate/backend; xác minh host postgres:5432 trong DATABASE_URL, migration exit 0, credentials reconciliation hợp lệ. Healthcheck / chỉ là liveness.                                                                              |
| POST /api/backend/\* trả 502                          | So sánh method/path và BACKEND_INTERNAL_URL, rồi gửi cùng request tới backend trực tiếp. POST đăng ký từng báo 502 nhưng lần Compose kiểm tra lại trả 201 qua cả hai đường; root cause chưa xác định. Không log Authorization hoặc request secrets. |
| Return URL hiển thị SUCCESS nhưng backend còn PENDING | Không tin query của Return. Kiểm tra IPN/QueryDR và trạng thái DB; hiện thiếu payment status endpoint cho UI.                                                                                                                                       |
| VNPay QueryDR trả 99                                  | Không coi là giao dịch thất bại hoặc thành công; lưu response đã lọc secret, theo dõi SCRUM-95/ADR và giữ Payment không kết luận nếu chưa có evidence hợp lệ.                                                                                       |

## 15. Tài liệu liên quan

- [API Contract v4.0](docs/api/BrewLite_API_Contract_v4.0.md)
- [Requirements v3.1](docs/docs_Phase2/BrewLite_Requirements_Specification_v3.1.docx)
- [US/AC Phase 2](docs/docs_Phase2/BrewLite_User_Stories_Acceptance_Criteria_Phase2.docx)
- [Use Case v3.1](docs/docs_Phase2/BrewLite_Use_Case_Specification_v3.1_VNPay_Phase_2%20.pdf)
- [ERD/Prisma Delta v0.2.2](docs/docs_Phase2/BrewLite_ERD_Prisma_Delta_Phase2_v0.2.2_CK-R01-R03_UPDATED.md)
- [Payment Architecture Phase 2](docs/design/payment/BrewLite_Payment_Architecture_Phase2_v1.0.md)
- [Shared Payment Finalization handoff](docs/design/payment/Shared_Payment_Finalization_Handoff_SCRUM-78.md)
- [Concurrency test handoff](docs/design/payment/Payment_Finalization_Concurrency_Test_Handoff_SCRUM-79.md)
- [Docker Compose setup and limitations](docs/Docker_Compose.md)
- [SCRUM-92 clean setup verification](docs/verification/SCRUM92_Docker_Clean_Setup_Verification.md)
- [Optional dev Compose coupon seed](backend/prisma/README-dev-compose-coupons.md)
- [VNPay Sandbox setup](docs/integration/VNPay_Sandbox_Setup.md)
- [QueryDR Sandbox E2E deferral decision](docs/decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md)
- [Verification evidence SCRUM-94](docs/verification/SCRUM94_Verification_Evidence.md)

## 16. Kiểm tra trước khi đóng băng Assignment 1

Checklist này chỉ có ý nghĩa khi người phụ trách **đánh dấu dựa trên kết quả thực tế**; các ô chưa đánh dấu không phải là minh chứng thất bại cũng không phải PASS:

- [ ] Xác nhận bảng thành viên/đóng góp, vai trò Scrum (nếu đã phân công), liên kết Jira board chính xác.
- [ ] Đối chiếu README với code/Swagger/API Contract tại commit cuối; phân loại rõ sai lệch `GET /payments/:paymentId/status` và quyết định sửa hoặc ghi nhận giới hạn nghiệm thu.
- [ ] Chạy lại các quality checks áp dụng cho baseline cuối; không lấy log từ commit cũ thay thế test mới.
- [ ] Xác nhận hướng dẫn setup DB/seed/Compose trên một môi trường sạch và không tác động database dùng chung.
- [ ] Người phụ trách local bổ sung/đối chiếu bằng chứng VNPay Sandbox và screenshot thực tế; không commit secret hoặc URL có chữ ký.
- [ ] Giữ QueryDR Sandbox E2E ở trạng thái **DEFERRED → A2/SCRUM-95** theo ADR APPROVED trừ khi có quyết định thay đổi chính thức.
- [ ] Reviewer kiểm tra toàn bộ link/tài liệu, PR cuối được merge đúng nhánh, Jira có quyết định nghiệm thu rõ.
- [ ] Đồng bộ/phát hành baseline A1 theo quy trình nhóm, xác nhận commit được tag `A1-final` là commit cuối cùng đã kiểm thử; không gắn tag trước khi đạt các điều kiện.

> **Nguyên tắc bàn giao:** README mô tả cách chạy và giới hạn đã biết, không tự thay thế SRS, Use Case, API Contract, hồ sơ kiểm thử hoặc quyết định nghiệm thu trên Jira. A1 hiện sử dụng local + Sandbox; URL HTTPS production và CI/CD deploy thuộc phạm vi Assignment 2, không được tuyên bố đã có ở A1.
