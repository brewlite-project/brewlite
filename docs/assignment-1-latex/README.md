# BrewLite — 16 project LaTeX độc lập (Assignment 1)

Nguồn: 6 file `.docx`, ERD PDF, Activity + Use Case + 6 Sequence SVG, PDF UI/UX đã cung cấp.
Định dạng tham chiếu: SGU `Assignment_report.pdf` và `Assigment_template_SGU.zip`.

## Các file riêng biệt

| Tệp `.tex` | Nội dung | Nguồn |
|---|---|---|
| `01_Project_Charter.tex` | Project Charter | Word chuyển sang LaTeX |
| `02_Requirements_Specification.tex` | Requirements Specification | Word chuyển sang LaTeX |
| `03_Techstack.tex` | Techstack | Word chuyển sang LaTeX |
| `04_User_Stories_Acceptance_Criteria.tex` | User Stories & Acceptance Criteria | Word chuyển sang LaTeX |
| `05_Use_Case_Specification.tex` | Use Case Specification | Word chuyển sang LaTeX |
| `06_Finalize_Product_Data_Model.tex` | Finalize Product Data Model | Word chuyển sang LaTeX |
| `07_ERD.tex` | ERD | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `08_Activity_Diagram.tex` | Activity Diagram | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `09_Use_Case_Diagram.tex` | Use Case Diagram | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `10_Sequence_Diagram_1.tex` | Sequence Diagram 1 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `11_Sequence_Diagram_2.tex` | Sequence Diagram 2 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `12_Sequence_Diagram_3.tex` | Sequence Diagram 3 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `13_Sequence_Diagram_4.tex` | Sequence Diagram 4 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `14_Sequence_Diagram_5.tex` | Sequence Diagram 5 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `15_Sequence_Diagram_6.tex` | Sequence Diagram 6 | Sơ đồ/PDF gốc chèn bằng pdfpages |
| `16_UIUX_Design.tex` | UI/UX Design | Sơ đồ/PDF gốc chèn bằng pdfpages |

## Cách biên dịch

Cài TeX Live hoặc MiKTeX có XeLaTeX, Tinos, Noto Sans, DejaVu Sans Mono, và các gói dùng trong tài liệu.
Để xuất một báo cáo riêng, mở terminal **ngay thư mục chứa 16 file .tex** và chạy:

```bash
xelatex -interaction=nonstopmode -halt-on-error 01_Project_Charter.tex
xelatex -interaction=nonstopmode -halt-on-error 01_Project_Charter.tex
```

Lặp 2 lần nhằm cập nhật mục lục và số trang. Để xuất tất cả vào `pdf/`:

```bash
bash build_all.sh         # Linux / macOS / Git Bash Windows
# hoặc chạy build_all.bat trong Command Prompt Windows
```

### Overleaf

Upload toàn bộ ZIP đã giải nén vào cùng project. Chọn **Compiler: XeLaTeX**, rồi chọn file cần xuất ở **Menu → Main document**. Vì mỗi `.tex` đã có `\documentclass`, có thể biên dịch độc lập. **Không** đặt một file `.tex` bên trong file khác làm `\input`.

### Tài nguyên chia sẻ

- `assets/branding`: logo SGU đúng mẫu.
- `assets/source-pdfs`: ERD và PDF thiết kế UI/UX gốc.
- `assets/source-svg`: 8 sơ đồ nguồn SVG có thể chỉnh bằng draw.io.
- `assets/diagrams`: 8 sơ đồ đã xuất PDF vector và chia trang cho dễ đọc.
- `pdf`: 16 bản PDF biên dịch độc lập.

## Bảng thành viên và phân công

Cả 16 file đều có bảng 6 thành viên/MSSV/vai trò và cột Phân công. Chưa có phân nhiệm được xác nhận nên đang để `Chưa cập nhật`; sửa trực tiếp cột cuối tại từng file nếu muốn giao việc theo tài liệu.

## Mức độ chuyển đổi

6 Word được chuyển thành LaTeX **có thể chỉnh sửa nội dung** với các bảng dài. ERD, diagram SVG và thiết kế UI/UX được **chèn làm trang PDF** để bảo toàn sơ đồ và chất lượng; chỉ nội dung được nhập từ DOCX mới là text LaTeX trực tiếp. Muốn chỉnh sửa sơ đồ cần mở file SVG trong draw.io, xuất lại PDF ở `assets/diagrams`.

Các file Markdown API trong ZIP không thuộc 16 tài liệu được yêu cầu nên không tạo file LaTeX tương ứng.
