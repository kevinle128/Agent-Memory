# Báo cáo e2e Account Switch trên prod

Ngày chạy: 2026-11-03. Dữ liệu thật trên server 103.82.28.49, proxy `52b9871`, Core `cdbd44e`. Client: Claude Code 2.1.289 thật, dùng cấu hình sẵn có của người dùng (đã trỏ vào proxy prod). Không có dữ liệu giả và không có upstream giả.

## Kết quả

| Kịch bản | Kết quả | Bằng chứng |
|---|---|---|
| Bridge thấy phiên thật và nhận ra System Admin | Đạt | `current` trả `state: bound` cho phiên `90d84afe…`; người dùng không bị 403 |
| Xem account hiện tại (`current`) | Đạt | Trả email, `display_name`, `account_label`, `account_id` của `studio.vtcmobile1@gmail.com` |
| Đổi sang account đang có sẵn (`changed:false`) | Đạt | Phiên đã ở account đó nên không ghi gì |
| Đổi thật sang account khác | Đạt | `changed:true`, `previous` là `studio.vtcmobile1`, `current` là `truongbathang1988`; log proxy `[subscription-bridge] account switch … from=sacc-f1da81y09a to=sacc-i7cawb7krq` |
| Binding giữ account mới sau các lượt chat thật | Đạt | `current` gọi lại sau 3 lượt chat chính vẫn trả `truongbathang1988` |
| Từ chối account Exhausted | Đạt | HTTP 409 `account_exhausted`, giờ reset thật `2026-11-07T01:59:59.973Z` (account `studio.vtcmobile@gmail.com`, 7 ngày 100%) |
| Từ chối email không có trong pool | Đạt | `account_not_in_pool` |
| Từ chối email sai định dạng | Đạt | `invalid_email` |
| Phiên lạ | Đạt | 401 `session_not_initialized` |
| Proxy inject `<subscription_tools>` cho admin | Đạt (sau khi sửa) | Langfuse: request chính (model opus) có đúng 1 khối trong tin nhắn `system`, ngay sau `</tdai_memory_tools>` |
| Lượt có lệnh `/sub` được ghi vào memory như lượt thường | Đạt | Log `tdai-recorder:write-l0` của phiên test, `userLen=624` |
| Model tự gọi bridge dựa vào khối inject trong system prompt | **Không dùng được** | Xem mục "Nguyên nhân gốc và cách xử lý" |
| `/sub` (file lệnh tự mang công thức curl) trong Claude Code thật | Đạt | Xem mục "Kết quả lối tắt `/sub`" |
| Người dùng thường không có khối, bridge 403 | Chưa làm | Không có khóa của người dùng thường |
| Subagent theo phiên cha | Chưa làm | Không dựng được kịch bản bằng CLI; đã có test tự động |
| Codex (xem, đổi, `$sub`) | Chưa làm | Cấu hình Codex trên máy chưa trỏ vào proxy; pool Codex chỉ có 1 account |
| Đổi account khi pool tự chuyển (429) | Chưa làm | Không thể ép account thật hết quota |

## Lỗi tìm thấy và đã sửa

Injector bị đăng ký bên trong nhánh `tdai-memory`, nên không chạy khi deployment không bật đủ điều kiện của nhánh đó. Đã chuyển ra ngoài (`52b9871`), có test cho cấu hình chỉ bật `skill` (đã thử đỏ với code cũ). Cấu hình prod có cả `skill` và `tdai-memory`, nên chưa xác định được lý do chính xác trên prod; log proxy sau bản sửa xác nhận khối được inject.

## Nguyên nhân gốc và cách xử lý

Trên đường đi qua pool, model **không nhận được** nội dung mà proxy thêm vào system prompt. Bằng chứng:

- Langfuse cho thấy request chính có `<subscription_tools>`, `<tdai_memory_tools>`, `<skill_tools>` và `<session_context>` trong tin nhắn `system`, và code không có chỗ nào gỡ chúng trước khi gửi.
- Nhưng model (cả `claude -p` lẫn phiên tương tác) không biết tên agent chỉ có trong `<session_context>`, và nói không có tool nào. Phiên của chính người lập kế hoạch cũng không thấy các khối này.
- Vì vậy vấn đề có từ trước, không riêng tính năng này. Chưa tìm ra chỗ nào làm mất nội dung; cần người nắm pipeline inject kiểm tra riêng.

Cách xử lý trong phạm vi tính năng: lối tắt **tự mang** công thức `curl`, không phụ thuộc vào khối inject. Nội dung lệnh đi tới model như tin nhắn của người dùng.

- Claude Code: file `~/.claude/commands/sub.md` dùng `${CLAUDE_SESSION_ID}`, do Claude Code thay bằng mã phiên.
- Codex: skill `sub` dùng `$CODEX_THREAD_ID`, là biến Codex đặt cho mọi lệnh shell (đúng bằng `session-id` mà proxy thấy).
- Bộ cài ghi địa chỉ proxy và space vào file lúc cài.

## Kết quả lối tắt `/sub`

Cài bằng chính bộ cài của prod (`/setup/hooks.sh`, proxy `ac7fe3a`) vào thư mục cấu hình tạm, rồi chạy Claude Code thật:

| Bước | Kết quả |
|---|---|
| `/sub` | Đạt: trả `truongbathang1988@gmail.com`, provider `claude` |
| `/sub studio.vtcmobile1@gmail.com` (cùng phiên) | Đạt: đổi thật, `previous` là `truongbathang1988@gmail.com` |
| `/sub studio.vtcmobile@gmail.com` (đang Exhausted) | Đạt: từ chối kèm giờ reset `2026-11-07T01:59:59Z`, phiên giữ nguyên account cũ |
| `/sub` | Đạt: vẫn `studio.vtcmobile1@gmail.com` |

Người dùng đã cài lối tắt trước đó cần chạy lại bộ cài để nhận file mới (bộ cài chỉ ghi đè file có dòng dấu).

## Vấn đề còn mở

- Khối `<subscription_tools>` trong system prompt vô hiệu trên đường đi qua pool. Nó không gây hại nhưng cũng không có tác dụng; giữ lại cho tới khi nguyên nhân chung được sửa.
- Lối tắt Codex (`$sub`) chưa chạy thật: cấu hình Codex trên máy này chưa trỏ vào proxy, và pool Codex chỉ có 1 account. Phần dựa vào `CODEX_THREAD_ID` lấy từ tài liệu Codex, chưa kiểm bằng chạy thật.

## Ghi chú vận hành

- Các lượt test tạo thêm vài phiên trong memory của team (lời nhắc test được ghi qua `write-l0`).
- Harness: `/tmp/as-e2e/` (truy vấn Langfuse và liệt kê pool chạy ngay trong container proxy, chỉ in trường không bí mật).
