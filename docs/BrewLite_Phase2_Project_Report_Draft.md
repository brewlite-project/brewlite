# Báo cáo đồ án BrewLite — Phase 2 (bản nháp)

> **Trạng thái tài liệu:** Bản nháp Markdown để tích hợp vào báo cáo chính. Đã rà soát lại DOCX/PDF trong repository: `BrewLite_Project_Charter.docx` là project charter; các DOCX còn lại là requirements, US/AC hoặc model decisions, không có báo cáo đồ án chính để sửa trực tiếp. Nội dung này chưa phải báo cáo chính, Leader approval hay nghiệm thu Jira.

**Ngày cập nhật kiểm chứng:** 07/11/2026 (Asia/Bangkok)
**Source baseline của các kiểm chứng runtime/test lịch sử:** fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0; coupon helper/Docker target check riêng tại eef344c24fedd7480d06c085da3fff298def90d4. Ngày 07/11/2026 fetch origin/dev mới nhất dba36a5c31ea07e88b2201e3c8ffd6b345720afa và merge tại 13c6410; không có dev commit mới hơn. Merge thêm Compose/env/docs/scripts, không sửa app source. Không rerun backend unit, Nest/API E2E, frontend Node/JSDOM hoặc PostgreSQL concurrency sau sync. Một isolated Compose E2E verifier được chạy riêng tại checkout HEAD 304a7c6 (code/Compose từ dev merge dba36a5); xem evidence để không gán các số test lịch sử cho commit này.
**Bằng chứng:** [SCRUM-94 Verification Evidence](verification/SCRUM94_Verification_Evidence.md)

## 1. Phạm vi Phase 2

BrewLite là hệ thống web đặt đồ uống phục vụ đồ án môn Công nghệ phần mềm. Phase 2 giữ cấu trúc một frontend, một backend và một PostgreSQL database; bổ sung VNPay Sandbox và xử lý lifecycle Payment/Order. Không xử lý tiền thật.

Các chức năng có trong source tại commit khảo sát gồm:

- Catalog sản phẩm, đăng ký/đăng nhập JWT, tạo Order và lịch sử Order.
- Coupon, tính tổng tiền/điểm Loyalty và snapshot dữ liệu đơn.
- Mock thanh toán CARD/WALLET cho local test/demo với cờ cho phép; không tự chuyển sang Mock khi VNPay đang PENDING/unknown.
- VNPay initiation, URL ký, public IPN, QueryDR client và reconciliation scheduler.
- Shared payment finalization, idempotency, khóa và transaction PostgreSQL, xử lý trùng lặp/xung đột/financial exception.
- Hết hạn Order, Grace và nhánh ZERO_AMOUNT nội bộ.
- Regression giữ provider Mock của Phase 1 để test/demo và không gọi cổng thanh toán thật.
- Coupon seed helper chỉ dành cho fixture development/test; là thao tác opt-in riêng, không tự chạy cùng catalog seed hoặc Compose startup. Helper host-side hard-code port 55432, không khớp Compose host default mới 15432; lần kiểm tra eef344c dùng namespace test riêng expose 55432, không xác minh mapping mặc định.

Các đầu mục trên mô tả **implementation**. Mức **test** và **nghiệm thu** được tách ở mục 6. Không dùng Mock hoặc test giả lập làm bằng chứng Sandbox E2E.

## 2. Kiến trúc và công nghệ

~~~mermaid
flowchart LR
  B[Browser] -->|Next.js UI / same-origin API| F[Next.js frontend]
  F -->|REST JSON| N[NestJS backend]
  N -->|Prisma 7| P[(PostgreSQL 18)]
  N -->|signed payment URL / IPN / QueryDR| V[VNPay Sandbox]
  V -->|browser Return: navigation only| B
  V -->|public HTTPS IPN| N
~~~

