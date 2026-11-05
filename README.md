# ☕ BrewLite

> Ứng dụng web đặt cà phê và thanh toán không tiền mặt (giả lập). Bài tập lớn môn **Công nghệ phần mềm**, Khoa Công nghệ thông tin, Trường Đại học Sài Gòn, học kỳ I năm học 2026–2027.

**Trạng thái:** đang triển khai • **Phiên bản tài liệu:** 1.0 • **Nguồn yêu cầu:** _BrewLite VER 1.0_ của giảng viên.

## 1. Giới thiệu

BrewLite giúp khách hàng xem menu, chọn size/topping, thêm đồ uống vào giỏ, đăng nhập, đặt hàng, thanh toán mock Ví/Thẻ và theo dõi đơn đã mua. Mục tiêu học phần là hoàn thiện MVP và triển khai đầy đủ Agile Scrum, từ requirements, phát triển theo sprint đến demo bàn giao.

**Phạm vi:** Một ứng dụng web, một backend NestJS và một CSDL. **Không** phải nền tảng multi-vendor/microservices và **không** xử lý tiền thật.

## 2. Thành viên & vai trò

| Thành viên              | Vai trò Scrum            | Trách nhiệm                                                       | GitHub                                       |
| ----------------------- | ------------------------ | ----------------------------------------------------------------- | -------------------------------------------- |
| Nguyễn Châu Hoàng Khang | Scrum Master / Developer | Team Leader, Điều phối nhóm, quản lý tiến độ, Backend Development | [@Ryannguyxn](https://github.com/Ryannguyxn) |
| Cao Nguyễn Quốc Khánh   | Developer                | Frontend Development, UI/UX, kiểm thử giao diện                   | [@username]                                  |
| Nguyễn Khải Hoàng       | Developer                | Requirements Analysis, hổ trợ phát triển Frontend/Backend         | [@username]                                  |
| Nguyễn Đăng Thụy        | Developer                | Business Analysis, đặc tả yêu cầu, hỗ trợ phát triển và kiểm thử  | [@username]                                  |
| Hoàng Văn Lập           | Developer                | System Design, Backend Development, Integration Testing           | [@username]                                  |
| Lâm Chí Khang           | Developer                | Database Design, Backend Development                              | [@username]                                  |

> Vai trò ở bảng là chỗ điền/chốt, **không** phải quyết định phân công chính thức. Thành viên vẫn có thể cùng phát triển frontend/backend theo sprint.

## 3. Công nghệ sử dụng

| Thành phần     | Stack                                    | Trạng thái                                           |
| -------------- | ---------------------------------------- | ---------------------------------------------------- |
| Frontend       | Next.js, React, TypeScript, Tailwind CSS | Next.js bắt buộc; các thành phần khác theo gợi ý đề  |
| Backend        | NestJS, TypeScript, REST API             | NestJS bắt buộc                                      |
| Auth           | JWT, Argon2id, class-validator             | Yêu cầu theo task                                    |
| Database / ORM | PostgreSQL + Prisma                      | **Đề xuất**, cần chốt với nhóm (đề cho phép TypeORM) |
| Giỏ hàng       | Zustand hoặc React Context               | **Chưa chốt**                                        |
| Thanh toán     | Mock Payment Service (Ví/Thẻ)            | Giả lập, không giao dịch thật                        |
| DevOps         | Git, GitHub, Docker Compose              | Docker Compose cần có khi bàn giao                   |
| Scrum          | Jira; GitHub Pull Requests               | Theo quy trình nhóm                                  |

Chi tiết: `docs/BrewLite_Techstack.docx` (sau khi đưa tài liệu vào repo).

## 4. Kiến trúc tổng quan

```text
[Next.js / Browser]
         |
      REST/JSON
         v
[NestJS REST API] ---> [Mock Payment Service]
         |
    Prisma / ORM
         v
   [PostgreSQL]
```

Backend tổ chức thành module chức năng như `auth`, `products`, `orders`, `payments`, `loyalty` trong **một ứng dụng NestJS**.

## 5. Tính năng và Product Backlog

| Task | Nội dung                                                              | Sprint gợi ý |
| ---- | --------------------------------------------------------------------- | ------------ |
| 1    | Scaffold frontend/backend, Git, `.env.example`, README                | Sprint 1     |
| 2    | `GET /products` trả danh sách đồ uống                                 | Sprint 1     |
| 3    | Trang Menu gọi API, loading/empty state                               | Sprint 1     |
| 4    | Chi tiết sản phẩm, size S/M/L, topping, tính giá                      | Sprint 1     |
| 5    | Giỏ hàng thêm/sửa/xóa, tổng tiền                                      | Sprint 2     |
| 6    | `POST /orders`, validate, lưu `PENDING`                               | Sprint 2     |
| 7    | Đăng ký, đăng nhập, Argon2id, JWT Guard                                 | Sprint 2     |
| 8    | Mock thanh toán Ví/Thẻ, `PAID`/`PAYMENT_FAILED`                       | Sprint 3     |
| 9    | Xác nhận đơn, `GET /orders/me`, Docker Compose, demo                  | Sprint 3     |
| 10   | State machine, idempotency, concurrency stock, coupon/loyalty và test | Sprint 3     |

Mỗi task tương ứng 1 điểm theo đề (10 điểm tổng); phải đạt acceptance criteria và Definition of Done.

## 6. Cấu trúc dự án

```text
brewlite/
├── frontend/            # Next.js
├── backend/             # NestJS
├── docs/                # Tài liệu phân tích, thiết kế (bổ sung theo sprint)
├── docker-compose.yml   # Dự kiến hoàn thiện ở Sprint 3
├── .env.example         # Cấu hình mẫu (kiểm tra vị trí thật trong repo)
├── .gitignore
└── README.md
```

> Sơ đồ trên là **cấu trúc mục tiêu**, không khẳng định các file tùy chọn đã có trong GitHub.

## 7. Cài đặt và chạy local

**Yêu cầu:** Git, Node.js LTS tương thích với `package.json`, npm; **Docker Desktop** (đã bật `Engine running`, hỗ trợ `docker compose` v2+) hoặc PostgreSQL nếu chạy thủ công ngoài Docker. Các câu lệnh dưới đây áp dụng khi repo sử dụng npm và script `dev` / `start:dev` mặc định; kiểm tra `package.json` trước khi chạy.

```bash
git clone <URL_REPOSITORY>
cd brewlite
```

Terminal 1 (frontend):

```bash
cd frontend
npm install
npm run dev
```

Terminal 2 (backend):

```bash
cd backend
npm install
npm run start:dev
```

**Cổng dự kiến theo scaffold nhóm:** frontend `http://localhost:3000`, backend `http://localhost:3001`. Kiểm tra file cấu hình hiện tại nếu khác.

Tạo `.env` cục bộ theo `.env.example` **sau khi nhóm thêm đủ biến**. Ví dụ biến cấu hình có thể bao gồm `DATABASE_URL`, `JWT_SECRET` và URL backend cho frontend; tên biến chính xác phải khớp source code. **Không commit `.env`.**

### 7.2. Chạy toàn bộ hệ thống bằng Docker Compose (Khuyến nghị)

**Yêu cầu trước khi chạy:**
- Đã cài và bật **Docker Desktop** (trạng thái `Engine running`, hỗ trợ `docker compose` v2+).
- Trên Windows, có thể chạy bằng **Git Bash** (khuyến nghị khi dùng `.sh`) hoặc **Windows PowerShell** (dùng `.ps1`). Tuyệt đối không chạy lệnh `bash ...` trong PowerShell nếu máy chỉ có `C:\Windows\System32\bash.exe` (WSL launcher) mà chưa cài distro WSL Linux.
- Hướng dẫn vận hành đầy đủ xem tại [`docs/Docker_Compose.md`](docs/Docker_Compose.md) và báo cáo kiểm chứng tại [`docs/verification/SCRUM92_Docker_Clean_Setup_Verification.md`](docs/verification/SCRUM92_Docker_Clean_Setup_Verification.md).

#### Cách A — Chạy trên Git Bash (Windows) / Linux / macOS:

```bash
# 1. Tạo file compose.env từ mẫu và tự điền mật khẩu/secret ngẫu nhiên local (không commit compose.env)
cp compose.env.example compose.env

# 2. Kiểm tra preflight biến môi trường và build/khởi chạy 4 services (postgres, migrate, backend, frontend)
bash scripts/compose-preflight-env.sh && docker compose --env-file compose.env up --build -d

# 3. Xác minh deterministic container `migrate` đã hoàn tất với exit code = 0 trước khi seed (tránh race condition)
bash scripts/compose-preflight-env.sh && \
  test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$(docker compose --env-file compose.env ps -a -q migrate)")" = "exited:0" && \
  echo "Migration verified (exited:0)"

# 4. Chạy guarded demo seed (4 categories, 9 products, 5 toppings) sau khi migrate đã exited:0
bash scripts/compose-preflight-env.sh && \
  docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed

# 5. (Tùy chọn) Khi muốn chạy kiểm thử tích hợp E2E tự động trên stack/volume/DB cô lập (-p brewlite_scrum92_e2e):
# Dừng stack dev brewlite_compose trước để tránh trùng cổng 3000/3001/15432, sau đó chạy:
docker compose --env-file compose.env stop
node scripts/scrum92/verify_compose_e2e.mjs --up
node scripts/scrum92/verify_compose_e2e.mjs --down
```

#### Cách B — Chạy trên Windows PowerShell:

```powershell
# 1. Tạo file compose.env từ mẫu và tự điền mật khẩu/secret ngẫu nhiên local (không commit compose.env)
Copy-Item compose.env.example compose.env

# 2. Kiểm tra preflight biến môi trường và build/khởi chạy 4 services (postgres, migrate, backend, frontend)
powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
docker compose --env-file compose.env up --build -d

# 3. Xác minh deterministic container `migrate` đã hoàn tất với exit code = 0 trước khi seed (tránh race condition)
$migrateId = docker compose --env-file compose.env ps -a -q migrate
$migrateState = if ($migrateId) { docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' $migrateId } else { '' }
if ($migrateState -ne 'exited:0') { throw "Migration container has not completed cleanly (state=$migrateState)" }
Write-Output "Migration verified ($migrateState)"

# 4. Chạy guarded demo seed (4 categories, 9 products, 5 toppings) sau khi migrate đã exited:0
powershell -ExecutionPolicy Bypass -File scripts/compose-preflight-env.ps1
if ($LASTEXITCODE -ne 0) { throw "Compose preflight failed" }
docker compose --env-file compose.env run --rm --no-deps -e ALLOW_COMPOSE_DEMO_SEED=true migrate npm run db:seed

# 5. (Tùy chọn) Khi muốn chạy kiểm thử tích hợp E2E tự động trên stack/volume/DB cô lập (-p brewlite_scrum92_e2e):
# Dừng stack dev brewlite_compose trước để tránh trùng cổng 3000/3001/15432, sau đó chạy:
docker compose --env-file compose.env stop
node scripts/scrum92/verify_compose_e2e.mjs --up
node scripts/scrum92/verify_compose_e2e.mjs --down
```

## 8. API dự kiến

| Endpoint              | Ý nghĩa                      |
| --------------------- | ---------------------------- |
| `GET /products`       | Menu                         |
| `GET /products/:id`   | Chi tiết sản phẩm            |
| `POST /auth/register` | Đăng ký                      |
| `POST /auth/login`    | JWT login                    |
| `POST /orders`        | Tạo đơn `PENDING`            |
| `POST /payments`      | Thanh toán mock (idempotent) |
| `GET /orders/me`      | Lịch sử đơn                  |

Các API trên là **contract mục tiêu theo đề**, không khẳng định đã implement.

## 9. Quy tắc & quy trình làm việc

**Scrum:** quản lý Product Backlog / Sprint Backlog trên Jira; họp Sprint Planning, Daily Scrum ngắn, Sprint Review và Retrospective.

**Branching:** `main` là nhánh ổn định, `dev` để tích hợp; mỗi task tạo nhánh từ `dev` và PR trở lại `dev`.

```text
Jira issue -> branch từ dev -> implement/test -> commit & push
            -> PR vào dev -> review -> merge -> Jira Done
Cuối sprint: review bản ổn định -> PR dev vào main (sau khi test)
```

**Ví dụ tên nhánh:** `docs/SCRUM-9-project-charter` hoặc `feat/SCRUM-12-products-api`.

**Ví dụ commit:** `SCRUM-9 docs: hoàn thiện Project Charter và Techstack`.

> Cú pháp Smart Commit và các lệnh như `#in-review` chỉ hoạt động khi Jira đã cấu hình phù hợp; không mặc định một comment trong commit sẽ chuyển trạng thái task.

**Pull request:** nêu mục tiêu, Jira key, cách test, screenshots nếu có; ít nhất một người khác review, không merge khi build/test lỗi.

## 10. Kiểm thử / Definition of Done

- [ ] Hoàn thành acceptance criteria và chạy được trên máy nhóm.
- [ ] Code build được; có test tương ứng khi sửa nghiệp vụ.
- [ ] API validate dữ liệu; UI xử lý loading/lỗi cơ bản.
- [ ] Mật khẩu được hash; route nhạy cảm có JWT Guard.
- [ ] Pull Request đã được review và merge đúng nhánh.
- [ ] Tài liệu/cách chạy được cập nhật khi cần.
- [ ] Riêng Task 10 có kiểm thử transition sai, key thanh toán lặp và đặt đồng thời không vượt tồn kho.

## 11. Sprint log (kế hoạch đề xuất)

| Giai đoạn | Ngày dự kiến     | Sprint Goal                                   | Kết quả        |
| --------- | ---------------- | --------------------------------------------- | -------------- |
| Sprint 0  | 12–18/10/2026    | Tài liệu nền, ERD, backlog, scaffold          | Đang thực hiện |
| Sprint 1  | 19/10–01/11/2026 | Nền tảng & menu (task 1–4)                    | Chưa bắt đầu   |
| Sprint 2  | 02–15/11/2026    | Cart, order, auth (task 5–7)                  | Chưa bắt đầu   |
| Sprint 3  | 16–29/11/2026    | Payment, nghiệp vụ nâng cao, demo (task 8–10) | Chưa bắt đầu   |

Ngày chỉ là lịch **dự kiến nội bộ**, cần xác nhận trước khi cam kết với giảng viên.

## 12. Tài liệu & liên kết

- `docs/BrewLite_Project_Charter.docx`: mục tiêu, phạm vi, kế hoạch, rủi ro.
- `docs/BrewLite_Techstack.docx`: kiến trúc, stack và chuẩn kỹ thuật.
- Requirements / Use Case Specification / ERD: bổ sung khi được duyệt.
- Jira Board: `https://nguyenkhang03012006.atlassian.net/jira/software/projects/SCRUM/boards/1?filter=&groupBy=none`
- GitHub repository: `https://github.com/brewlite-project/brewlite`
- Figma / mockups (nếu có): `[ĐIỀN_LINK_FIGMA]`

## 13. Bàn giao

Đến cuối Sprint 3: chạy frontend + backend + database qua Docker Compose; trình diễn luồng **menu → tùy chọn → giỏ → đăng nhập → đơn → thanh toán mock → xác nhận → lịch sử**; chứng minh test Task 10; bàn giao mã nguồn, README, tài liệu và ghi nhận phản hồi cho backlog tiếp theo.
