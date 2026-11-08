# BrewLite Pull Request Review

Hãy review task/PR hiện tại của BrewLite.

## Input

Jira task: `<JIRA_KEY>`
Tên task: `<TASK_NAME>`
Assignee: `<MEMBER_NAME>`

Jira Description:
`<PASTE_JIRA_DESCRIPTION>`

Definition of Done / Acceptance Criteria:
`<PASTE_DOD_OR_AC>`

Base branch mặc định: `dev`

Nếu Jira scope hoặc API Contract liên quan chưa đủ rõ, hãy chỉ ra thông tin còn thiếu và dừng review tại đó.

## Yêu cầu

1. Đọc `AGENTS.md`.
2. Xác định:
   - branch hiện tại;
   - base branch;
   - diff của branch hiện tại so với `dev`;
   - các file thay đổi;
   - Jira scope;
   - API Contract và tài liệu liên quan.
3. Chỉ review các thay đổi thuộc PR hiện tại.
4. Không sửa code.
5. Không commit, push, pull, merge, switch branch hoặc thay đổi Git history.
6. Có thể chạy các lệnh read-only, build và test phù hợp nếu được phép.

## Review checklist

Kiểm tra:

- đúng Jira scope;
- đúng API Contract;
- logic nghiệp vụ;
- regression;
- authentication / authorization;
- security;
- DTO / validation;
- Prisma query;
- transaction;
- database consistency;
- Swagger/OpenAPI;
- error handling;
- frontend/backend integration nếu liên quan;
- build;
- tests;
- test coverage cần thiết.

## Output

Trước tiên cho biết:

- PR đang thay đổi những gì;
- flow kỹ thuật của phần được thay đổi;
- scope Jira nào đã được đáp ứng;
- scope Jira nào chưa được đáp ứng.

Sau đó phân loại findings:

### Blocker

Lỗi khiến task không thể approve/merge.

### Major

Lỗi quan trọng cần sửa trước khi Done.

### Minor

Lỗi nhỏ hoặc cải thiện nên sửa.

### Looks good

Những phần đã đúng.

Mỗi finding phải có:

- file/path;
- vị trí hoặc đoạn code liên quan;
- vấn đề;
- tại sao đó là vấn đề;
- cách sửa cụ thể.

## Final Verdict

Kết luận một trong:

- `PASS`
- `PASS WITH MINOR ISSUES`
- `REQUEST CHANGES`

Nêu rõ task có đủ điều kiện để:

- approve PR;
- merge vào `dev`;
- chuyển Jira sang Done;

hay chưa.

## Message to Assignee

Nếu kết luận là `REQUEST CHANGES` hoặc có vấn đề cần thành viên sửa:

Viết thêm một tin nhắn ngắn bằng tiếng Việt để leader có thể gửi trực tiếp cho người đang phụ trách task.

Tin nhắn phải:

- thân thiện, tự nhiên;
- nói rõ task hiện chưa pass ở điểm nào;
- liệt kê chính xác những phần cần sửa;
- không dùng ngôn ngữ quá kỹ thuật nếu không cần;
- yêu cầu thành viên test lại sau khi sửa;
- không thêm lỗi không có trong review.

Nếu task `PASS`, không cần tạo message yêu cầu sửa.

Không tự sửa code.
Không tự approve hoặc merge PR.
Dừng sau khi báo cáo review.