Frontend: Next.js 16.3.8, React 19.2.8 và TypeScript. Backend: NestJS 12, TypeScript 6, Prisma 7.10.1. Container base dùng Node 26; Compose dùng PostgreSQL 18. Source được tổ chức theo frontend/, backend/, docs/, và docker-compose.yml.

Host local: browser dùng localhost:3000; backend dùng localhost:3001; PostgreSQL dùng host/port trong DATABASE_URL. Compose mặc định publish frontend 3000, backend 3001 và PostgreSQL 127.0.0.1:15432; host ports có thể override bằng FRONTEND_HOST_PORT, BACKEND_HOST_PORT, POSTGRES_HOST_PORT. Trong Docker network dùng postgres:5432 và backend:3001. BACKEND_INTERNAL_URL là server-side runtime config; NEXT_PUBLIC_API_URL có thể được nhúng vào client build và không được chứa secret.

Migration được quản lý bằng Prisma migrations. Compose có service migrate chạy prisma migrate deploy rồi mới cho backend start. Catalog seed và coupon fixture seed là hai thao tác tách biệt; coupon helper mới chỉ chấp nhận DB có tên brewlite_compose cùng target/acknowledgement guard riêng, và không được dùng trên DB ứng dụng hoặc database chia sẻ. Chi tiết lệnh và điều kiện nằm trong [coupon seed guide](../backend/prisma/README-dev-compose-coupons.md).

## 3. Payment flow và quy tắc nghiệp vụ

1. Customer xác thực với backend và tạo Order PENDING từ catalog; giá và thông tin item được snapshot ở backend.
2. Khởi tạo VNPay tạo Payment Attempt PENDING với Idempotency-Key, thông tin correlation và URL ký dùng số tiền lấy từ Order.
3. Browser được chuyển tới VNPay rồi quay về Return URL. Return chỉ là điều hướng; query string không có thẩm quyền xác nhận giao dịch.
4. VNPay gọi IPN server-to-server qua HTTPS, không cần Customer JWT. Backend xác minh HMAC, merchant, TxnRef, amount và trạng thái trước khi ACK.
5. QueryDR client xác minh response để phục hồi/đối soát; scheduler quản lý lần thử và lease. IPN và QueryDR đưa bằng chứng đã xác minh vào cùng Shared Payment Finalization.
6. Finalization xử lý trong transaction và khóa theo Order/Payment. Idempotency, gateway event và điều kiện terminal ngăn lặp coupon, Loyalty, inventory hoặc side effect.
7. UI cần đọc trạng thái server sau Return. **GET /payments/:paymentId/status chưa có controller/route backend trong source baseline; static inventory sau sync tới origin/dev dba36a5 cũng không thấy route**, dù API Contract v4.0 §5 và frontend service có tham chiếu endpoint này.

Payment có trạng thái PENDING, SUCCESS, FAILED. Order có PENDING, PAYMENT_FAILED, PAID, PREPARING, READY, COMPLETED, CANCELLED. Tối đa một Payment SUCCESS được chấp nhận cho một Order. Event trùng được nhận diện và không lặp side effect; event mâu thuẫn/late success tạo financial exception/requires review, giữ terminal state hiện có và không hồi sinh Order.

Order có TTL 15 phút. Grace 5 phút hỗ trợ xác minh một attempt đã bắt đầu; hết giờ không tự chứng minh thất bại và không cho phép Payment URL vượt expiresAt. Sau Grace, expiry/reconciliation dùng database time và khóa Order. Nếu QueryDR không xác định được kết quả, giữ trạng thái cần đối soát thay vì tự đánh FAILED.

ZERO_AMOUNT là nhánh nội bộ không redirect tới VNPay hoặc Mock; khi hợp lệ ghi Payment SUCCESS 0 VND và không cộng Loyalty. Mock Phase 1 vẫn là provider riêng, chỉ bật ngoài production; không phải fallback cho VNPay chưa xác định.

## 4. Baseline và cách xử lý metadata tài liệu

