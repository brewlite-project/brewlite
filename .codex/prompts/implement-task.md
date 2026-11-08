# BrewLite Task Implementation

Tôi đang thực hiện một Jira task của BrewLite.

## Input

Jira task: `<JIRA_KEY>`
Tên task: `<TASK_NAME>`

## Mục tiêu

Hỗ trợ tôi implement task đúng kiến trúc và tài liệu hiện tại của BrewLite.

Tôi đang học backend, vì vậy tôi cần hiểu code chứ không chỉ cần code chạy.

## Trước khi sửa code

1. Đọc `AGENTS.md`.
2. Đọc Jira scope.
3. Đọc API Contract liên quan.
4. Đọc code hiện tại và dependency của task.
5. Giải thích flow hiện tại bằng tiếng Việt.
6. Xác định:
   - file nào cần sửa;
   - file nào không cần sửa;
   - dependency;
   - risk;
   - test cần chạy.
7. Đưa kế hoạch implementation ngắn.

Không sửa file cho tới khi tôi đồng ý bắt đầu implementation.

## Khi được phép implement

- chỉ sửa những file cần thiết;
- không refactor ngoài scope;
- không tự thêm endpoint/field/business rule;
- theo convention hiện có;
- giải thích từng thay đổi quan trọng;
- ưu tiên thay đổi nhỏ và dễ review.

Nếu liên quan backend, giải thích luồng phù hợp:

`Request → Guard → Controller → DTO → Service → Prisma → PostgreSQL → Response`

## Sau implementation

1. Kiểm tra diff.
2. Chạy build/test phù hợp.
3. Kiểm tra API Contract.
4. Kiểm tra regression.
5. Báo:
   - file đã sửa;
   - thay đổi chính;
   - test đã chạy;
   - test chưa chạy được;
   - risk còn lại.

Không commit hoặc push nếu tôi chưa cho phép.

Dừng trước bước Git commit.
