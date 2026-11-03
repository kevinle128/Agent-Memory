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
| Model tự gọi bridge khi được hỏi | **Chưa đạt** | Xem mục "Vấn đề còn mở" |
| Người dùng thường không có khối, bridge 403 | Chưa làm | Không có khóa của người dùng thường |
| Subagent theo phiên cha | Chưa làm | Không dựng được kịch bản bằng CLI; đã có test tự động |
| Codex (xem, đổi, `$sub`) | Chưa làm | Cấu hình Codex trên máy chưa trỏ vào proxy; pool Codex chỉ có 1 account |
| Đổi account khi pool tự chuyển (429) | Chưa làm | Không thể ép account thật hết quota |

## Lỗi tìm thấy và đã sửa

Injector bị đăng ký bên trong nhánh `tdai-memory`, nên không chạy khi deployment không bật đủ điều kiện của nhánh đó. Đã chuyển ra ngoài (`52b9871`), có test cho cấu hình chỉ bật `skill` (đã thử đỏ với code cũ). Cấu hình prod có cả `skill` và `tdai-memory`, nên chưa xác định được lý do chính xác trên prod; log proxy sau bản sửa xác nhận khối được inject.

## Vấn đề còn mở

Trong chế độ `claude -p`, model (opus) trả lời "không có khối `<subscription_tools>`" ngay cả khi Langfuse cho thấy khối nằm trong request, và nó từ chối trích system prompt. Khối `<tdai_memory_tools>` có sẵn cũng không được model xác nhận. Vì vậy chưa chứng minh được model tự gọi bridge từ khối inject. Cần thử trong phiên tương tác thật: gõ `/sub` (sau khi chạy lại bộ cài hook) hoặc hỏi bằng lời thường trong Claude Code tương tác.

## Ghi chú vận hành

- Các lượt test tạo thêm vài phiên trong memory của team (lời nhắc test được ghi qua `write-l0`).
- Harness: `/tmp/as-e2e/` (truy vấn Langfuse và liệt kê pool chạy ngay trong container proxy, chỉ in trường không bí mật).
