# ADR – Hoãn nghiệm thu VNPay QueryDR Sandbox E2E sang A2

**Trạng thái:** APPROVED – Điều chỉnh phạm vi nghiệm thu A1  
**Ngày quyết định:** 03/11/2026  
**Task liên quan:** SCRUM-81 – P2-07 Implement VNPay IPN Endpoint & QueryDR Client  
**Task theo dõi A2:** SCRUM-95 – Investigate & Complete VNPay QueryDR Sandbox E2E

---

## 1. Bối cảnh (Context)

Trong Phase 2 của dự án BrewLite, nhóm triển khai tích hợp VNPay Sandbox, bao gồm:

- **IPN (Instant Payment Notification):** Tiếp nhận và xác minh thông báo kết quả thanh toán từ VNPay.
- **QueryDR (Query Transaction):** Chủ động truy vấn VNPay để xác minh trạng thái giao dịch, phục vụ đối soát và hỗ trợ xử lý các trường hợp IPN không được tiếp nhận hoặc xử lý thành công.
- **Shared Payment Finalization:** Xử lý kết quả thanh toán đã được xác minh, bảo đảm tính nhất quán giữa Payment, Order và các dữ liệu nghiệp vụ liên quan.

Trong quá trình nghiệm thu SCRUM-81, nhóm đã thực hiện giao dịch thanh toán thực tế trên VNPay Sandbox với số tiền **42.000 VND**, thông qua thẻ thử nghiệm NCB.

### 1.1. Kết quả nghiệm thu thành công

- VNPay gửi IPN hợp lệ đến backend BrewLite thông qua HTTPS/ngrok.
- Backend xác minh và phản hồi IPN với `RspCode = 00`.
- Payment được cập nhật thành `SUCCESS`.
- Order được cập nhật thành `PAID`.
- Gateway Event được lưu với `outcome = SUCCESS` và `disposition = FINALIZED`.
- Không phát sinh financial exception.
- Unit tests: **221/221 PASS**.
- PostgreSQL integration tests đã chạy sau bản sửa R-01: **28/28 PASS**.
- Production build và lint: **PASS**.
- Cơ chế xử lý giao dịch đồng thời, trùng lặp và grace period đã được kiểm tra trong các bài integration test liên quan.

### 1.2. Vấn đề còn tồn đọng

Khi gọi QueryDR API thực tế đến VNPay Sandbox để truy vấn lại giao dịch đã thanh toán, hệ thống liên tục nhận phản hồi:

```json
{
  "vnp_ResponseCode": "99",
  "vnp_Message": "Unexpected error"
}
```

Phản hồi chỉ chứa hai trường trên, không có thông tin giao dịch đầy đủ hoặc chữ ký `vnp_SecureHash`.

Do đó, QueryDR Client từ chối phản hồi này và không sử dụng nó làm bằng chứng tài chính hợp lệ.

Nhóm đã tiến hành kiểm tra:

- HTTP method, endpoint và JSON request.
- Merchant TMN Code.
- Các trường định danh giao dịch.
- Thời gian tạo giao dịch theo GMT+7.
- Cơ chế HMAC-SHA512 và thứ tự các trường ký.
- Địa chỉ IP nội bộ và IP công khai.
- Trường tùy chọn `vnp_TransactionNo`.
- Sự tương thích giữa implementation và tài liệu QueryDR PAY 2.1.0.

Tuy nhiên, **chưa xác định được nguyên nhân chính xác** của phản hồi mã `99`.

Nhóm đã gửi yêu cầu hỗ trợ kỹ thuật đến VNPay vào ngày 03/11/2026 và đang chờ phản hồi.

---

## 2. Quyết định (Decision)

Nhằm bảo đảm tiến độ hoàn thành A1 và không gây đình trệ các task phụ thuộc, nhóm quyết định **điều chỉnh phạm vi nghiệm thu SCRUM-81 cho A1 và chuyển phần kiểm thử QueryDR Sandbox E2E thực tế sang A2**.