Nguồn nghiệp vụ là Requirements v3.1, US/AC v2.3, Use Case v3.1, ERD/Prisma Delta v0.2.2 và API Contract v4.0. Metadata ở đầu Contract/Requirements/US-AC và ERD có trạng thái review/candidate không còn đồng bộ. Contract v4.0, mục normative và §14, ghi quyết định đã xác nhận BR/Requirements v3.1, US/AC v2.3, UC v3.1, ERD/DBML v0.2.2 làm đầu vào được duyệt và chốt các design decision. Báo cáo này dùng quyết định đó làm baseline; không chỉnh sửa các baseline đã duyệt chỉ để hợp thức hóa source.

Architecture document ghi READY FOR APPROVAL nên được xem là tài liệu thiết kế tham chiếu, không tự coi là approval độc lập. Handoff SCRUM-78/79 giải thích finalization và concurrency; kết quả test cũ trong handoff không được tính là kết quả của commit hiện tại.

Đã rà soát tên và nội dung đầu DOCX trong repository; không có báo cáo đồ án DOCX/PDF chính. `BrewLite_Project_Charter.docx` là charter, không phải báo cáo. Không tìm thấy tiện ích PDF local (`pdftotext`, `pdfinfo`, `pdftoppm`, `mutool`) trong PATH/vị trí cài đặt thông thường; không mở Edge để thay thế. Nội dung Use Case PDF chưa được trích xuất/đọc trong lượt này. Baseline mô tả ở đây dựa trên Contract §14, Requirements/US-AC có sẵn, ERD delta, Prisma schema/migrations và code; cần người có công cụ đọc PDF xác nhận nội dung PDF trước khi tích hợp chính thức.

## 5. Hình minh họa

Chưa chèn ảnh giao diện. CUA hiện báo `Browsers: Error: The browser access host is unavailable`; dừng thao tác UI theo yêu cầu, không thay bằng HTTP/JSDOM. Không dùng mockup hoặc hình tạo sinh. Cần ảnh thật từ browser được phép trên môi trường test riêng: catalog, đăng nhập, checkout, Mock payment success và lịch sử đơn; loại bỏ token/cookie/PII trước khi tích hợp báo cáo.

## 6. Kết quả kiểm chứng

Các kết quả ứng dụng cũ ở bảng dưới thuộc source commit fb293e2ac35c0fe29fbe3573bf5edf81b7a586a0 (06–07/11/2026). Bảng post-sync ghi riêng coupon helper/Docker target checks tại eef344c24fedd7480d06c085da3fff298def90d4 và isolated Compose verifier tại checkout HEAD 304a7c6 (sau merge origin/dev dba36a5). Không gộp hoặc gán số liệu lịch sử cho commit tài liệu mới.

