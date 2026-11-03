# BrewLite Frontend Docker Handoff (SCRUM-90 / P2-16)

Tài liệu này hướng dẫn cách build, cấu hình và vận hành Docker image cho Next.js Frontend của dự án BrewLite.

---

## 1. Kiến trúc Image và Build Context

- **Base Image**: Sử dụng `node:26-bookworm-slim` cho tất cả các stage (`deps`, `builder`, `runner`). Đồng bộ 100% với backend image (`backend/Dockerfile`), sử dụng Debian Bookworm (glibc) ổn định và bảo mật.
- **Multi-stage Build**:
  - `deps`: Chạy `npm ci` độc lập để tận dụng tối đa Docker cache.
  - `builder`: Copy source code và dependencies, thực hiện production build với Next.js Standalone mode (`output: "standalone"`).
  - `runner`: Image runtime siêu nhẹ chỉ chứa output standalone tối giản, Node.js runtime, static assets client (`.next/static`) và static public files (`public/`).
- **Tối ưu kích thước**: Image runtime chỉ chiếm ~97MB compressed / ~407MB uncompressed (loại bỏ devDependencies, source TypeScript, file tests và artifacts của host).
- **Bảo mật**: Container chạy dưới quyền người dùng non-root mặc định `node` (UID 1000). Tất cả các file nhạy cảm (`.env`, `.env.local`, `.git`, `tests/`) đều được loại trừ qua `frontend/.dockerignore`.
- **Network Listening**: Cấu hình `HOSTNAME="0.0.0.0"` và `PORT=3000` cho phép container nhận request từ bên ngoài host.

---

## 2. Phân biệt URL Backend: Trình duyệt vs Bên trong Container

Đây là điểm cốt lõi trong kiến trúc tích hợp giữa Frontend và Backend khi chạy Dockerized:

| Môi trường | Biến môi trường | Mục đích & Phạm vi | URL mẫu |
| :--- | :--- | :--- | :--- |
| **Trình duyệt (Browser / Client-side)** | `NEXT_PUBLIC_API_URL` | Dành cho JavaScript chạy trên trình duyệt của máy khách (Host OS). Trình duyệt KHÔNG nằm trong mạng Docker nội bộ nên không thể phân giải tên service như `http://backend:3001`.<br>Trình duyệt ưu tiên gọi **relative URL** `/api/backend/*` (same-origin) gửi thẳng về Next.js server để tránh CORS. Nếu gọi trực tiếp backend (direct fetch), dùng URL public truy cập được từ host. | Direct: `http://localhost:3001`<br>Relative: `/api/backend/*` |
| **Bên trong Container (Container-side / Next.js Server)** | `BACKEND_INTERNAL_URL` | Dành cho Next.js Server (Route Handler dynamic proxy `/api/backend/[[...path]]` và SSR) chạy bên trong container.<br>Vì chạy trong container, `localhost:3001` sẽ trỏ về chính container Frontend (loopback), do đó Next.js server PHẢI dùng URL nội bộ của Docker network hoặc `host.docker.internal`. | Docker Compose / Network: `http://backend:3001`<br>Backend trên host Windows: `http://host.docker.internal:3001` |

### Cơ chế hoạt động của Dynamic Reverse Proxy:
1. Trình duyệt người dùng gửi request tới: `http://localhost:3000/api/backend/products` (cùng origin với frontend, không bị chặn CORS).
2. Next.js server bên trong container nhận request tại `app/api/backend/[[...path]]/route.ts`.
3. Route Handler đọc biến môi trường runtime `BACKEND_INTERNAL_URL`:
   - Nếu chạy trong Docker Compose: forward request tới `http://backend:3001/products`.
   - Nếu backend chạy trên host Windows (theo tài liệu P2-17): forward request tới `http://host.docker.internal:3001/products`.
4. Backend xử lý xong và phản hồi lại cho Next.js server, Next.js server stream kết quả trả về cho trình duyệt.

---

## 3. Hướng dẫn Build và Chạy Container (PowerShell)

### 3.1. Build Docker Image
Chạy lệnh build từ thư mục gốc của repository:

```powershell
docker build -t brewlite-frontend:local frontend
```

Hoặc di chuyển vào thư mục `frontend`:

```powershell
Push-Location frontend
try {
    docker build -t brewlite-frontend:local .
} finally {
    Pop-Location
}
```

*(Tùy chọn: Nếu muốn nhúng một URL backend public cố định cho client bundle lúc build, truyền `--build-arg NEXT_PUBLIC_API_URL=http://your-domain:3001`)*.

---

### 3.2. Chạy Container

#### Kịch bản A: Chạy độc lập, kết nối với Backend đang chạy trên Host Windows (theo quy ước P2-17)

```powershell
docker run -d --name brewlite-frontend-local `
    -e BACKEND_INTERNAL_URL=http://host.docker.internal:3001 `
    -p 3000:3000 `
    brewlite-frontend:local
```

#### Kịch bản B: Chạy trong cùng Docker Network với Backend Container (Compose)

```powershell
# Ví dụ Backend container đang chạy trong network 'brewlite-net' với alias 'backend'
docker run -d --name brewlite-frontend-local `
    --network brewlite-net `
    -e BACKEND_INTERNAL_URL=http://backend:3001 `
    -p 3000:3000 `
    brewlite-frontend:local
```

---

## 4. Kiểm tra Nghiệm thu (Verification Smoke Test)

### 4.1. Kiểm tra trạng thái Container và Logs
```powershell
docker ps --filter "name=brewlite-frontend-local"
docker logs --tail 20 brewlite-frontend-local
```

### 4.2. Kiểm tra Website và Static Assets
```powershell
# 1. Trang chủ (HTTP 200)
Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing

# 2. Trang tính năng (HTTP 200)
Invoke-WebRequest -Uri "http://localhost:3000/orders" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:3000/vnpay/preview" -UseBasicParsing

# 3. Static assets trong public/ (HTTP 200)
Invoke-WebRequest -Uri "http://localhost:3000/images/product-placeholder.svg" -UseBasicParsing
```

### 4.3. Kiểm tra kết nối tới Backend thông qua Reverse Proxy
```powershell
# GET danh sách sản phẩm qua proxy
Invoke-RestMethod -Uri "http://localhost:3000/api/backend/products"

# Test POST endpoint qua proxy
Invoke-RestMethod -Method POST `
    -Uri "http://localhost:3000/api/backend/auth/login" `
    -Body '{"username":"test_user","password":"test_password"}' `
    -ContentType "application/json"
```

### 4.4. Dừng và Dọn dẹp Container Test
```powershell
docker stop --time 15 brewlite-frontend-local
docker rm brewlite-frontend-local
```
