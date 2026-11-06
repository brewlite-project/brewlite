# SCRUM-94 Verification Evidence

**Ngày chạy:** 06–07/11/2026 (Asia/Bangkok)
**Code commit:** fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0 (SCRUM-94 branch HEAD)
**Branch kiểm tra:** SCRUM-94-phase2-readme-report
**Môi trường:** Windows; host checks Node v22.18.0/npm 10.9.3; Docker Desktop 4.97.0, Engine 29.9.2, Compose 5.6.1; clean test container Node v26.13.0; PostgreSQL 18. Docker CLI có trong PATH dưới thư mục cài user-local Docker Desktop nhưng sandbox từ chối truy cập; các kiểm tra CLI/Engine thành công khi chạy với quyền đã cấp.
**DB:** PostgreSQL 18 trong Compose project scrum94_p2_20261106_a7f3, network/volume riêng; brewlite_seed_scrum94_docker cho migrate/seed/runtime; brewlite_scrum69_test_db được suite tạo bên trong cùng server tạm. Không dùng brewlite_db, brewlite_seed_hoang hoặc DB dùng chung. Không ghi DB URL, JWT, cookie, Authorization, password, HashSecret hay signed URL vào evidence.

**Giới hạn mốc source:** HEAD được kiểm tra là `fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0`. Remote-tracking `origin/dev` đang ở `1a67a0c`, cao hơn 4 commit; phần chênh có PR #139 với `backend/package.json` và helper seed coupon cho Compose. Không fast-forward/rebase vì lượt này chỉ được phép cập nhật tài liệu và không sửa dependency/seed. Mọi test/evidence trong file chỉ áp dụng cho HEAD nêu trên. Trước Draft PR cần đồng bộ branch theo quy trình nhóm, đối chiếu README với helper mới nếu được giữ lại và kiểm tra lại các lệnh bị ảnh hưởng.

Các summary dưới đây được ghi từ output của command/test trên cùng commit. Đây là log đã lọc để không lưu thông tin nhạy cảm; không có screenshot.

## Thiết lập sạch

| Case / mong đợi | Kết quả thực tế | Trạng thái |
| --- | --- | --- |
| npm ci backend và frontend theo lockfile | backend cài 529 packages, frontend 403 packages; trên Node 22.18.0 npm phát EBADENGINE do một số package yêu cầu Node 22.22.2/22.22.3+ hoặc 26 | PASS với cảnh báo engine |
| Prisma Client | npm run db:generate tạo Prisma Client 7.10.1 trong worktree | PASS |
| Prisma schema | npm run db:validate | PASS |
| Migrations | npm run db:migrate trên DB task-local; 9 migrations áp dụng | PASS |
| Seed | npm run db:seed; 4 categories, 9 products, 5 toppings; no legacy products | PASS |
| Seed DB kiểm tra | Trước seed: 9 migrations, 4 categories, 0 products/toppings/orders/payments. Sau seed: 9 migrations, 4 categories, 9 products, 5 toppings, 0 orders/payments. Những đơn/tài khoản test về sau chỉ ở DB task-local và không lưu PII. | PASS |
| Docker images | Build migrate/backend/frontend từ source; Prisma Client 7.10.1 generate trong build image, Nest build và Next build hoàn tất; Next tạo 11/11 static pages. | PASS; npm audit có advisory, không sửa dependency |

## Build và test

