# BrewLite — Phase 2

BrewLite là ứng dụng web đặt đồ uống cho đồ án Công nghệ phần mềm. Phase 2 bổ sung thanh toán VNPay Sandbox và các quy tắc xử lý Payment/Order; hệ thống vẫn chạy như một ứng dụng Next.js, một backend NestJS và PostgreSQL. Không xử lý tiền thật.

README mô tả source hiện tại, không thay thế tiêu chí nghiệm thu. Bằng chứng theo commit code được khảo sát nằm tại [Verification Evidence SCRUM-94](docs/verification/SCRUM94_Verification_Evidence.md). Báo cáo đồ án đang được chuẩn bị ở dạng bản nháp Markdown vì repository chưa có báo cáo chính để chỉnh sửa trực tiếp.

## Phạm vi và tình trạng

Source hiện có menu, đăng ký/đăng nhập JWT, tạo đơn và lịch sử đơn; coupon/loyalty; thanh toán Mock giữ tương thích Phase 1; VNPay initiation, public IPN, QueryDR client/scheduler, ZERO_AMOUNT, expiration và shared payment finalization.

Các trạng thái này cần được đọc riêng:

- **Implementation:** có controller/service/schema/script trong source.
- **Test:** automated tests chỉ chứng minh các nhánh và môi trường mà chúng chạy; Mock hoặc giả lập gateway không chứng minh Sandbox E2E.
- **Nghiệm thu:** quyết định Leader/PR/Jira. README này không tự chuyển task sang Done.