### 2.1. Phạm vi được chấp nhận trong A1

Các hạng mục sau được chấp nhận:

1. Triển khai VNPay IPN Endpoint.
2. Xác minh tính hợp lệ của IPN, bao gồm chữ ký, merchant, mã giao dịch và số tiền.
3. Xử lý kết quả IPN thông qua Shared Payment Finalization.
4. Xác minh thành công luồng thanh toán IPN thực tế trên VNPay Sandbox.
5. Triển khai QueryDR HTTP Client, bao gồm:
   - Tạo và ký request QueryDR.
   - Gửi request đến VNPay.
   - Kiểm tra chữ ký response.
   - Đối chiếu thông tin giao dịch.
   - Phân biệt kết quả xử lý truy vấn và trạng thái thanh toán.
6. Kiểm thử QueryDR Client bằng các response giả lập có chữ ký hợp lệ trong unit/integration tests.
7. Hoàn thành các bài kiểm thử liên quan và xác minh không phát sinh regression trong những trường hợp được bao phủ.

### 2.2. Phạm vi chuyển sang A2

Các hạng mục sau được hoãn sang A2:

1. Điều tra và giải quyết nguyên nhân VNPay Sandbox QueryDR trả mã `99 / Unexpected error`.
2. Kiểm thử QueryDR E2E thực tế với VNPay Sandbox.
3. Nhận và xác minh thành công một response QueryDR có chữ ký hợp lệ từ VNPay Sandbox.
4. Nghiệm thu end-to-end cơ chế đối soát và phục hồi trạng thái thanh toán khi IPN không đến hoặc không được xử lý thành công.
5. Kiểm tra lại tính nhất quán dữ liệu và các bất biến tài chính trong tình huống phục hồi thực tế.

**Quyết định này không loại bỏ QueryDR khỏi yêu cầu hệ thống và không đồng nghĩa với việc QueryDR Sandbox E2E đã PASS.**

---

## 3. Giới hạn và rủi ro đã biết (Known Limitations and Risks)

### 3.1. QueryDR Sandbox chưa được nghiệm thu E2E

Mặc dù QueryDR Client đã được triển khai và vượt qua các bài kiểm thử tự động, nhóm chưa xác minh được một giao dịch thực tế thông qua QueryDR Sandbox.

### 3.2. Khả năng phục hồi khi mất IPN chưa được xác minh thực tế

Nếu khách hàng thanh toán thành công nhưng backend không nhận được IPN, Payment có thể tiếp tục ở trạng thái `PENDING`.

Trong trường hợp đó, hệ thống cần cơ chế đối soát để xác định kết quả thanh toán.

Tuy nhiên, do QueryDR Sandbox hiện trả mã `99`, nhóm chưa thể bảo đảm khả năng phục hồi tự động trong môi trường Sandbox.

### 3.3. Rủi ro đối với Reconciliation Scheduler

Reconciliation Scheduler có thể được triển khai và kiểm thử với QueryDR responses giả lập.

Tuy nhiên, khi kết nối với QueryDR Sandbox thực tế, scheduler vẫn có thể gặp phản hồi mã `99`.

Việc scheduler hoạt động đúng theo unit/integration tests không được xem là bằng chứng rằng toàn bộ luồng đối soát thực tế đã được nghiệm thu.

### 3.4. Giới hạn đối với bản demo A1

Nhóm có thể trình diễn luồng thanh toán VNPay thông thường đã được kiểm thử thành công qua IPN.

Tuy nhiên, không tuyên bố rằng hệ thống đã xác minh thành công cơ chế tự động phục hồi giao dịch khi IPN bị mất.

---

## 4. Tiêu chí nghiệm thu cho A2 (Acceptance Criteria)

Task A2 theo dõi vấn đề này chỉ được xem là hoàn thành khi đáp ứng các tiêu chí sau:

**AC-01: Xác định nguyên nhân lỗi QueryDR**