| Lệnh/case | Mong đợi | Kết quả thực tế |
| --- | --- | --- |
| backend npm run build | Nest build hiện tại thành công | PASS |
| backend npm test | Unit/service suites hiện tại | PASS — 33 files, 300 tests |
| backend npm run test:e2e | Nest/API tests hiện tại; không phải UI browser | PASS — 10 files, 227 tests |
| backend selected npm run test:integration, gate tắt | PostgreSQL disposable và target name được allowlist | PASS cho phần đã chạy — 9 files, 147 passed, 10 skipped, 0 failed (157 total). 10 skipped là hai payment/promotion concurrency groups khi PAYMENT_CONCURRENCY_TESTS chưa bật; skipped không tính PASS. |
| Backend PostgreSQL concurrency, gate bật | `PAYMENT_CONCURRENCY_TESTS=1`; 3 test files; runner/PostgreSQL dùng chung isolated network namespace, DB `brewlite_test` trên loopback port 5433, 9/9 migration | PASS — 83 passed, 0 failed, 0 skipped; 23 gate-controlled concurrency tests thực chạy. Mã runner exit 0. [Log](SCRUM94_Concurrency_Test_Safe.log). Kết quả chạy riêng, không cộng với 147 của lượt trước. |
| Integration attempt đầu | Test coupon preview yêu cầu DB name dạng brewlite *_test | FAIL setup — 8 files passed, 1 failed; 136 passed, 21 skipped. Tạo DB disposable đúng suffix và chạy lại, không sửa source |
| frontend npm run build | Production bundle/static generation | PASS — compiled; 11/11 static pages generated |
| frontend 5 JSDOM files | checkout-flow, payment-ui, order-history, order-confirmation, vnpay-ui-flow | PASS — 5 files, 166 tests passed, 0 failed/cancelled/skipped |
| frontend npm test lần host đầu | Bao gồm SCRUM-69 real backend/PostgreSQL integration | Setup không có DATABASE_URL/ORDERS_TEST_DATABASE_URL; 174 total, 172 passed, 0 failed, 2 cancelled, 0 skipped, exit 1. Hai cancelled không tính PASS. |
| frontend npm test rerun trong Docker test container | Cùng suite, SCRUM-69 dùng DB riêng do test guard tạo trong PostgreSQL tạm; không sửa guard | PASS — 174 total, 174 passed, 0 failed, 0 cancelled, 0 skipped; 45 suites. Log đã lọc: [SCRUM94_SCRUM69_Test_Safe.log](SCRUM94_SCRUM69_Test_Safe.log). |

SCRUM-69 trước hết đọc backend/.env nếu có, rồi chọn ORDERS_TEST_DATABASE_URL, AUTH_TEST_DATABASE_URL hoặc DATABASE_URL; thiếu cả ba thì hook hủy hai test real-backend. Khi có URL, suite dùng kết nối admin để tạo database cố định brewlite_scrum69_test_db, chạy prisma migrate deploy, đặt cờ test trong process và bind Nest tới 127.0.0.1:3001. Nó xóa fixture theo ID tạo bởi chính lượt test nhưng không drop database. Rerun chạy bên trong container riêng nên loopback 3001 không đụng listener của host; server/database đều thuộc project SCRUM-94 tạm. Guard và source không đổi.

Lượt selected integration ban đầu giữ gate tắt nên có 10 skipped. Để chạy đúng guard, một PostgreSQL container task-local dùng `network=none`, không có published ports; test runner chia sẻ network namespace bằng `--network container:<postgres-container>`, nên `localhost:5433` trong runner trỏ duy nhất tới DB tạm. Xác nhận từ PostgreSQL và runner: `current_database()=brewlite_test`, `inet_server_port()=5433`, 9 migrations hoàn tất, kết nối runner thành công. Không nới guard, dùng host listener hay DB chung. Với `PAYMENT_CONCURRENCY_TESTS=1`, ba file cho kết quả 83/83 pass; 23 concurrency cases active, không skip.

## Local runtime smoke

**Chuẩn bị:** seed DB task-local; Node processes chỉ dùng cổng 3002/3005; frontend same-origin route trỏ backend task-local. Synthetic credentials/card data được giữ trong tiến trình test và không lưu trong report.

| Case / kỳ vọng | Kết quả thực tế | Trạng thái |
| --- | --- | --- |
| GET catalog trực tiếp backend và qua /api/backend/products; 9 item | 9 items | PASS |
| POST đăng ký qua frontend /api/backend/auth/register; kỳ vọng 201 | Host smoke trước đó báo 502 fetch failed, direct trả 201. Next host rerun với BACKEND_INTERNAL_URL=http://127.0.0.1:3002 và Compose rerun với backend:3001 đều cho proxy/direct POST 201; 502 không tái hiện. Lượt trước có log Next không nhất quán ghi 201. | Rerun PASS; nguyên nhân 502 cũ chưa xác định, không gán implementation/owner |
| Login/create Order/Mock Payment qua Next proxy | Register 201, login 200, order 201 PENDING, Mock payment 200 SUCCESS, Order PAID, GET /orders/me 200 | PASS; Mock/local only, không phải VNPay |
| Restart backend Compose tạm và GET history | Restart chỉ container task SCRUM-94; cùng JWT trong tiến trình đọc lại Order | PASS — Order vẫn PAID sau restart |
| GET /payments/:paymentId/status | API Contract v4.0 §5 khóa GET với Bearer/ownership/DB-only: UUID sai 400, không tồn tại/khác chủ 404, chủ sở hữu 200. Frontend service gọi GET. Backend controller inventory chỉ có POST /payments, POST /payments/vnpay/initiate, GET /payments/vnpay/ipn, POST /payments/zero-amount; không có GET status. Runtime GET direct và proxied đều 404. Probe không gửi JWT để phát hiện route; không chứng minh authenticated not-found behavior theo Contract. | FAIL — implementation gap so với Contract; không gán owner |
| UI browser và screenshot | Không chạy/chụp | BLOCKED — CUA báo `Browsers: Error: The browser access host is unavailable`; dừng UI theo yêu cầu. Cần ảnh thật cho catalog, login, checkout, Mock payment success và order history. |