| Case / mong đợi | Kết quả thực tế | Trạng thái |
| --- | --- | --- |
| Prisma generate/validate | Client 7.10.1 generate thành công; schema validate thành công | PASS |
| Migration | 9 migrations trên database tạm; trước seed catalog rỗng | PASS |
| Catalog seed | 4 categories, 9 products, 5 toppings; seed output không có legacy product | PASS |
| Backend unit/service | 33 files, 300 tests passed | PASS |
| Backend HTTP/Nest E2E | 10 files, 227 tests passed; đây không phải browser/Sandbox | PASS |
| PostgreSQL integration chọn lọc ban đầu | 9 files; 147 passed, 10 skipped, 0 failed. 10 skipped thuộc hai nhóm concurrency trong payments/promotions, bị gate bởi PAYMENT_CONCURRENCY_TESTS=1; suite yêu cầu AUTH_TEST_DATABASE_URL đúng localhost:5433/brewlite_test. Đây là kết quả khi gate tắt, không tính skipped là PASS. | PASS cho phần đã chạy; 10 skipped |
| PostgreSQL concurrency rerun có gate | [Concurrency log](verification/SCRUM94_Concurrency_Test_Safe.log); Docker PostgreSQL 18 và runner Node 26.13.0 chia sẻ network namespace riêng, không publish host port. Trước test: DB `brewlite_test`, `inet_server_port()=5433`, 9/9 migrations, kết nối runner thành công. `PAYMENT_CONCURRENCY_TESTS=1`; 3 files, 83 passed, 0 failed, 0 skipped. 23 gated cases thực chạy: 13 finalization, 7 payment locking/idempotency, 3 coupon. | PASS; run riêng, không cộng với 147 passed lần trước |
| Integration run đầu | 8 files passed, 1 file failed do DB name không khớp guard; 136 passed, 21 skipped; sửa target sang tên test allowlist và chạy lại thành công | FAIL cấu hình đầu; rerun PASS |
| Frontend production build | Next build thành công; static generation 11/11 | PASS |
| Frontend Node/JSDOM subset | 5 files; 166 passed, 0 failed/cancelled/skipped | PASS |
| Full frontend npm test, lần host đầu | 174 total: 172 passed, 0 failed, 2 cancelled, 0 skipped; exit 1 vì SCRUM-69 setup thiếu DATABASE_URL/ORDERS_TEST_DATABASE_URL. | BLOCKED ở setup; hai cancelled không tính PASS |
| Full frontend npm test, rerun cô lập | 174 total: 174 passed, 0 failed, 0 cancelled, 0 skipped; SCRUM-69 tạo database test riêng theo guard hiện có trong PostgreSQL tạm. Node 26.13.0, output đã lọc ở [SCRUM-94 test log](verification/SCRUM94_SCRUM69_Test_Safe.log). | PASS cho suite Node/JSDOM + PostgreSQL setup trong test này |
| HTTP catalog qua Next proxy | GET direct /products và GET /api/backend/products trả 200 JSON; catalog seeded có 9 sản phẩm | PASS |
| POST đăng ký qua Next proxy | Lượt host trước báo proxy 502/direct 201; hai rerun hiện tại (Next host với backend URL 127.0.0.1:3002 và Compose với backend:3001) đều nhận POST 201 qua direct lẫn proxy. Lượt trước cũng có dòng log Next 201 không khớp báo cáo 502. Root cause chưa xác định, không quy cho implementation/owner. | Hai rerun PASS; cảnh báo cũ chưa được giải thích |
| Backend direct local smoke | Register/login, tạo Order PENDING, Mock CARD SUCCESS/PAID, replay trả Idempotency-Replayed=true, GET /orders/me thấy SUCCESS; database vẫn giữ trạng thái sau restart | PASS — Mock/local only |
| Backend payment status route | Contract v4.0 §5 khóa GET /payments/:paymentId/status (Bearer, ownership, DB-only; UUID sai 400, không tồn tại/khác chủ 404, chủ sở hữu 200); frontend service gọi GET. Backend chỉ khai báo POST /payments, POST /payments/vnpay/initiate, GET /payments/vnpay/ipn, POST /payments/zero-amount; không có status GET. Runtime direct và qua proxy đều trả 404 ở fb293e. Sync dev không có diff trong backend/src/payments; route vẫn thiếu ở eef344c. Probe không gửi JWT để kiểm tra đăng ký route; 404 này không chứng minh Contract's authorized not-found behavior. | FAIL — implementation gap so với Contract; không gán owner |
| Docker Compose default workflow (historical source fb293e2) | [Safe log](verification/SCRUM94_Docker_Default_Safe.log). Project/volume/network/DB task-local; build ba image PASS; PostgreSQL healthy; migrate Exit 0 với 9/9 migrations; manual seed 4 categories/9 products/5 toppings. Backend không healthy do thiếu VNPAY_TMN_CODE; frontend bị chặn theo dependency. | BLOCKED ở lượt lịch sử này; không đại diện verifier post-sync hoặc Sandbox |
| Isolated Compose E2E verifier sau sync tại checkout HEAD 304a7c6 | [Safe log](verification/SCRUM94_Compose_Verifier_PostSync_Safe.log). docker-compose.yml mặc định; harness đặt project brewlite_scrum92_e2e, DB brewlite_seed_scrum92_e2e, host ports 13000/13001/15492, NODE_ENV=test, schedulers off và VNPay synthetic. Health, 9 migrations, seed 4/9/5, FE→BE→DB, auth/order, Mock guard, ZERO_AMOUNT, initiation/replay nội bộ, persistence và cleanup đạt. | PASS cho isolated test profile; không gọi Sandbox, không phải production PASS |
| Docker Compose development smoke riêng | [Runtime smoke](verification/SCRUM94_Runtime_Smoke_Safe.log). SCRUM-94 tạo override task-local tạm, không phải file workflow trong repo; đặt NODE_ENV=development, tắt expiration/reconciliation, bật Mock và remap host ports. Login/order/Mock SUCCESS→PAID/history và persistence sau restart đã chạy trên project tạm. | PASS giới hạn ở development/Mock; không thay production hoặc SCRUM-92 nghiệm thu |
| Post-sync backend Docker targets: `docker build --target migrate` và `--target runtime` trên source eef344c ([log](verification/SCRUM94_DevSync_Verification_Safe.log)) | Hai targets build/export thành công; không start production app hoặc gọi Sandbox. | PASS cho Docker packaging, không phải Compose health |
| Coupon seed policy: `npx vitest run prisma/seed-compose-coupons.policy.spec.ts`; source spec bind-mounted read-only vì Docker build context loại `*.spec.ts` ([log](verification/SCRUM94_DevSync_Verification_Safe.log)) | Lần đầu 0 test file do `.dockerignore`; rerun 25 passed, 0 failed, 0 skipped. | PASS ở rerun; setup attempt không tính là test |
| Coupon seed helper + PostgreSQL trên source eef344c ([log](verification/SCRUM94_DevSync_Verification_Safe.log)) | DB task-local tên `brewlite_compose`, network namespace riêng, port 55432 không publish host, 9 migrations trước seed. Lần đầu 5 new, lần hai 0 new/5 existing; sau cùng 5 coupon, usage sum 0, 0 redemptions. | PASS cho insert-only/idempotent helper trên DB tạm; không dùng application DB |
| Real VNPay Sandbox IPN / QueryDR E2E | ADR A1 reports a successful historical IPN Sandbox transaction (42,000 VND). The current SCRUM-94 Compose verifier only executed local initiation/replay with synthetic config; no redirect, gateway call, real IPN or QueryDR E2E. Khang adds current credentials/public HTTPS IPN/evidence; QueryDR Sandbox E2E deferred to A2/SCRUM-95. | BLOCKED for new real Sandbox E2E; no PASS claim from synthetic/Mock |
| Screenshot giao diện thật | CUA báo `Browsers: Error: The browser access host is unavailable`; dừng thao tác UI. Chưa có ảnh thật trong repo. Còn cần catalog, login, checkout, Mock payment success, order history. | BLOCKED |