- Xác định được nguyên nhân VNPay Sandbox trả mã `99`.
- Phân biệt rõ lỗi implementation, cấu hình merchant hoặc giới hạn của Sandbox.
- Ghi nhận bằng chứng kỹ thuật và phương án xử lý.

**AC-02: QueryDR Sandbox E2E thành công**

- Gửi request QueryDR hợp lệ đến VNPay Sandbox.
- Nhận response chứa đầy đủ thông tin giao dịch và chữ ký hợp lệ.
- Xác minh thành công HMAC-SHA512.
- Đối chiếu merchant, transaction reference, amount và transaction status.

**AC-03: Xác minh khả năng phục hồi khi mất IPN**

- Mô phỏng hoặc kiểm thử tình huống backend không nhận được IPN.
- Hệ thống thực hiện QueryDR để truy vấn trạng thái giao dịch.
- Kết quả đã xác minh được chuyển đến Shared Payment Finalization.
- Payment và Order được cập nhật chính xác theo kết quả và quy tắc nghiệp vụ.

**AC-04: Bảo đảm các bất biến tài chính**

- Không tạo hai Payment `SUCCESS` cho cùng một Order.
- Không cộng điểm thưởng hoặc cập nhật tồn kho hai lần.
- Không xử lý trùng Gateway Event như một giao dịch mới.
- Không tự động đánh dấu thanh toán thành công khi chưa có bằng chứng tài chính hợp lệ.
- Các trường hợp late payment và financial exception được xử lý đúng chính sách đã duyệt.

**AC-05: Regression và tài liệu**

- Các bài unit/integration tests liên quan đạt yêu cầu.
- Hoàn thành kiểm thử PostgreSQL concurrency phù hợp.
- Cập nhật tài liệu kỹ thuật và kết quả nghiệm thu thực tế.
- Đóng issue A2 sau khi các Acceptance Criteria trên được xác minh.

---

## 5. Hệ quả của quyết định (Consequences)

### 5.1. Đối với SCRUM-81

- SCRUM-81 có thể được xem xét hoàn thành trong phạm vi A1 đã điều chỉnh, sau khi vượt qua code review và PR được merge thành công theo quy trình nhóm.
- Không ghi nhận QueryDR Sandbox E2E là PASS.
- Phần việc chuyển sang A2 phải được theo dõi bằng một Jira issue riêng.

### 5.2. Đối với các task phụ thuộc

- Các task sử dụng VNPay IPN và Shared Payment Finalization có thể tiếp tục tích hợp theo phạm vi đã kiểm thử.
- Các task liên quan đến QueryDR hoặc Reconciliation Scheduler phải ghi nhận giới hạn Sandbox hiện tại.
- Không được xem việc SCRUM-81 hoàn thành phạm vi A1 là bằng chứng toàn bộ hệ thống đối soát VNPay đã hoạt động E2E.

### 5.3. Đối với báo cáo và nghiệm thu

- Báo cáo A1 phải phản ánh đúng các chức năng đã được kiểm thử thực tế.
- Giới hạn QueryDR cần được trình bày trong phần vấn đề tồn đọng hoặc hướng phát triển.
- Khi bắt đầu A2, nhóm sử dụng ADR này cùng issue Jira để tiếp tục điều tra và hoàn thiện.

---

## 6. Theo dõi và trách nhiệm (Follow-up)

**Người chịu trách nhiệm:** Leader BrewLite phối hợp với thành viên phụ trách tích hợp VNPay.

**Issue A2:** SCRUM-95, cần cập nhật mã issue sau khi tạo trên Jira.

**Trạng thái hỗ trợ VNPay:** Đã gửi email ngày 03/11/2026, chưa có phản hồi tại thời điểm lập tài liệu.

**Điều kiện đóng vấn đề:** Chỉ đóng issue A2 khi QueryDR Sandbox E2E và khả năng phục hồi thanh toán liên quan đã được kiểm thử thành công, hoặc khi có quyết định thay đổi phạm vi mới được phê duyệt và ghi nhận rõ ràng.
