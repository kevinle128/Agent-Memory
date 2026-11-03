# Giai đoạn 1: Spike: khóa phiên, curl từ Codex, lối tắt Codex, API vai trò

Không sửa code sản phẩm. Kết quả ghi vào `plans/261103-0051-account-switch/reports/spike-session-key-and-clients.md`.

## Bối cảnh (đã đọc code)

- Khóa binding của pool: `sessionKey = "session:" + id`, `id = input.sessionId || extractPoolSessionId(...)` (`MemoryProxy/src/subscription-pool/pool-request.ts:157-158`). `extractPoolSessionId` đọc `x-parent-conversation-id`, rồi `session-id`, `session_id`, `x-claude-code-session-id`, rồi `body.client_metadata.session_id` (`pool-request.ts:89-96`).
- Runner Codex chỉ truyền `sessionId` khi agent không phải `codex` (`pipeline/runners/codex.ts:1158-1171`). Runner anthropic không truyền (`anthropic.ts:1115-1126`).
- Định danh phiên mà khối inject đặt vào `x-conversation-id`: Claude Code dùng `resolveConversationId` (`session/session-key.ts:28-42`: `x-parent-conversation-id`, `x-conversation-id`, `x-session-id`, `x-claude-code-session-id`, …). Codex dùng `extractCodexSessionId` (`codex.ts:181-192`: `x-parent-conversation-id`, `session-id`, `client_metadata.session_id`).
- `x-tdai-service-id` trong khối lấy từ `session.space_id` (`tdai-tools-injector.ts:199-203`), được ghi từ `identity.spaceId` (`session/store.ts:633`). Khóa pool dùng spaceId từ đường dẫn (`codex.ts:1142`).
- Theo comment `session/codex/hook-gate.ts:37-40`, subagent Codex gửi **cùng** `session-id` với cha.
- Codex nhận cùng các khối inject qua `<tdai_injections>` (`codex.ts:850-903`).

## Bước

1. Chạy local theo `docs/local-development.md` (Mongo, Core :8420, Proxy :8096). Kiểm `lsof -i :8096` và dùng lại tiến trình đang chạy; không mở thêm.
2. Bật một nhóm `subscription_pool` cho `claude-code` và `codex` có ít nhất 1 tài khoản (local dev cho spike; e2e chính chạy trên prod sau deploy).
3. Bắt header thật ở Proxy cho một lượt chính:
   - Claude Code 2.1.289 (`claude --version` local): in danh sách tên header liên quan phiên (`x-claude-code-session-id`, `x-session-id`, `x-conversation-id`, `session-id`, `session_id`, `x-parent-conversation-id`). Dùng log tạm trong tiến trình dev hoặc proxy bắt gói; không commit.
   - Codex 0.166 (`codex --version` local): như trên, thêm `x-codex-turn-metadata`.
   - Ghi rõ: mỗi client có **đúng một** header phiên trong tập trên, hoặc nếu nhiều thì giá trị bằng nhau.
4. Kiểm bằng máy rằng khóa khớp: sau một lượt chính do pool phục vụ, liệt kê `nottl/<space>/pool-binding/<provider>/` trong ProxyStorage và so với `sessionBindingKey(space, provider, "session:" + <x-conversation-id trong khối <tdai_memory_tools> của chính phiên đó>)` (tính bằng `node --import tsx -e` gọi `binding-store.ts`). Làm cho cả `claude` và `codex`, và cho một lượt subagent của mỗi client.
5. Xác minh `session.space_id` bằng spaceId trên đường dẫn `/claude-code/<space>/…`, `/codex/<space>/…`.
6. Xác minh khóa session store L1: CC là `claude-code:<id>`, Codex là `codex:<id>` (`session/codebuddy/init.ts:553`). Tìm chỗ CC ghi khóa (`rg -n 'agentSource\}:' MemoryProxy/src/session`). Ghi kết quả; giai đoạn 3 dựa vào nó để biết provider.
7. Curl từ Codex: trong một phiên Codex, nhờ model chạy curl `memory-bridge` có sẵn trong khối. Ghi lại: sandbox có chặn mạng không, Codex có xin phê duyệt (`require_escalated`) không. Nếu bị chặn và không có cách duyệt, đây là chặn cho Codex (xem "Phương án dự phòng").
8. Lối tắt Codex: tạo tạm skill `sub` ở `~/.codex/skills/sub/SKILL.md`, rồi thử `~/.agents/skills/sub/SKILL.md`. Ghi thư mục nào Codex 0.166 đọc, `$sub abc@x.com` có đưa chữ sau tên skill tới model không, và `/sub` có hiện không. Xóa file tạm sau khi thử.
9. Lối tắt Claude Code: tạo tạm `~/.claude/commands/sub.md` có `$ARGUMENTS`; kiểm `/sub` và `/sub a@b.c` đưa đúng chữ tới model. Xóa sau khi thử.
10. API vai trò: gọi `POST http://127.0.0.1:8420/v3/internal/meta/user/list-by-instance` với `Authorization: Bearer <serviceToken>`, `x-tdai-service-id: <space>`, body `{"user_ids":["<id admin>"],"limit":1}`. Ghi dạng `data.items[0].user_type`. Không ghi token vào báo cáo.

## Phương án dự phòng

- Header CC khác nhau giữa định danh và pool (bước 3-4 lệch): đổi `poolSessionKey`/bridge sang đọc **đúng** id mà pool dùng, bằng cách khối inject ghi thêm header đó. Ghi rõ trước khi làm giai đoạn 3.
- Codex không khớp khóa: bridge nhận thêm header `session-id` do khối Codex đặt bằng id pool. Nếu Codex vẫn không ổn định, Account Switch chỉ bật cho Claude Code ở bản đầu; hỏi người dùng trước.
- Codex sandbox chặn curl không duyệt được: dòng hướng dẫn trong khối nói model xin chạy ngoài sandbox, như cổng cài hook đang làm (`agents/codex/README.md:197-199`).

## Tiêu chí đạt

- Báo cáo có bảng: client × (header thấy được, id định danh, id pool, khóa tính được, khóa trong storage, khớp có/không) cho lượt chính và subagent.
- Báo cáo nêu thư mục skill Codex dùng được và ví dụ đầu vào model nhận.
- Báo cáo nêu dạng phản hồi `user/list-by-instance`.
- Không có file nào trong `MemoryProxy/src`, `MemoryCore/src` bị đổi (`git status --short` chỉ có thư mục plan).

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Không có tài khoản pool thật ở local | Cao × Cao | Câu hỏi mở 2; có thể làm bước 3-6 trên prod (chỉ đọc storage) |
| Log header tạm bị commit | Thấp × Trung bình | Chỉ dùng tiến trình dev; `git diff` trống trước khi xong |

## Lùi lại

Không có thay đổi code. Xóa file lệnh/skill tạm ở bước 8-9.
