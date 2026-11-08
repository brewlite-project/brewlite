# BrewLite Debug Workflow

Tôi đang debug một lỗi trong BrewLite.

## Input

Jira/task: `<JIRA_KEY_OR_CONTEXT>`

Hiện tượng:
`<ERROR_DESCRIPTION>`

Expected behavior:
`<EXPECTED_BEHAVIOR>`

## Quy trình

1. Đọc `AGENTS.md`.
2. Không sửa code ngay.
3. Thu thập bằng chứng trước:
   - error message;
   - stack trace;
   - request/response;
   - relevant logs;
   - Git diff;
   - file liên quan;
   - API Contract;
   - database/migration state nếu liên quan.
4. Trace flow của request.
5. Xác định root cause có khả năng nhất.
6. Phân biệt:
   - root cause;
   - symptom;
   - lỗi có sẵn;
   - lỗi mới do branch/task hiện tại gây ra.

## Trước khi sửa

Báo cho tôi:

- lỗi xảy ra ở đâu;
- vì sao xảy ra;
- bằng chứng;
- file cần sửa;
- phương án sửa tối thiểu;
- risk.

Không sửa file trước khi tôi đồng ý.

## Khi được phép sửa

- sửa tối thiểu;
- không refactor không liên quan;
- chạy lại case gây lỗi;
- chạy regression test phù hợp;
- kiểm tra final diff.

Nếu lỗi chưa xác định chắc chắn:
không đoán và sửa hàng loạt.
Hãy tiếp tục thu thập bằng chứng.

Không commit/push/merge nếu chưa được tôi cho phép.