### Tái hiện tối thiểu: POST proxy 502

- Code commit: `fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0`; API Contract v3.0 §6 quy định public `POST /auth/register` trả `201 Created`. Backend `AuthController` đăng ký POST; Next catch-all proxy nhận POST và chuyển method/body tới `BACKEND_INTERNAL_URL`.
- Request shape tối thiểu trên dữ liệu test dùng một email mới và password test hợp lệ (không lưu giá trị): `POST http://127.0.0.1:<frontend-port>/api/backend/auth/register`, `Content-Type: application/json`, body `{"email":"<unique-test-email>","password":"<test-only-password>","fullName":"SCRUM-94 test"}`. So sánh cùng method/body trực tiếp với `POST http://127.0.0.1:<backend-port>/auth/register`; không ghi body/response có credential vào log.
- Lượt host trước: backend `127.0.0.1:3002`, Next `127.0.0.1:3005`, `BACKEND_INTERNAL_URL=http://127.0.0.1:3002`; `GET /api/backend/products` trả 200, `POST /api/backend/auth/register` với email/password tổng hợp hợp lệ kỳ vọng 201 nhưng báo 502 `fetch failed`; gửi cùng kiểu POST trực tiếp tới `http://127.0.0.1:3002/auth/register` trả 201.
- Rerun Next host: `PORT=3006`, `BACKEND_INTERNAL_URL=http://127.0.0.1:3002`, `NEXT_PUBLIC_API_URL=http://localhost:3002`; GET proxy 200, direct POST 201, proxy POST 201.
- Rerun task Compose: `BACKEND_INTERNAL_URL=http://backend:3001`, host ports 3002/3005; `GET /api/backend/products` trả 200; direct `POST /auth/register` và proxy `POST /api/backend/auth/register` đều trả 201. Không tái hiện 502. Log Next lượt cũ có dòng request 201 không khớp báo cáo HTTP 502, nên kết quả trước chưa đủ để kết luận lỗi implementation hay cấu hình cụ thể. Không gán owner.
- Log hiện tại: [SCRUM94_Runtime_Smoke_Safe.log](SCRUM94_Runtime_Smoke_Safe.log). Request body/email/password thật không lưu.

### Tái hiện tối thiểu: payment status 404

- Cùng code commit `fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0`; API Contract v4.0 §5 yêu cầu `GET /payments/:paymentId/status` có Bearer JWT và ownership. Với route được đăng ký, request thiếu JWT dự kiến `401`; request có JWT hợp lệ cho Payment của chủ sở hữu dự kiến `200`; UUID sai `400`; Payment không tồn tại hoặc thuộc user khác `404`.
- Request probe an toàn: `GET http://127.0.0.1:<backend-port>/payments/<valid-shaped-uuid>/status` và cùng GET qua `http://127.0.0.1:<frontend-port>/api/backend/payments/<valid-shaped-uuid>/status`, không gửi Authorization header. Mong đợi để xác nhận route được đăng ký là `401` khi thiếu JWT; thực tế cả direct và proxy trả `404`. Controller inventory cũng không có GET status handler.
- Kết luận: implementation gap đối với route Contract, không phải kết quả `404` của một Payment ID đã được kiểm tra ownership. Vì route chưa tồn tại, authenticated owner/foreign-owner cases chưa thể được thực hiện; không gán owner.
- Log đã lọc, gồm actual direct/proxy response: [SCRUM94_Runtime_Smoke_Safe.log](SCRUM94_Runtime_Smoke_Safe.log).

Safe HTTP/Compose output: [SCRUM94_Runtime_Smoke_Safe.log](SCRUM94_Runtime_Smoke_Safe.log). HTTP proxy + local Mock không chứng minh frontend browser thật. Không dùng JSDOM/HTTP-only smoke để thay browser evidence.

## Giới hạn chưa hoàn tất