Tại code commit được kiểm tra, frontend có gọi GET /payments/:paymentId/status sau VNPay Return nhưng backend chưa có route đó. Một smoke trước đó ghi POST đăng ký qua proxy là 502, còn POST trực tiếp là 201; hai rerun hiện tại (Next host với BACKEND_INTERNAL_URL=http://127.0.0.1:3002 và Compose với backend:3001) đều trả 201 qua proxy lẫn direct. Vì vậy 502 trước đó chưa tái hiện và chưa đủ căn cứ quy cho implementation hoặc một owner; nguyên nhân vẫn chưa xác định. Chi tiết expected/actual và log an toàn nằm trong [SCRUM-94 evidence](docs/verification/SCRUM94_Verification_Evidence.md).

## Stack và cấu trúc

- Node.js: Dockerfiles dùng Node 26. Một số dependency trong lockfile yêu cầu Node 22.22.2/22.22.3 trở lên; Node 22.18.0 đã phát cảnh báo EBADENGINE khi kiểm chứng. Dùng Node 26 để khớp container hoặc Node 22.22.3 trở lên.
- npm: dùng npm ci theo package-lock.json; không nâng dependency chỉ để chạy tài liệu này.
- Frontend: Next.js 16.3.8, React 19.2.8, TypeScript và Tailwind CSS.
- Backend: NestJS 12, TypeScript 6, Prisma 7.10.1.
- Database: PostgreSQL 18; Compose dùng postgres:18-alpine.
- Containers: Docker Compose; service postgres, migrate, backend, frontend.

~~~text
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
~~~

Nguồn baseline và tài liệu kỹ thuật được liệt kê ở [Tài liệu liên quan](#tài-liệu-liên-quan).

## Chạy local trên host

### Điều kiện

Cần Git, Node.js/npm, PostgreSQL 18 và hai terminal. Xác nhận phiên bản và cổng trước khi chạy:

~~~bash
node --version
npm --version
psql --version
~~~

Dùng một database riêng cho bản demo. Không dùng database dùng chung, production, brewlite_db hoặc brewlite_seed_hoang. Tên database để chạy seed phải theo mẫu brewlite_seed_<suffix>, vì seed có allowlist riêng. Ví dụ dưới đây tạo database rỗng; thay my_local_postgres_role bằng role local của bạn:

~~~bash
createdb -h 127.0.0.1 -p 5432 -U my_local_postgres_role brewlite_seed_local
~~~

### Cấu hình backend

Từ thư mục repository root:

~~~bash
cd backend
npm ci
if [ ! -f .env ]; then cp .env.example .env; fi
~~~

Trong PowerShell, thay lệnh cuối bằng:

~~~powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
~~~

Chỉ tạo file nếu chưa có; không ghi đè cấu hình local. Mở backend/.env và thay toàn bộ giá trị mẫu. Đặc biệt, DATABASE_URL trong file mẫu trỏ tới brewlite_db tại port 5433; tuyệt đối không chạy migration hoặc seed trước khi thay bằng database disposable riêng của bạn, ví dụ brewlite_seed_local trên PostgreSQL local. URL của host dùng địa chỉ host như 127.0.0.1:<port>; không dùng tên service Docker postgres.

Các biến:

| Biến | Phân loại | Mục đích |
| --- | --- | --- |
| DATABASE_URL | Backend private, runtime và Prisma CLI | PostgreSQL mà backend, generate/validate/migrate/seed sử dụng. Xác minh host, port, tên DB trước mọi lệnh ghi dữ liệu. |
| JWT_SECRET | Backend private, runtime | Chuỗi ngẫu nhiên tối thiểu 32 bytes; không đưa sang frontend. |
| INTERNAL_SECRET | Backend private, runtime | Secret riêng cho internal order advance; khác JWT_SECRET. |
| PORT | Backend runtime | Mặc định 3001 trên host. |
| MOCK_PAYMENT_ENABLED | Backend runtime | Mặc định tắt; chỉ đặt true cho local/test/demo ngoài production. Không tự fallback từ VNPay. |
| ORDER_EXPIRATION_ENABLED / ORDER_EXPIRATION_BATCH_SIZE | Backend runtime | Worker hết hạn đơn; cấu hình mẫu bật worker. |
| VNPAY_TMN_CODE / VNPAY_HASH_SECRET | Backend private, runtime | Merchant và HashSecret Sandbox; không commit, log hoặc đặt ở frontend. |
| VNPAY_PAYMENT_URL / VNPAY_RETURN_URL | Backend runtime | URL thanh toán Sandbox và trang frontend nhận browser return. Với Compose production runtime, HTTP localhost Return chỉ được phép khi VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true; dùng HTTPS cho endpoint public. |
| VNPAY_QUERYDR_URL / VNPAY_QUERYDR_TIMEOUT_MS | Backend private, runtime | Client QueryDR; cần endpoint/cấu hình hợp lệ khi bật reconciliation. |
| VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL | Backend runtime, optional | Chỉ để Compose production runtime cho phép Return URL HTTP trên localhost; không cho phép endpoint public HTTP. |
| PAYMENT_RECONCILIATION_ENABLED và PAYMENT_RECONCILIATION_* | Backend runtime | Scheduler, lease, cooldown, batch và IP server. Với host local không có cấu hình Sandbox, đặt enabled=false rõ ràng; không dùng cách này cho production. |

Giữ các secret chỉ trong backend/.env. Không lưu JWT, cookie, Authorization header, password, HashSecret hoặc URL có chữ ký trong log/evidence.

### Generate, migrate, seed và chạy

Từ backend/ sau khi đã thay DATABASE_URL:

~~~bash
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
npm run start:dev
~~~

db:generate tạo Prisma Client theo schema; không thay migration. db:migrate chạy prisma migrate deploy và chỉ áp dụng migration chưa chạy. Không dùng migrate reset hoặc db push để sửa drift.

db:seed chỉ được chạy khi DATABASE_URL trỏ tới DB có tên brewlite_seed_<suffix>, hoặc Compose database được allowlist chính xác. Trước khi seed, xác nhận database rỗng về catalog và đã có migrations. Seed upsert 4 categories, 9 products và 5 toppings; cập nhật tên/giá/hình ảnh catalog mẫu, tạo liên kết sản phẩm–topping, giữ stock và trạng thái availability hiện có. Seed từ chối catalog có product ID ngoài danh sách mẫu; không xóa dữ liệu cũ và không sửa Order/Payment. Seed không tạo user. Seed lại có thể cập nhật giá/tên catalog mẫu. Không dùng database có dữ liệu nghiệp vụ.

Mở terminal khác từ repository root để chạy frontend:

~~~bash
cd frontend
npm ci
if [ ! -f .env.local ]; then cp .env.example .env.local; fi
~~~

Trong PowerShell, chỉ tạo file nếu chưa có:

~~~powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
~~~

Nếu frontend/.env.local đã tồn tại, sửa các giá trị hiện có thay vì ghi đè. Trong frontend/.env.local, khi frontend và backend chạy trên host, dùng:

~~~dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
BACKEND_INTERNAL_URL=http://127.0.0.1:3001
~~~

Trong PowerShell, khi backend và frontend ở cùng máy:

~~~powershell
$env:NEXT_PUBLIC_API_URL = 'http://localhost:3001'
$env:BACKEND_INTERNAL_URL = 'http://127.0.0.1:3001'
npm run dev
~~~

NEXT_PUBLIC_API_URL là biến public có thể được nhúng lúc build; không đặt secret vào đây. BACKEND_INTERNAL_URL là runtime server-only cho Next Route Handler/SSR. Khi chạy trong Compose, server-side URL phải là http://backend:3001; trình duyệt dùng localhost:3000 và đường dẫn same-origin /api/backend/*.

Khởi động frontend bằng npm run dev. Mặc định frontend ở http://localhost:3000; backend ở http://localhost:3001. Backend GET / là liveness, không query PostgreSQL. GET /api-docs mở Swagger.

Kiểm tra thủ công từ host:

~~~bash
curl --fail http://localhost:3001/
curl --fail http://localhost:3001/api-docs
curl --fail http://localhost:3000/api/backend/products
~~~

Kết quả catalog kỳ vọng gồm 9 items sau seed. Smoke Compose SCRUM-94 mới nhất nhận GET 200 và POST đăng ký 201 qua same-origin proxy; Next dev trên host với cấu hình backend đích tương ứng cũng trả POST 201, giống backend trực tiếp. Kết quả 502 từ lượt host smoke trước chưa tái hiện. Nếu gặp 502, so sánh đúng method/path, BACKEND_INTERNAL_URL và lệnh direct với proxy; xem [evidence](docs/verification/SCRUM94_Verification_Evidence.md), không suy đoán lỗi database.

## Chạy bằng Docker Compose

Dockerfile dùng Node 26; Compose tạo project, network, container, database và named volume riêng theo project name. Host ports được cố định: frontend 3000, backend 3001, PostgreSQL 55432. Project name riêng không đổi các port này; kiểm tra port trước khi start và không đụng tới project/volume khác.

Compose dùng compose.env, không tự đọc backend/.env hoặc frontend/.env.local. Từ root, chỉ tạo compose.env nếu file chưa có; nếu đã có, cập nhật file hiện tại để tránh ghi đè cấu hình local:

~~~bash
if [ ! -f compose.env ]; then cp compose.env.example compose.env; fi
~~~

Trong PowerShell: if (!(Test-Path compose.env)) { Copy-Item compose.env.example compose.env }. Điền giá trị local cho POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, DATABASE_URL, JWT_SECRET và INTERNAL_SECRET. Username/password/database trong DATABASE_URL phải khớp POSTGRES_*; trong network, URL bắt buộc dùng host postgres và port 5432. Host kết nối DB qua 127.0.0.1:55432.

Compose backend dùng image runtime production và mặc định bật Payment Reconciliation. Muốn khởi động backend theo cấu hình này cần Sandbox merchant/secret cùng QueryDR endpoint, IP và lease hợp lệ; placeholder trong `compose.env.example` không phải credential. Không tắt reconciliation để bỏ qua production guard.

Lượt SCRUM-94 ngày 07/11/2026 trên commit `fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0` chạy Compose mặc định trong project/database/volume task-local. Build ba image, PostgreSQL health, 9 migrations và manual seed đều đạt. Backend không đạt health vì thiếu `VNPAY_TMN_CODE`; frontend phụ thuộc backend healthy nên chưa khởi động. Vì project `brewlite_compose` của người dùng đang chạy trên cổng 3000/3001/55432, lượt này chỉ remap host ports của project tạm sang 39000/39001/39432; service config/runtime vẫn từ `docker-compose.yml`. Kết quả chi tiết ở [default Compose evidence](docs/verification/SCRUM94_Docker_Default_Safe.log). Đây không phải production pass.

Lượt smoke ứng dụng riêng trước đó dùng development override: `NODE_ENV=development`, `ORDER_EXPIRATION_ENABLED=false`, `PAYMENT_RECONCILIATION_ENABLED=false`, `MOCK_PAYMENT_ENABLED=true`, cùng host port riêng. Các thay đổi này cho phép chạy luồng demo mà không cần scheduler/credential Sandbox và bật provider Mock; build, đăng nhập, tạo đơn, Mock, lịch sử và persistence chỉ được xác nhận trong môi trường development tạm. Không suy kết quả đó thành production hoặc Sandbox.

Chọn một tên project riêng và dùng nhất quán cho mọi lệnh, ví dụ brewlite-local-a7f3. Tài liệu Compose chi tiết cũng yêu cầu preflight để ngăn exported shell variables ghi đè compose.env. Dùng Git Bash/WSL có bash:

~~~bash
bash scripts/compose-preflight-env.sh
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env config --services
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env up --build -d
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env logs --tail 100 postgres migrate backend frontend
~~~

Migration service đợi PostgreSQL health rồi chạy db:migrate; backend chỉ start sau migrate thành công; frontend đợi backend health. Backend/frontend healthcheck hiện chỉ gọi GET /, không xác nhận kết nối database. Đọc log của migrate và gọi GET /api/backend/products để kiểm tra ứng dụng với dữ liệu đã seed.

Seed Compose là thao tác riêng, không tự chạy khi up. Trước khi seed, dùng lệnh và checklist trong [Docker Compose guide](docs/Docker_Compose.md) để xác minh đúng project/database, 9 migrations và chưa có products. Chỉ seed DB demo riêng bằng lệnh đúng allowlist:

~~~bash
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed
~~~

Logs, stop, start lại và kiểm tra persistence:

~~~bash
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env logs --tail 100 backend frontend
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env stop
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env start
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env restart
bash scripts/compose-preflight-env.sh && docker compose -p brewlite-local-a7f3 --env-file compose.env ps
~~~

Named volume giữ PostgreSQL data qua stop/start. Không dùng down -v hoặc prune để dọn project khi chưa xác minh đúng tài nguyên; nếu xóa containers/network bằng down, phải giữ named volume cần thiết.

## VNPay Sandbox

Chỉ dùng merchant Sandbox và dữ liệu test. Thiết lập VNPAY_TMN_CODE, VNPAY_HASH_SECRET, VNPAY_PAYMENT_URL, VNPAY_RETURN_URL trong backend environment riêng của người chạy. VNPAY_RETURN_URL trỏ tới frontend /payment, ví dụ http://localhost:3000/payment khi chạy local; trong runtime production phải bật VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL=true mới cho HTTP localhost.

POST /payments/vnpay/initiate tạo attempt VNPay PENDING và URL đã ký. Browser được redirect sang VNPay rồi quay về Return URL. Return chỉ là điều hướng trình duyệt; query parameters không phải bằng chứng thanh toán. Backend IPN và QueryDR đã xác minh là nguồn tài chính; chúng đi qua shared finalization. Không đánh dấu Payment SUCCESS chỉ vì người dùng trở về trang web.

IPN là GET /payments/vnpay/ipn và không cần Customer JWT. VNPay phải gọi được backend qua public HTTPS. Backend chạy trên laptop thường cần HTTPS tunnel hoặc backend test đã public; URL callback được khai báo trong cấu hình merchant Sandbox, không phải biến VNPAY_IPN_URL trong repo. Không mở tunnel nếu chưa có merchant/test authorization và chưa xác minh đúng route. QueryDR dùng server-side credentials, signature validation và scheduler; không gọi bằng trình duyệt.

Frontend hiện cần GET /payments/:paymentId/status để đọc trạng thái sau return nhưng endpoint này chưa được tìm thấy trong backend. Vì vậy chưa thể xác nhận luồng UI Return-to-authoritative-status trên source hiện tại. ADR hiện hành cũng ghi QueryDR Sandbox trả 99/Unexpected error và chuyển E2E QueryDR sang SCRUM-95. Không thay Sandbox bằng Mock để tuyên bố Sandbox PASS.

## Kiểm thử theo lớp

Chạy lệnh từ đúng thư mục package:

~~~bash
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
~~~

Backend PostgreSQL integration cần database test disposable đã migrate và các biến AUTH_TEST_DATABASE_URL / ORDERS_TEST_DATABASE_URL phù hợp. Một số suite có guard cố định `localhost:5433/brewlite_test`; không chạy trên DB dùng chung hoặc nới guard. Có thể đáp ứng guard trong Docker bằng cách chạy PostgreSQL và test runner trong cùng network namespace riêng, không publish cổng host. Lượt SCRUM-94 với `PAYMENT_CONCURRENCY_TESTS=1` đã xác minh database identity `brewlite_test`, server port 5433, 9 migrations và kết nối runner trước test; ba file concurrency-related cho kết quả 83 passed, 0 failed, 0 skipped, gồm 23 test trong các gate. Kết quả này là lần chạy riêng, chồng lấp một phần với lượt integration chọn lọc trước đó (147 passed, 10 skipped), nên không cộng hai bộ số liệu. Xem [concurrency log](docs/verification/SCRUM94_Concurrency_Test_Safe.log).

Frontend npm test chạy Node test runner với JSDOM, không phải browser thật. Suite payment-confirmation-flow khởi động backend và PostgreSQL test, cần DATABASE_URL hoặc ORDERS_TEST_DATABASE_URL cùng cổng API trống; test tạo database riêng brewlite_scrum69_test_db. Lần host chạy ban đầu thiếu biến DB nên có 2 cancelled; rerun trong Docker task-local không sửa guard và đạt 174 passed, 0 failed, 0 cancelled, 0 skipped. Không dùng kết quả này làm Browser/Sandbox E2E.

## Hạn chế hiện tại

- Backend chưa có GET /payments/:paymentId/status dù API Contract v4.0 §5 và frontend payment service cần endpoint đọc trạng thái authoritative sau VNPay Return.
- POST qua frontend same-origin proxy từng báo 502 trong host smoke, nhưng Next host và Compose rerun đều trả 201 cả direct và proxy với backend URL đúng môi trường. Lỗi cũ chưa tái hiện, nguyên nhân chưa xác định; không quy cho implementation hay gán owner.
- VNPay Sandbox và QueryDR Sandbox E2E chưa được xác minh trong SCRUM-94; Khang bổ sung phần Sandbox/credential/public IPN/QueryDR Sandbox E2E theo phân công đã thống nhất. ADR-P2-QueryDR-Sandbox-E2E-Deferred.md vẫn ghi nhận lần QueryDR 99/Unexpected error và SCRUM-95; không dùng Mock thay thế Sandbox.
- Docker CLI có trong PATH dưới thư mục cài Docker Desktop user-local; sandbox từ chối đọc/chạy trực tiếp path này, còn Docker CLI/Engine hoạt động khi kiểm tra bằng quyền được cấp. Compose mặc định đã build/migrate/seed nhưng backend bị chặn bởi cấu hình Sandbox còn thiếu; development override trước đó kiểm chứng được luồng API/Mock và persistence. Hai kết quả này không phải SCRUM-92 acceptance hoặc Sandbox E2E. Trạng thái task/Leader approval không được thay đổi.
- Kết quả test hiện hành và các phần BLOCKED được ghi tại docs/verification/SCRUM94_Verification_Evidence.md.

## Troubleshooting

| Triệu chứng | Cách kiểm tra |
| --- | --- |
| npm ci báo EBADENGINE | Kiểm tra node --version; dùng Node 22.22.3+ hoặc 26 khớp Dockerfile. Không dùng npm install để thay lockfile. |
| Prisma P1001 / không kết nối DB | Kiểm tra DATABASE_URL, host/port thực tế và database name; host local dùng 127.0.0.1 và port Postgres đang chạy, Compose dùng postgres:5432. Không sửa/reset DB dùng chung. |
| db:seed từ chối chạy | Seed chỉ allowlist brewlite_seed_* hoặc Compose DB đã duyệt với flag một lần; xác nhận đúng database rỗng và không có sản phẩm ngoài catalog demo. |
| Compose preflight nêu biến xung đột | Xóa biến export trùng theo hướng dẫn script, chạy lại preflight; không để shell ghi đè compose.env. |
| Compose migrate/backend không healthy | Xem logs postgres/migrate/backend; xác minh host postgres:5432 trong DATABASE_URL, migration exit 0, credentials reconciliation hợp lệ. Healthcheck / chỉ là liveness. |
| POST /api/backend/* trả 502 | So sánh method/path và BACKEND_INTERNAL_URL, rồi gửi cùng request tới backend trực tiếp. POST đăng ký từng báo 502 nhưng lần Compose kiểm tra lại trả 201 qua cả hai đường; root cause chưa xác định. Không log Authorization hoặc request secrets. |
| Return URL hiển thị SUCCESS nhưng backend còn PENDING | Không tin query của Return. Kiểm tra IPN/QueryDR và trạng thái DB; hiện thiếu payment status endpoint cho UI. |
| VNPay QueryDR trả 99 | Không coi là giao dịch thất bại hoặc thành công; lưu response đã lọc secret, theo dõi SCRUM-95/ADR và giữ Payment không kết luận nếu chưa có evidence hợp lệ. |

## Tài liệu liên quan

- [API Contract v4.0](docs/api/BrewLite_API_Contract_v4.0.md)
- [Requirements v3.1](docs/docs_Phase2/BrewLite_Requirements_Specification_v3.1.docx)
- [US/AC Phase 2](docs/docs_Phase2/BrewLite_User_Stories_Acceptance_Criteria_Phase2.docx)
- [Use Case v3.1](docs/docs_Phase2/BrewLite_Use_Case_Specification_v3.1_VNPay_Phase_2%20.pdf)
- [ERD/Prisma Delta v0.2.2](docs/docs_Phase2/BrewLite_ERD_Prisma_Delta_Phase2_v0.2.2_CK-R01-R03_UPDATED.md)
- [Payment Architecture Phase 2](docs/design/payment/BrewLite_Payment_Architecture_Phase2_v1.0.md)
- [Shared Payment Finalization handoff](docs/design/payment/Shared_Payment_Finalization_Handoff_SCRUM-78.md)
- [Concurrency test handoff](docs/design/payment/Payment_Finalization_Concurrency_Test_Handoff_SCRUM-79.md)
- [Docker Compose setup and limitations](docs/Docker_Compose.md)
- [VNPay Sandbox setup](docs/integration/VNPay_Sandbox_Setup.md)
- [QueryDR Sandbox E2E deferral decision](docs/decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md)
- [Verification evidence SCRUM-94](docs/verification/SCRUM94_Verification_Evidence.md)