Backend unit/service, Nest/API E2E, frontend Node/JSDOM, PostgreSQL integration/concurrency, Docker Compose smoke, coupon helper integration và VNPay Sandbox là các lớp kiểm chứng riêng. Frontend 174/174 chạy bằng Node/JSDOM cùng SCRUM-69 PostgreSQL test DB; không phải browser thật. Nest/API E2E không chứng minh JSDOM hoặc concurrency; PostgreSQL concurrency và coupon helper dùng DB thật nhưng không phải Sandbox. Historical Compose thường từng bị chặn do thiếu VNPAY_TMN_CODE; isolated Compose verifier sau sync đạt với NODE_ENV=test và config synthetic, không phải production/Sandbox. Backend Docker target builds là packaging check riêng. Không lớp nào thay cho Sandbox E2E; SCRUM-92/93 không được tự nghiệm thu trong tài liệu này.

## A1 cuối — nguồn xác nhận và phạm vi có thể kết luận

Nguồn định nghĩa A1 cuối tìm thấy trong repository là [ADR-P2-QueryDR-Sandbox-E2E-Deferred](decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md), trạng thái APPROVED ngày 03/11/2026. ADR điều chỉnh nghiệm thu SCRUM-81 cho A1: IPN Sandbox thật được thử thành công; QueryDR client và automated tests được chấp nhận; QueryDR Sandbox E2E và phục hồi khi mất IPN chuyển sang A2/SCRUM-95. ADR ghi lịch sử giao dịch 42.000 VND qua HTTPS/ngrok, RspCode 00, Payment SUCCESS, Order PAID, Gateway Event FINALIZED, không có financial exception; unit 221/221, PostgreSQL integration 28/28, build/lint PASS tại thời điểm đó. Đây là kết quả do ADR báo cáo, không phải lượt chạy SCRUM-94.

