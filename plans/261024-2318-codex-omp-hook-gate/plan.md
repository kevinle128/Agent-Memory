# Giai đoạn 8: bắt buộc cài hook cho Codex và oh-my-pi

Trạng thái: chờ duyệt. Phạm vi do bạn chốt: chỉ Codex và oh-my-pi (`omp`).

Nghiên cứu: `plans/reports/researcher-261024-2300-codex-hook-gate.md`, `plans/reports/researcher-261024-2300-oh-my-pi-hook-gate.md`.

## Kết quả mong muốn
Session tương tác của Codex hoặc omp chưa có báo cáo hook thì không đi tới model. Proxy trả một lệnh gọi công cụ shell để chính client chạy lệnh cài hook (`--session <id>`). Có báo cáo thì proxy xóa các lượt giả và chuyển tiếp prompt gốc. Không có form hỏi: cài luôn (đúng quyết định "client không có form thì cài luôn").

## Ràng buộc (theo quyết định đã có)
- Không chặn chạy không tương tác, giống Claude Code (bạn đã chọn A): `codex exec`, app-server, SDK, `omp -p`, rpc đều cho qua.
- Cổng mở khi lỗi: sau 2 lần cài không thành trong một hội thoại thì cho qua, giống Claude Code.
- Một công tắc chung `hookGate.enabled`; lượt giả luôn bị xóa trước khi lên model, kể cả khi tắt cổng.
- Request bị chặn không ghi L0.

## Ngoài phạm vi
- Các client khác. Model anthropic-messages trong omp (omp giả header Claude Code).

## Thiết kế
1. **Lõi dùng chung** `MemoryProxy/src/session/hook-gate-core.ts`: đọc báo cáo hook (chờ tối đa khoảng 3 giây sau kết quả công cụ), đếm số lần thất bại, tạo lệnh cài (`buildInstallCommand` thêm `--client`). Mỗi client có một adapter nhỏ: nhận diện request được chặn, dựng câu trả lời giả, nhận diện và xóa lượt giả. Gate Claude Code chuyển sang dùng lõi này, hành vi không đổi (snapshot test).
2. **Codex** (`/codex/<space>/responses`):
   - Chỉ chặn khi header `originator` là `codex-tui` và request có công cụ shell. Request đặt tiêu đề (`thread_source: thread_title`) được xếp là request phụ, không chặn và không nhận memory.
   - Dựng lời gọi theo công cụ request đưa: `function_call` `exec_command` (`cmd`) hoặc `custom_tool_call` `exec` (JavaScript gọi `tools.exec_command`), luôn xin chạy ngoài sandbox (`require_escalated`, kèm lý do). Codex TUI sẽ hiện hộp duyệt; người dùng đồng ý thì lệnh chạy.
   - `call_id` có tiền tố `call_codex_hook_gate_`; khi xóa, bỏ cả lời gọi, kết quả và tin `<turn_aborted>` đi kèm.
   - Lệnh bị từ chối hoặc lỗi: trả câu trả lời dạng text kèm lệnh cài thủ công.
3. **oh-my-pi** (đường `/pi/<space>/v1`, adapter pi, nhận diện bằng User-Agent `omp/`):
   - Session id: thêm nguồn dự phòng `prompt_cache_key` trong body cho omp. Không có session id thì không chặn và ghi cảnh báo.
   - Installer `--client omp`: đặt extension vào `~/.omp/agent/extensions/`; bật `compat.supportsPromptCacheKey: true` cho provider trỏ về proxy trong `~/.omp/agent/models.yml` (có sao lưu; không tìm thấy provider của proxy thì in hướng dẫn).
   - Chỉ chặn khi request có công cụ `ask` (chỉ có ở chế độ tương tác) và có công cụ `bash`. Dựng lời gọi `bash` (`command`, `i`); xóa lượt `assistant` có tool call tiền tố gate và lượt `tool` tương ứng.
   - Kiểm tra định dạng session id UUIDv7 và nội dung dạng mảng khi tách câu người dùng.

## Kiểm thử
- Unit: lõi, hai adapter, snapshot Claude Code không đổi.
- E2E với client thật trên proxy local (tmux cho TUI): Codex TUI chưa có hook → hộp duyệt → đồng ý → prompt gốc được trả lời, session sau không bị hỏi; `codex exec` không bị chặn; từ chối → text có lệnh thủ công; request đặt tiêu đề không bị chặn. omp TUI chưa có hook → tự cài → prompt gốc được trả lời; `omp -p` không bị chặn; pi thường vẫn như cũ.
- Chạy lại `hook-gate-e2e.sh` (Claude Code) và `codex-pi-e2e.sh`.
- Review độc lập, deploy proxy production, chạy lại e2e trên production, đọc Langfuse.

## Lùi lại
`hookGate.enabled: false` (tắt cả ba client).
