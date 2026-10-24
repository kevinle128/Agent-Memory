# Nhật ký triển khai: skill toàn cục và skill dự án

## 2026-10-24

- 09:11 Bạn duyệt plan và yêu cầu tự làm đến hết. Sau mỗi phase sửa code phải có e2e test.
- Giai đoạn 0 (tên dự án):
  - Proxy: commit `f3d0a3d0`. Tên dự án là đường dẫn remote không có host (`vtc/3q-chess/3q-game-api`); bỏ phần `?`/`#`; ký tự không an toàn thì không có tên. Key và hash không đổi.
  - Core: nhận và lưu `project_name` trên L0 (sqlite, mongo, tcvdb), cùng quy tắc kiểm tra ký tự với Proxy. Commit chung với phần Core của Giai đoạn 1, vì Giai đoạn 1 đang sửa cùng thư mục store; Proxy mới gửi tên cho Core cũ thì Core bỏ qua trường này (schema `passthrough`).
  - Test: Proxy 465/465 + test làm sạch tên, tsc sạch. E2E local (`MemoryProxy/scripts/qa/project-e2e.sh`, Claude Code thật, HOME tạm): 2/2 (repo GitLab nhiều cấp có tên đúng; thư mục ngoài git không có dự án).
  - Review độc lập: không có lỗi chặn. Đã sửa: kiểm tra tên một lần ở nơi tạo, chặn ký tự Unicode tách dòng và đảo chiều, bỏ query string khỏi tên, thêm tên vào kết quả tìm kiếm L0 của sqlite.
- Giai đoạn 1 (Core: phạm vi skill, lịch sử sửa, đề xuất, rollback, diff): commit `2956cb15` (gồm phần Core của Giai đoạn 0).
  - Test: Core 784/784. E2E HTTP local (`MemoryCore/scripts/qa/skill-change-e2e.sh`): 10/10 (tạo skill; đề xuất của hệ thống cho skill toàn cục chờ duyệt; duyệt áp dụng ngay; đề xuất stale không áp dụng; rollback có lý do; rollback thiếu lý do bị từ chối; diff; skill dự án tự áp dụng; lịch sử có trường audit). E2E Giai đoạn 0 chạy lại: 2/2.
  - Review độc lập: 1 CRITICAL đã sửa (khóa phiên bản không được kiểm tra trong store, ghi đồng thời làm hỏng file của phiên bản; nay store kiểm tra phiên bản đầu trong giao dịch, file ghi vào thư mục tạm riêng rồi mới chuyển). Đã sửa thêm: một skill chỉ còn một đề xuất chờ, đề xuất cũ thành stale; đề xuất hết hạn sau 30 ngày; `proposals/list` bắt buộc `team_id`; sửa đề xuất kẹt ở trạng thái đã duyệt.
  - Chưa deploy: ở chế độ `code`, bộ trích xuất chưa tạo được skill cho đến khi Giai đoạn 2-3 truyền dự án vào. Core deploy sau Giai đoạn 3.
  - Để Giai đoạn 4: bridge của Proxy phải bỏ `change_source`, `scope`, `project_*` do model gửi (chỉ mở khi `allowLlmWrite=true`, mặc định tắt).
  - 10:00 ba agent dừng vì giới hạn API (429); chạy lại lần lượt từng agent.
- Giai đoạn 2-3 (gắn dự án vào hội thoại cho skill, chặn trích xuất): commit `536364b8`.
  - Agent bị treo hai lần; tôi tự làm tiếp phần còn lại trong session chính.
  - Test: Core 813/813, Proxy 476/476, tsc sạch. E2E local (`MemoryCore/scripts/qa/skill-project-gate-e2e.sh`): 5/5 (có dự án được nhận; đổi dự án thì tách buffer; không dự án thì bỏ với lý do `no_project`; một dự án thì qua bước chặn và tới bộ trích xuất; hash sai coi là không dự án). Phiên Claude Code thật trong repo: buffer skill có `project_name`; ngoài git thì `project_hash` rỗng. E2E Giai đoạn 0 và 1 chạy lại: 2/2 và 10/10.
  - E2E tìm ra hai lỗi có từ trước, đã sửa: thiếu import `SkillCoreError` trong gateway (lỗi `ReferenceError`); worker lặp lỗi khoảng 45.000 lần khi không dựng được extractor (nay dựng khi cần, lỗi được thử lại theo từng task).
  - Review độc lập: không có lỗi chặn. Đã sửa: import có `strict_mode` mà không có dự án thì bị từ chối ở chế độ `code`; tra L0 đọc hết các trang, phần chưa đọc được coi là hỗn hợp; lỗi dựng extractor luôn là lỗi tạm thời; giới hạn thời gian chờ khi lưu trữ.
  - Thứ tự deploy cần đổi: Proxy trước Core. Proxy cũ không gửi dự án, nên Core mới sẽ bỏ mọi task ở chế độ `code`.
  - Ghi nhận, chưa sửa: hai lượt thêm hội thoại đồng thời trong cùng session có thể lưu trữ một buffer hai lần (lỗi có từ trước; không gây trộn dự án).
