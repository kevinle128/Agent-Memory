# Nhật ký triển khai: skill toàn cục và skill dự án

## 2026-10-24

- 09:11 Bạn duyệt plan và yêu cầu tự làm đến hết. Sau mỗi phase sửa code phải có e2e test.
- Giai đoạn 0 (tên dự án):
  - Proxy: commit `f3d0a3d0`. Tên dự án là đường dẫn remote không có host (`vtc/3q-chess/3q-game-api`); bỏ phần `?`/`#`; ký tự không an toàn thì không có tên. Key và hash không đổi.
  - Core: nhận và lưu `project_name` trên L0 (sqlite, mongo, tcvdb), cùng quy tắc kiểm tra ký tự với Proxy. Commit chung với phần Core của Giai đoạn 1, vì Giai đoạn 1 đang sửa cùng thư mục store; Proxy mới gửi tên cho Core cũ thì Core bỏ qua trường này (schema `passthrough`).
  - Test: Proxy 465/465 + test làm sạch tên, tsc sạch. E2E local (`MemoryProxy/scripts/qa/project-e2e.sh`, Claude Code thật, HOME tạm): 2/2 (repo GitLab nhiều cấp có tên đúng; thư mục ngoài git không có dự án).
  - Review độc lập: không có lỗi chặn. Đã sửa: kiểm tra tên một lần ở nơi tạo, chặn ký tự Unicode tách dòng và đảo chiều, bỏ query string khỏi tên, thêm tên vào kết quả tìm kiếm L0 của sqlite.
