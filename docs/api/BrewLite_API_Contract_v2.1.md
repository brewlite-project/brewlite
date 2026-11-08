# BrewLite – API Contract

**Version:** 2.1
**Sprint:** Sprint 2 – Cart, Authentication & Order (kế thừa Sprint 1)
**Status:** Approved / Sprint 2 Baseline
**Owner:** HKhang (BrewLite project leader)
**Tech Stack:** NestJS, Next.js, PostgreSQL, Prisma
**API Style:** REST / JSON

---

## 1. Introduction

### 1.1. Purpose

Tài liệu này định nghĩa API Contract giữa Backend và Frontend của hệ thống BrewLite.

Mục tiêu:

- Thống nhất cấu trúc request và response.
- Thống nhất tên trường, kiểu dữ liệu và HTTP status.
- Làm cơ sở triển khai Backend API và tích hợp Frontend.
- Đảm bảo API tuân thủ Requirements Specification, User Stories & Acceptance Criteria, Use Case Specification và ERD đã chốt.
- Giữ tương thích với API Contract v1.0 của Sprint 1.

### 1.2. Scope

API Contract v2.1 kế thừa các endpoint và cấu trúc cơ bản của v2.0, mở rộng Product Catalog theo ERD/Prisma Upgrade (PR #63) và đồng bộ quy tắc Create Order liên quan:

| Method | Endpoint         | Description                                       |
| ------ | ---------------- | ------------------------------------------------- |
| GET    | `/products`      | Lấy danh sách đồ uống                             |
| GET    | `/products/:id`  | Lấy chi tiết đồ uống, Size và Topping             |
| POST   | `/auth/register` | Đăng ký Customer                                  |
| POST   | `/auth/login`    | Đăng nhập và cấp JWT                              |
| POST   | `/orders`        | Tạo Order PENDING từ Cart, hỗ trợ coupon tùy chọn |

Quy định phạm vi:

- `GET /products`, `GET /products/:id`, `POST /auth/register`, `POST /auth/login` là public.
- `POST /orders` yêu cầu JWT.
- Các mở rộng Catalog ở v2.1 phải được thông báo cho Frontend Khánh/Lập và Backend owner Order trước khi tích hợp.
- Cart được quản lý phía Frontend bằng Zustand/Context; không có Cart API trong Sprint 2.
- `POST /payments`, `GET /orders/me`, Order History, Loyalty API, coupon preview và các API khác thuộc Sprint 3+.
- Sprint 2 chỉ triển khai mức nghiệp vụ cần thiết để hoàn thành flow Cart → Auth → Create Order.
- Advanced concurrency hardening, scheduled expiration, advanced coupon serialization và các race-condition test chuyên sâu được defer sang Task 10 / Sprint 3 trừ khi cần để sửa lỗi nghiêm trọng.

### 1.3. Source of Truth

Baseline Sprint 1 là `BrewLite_API_Contract_v1.0.md` (Approved, bảo lưu).

API Contract v2.1 được xây dựng dựa trên:

1. BrewLite Requirements Specification v3.0
2. BrewLite User Stories & Acceptance Criteria v2.2
3. BrewLite Use Case Specification v3.0
4. `database/schema.dbml`
5. API Contract v1.0 và v2.0 (lưu lịch sử, không ghi đè)

Khi có mâu thuẫn về business rule, nhóm phải đối chiếu tài liệu yêu cầu đã chốt trước khi thay đổi API Contract. Các mục Product Catalog/size/topping đã thống nhất trong v2.1 thay thế mục tương ứng của v2.0; các mục khác được kế thừa.

### 1.4. Sprint 2 Implementation Responsibilities

| Thành viên | Trách nhiệm Sprint 2                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| HKhang     | API Contract, review Swagger/PR, consistency review, integration coordination             |
| Thụy       | Prisma schema/migration cho User, Order, OrderItem và các relation cần thiết cho Sprint 2 |
| Hoàng      | Register, Login, JWT Strategy/Guard, Auth DTO và Swagger                                  |
| CKhang     | `POST /orders`, Order Controller/DTO/Service, tính giá, transaction tạo Order             |
| Khánh      | Cart State/UI, payload mapping từ Cart sang Checkout                                      |
| Lập        | Auth UI, Checkout Flow, gọi `POST /orders`, hiển thị response/errors                      |

Nếu coupon được triển khai trong Sprint 2, phần DB/model liên quan chỉ làm ở mức cần thiết cho `POST /orders`. Không mở rộng sang Promotion/Loyalty ngoài phạm vi Create Order.

### 1.5. Product Catalog Upgrade – Responsibility & Release Boundary

| Hạng mục                                  | Owner chính                                              | Trách nhiệm/ranh giới                                                                                        |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ERD, Prisma Schema, Migration 5           | HKhang (đã merge PR #63)                                 | Schema nền cho `categories`, `product_toppings`, `sizePolicy`, availability; không thay đổi migration cũ     |
| API Contract v2.1                         | HKhang                                                   | Chốt response/rules, cập nhật Swagger expectation, chủ trì consistency review                                |
| `GET /products`, `GET /products/:id`      | HKhang (nhánh `feature/product-catalog-backend-upgrade`) | DTO, service, mapping, unit/HTTP tests, Swagger; duy trì 5 field cũ                                          |
| `POST /orders` và server-side validation  | CKhang                                                   | Cập nhật code ở task/PR Order riêng để đáp ứng ORD-CAT-01…08; không tự động thuộc phạm vi PR Product Catalog |
| Menu / Product Listing / Product Detail   | Khánh                                                    | Tích hợp response Product v2.1, badge/category/size/topping, trạng thái unavailable                          |
| Auth UI / Checkout                        | Lập                                                      | Gửi size/topping hợp lệ, xử lý mã lỗi Order, giữ Cart khi cần Login                                          |
| Register / Login / JWT                    | Hoàng                                                    | Đối chiếu AuthService với Argon2id helper, kiểm chứng Auth contract; không đổi payload Auth                  |
| Schema Order và các phần DB Sprint 2 khác | Thụy (phân công Sprint 2 gốc)                            | Phối hợp CKhang nếu Order cần cập nhật ở nhánh khác                                                          |

Quy tắc phối hợp: các chủ sở hữu Backend/Frontend xác nhận các trường, lỗi và quy tắc tương ứng trước khi đánh dấu tài liệu Approved. PR #63 xác nhận phần schema đã merge, **không có nghĩa** hai Product API và `POST /orders` đã triển khai v2.1.

---

## 2. General API Conventions

### 2.1. Base URL

Backend chạy tại:

`http://localhost:3001`

Các endpoint đang được đặc tả:

- `GET /products`
- `GET /products/:id`
- `POST /auth/register`
- `POST /auth/login`
- `POST /orders`

Swagger UI:

`http://localhost:3001/api-docs`

Frontend sử dụng API Base URL từ biến môi trường, không hardcode địa chỉ Backend trong từng component.

### 2.2. HTTP & JSON

- API sử dụng REST qua HTTP.
- Request/response body sử dụng JSON.
- Tên trường JSON sử dụng camelCase.
- `Content-Type: application/json`.
- Date/time trả về theo ISO 8601 UTC.
- Hai endpoint Product là public.
- `STANDARD` chỉ chấp nhận S/M/L; `ONE_SIZE` chỉ chấp nhận ONE_SIZE (100%).
- `description` và `rating` là nullable; rating (nếu có) nằm trong khoảng 0–5.
- Hai endpoint Auth là public.
- `POST /orders` yêu cầu JWT Bearer Token.

### 2.3. Data Conventions

| Data Type       | Convention                |
| --------------- | ------------------------- |
| Product ID      | string (UUID)             |
| User ID         | string (UUID)             |
| Order ID        | string (UUID)             |
| Topping ID      | string (UUID)             |
| Product name    | string                    |
| Image URL       | string                    |
| Price           | JSON number, đơn vị VND   |
| Availability    | boolean                   |
| Size            | `S`, `M`, `L`, `ONE_SIZE` |
| Size multiplier | `100`, `120`, `140`       |
| Topping price   | JSON number, đơn vị VND   |
| Date/time       | ISO 8601 UTC              |

Giá tiền được truyền dưới dạng số, không kèm ký hiệu `đ` hoặc dấu phân cách hàng nghìn.

Ví dụ: `35000`, không phải `"35.000đ"`.

#### Monetary Value Serialization

- Các trường tiền như `basePriceVnd`, `priceVnd`, `unitPriceVnd`, `lineTotalVnd`, `subtotalVnd`, `discountVnd`, `totalVnd` dùng JSON number.
- Không trả trực tiếp JavaScript `bigint` từ Prisma ra JSON.
- Backend chỉ chuyển sang `number` khi nằm trong `Number.isSafeInteger`.
- Frontend chỉ dùng giá từ Product/Cart để hiển thị tạm tính.
- Backend là nguồn quyết định giá cuối cùng khi tạo Order.

#### Product Image URL Convention

- Ảnh Product được lưu tại `frontend/public/images/`.
- Backend trả `imageUrl` dạng `/images/...`.
- Frontend dùng đường dẫn này trực tiếp.
- Nếu ảnh lỗi, Frontend hiển thị fallback.

### 2.4. HTTP Status Codes

| HTTP Status               | Ý nghĩa                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| 200 OK                    | Request thành công                                                          |
| 201 Created               | Tạo resource thành công                                                     |
| 400 Bad Request           | Validation hoặc request không hợp lệ                                        |
| 401 Unauthorized          | Thiếu/sai/hết hạn JWT hoặc credential đăng nhập sai                         |
| 404 Not Found             | Resource hợp lệ về định dạng nhưng không tồn tại                            |
| 409 Conflict              | Xung đột nghiệp vụ như email trùng, stock không đủ, active order đã tồn tại |
| 500 Internal Server Error | Lỗi server ngoài dự kiến                                                    |

Không dùng HTTP 200 để biểu diễn lỗi.

### 2.5. Authentication / JWT

- `POST /auth/register` và `POST /auth/login` không yêu cầu JWT.
- `POST /orders` yêu cầu `Authorization: Bearer <accessToken>`.
- JWT chứa `sub` là User UUID.
- TTL mặc định: 60 phút (`3600` giây), phải khớp cấu hình thực tế.
- User ID trong Order phải lấy từ JWT đã xác minh, không lấy từ request body.
- Không trả `password`, `passwordHash`, JWT secret.
- Không commit `JWT_SECRET`.
- Token thiếu/sai/hết hạn: `401 UNAUTHORIZED`.
- Login thành công trả `accessToken`, `tokenType: "Bearer"`, `expiresIn: 3600`.

### 2.6. Error Response

Sprint 1 giữ nguyên error payload đã Approved.

Sprint 2 dùng additive extension tại mục 5.2, không phá compatibility Product API v1.0.

---

## 3. GET /products – Product Listing

### 3.1. Overview

| Attribute                | Value       |
| ------------------------ | ----------- |
| Method                   | GET         |
| Endpoint                 | `/products` |
| Authentication           | Public      |
| Success Status           | 200 OK      |
| Related Requirements     | FR-CAT-001  |
| Related User Stories     | US-CAT-01   |
| Related Use Case         | UC-CAT-001  |
| Backend Owner (Sprint 1) | Hoàng       |
| Frontend Consumer        | Khánh       |

### 3.2. Request

Không yêu cầu body/JWT; chưa có pagination hay filter bắt buộc trong v2.1.

### 3.3. Success Response – 200

```json
{
  "items": [
    {
      "id": "a1000000-0000-4000-8000-000000000001",
      "name": "Cà phê đen",
      "imageUrl": "/images/product-placeholder.svg",
      "basePriceVnd": 30000,
      "isAvailable": true,
      "category": {
        "code": "traditional",
        "name": "Cà phê truyền thống"
      },
      "description": null,
      "rating": null,
      "isNew": false,
      "isBestseller": false
    }
  ]
}
```

| Field          | Type             | Rule                                    |
| -------------- | ---------------- | --------------------------------------- |
| `id`           | UUID string      | Giữ nguyên từ v1.0                      |
| `name`         | string           | Tên sản phẩm                            |
| `imageUrl`     | string           | Relative path `/images/...`             |
| `basePriceVnd` | number           | VND, safe integer                       |
| `isAvailable`  | boolean          | `stock > 0 && category.isActive`        |
| `category`     | object           | `{code: string, name: string}`, luôn có |
| `description`  | string hoặc null | Field luôn xuất hiện                    |
| `rating`       | number hoặc null | 0–5; field luôn xuất hiện               |
| `isNew`        | boolean          | Badge sản phẩm mới                      |
| `isBestseller` | boolean          | Badge bán chạy                          |

### 3.4. Business Rules

- Public; giữ dạng `{ "items": [...] }` để tương thích Sprint 1.
- Sắp xếp tăng dần theo `name`, sau đó `id`.
- Danh sách rỗng trả `200 { "items": [] }`.
- Không trả `stock` thực tế, `sizes` hoặc `toppings` trong listing.
- Product thuộc category không hoạt động **vẫn hiển thị**, nhưng `isAvailable = false` (phương án A đã chốt).
- Product hết hàng vẫn có thể xuất hiện với `isAvailable = false`.
- Không tạo giá trị rating giả; `rating` chưa có thì trả `null`.

---

## 4. GET /products/:id – Product Detail

### 4.1. Overview

| Attribute                | Value                              |
| ------------------------ | ---------------------------------- |
| Method                   | GET                                |
| Endpoint                 | `/products/:id`                    |
| Authentication           | Public                             |
| Success Status           | 200 OK                             |
| Not Found Status         | 404 Not Found                      |
| Related Requirements     | FR-CAT-002, FR-CAT-003, FR-CAT-004 |
| Related User Stories     | US-CAT-02, US-CAT-03, US-CAT-04    |
| Related Use Case         | UC-CAT-002                         |
| Backend Owner (Sprint 1) | CKhang                             |
| Frontend Consumers       | Khánh, Lập                         |

### 4.2. Request

`GET /products/{productId}`; path `id` bắt buộc là UUID string. UUID sai định dạng: HTTP 400; UUID hợp lệ nhưng không tồn tại: HTTP 404.

### 4.3. Success Response – 200

```json
{
  "id": "a1000000-0000-4000-8000-000000000001",
  "name": "Cà phê đen",
  "imageUrl": "/images/product-placeholder.svg",
  "basePriceVnd": 30000,
  "isAvailable": true,
  "category": {
    "code": "traditional",
    "name": "Cà phê truyền thống"
  },
  "description": null,
  "rating": null,
  "isNew": false,
  "isBestseller": false,
  "sizePolicy": "STANDARD",
  "sizes": [
    { "size": "S", "multiplierPercent": 100 },
    { "size": "M", "multiplierPercent": 120 },
    { "size": "L", "multiplierPercent": 140 }
  ],
  "toppings": []
}
```

Các field chung giữ cùng ý nghĩa/kiểu dữ liệu như `GET /products`. `sizePolicy` luôn là `STANDARD` hoặc `ONE_SIZE`; `sizes`, `toppings` luôn là array (có thể rỗng đối với toppings).

### 4.4. Business Rules

- `STANDARD`: chỉ S=100%, M=120%, L=140%; Frontend mặc định chọn S.
- `ONE_SIZE`: `sizes` chỉ gồm `{ "size": "ONE_SIZE", "multiplierPercent": 100 }`; Frontend mặc định ONE_SIZE.
- Topping chỉ xuất hiện nếu có liên kết `product_toppings` với Product **và** `toppings.is_available = true`.
- Topping trả `id`, `name`, `priceVnd` (JSON number); không nhân giá topping theo Size; trả `[]` khi không có topping hợp lệ.
- Tối đa 3 loại topping khác nhau cho một dòng Cart/Order; mỗi topping tối đa một lần.
- `isAvailable = stock > 0 && category.isActive`; nếu false, Product vẫn trả HTTP 200 để hiển thị nhưng không được thêm vào Cart/đặt hàng.
- Không công khai số lượng stock thực tế; Backend kiểm tra lại toàn bộ khi tạo Order.
- Không thay đổi format lỗi Product Sprint 1: 400 UUID sai, 404 không tồn tại, 500 lỗi bất ngờ.

### 4.5. Price Calculation

```text
sizePriceVnd = floor(basePriceVnd * multiplierPercent / 100)
unitPriceVnd = sizePriceVnd + sum(topping.priceVnd)
lineTotalVnd = unitPriceVnd * quantity
```

Tính bằng số nguyên trong Backend, không dùng floating-point cho nghiệp vụ giá. Topping không nhân hệ số Size. Frontend chỉ tạm tính; Backend quyết định giá cuối cùng.

---

## 5. Error Response Standard

### 5.1. Legacy Sprint 1 Format

```json
{
  "statusCode": 404,
  "message": "Product not found",
  "error": "Not Found"
}
```

Sprint 1 Product errors giữ nguyên.

### 5.2. Sprint 2 Error Extension

Sprint 2 cho phép thêm `code` để Frontend xử lý machine-readable error.

Ví dụ:

```json
{
  "statusCode": 409,
  "message": "Email already exists",
  "error": "Conflict",
  "code": "EMAIL_ALREADY_EXISTS"
}
```

Quy định:

- `statusCode`: number, required.
- `message`: string hoặc string[], required.
- `error`: string, required.
- `code`: string, required cho các lỗi nghiệp vụ Sprint 2 đã định nghĩa.
- Không bắt buộc `code` cho Product v1.0 hoặc lỗi 500.
- Không trả raw SQL, stack trace, password/hash/secret.

### 5.3. Sprint 2 Error Codes

| Code                 | HTTP | Meaning                                              |
| -------------------- | ---: | ---------------------------------------------------- |
| VALIDATION_ERROR     |  400 | DTO/shape/range/enum/UUID sai                        |
| EMAIL_ALREADY_EXISTS |  409 | Email đã tồn tại                                     |
| INVALID_CREDENTIALS  |  401 | Email/password không hợp lệ                          |
| UNAUTHORIZED         |  401 | Thiếu/sai/hết hạn JWT                                |
| INVALID_CART         |  400 | Cart semantic/business rule không hợp lệ             |
| INVALID_COUPON       |  400 | Coupon không hợp lệ                                  |
| INSUFFICIENT_STOCK   |  409 | Không đủ stock                                       |
| PENDING_ORDER_EXISTS |  409 | User đã có active unpaid order nếu rule này được bật |

---

## 6. POST /auth/register – Create Customer

### 6.1. Overview

| Attribute         | Value            |
| ----------------- | ---------------- |
| Method            | POST             |
| Endpoint          | `/auth/register` |
| Authentication    | Public           |
| Success           | 201 Created      |
| Backend Owner     | Hoàng            |
| Frontend Consumer | Lập              |

Không tự động login hoặc phát JWT sau khi Register.

### 6.2. Request

```json
{
  "email": "customer@example.com",
  "password": "Password123",
  "fullName": "Nguyen Van A"
}
```

| Field    | Type   | Required | Validation                            |
| -------- | ------ | -------- | ------------------------------------- |
| email    | string | Yes      | Email hợp lệ, trim/lowercase, max 255 |
| password | string | Yes      | Tối thiểu 8 ký tự                     |
| fullName | string | No       | max 255                               |

Rules:

- Password được hash bằng **Argon2id** trước khi lưu `users.password_hash`. Không lưu plaintext, không log password hoặc password hash; không trim/normalize password trước khi hash.
- Không log password.
- `role`, `loyaltyPoints`, `passwordHash` từ client không được dùng.
- DB enforce unique email.
- `loyaltyPoints` mặc định 0 nếu schema có trường này.

### 6.3. Success Response – 201

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "customer@example.com",
  "fullName": "Nguyen Van A"
}
```

Không trả password, hash, role, loyaltyPoints hoặc accessToken.

### 6.4. Errors

- `400 VALIDATION_ERROR`
- `409 EMAIL_ALREADY_EXISTS`
- `500 Internal Server Error`

### 6.5. Swagger

- Auth tag
- RegisterDto
- Response DTO riêng
- `@ApiCreatedResponse`
- `@ApiBadRequestResponse`
- `@ApiConflictResponse`
- `@ApiInternalServerErrorResponse`

---

## 7. POST /auth/login – Issue JWT

### 7.1. Overview

| Attribute         | Value         |
| ----------------- | ------------- |
| Method            | POST          |
| Endpoint          | `/auth/login` |
| Authentication    | Public        |
| Success           | 200 OK        |
| Backend Owner     | Hoàng         |
| Frontend Consumer | Lập           |

### 7.2. Request

```json
{
  "email": "customer@example.com",
  "password": "Password123"
}
```

Rules:

- Email được chuẩn hóa để lookup.
- Password required, non-empty.
- Verify bằng **Argon2id** với `users.password_hash`; không trim/normalize password trước khi verify.
- Không tiết lộ email có tồn tại hay không.

### 7.3. Success Response – 200

```json
{
  "accessToken": "<JWT_ACCESS_TOKEN>",
  "tokenType": "Bearer",
  "expiresIn": 3600
}
```

JWT chứa `sub = User UUID`.

Không trả password/hash/refreshToken/JWT secret.

### 7.4. Errors

- `400 VALIDATION_ERROR`
- `401 INVALID_CREDENTIALS`
- `500 Internal Server Error`

Email không tồn tại và password sai phải trả cùng status/code/message.

### 7.5. Frontend Behavior

- Login thành công: lưu token theo strategy Frontend đã chốt.
- Login thất bại: giữ nguyên Cart.
- Token hết hạn khi Checkout: chuyển Login nhưng không làm mất Cart.

---

## 8. POST /orders – Create PENDING Order

### 8.1. Overview

| Attribute         | Value        |
| ----------------- | ------------ |
| Method            | POST         |
| Endpoint          | `/orders`    |
| Authentication    | JWT required |
| Success           | 201 Created  |
| Backend Owner     | CKhang       |
| Frontend Consumer | Lập, Khánh   |
| DB Owner          | Thụy         |

Header:

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

Order mới có status `PENDING`.

Payment API không thuộc v2.0.

### 8.2. Request Body

```json
{
  "items": [
    {
      "productId": "550e8400-e29b-41d4-a716-446655440000",
      "size": "M",
      "toppingIds": ["7d44a44c-8d1a-4af3-98cb-90e5d4c8a001"],
      "quantity": 2
    }
  ],
  "couponCode": "WELCOME20"
}
```

| Field              | Type          | Required | Validation                     |
| ------------------ | ------------- | -------- | ------------------------------ |
| items              | array         | Yes      | 1–20 dòng                      |
| items[].productId  | UUID string   | Yes      | Product tồn tại                |
| items[].size       | enum string   | Yes      | S/M/L/ONE_SIZE theo sizePolicy |
| items[].toppingIds | UUID string[] | Yes      | 0–3 ID khác nhau               |
| items[].quantity   | integer       | Yes      | 1–10                           |
| couponCode         | string        | No       | Tối đa 1 mã, trim, normalize   |

Client không được quyết định:

- `userId`
- `status`
- `price`
- `unitPriceVnd`
- `lineTotalVnd`
- `subtotalVnd`
- `discountVnd`
- `totalVnd`

Backend không dùng các field này nếu client tự thêm.

### 8.3. Server-side Validation & Calculation

Backend phải:

1. Lấy User ID từ JWT.
2. Validate DTO.
3. Kiểm tra Product tồn tại, `category.isActive = true`, `stock > 0`; nếu không đủ số lượng thì trả `409 INSUFFICIENT_STOCK`.
4. Kiểm tra Size theo Product: `STANDARD` chỉ S/M/L, `ONE_SIZE` chỉ ONE_SIZE.
5. Kiểm tra Topping thuộc `product_toppings` của Product và `toppings.is_available = true`; tối đa 3 ID khác nhau, không trùng.
6. Kiểm tra quantity.
7. Kiểm tra stock ở thời điểm tạo Order.
8. Đọc toàn bộ giá từ database.
9. Tự tính lại giá.
10. Nếu có coupon, validate coupon và tính discount.
11. Tạo Order + OrderItems trong transaction.
12. Nếu bất kỳ bước nào lỗi, rollback toàn bộ Create Order.

Pricing:

```text
unitPriceVnd =
floor(basePriceVnd * multiplierPercent / 100)
+ sum(toppingPriceVnd)

lineTotalVnd = unitPriceVnd * quantity
subtotalVnd = sum(lineTotalVnd)
totalVnd = subtotalVnd - discountVnd
```

Nếu không có coupon:

```text
discountVnd = 0
```

### 8.3.1. Product Catalog Validation Matrix (ORD-CAT-01…08)

Các mã dưới đây là **mã quy tắc nghiệp vụ để truy vết test**, không phải giá trị field `code` trong HTTP error response. Các lỗi trả về vẫn dùng `INVALID_CART`, `INSUFFICIENT_STOCK` hoặc `VALIDATION_ERROR` như §5 và §8.7.

| Rule ID        | Server-side rule                                                                                          | Khi vi phạm                                                                                     | `details[].reason` gợi ý                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **ORD-CAT-01** | Product ID phải tham chiếu Product đang tồn tại                                                           | `400 INVALID_CART`                                                                              | `PRODUCT_NOT_FOUND`                                                                                |
| **ORD-CAT-02** | Category của Product phải active; Product phải đủ stock theo quantity yêu cầu                             | Category inactive: `400 INVALID_CART`; thiếu stock: `409 INSUFFICIENT_STOCK`                    | `PRODUCT_UNAVAILABLE` (category inactive); trường hợp thiếu stock dùng `details` số lượng như §8.7 |
| **ORD-CAT-03** | `sizePolicy=STANDARD` chỉ chấp nhận `S`, `M`, `L`                                                         | `400 INVALID_CART`                                                                              | `INVALID_SIZE`                                                                                     |
| **ORD-CAT-04** | `sizePolicy=ONE_SIZE` chỉ chấp nhận `ONE_SIZE`                                                            | `400 INVALID_CART`                                                                              | `INVALID_SIZE`                                                                                     |
| **ORD-CAT-05** | Mỗi `toppingId` phải có liên kết với chính Product trong `product_toppings`                               | `400 INVALID_CART`                                                                              | `TOPPING_NOT_ALLOWED` (ID không tồn tại: `TOPPING_NOT_FOUND`)                                      |
| **ORD-CAT-06** | Topping đã liên kết phải có `isAvailable=true` tại thời điểm tạo Order                                    | `400 INVALID_CART`                                                                              | `TOPPING_UNAVAILABLE`                                                                              |
| **ORD-CAT-07** | Mỗi dòng tối đa 3 topping ID **khác nhau**, không ID trùng                                                | `400 INVALID_CART` (semantic); lỗi hình dạng/kiểu dữ liệu có thể là `400 VALIDATION_ERROR`      | `DUPLICATE_TOPPING`, `TOO_MANY_TOPPINGS`                                                           |
| **ORD-CAT-08** | Đọc giá Product/Topping từ PostgreSQL, tính lại và lưu snapshot bằng công thức §8.3, không tin giá Client | Không chấp nhận giá Client làm nguồn giá; lỗi dữ liệu Cart trả `400 INVALID_CART` khi thích hợp | `INVALID_PRICE_DATA` nếu dữ liệu không hợp lệ; lỗi hạ tầng thật sự là HTTP 500                     |

**Thứ tự phân loại lỗi:** sai shape, kiểu dữ liệu, UUID và enum không nằm trong tập `S/M/L/ONE_SIZE` → `VALIDATION_ERROR`; size nằm trong tập enum nhưng sai `sizePolicy` của Product → `INVALID_CART / INVALID_SIZE`. Category inactive **không** được đánh đồng với thiếu stock. Backend không công khai số stock qua Product API, nhưng `INSUFFICIENT_STOCK` có thể cung cấp chi tiết số lượng theo định dạng lỗi Order đã chốt.

**Khả năng tương thích:** body của `POST /orders` không đổi cấu trúc; tập giá trị `size` được mở rộng thêm `ONE_SIZE` theo từng Product. Các nguyên tắc coupon/transaction của v2.0 tiếp tục áp dụng. CKhang chịu trách nhiệm triển khai và test các quy tắc này trong task/PR Order riêng.

**Test acceptance tối thiểu cho owner Order:** Product không tồn tại; category inactive; thiếu stock; STANDARD với ONE_SIZE và ngược lại; topping không liên kết; topping unavailable; trùng topping; hơn 3 topping; tính giá `floor` và snapshot; transaction rollback nếu validation thất bại.

### 8.4. Coupon Scope in Sprint 2

Coupon là optional.

Sprint 2 MUST:

- Nhận `couponCode` optional.
- Lookup coupon.
- Kiểm tra coupon tồn tại và đang sử dụng được theo các rule hiện có trong tài liệu nghiệp vụ.
- Kiểm tra min subtotal nếu có.
- Tính discount.
- Lưu coupon/order snapshot cần thiết để Order response không thay đổi hồi tố.

Sprint 2 KHÔNG bắt buộc:

- coupon preview API
- advanced concurrent coupon quota serialization
- full HELD → CONSUMED → RELEASED lifecycle
- scheduled coupon release
- row-lock strategy chuyên sâu

Các phần trên defer sang Task 10 / Sprint 3 nếu không phải điều kiện bắt buộc của implementation hiện tại. Các quy tắc Product Catalog được cập nhật ở bản 2.1; việc triển khai `POST /orders` vẫn thuộc owner Order, không tự mở rộng phạm vi task Backend Catalog.

### 8.5. Transaction Scope

Sprint 2 MUST:

- Tạo Order và OrderItems nguyên tử.
- Không được tạo Order dở dang.
- Không tin giá/owner/status từ client.
- Stock không được âm do logic request thông thường.
- Nếu Order creation thất bại thì rollback.

Advanced concurrency hardening như:

- partial unique index cho active Order
- bounded retry cho transaction race
- row lock coupon
- concurrent coupon quota tests
- concurrent expiration cleanup
- scheduled expiration cron

được defer sang Task 10 / Sprint 3.

### 8.6. Success Response – 201

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440010",
  "status": "PENDING",
  "items": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440011",
      "productId": "550e8400-e29b-41d4-a716-446655440000",
      "productName": "Cà phê sữa",
      "size": "M",
      "sizeMultiplierPercent": 120,
      "basePriceVnd": 45000,
      "quantity": 2,
      "unitPriceVnd": 59000,
      "lineTotalVnd": 118000,
      "toppings": [
        {
          "id": "7d44a44c-8d1a-4af3-98cb-90e5d4c8a001",
          "name": "Trân châu",
          "priceVnd": 5000
        }
      ]
    }
  ],
  "couponCode": "WELCOME20",
  "subtotalVnd": 118000,
  "discountVnd": 20000,
  "totalVnd": 98000,
  "createdAt": "2026-10-21T13:00:00.000Z"
}
```

Rules:

- `couponCode`: string hoặc null.
- `status = PENDING`.
- `createdAt`: ISO 8601 UTC.
- Backend trả snapshot giá đã dùng để tạo Order.
- Response total phải là giá server-side.
- Không tạo Payment khi tạo Order.

### 8.7. Error Responses

| HTTP | code                 | Trigger                                                         |
| ---- | -------------------- | --------------------------------------------------------------- |
| 400  | VALIDATION_ERROR     | DTO/shape/UUID/enum/range sai                                   |
| 400  | INVALID_CART         | Cart semantic không hợp lệ                                      |
| 400  | INVALID_COUPON       | Coupon không tồn tại/không hợp lệ                               |
| 401  | UNAUTHORIZED         | Thiếu/sai/hết hạn JWT                                           |
| 409  | INSUFFICIENT_STOCK   | Không đủ stock                                                  |
| 409  | PENDING_ORDER_EXISTS | Chỉ dùng nếu active-order rule đã được implement trong Sprint 2 |
| 500  | none required        | Lỗi hệ thống                                                    |

Ví dụ `INSUFFICIENT_STOCK`:

```json
{
  "statusCode": 409,
  "message": "Insufficient product stock",
  "error": "Conflict",
  "code": "INSUFFICIENT_STOCK",
  "details": [
    {
      "productId": "550e8400-e29b-41d4-a716-446655440000",
      "requestedQuantity": 6,
      "availableQuantity": 5
    }
  ]
}
```

Ví dụ `INVALID_CART`:

```json
{
  "statusCode": 400,
  "message": ["Invalid cart item at index 1"],
  "error": "Bad Request",
  "code": "INVALID_CART",
  "details": [
    {
      "itemIndex": 1,
      "reason": "DUPLICATE_TOPPING"
    }
  ]
}
```

Suggested `reason` values:

- `DUPLICATE_CONFIGURATION`
- `DUPLICATE_TOPPING`
- `PRODUCT_NOT_FOUND`
- `TOPPING_NOT_FOUND`
- `PRODUCT_UNAVAILABLE`
- `INVALID_SIZE`
- `TOPPING_NOT_ALLOWED`
- `TOPPING_UNAVAILABLE`
- `TOO_MANY_TOPPINGS`
- `INVALID_PRICE_DATA`

Frontend không parse text `message` để suy luận loại lỗi; dùng `code` và `details`.

### 8.8. Swagger Expectations

NestJS Swagger cần mô tả:

- Bearer scheme
- `@ApiBearerAuth`
- CreateOrderDto
- OrderResponseDto
- `@ApiCreatedResponse`
- `@ApiBadRequestResponse`
- `@ApiUnauthorizedResponse`
- `@ApiConflictResponse`
- `@ApiInternalServerErrorResponse`

Nested DTO phải validate đúng:

- items 1–20
- quantity 1–10
- toppingIds 0–3
- UUID
- enum Size

---

## 9. Frontend Integration Expectations

### 9.1. Cart

Cart được quản lý phía Frontend.

Frontend chịu trách nhiệm:

- Add item
- Remove item
- Update quantity
- Cart badge
- Tạm tính giá
- Giữ Cart qua login flow theo UX đã chốt

Frontend không được coi local Cart là nguồn giá cuối cùng.

### 9.2. Auth

Frontend:

- Gọi Register/Login theo contract.
- Không gửi role/loyaltyPoints.
- Lưu và gửi Bearer Token cho endpoint bảo vệ.
- Khi JWT hết hạn ở Checkout, chuyển Login nhưng giữ Cart.

### 9.3. Checkout

Frontend gửi:

- productId
- size
- toppingIds
- quantity
- couponCode nếu có

Frontend không gửi:

- userId
- status
- total
- price
- discount quyết định bởi client

Sau Create Order thành công, hiển thị response từ server.

---

## 10. Future Scope – Not in v2.1

Không đặc tả trong v2.1:

- `POST /payments`
- `GET /orders/me`
- Order History
- Cancel Order API
- Loyalty API
- Coupon preview API
- Payment idempotency
- Advanced concurrency protection
- Scheduled expiration cron
- Advanced coupon quota locking
- Release/consume coupon lifecycle
- Race-condition acceptance tests chuyên sâu
- Catalog pagination

Các nội dung này được xử lý ở Sprint 3 / Task 10 hoặc version contract tiếp theo.

---

## 11. Version / Change History

| Version | Status                 | Scope                                                                                                                             | Compatibility                                               |
| ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1.0     | Approved               | GET `/products`, GET `/products/:id`                                                                                              | Sprint 1 baseline                                           |
| 2.0     | Approved – API Design  | Adds Auth/JWT and POST `/orders`; preserves Product contract                                                                      | Baseline Sprint 2                                           |
| 2.1     | Final Review Candidate | Catalog fields, availability, sizes, product-specific toppings, price rounding, Argon2id; ORD-CAT-01…08 and responsibility matrix | Additive Product fields; Order size/validation rule updates |

---

## 12. Sprint 2 Approval Gate

API Contract v2.1 sẵn sàng để hoàn tất nghiệm thu khi:

- Product v1.0 giữ nguyên endpoint và field cũ; thêm field mới một cách tương thích.
- Register/Login fields và status được team thống nhất.
- JWT rules được thống nhất.
- `POST /orders` request/response được Backend + Frontend thống nhất.
- Server-side pricing được thống nhất.
- Coupon scope được giới hạn đúng Sprint 2.
- Advanced concurrency/expiration không bị ngầm đưa vào Sprint 2 nếu Jira chưa có task.
- Swagger phải phản ánh đúng contract.
- Jira assignment phải khớp với trách nhiệm implementation (§1.4–1.5).
- Từng rule ORD-CAT-01…08 có owner và acceptance tests; logic Order thuộc PR của CKhang, không bị ghi nhầm là đã triển khai cùng Product API.
- Kiểm tra ví dụ tính tiền: `45000 × 120% + 5000 = 59000`, số lượng 2 → `118000`; coupon ví dụ `20000` → tổng `98000`.
- Mọi thay đổi sau Approval phải cập nhật API Contract trước khi merge code liên quan.

**Design State:** Final Review Candidate. Quyết định nghiệp vụ/response đã chốt với Leader; chưa xác nhận triển khai, tích hợp và approval của các owner liên quan. Không tự coi phiên bản này là Approved khi chưa qua §12–13.

---

## 13. Sprint 2 Definition of Done for API Contract

Contract task được xem là Done khi:

1. Markdown v2.1 được commit vào repository; v2.0 được giữ nguyên.
2. Team đã được thông báo endpoint mới.
3. Backend owners xác nhận request/response.
4. Frontend owners xác nhận payload/error handling.
5. Swagger implementation bám contract.
6. Không còn field hoặc business rule Sprint 2 chưa có owner.
7. Không còn scope Task 10 bị ngầm nhét vào `POST /orders`.
8. Product Catalog DTO/Swagger/tests đồng bộ với v2.1; owner Order đồng bộ kiểm tra `ONE_SIZE` và topping.
9. Đối chiếu AuthService thực sự gọi Argon2id hash/verify, không chỉ khai báo hàm helper.
10. Owner Order đối chiếu và lập test cho đủ ORD-CAT-01…08; các ngoại lệ `VALIDATION_ERROR` / `INVALID_CART` / `INSUFFICIENT_STOCK` nhất quán.
11. Các owner HKhang, CKhang, Khánh và Lập xác nhận phạm vi tích hợp và tác động tương thích trước khi nâng trạng thái Approved.