| Case | Mong đợi | Kết quả thực tế | Trạng thái |
| --- | --- | --- | --- |
| Docker Compose default workflow | Build/start/health, 9 migrations, manual seed | Build 3 images PASS; PostgreSQL healthy; migrate Exit 0; seed PASS, DB counts 4/9/5 categories/products/toppings. Backend production restart unhealthy vì `VNPAY_TMN_CODE` thiếu; frontend còn Created theo dependency. [Safe log](SCRUM94_Docker_Default_Safe.log). | BLOCKED cho runtime/FE flows do Sandbox config thiếu; không phải production PASS |
| Docker Compose development smoke trước đó | FE proxy/auth/order/Mock/history/restart | PASS trong development override trên project tạm theo [runtime log](SCRUM94_Runtime_Smoke_Safe.log). Override tắt expiration/reconciliation, đặt NODE_ENV=development và bật Mock; không phải production/Sandbox. Không chạm project brewlite_compose hiện có. | PASS giới hạn; không kết luận SCRUM-92 Done |
| PostgreSQL concurrency suites | Lock race/rollback cases theo guard hiện có | PASS — gate `PAYMENT_CONCURRENCY_TESTS=1` đã bật trên PostgreSQL isolated `localhost:5433/brewlite_test`; 23 gate-controlled cases trong 3 files chạy thực. Không sửa guard hoặc dùng DB chung. | PASS — 83 passed, 0 failed/skipped |
| VNPay Sandbox initiate→redirect→IPN→status/QueryDR | Sandbox merchant, ký URL, public HTTPS callback, authoritative status | Presence-only check: VNPAY_TMN_CODE, VNPAY_HASH_SECRET, VNPAY_RETURN_URL không có giá trị trong compose.env/host env; public HTTPS IPN endpoint/tunnel chưa được xác minh; browser tool đã dừng. Không gọi Sandbox, không thay Mock vào | BLOCKED |
| Sandbox / QueryDR Sandbox E2E | Signed response, public HTTPS IPN, correlation, shared finalization | Khang bổ sung credential, public IPN và Sandbox/QueryDR E2E theo xác nhận của người yêu cầu. ADR ghi lần QueryDR 99/Unexpected error, E2E chuyển SCRUM-95; SCRUM-94 không gọi Sandbox. | BLOCKED; chờ Khang |

CUA báo browser access host unavailable; không thử vượt chặn, không có ảnh thật trong repo. Đã tìm tiện ích PDF local trong PATH/vị trí cài đặt thông thường nhưng `pdftotext`, `pdfinfo`, `pdftoppm`, `mutool` đều không có; không mở Edge. Use Case PDF chưa được đọc/trích xuất. Rà soát DOCX xác nhận Project Charter không phải báo cáo đồ án; không tìm thấy DOCX/PDF báo cáo chính để sửa. Bản Markdown tiếp tục là draft.

## Tài nguyên task-local và dọn dẹp

- PostgreSQL Compose tạm: project scrum94_p2_20261106_a7f3, host ports 55440/3002/3005; task-only network/volume/container. Đã chạy `docker compose down` không dùng `-v`; xác minh label, rồi xóa đúng volume và bốn image tag có tiền tố project. Không dùng prune.
- Database brewlite_seed_scrum94_docker và brewlite_scrum69_test_db thuộc volume tạm đã xóa. Test suite dọn fixture IDs của nó trước đó.
- Các project `scrum94-p2-b6e2` (PostgreSQL concurrency) và `scrum94p2d2e1` (default Compose), cùng container/network/volume/image/env/override tạm của lượt này, được xóa sau khi lưu log an toàn; existing `brewlite_compose` vẫn healthy. Thư mục temp SCRUM-94 chứa secret ngẫu nhiên, test context và script cũng được dọn. Host Next dev server ở cổng 3006 đã dừng.
- Các output do lượt SCRUM-94 tạo trong worktree (backend/frontend node_modules, backend/dist, backend/src/generated/Prisma Client, frontend/.next) đã được xác minh là thư mục thường bên trong worktree rồi xóa. Không còn cần dependency/build artifacts để đọc tài liệu.
- Compose project brewlite_compose và các tài nguyên ngoài SCRUM-94 không bị dừng/xóa.

## Nguồn log đã lưu trong repository

Các file log đã lọc nằm trong cùng thư mục verification: [runtime development smoke](SCRUM94_Runtime_Smoke_Safe.log), [SCRUM-69 test](SCRUM94_SCRUM69_Test_Safe.log), [PostgreSQL concurrency](SCRUM94_Concurrency_Test_Safe.log), [default Compose](SCRUM94_Docker_Default_Safe.log). Docker smoke không phải SCRUM-92 acceptance. Browser screenshot và VNPay Sandbox E2E chưa có; không suy từ Nest/API E2E, JSDOM, PostgreSQL integration hoặc Mock sang Sandbox PASS.