[PR #127](https://github.com/brewlite-project/brewlite/pull/127) có review APPROVED và merge commit c4c2422. [PR #142](https://github.com/brewlite-project/brewlite/pull/142) merge QueryDR response handling/tests (commit 784895b, ancestor của origin/dev dba36a5); diff PR chỉ sửa client/spec, không chứng minh Sandbox E2E mới.

Chưa tìm thấy Jira/Leader record xác nhận trạng thái tổng thể A1 hoặc SCRUM-81 là Done; phiên này không có Jira connector. Vì vậy chỉ xác nhận được phạm vi A1 theo ADR và lịch sử review/merge PR, không suy ra nghiệm thu tổng thể A1. Khang bổ sung credential/public HTTPS IPN và evidence Sandbox hiện hành; QueryDR Sandbox E2E vẫn là phần A2 theo ADR. Không dùng kết quả Mock/synthetic thay thế.

## 7. Hạn chế và công việc còn mở

- **Frontend proxy:** POST đăng ký trước đây từng báo 502 nhưng Next host và Compose rerun đều trả 201 qua direct và proxy; root cause của kết quả cũ chưa rõ. Chưa có căn cứ gán owner. Nếu tái diễn, cần giữ đúng request/log để phân tích trước khi kết luận implementation.
- **Payment status:** thêm/hoàn thiện API status theo Contract đã duyệt và test ownership/server truth; hiện UI Return chưa thể đọc trạng thái authoritative qua endpoint dự kiến.
- **Sandbox:** ADR APPROVED ghi IPN Sandbox thành công trong SCRUM-81 lịch sử. Verifier sau sync chỉ chạy local initiation/replay bằng config synthetic; không redirect, không gọi gateway, không chạy IPN/QueryDR E2E mới. Khang bổ sung credential, public HTTPS IPN và evidence hiện hành. QueryDR Sandbox E2E chuyển A2/SCRUM-95; không ghi PASS bằng Mock/synthetic data.
- **Docker:** Lượt Compose thường trên source fb293e lịch sử đã build/migrate/seed nhưng backend không healthy vì thiếu VNPAY_TMN_CODE; development override là smoke Mock riêng. Sau sync, isolated SCRUM-92 verifier chạy ở checkout HEAD 304a7c6 (Compose/app code từ origin/dev dba36a5), dùng docker-compose.yml mặc định nhưng harness đặt project, DB, cổng, NODE_ENV=test, scheduler off và VNPay config synthetic. Build/health, migrate/seed, FE→BE→DB, auth/order, Mock policy, ZERO_AMOUNT, VNPay initiation/replay nội bộ, persistence và exact-ID cleanup đều PASS; không gửi request tới gateway. Đây không phải production workflow hay Sandbox E2E. Xem [evidence](verification/SCRUM94_Verification_Evidence.md) và [SCRUM-92 verification report](verification/SCRUM92_Docker_Clean_Setup_Verification.md); không suy ra SCRUM-92 Done. Coupon helper host-side cố định port 55432 còn Compose default là 15432; kết quả eef344c không xác minh mapping đó.
- **Frontend payment tests:** full npm test hiện có 174 passed, 0 failed/cancelled/skipped sau khi SCRUM-69 được chạy trong DB tạm. Lần host đầu có 2 cancelled do thiếu biến DB. Kết quả test không tự xác nhận Jira SCRUM-87 đã Done.
- **Trạng thái A1:** ADR APPROVED là nguồn xác nhận phạm vi SCRUM-81 A1, PR #127 được review APPROVED/merged; không tìm thấy Jira/Leader record về nghiệm thu tổng thể A1. Không tự cập nhật trạng thái SCRUM-87/92/93.
- **Bằng chứng ảnh:** Ngày 07/11/2026 tại code commit `eef344c`, browser inventory trả `Browsers: Error: The browser access host is unavailable`; chưa mở ứng dụng hay chụp ảnh. Edge hiện có đang phục vụ công việc khác nên không bị tác động. Chi tiết trong [screenshot availability log](verification/SCRUM94_Browser_Screenshot_Blocked_Safe.log). Bản báo cáo chính cần ảnh thật của catalog, đăng nhập, checkout, Mock payment success và lịch sử đơn từ môi trường test riêng.
- Cài dependencies trên Node 22.18.0 sinh EBADENGINE và npm audit ghi nhận advisory; không chạy audit fix hay nâng dependency trong phạm vi tài liệu.

## 8. Tài liệu chuẩn và đối chiếu

- [API Contract v4.0](../docs/api/BrewLite_API_Contract_v4.0.md)
- [Requirements v3.1](docs_Phase2/BrewLite_Requirements_Specification_v3.1.docx)
- [US/AC Phase 2](docs_Phase2/BrewLite_User_Stories_Acceptance_Criteria_Phase2.docx)
- [Use Case v3.1](docs_Phase2/BrewLite_Use_Case_Specification_v3.1_VNPay_Phase_2%20.pdf)
- [ERD/Prisma Delta v0.2.2](docs_Phase2/BrewLite_ERD_Prisma_Delta_Phase2_v0.2.2_CK-R01-R03_UPDATED.md)
- [Payment Architecture Phase 2](design/payment/BrewLite_Payment_Architecture_Phase2_v1.0.md)
- [Shared Payment Finalization Handoff](design/payment/Shared_Payment_Finalization_Handoff_SCRUM-78.md)
- [Concurrency Test Handoff](design/payment/Payment_Finalization_Concurrency_Test_Handoff_SCRUM-79.md)
- [Docker Compose](Docker_Compose.md)
- [VNPay Sandbox Setup](integration/VNPay_Sandbox_Setup.md)
- [Approved QueryDR Sandbox E2E deferral ADR](decisions/ADR-P2-QueryDR-Sandbox-E2E-Deferred.md)
- [Verification evidence SCRUM-94](verification/SCRUM94_Verification_Evidence.md)

## 9. Kết luận nghiệm thu

Bản Markdown này là nội dung draft để tích hợp vào báo cáo chính; không có báo cáo chính chỉnh sửa được trong repository, và `BrewLite_Project_Charter.docx` không phải báo cáo đồ án. Draft phản ánh implementation/bằng chứng của commit đã nêu; không phải Leader approval và không xác nhận SCRUM-87/92/93 Done. Trước khi hoàn thiện báo cáo chính, cần tích hợp nội dung theo template chính, đọc Use Case PDF bằng công cụ local phù hợp, bổ sung ảnh UI thật khi browser được phép, và đính kèm kết quả Sandbox/QueryDR E2E do Khang bổ sung. Payment status route vẫn là issue so với Contract; POST proxy 502 cũ chưa tái hiện ở các rerun và không được xem là lỗi hiện hành.
