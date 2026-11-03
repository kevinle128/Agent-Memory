# Báo cáo spike: khóa phiên, lối tắt và API vai trò

Ngày chạy: 2026-11-03. Không sửa file nào trong `MemoryProxy/src` hay `MemoryCore/src`.

## Kết luận

Thiết kế giữ nguyên. Bridge và pool tính ra **cùng một khóa binding** cho Claude Code và Codex. Hai lối tắt (`/sub` cho Claude Code, `$sub` cho Codex) đều đưa đúng chữ tới model. Còn ba việc chưa kiểm bằng chạy thật (xem mục "Chưa kiểm"), không việc nào làm đổi thiết kế.

## Cách làm

Không có stack local và không có tài khoản pool thật, nên tôi dựng một listener tạm ở cổng 18099 (đã dừng). Tôi trỏ Claude Code 2.1.289 và Codex 0.166.0 vào đó bằng thư mục cấu hình tạm (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), nên không đụng `~/.claude` hay `~/.codex` của người dùng. Listener ghi tên header (giá trị chỉ ở dạng băm 8 ký tự) và văn bản tin nhắn người dùng, rồi trả HTTP 400 để client dừng ngay, nên không tốn quota. Sau đó tôi chạy ba hàm thật của Proxy trên đúng tập header bắt được.

## Bảng khóa phiên (bước 3, 4)

| Client | Header phiên thấy được | Id định danh (`resolveConversationId` / `extractCodexSessionId`) | Id pool (`extractPoolSessionId`) | Khóa binding khớp |
|---|---|---|---|---|
| Claude Code, lượt chính | Chỉ `x-claude-code-session-id` | giá trị của header đó | giá trị của header đó | Có |
| Claude Code, subagent | Chưa bắt được từ client thật | `x-parent-conversation-id` nếu có | `x-parent-conversation-id` nếu có | Có (giả định có header cha) |
| Codex, lượt chính | `session-id`, `thread-id`, `x-client-request-id` cùng một giá trị, trùng `client_metadata.session_id`. `x-codex-turn-metadata` khác nhau ở mỗi lượt. | `session-id` | `session-id` | Có |
| Codex, subagent | Chưa bắt được từ client thật | `x-parent-conversation-id` nếu có | `x-parent-conversation-id` nếu có | Có (giả định có header cha) |

Chi tiết:

- Với Claude Code, giá trị header `x-claude-code-session-id` **bằng** `session_id` mà Claude Code in ra khi chạy `claude -p --output-format json` (cùng băm `4b1a0fc6`). Vậy `${CLAUDE_SESSION_ID}` và `session_id` của hook cũng chính là id này.
- Mọi request trong một lần chạy Claude Code có cùng giá trị header. Hai lần chạy khác nhau cho hai giá trị khác nhau.
- Kiểm bằng `node --import tsx` gọi `resolveConversationId` (`session/session-key.ts:28`), `extractCodexSessionId` (`pipeline/runners/codex.ts:181`), `extractPoolSessionId` (`subscription-pool/pool-request.ts:89`) và `sessionBindingKey` (`subscription-pool/binding-store.ts`). Cả bốn dòng đều cho `keysEqual=true`.
- Kiểm này so khóa ở mức hàm. Tôi chưa so với dữ liệu thật trong ProxyStorage (xem "Chưa kiểm").

## Lối tắt Claude Code (bước 9)

- File `commands/sub.md` có `$ARGUMENTS` hoạt động. Gõ `/sub abc@x.com` thì model nhận hai khối: `<command-name>/sub</command-name>` kèm `<command-args>abc@x.com</command-args>`, và nội dung file lệnh đã thay tham số ("Use the subscription tools to handle this request: abc@x.com").
- Ở chế độ `-p`, một lệnh không tồn tại (`/nosuchcmd foo`) **không bị chặn**. Nó vẫn tới model, kèm một ghi chú "lệnh không chạy". Tài liệu Claude Code nói chế độ tương tác thì báo "Unknown command" và không gửi đi, nên file lệnh cài sẵn vẫn cần cho chế độ tương tác. Tôi chưa chạy chế độ tương tác.

## Lối tắt Codex (bước 8)

- Skill hoạt động ở **cả hai** vị trí: `$CODEX_HOME/skills/<tên>/SKILL.md` (tức `~/.codex/skills`) và `$HOME/.agents/skills/<tên>/SKILL.md`.
- Gõ `$sub abc@x.com` thì model nhận ba mục người dùng theo thứ tự: `<environment_context>`, rồi nguyên văn `$sub abc@x.com`, rồi khối `<skill>` có nội dung SKILL.md. Vậy tham số **đến được model**, nằm ở mục riêng trước khối skill.
- Lệnh `/sub` của Codex không thử, vì Codex đã bỏ custom prompt từ bản 0.117.
- Tôi chỉ thử với `codex exec`. Chưa thử trong giao diện TUI.

## Provider của phiên (bước 6)

- Bridge nhận mã phiên trần trong `x-conversation-id`, nên phải thử các khóa có tiền tố: `sessionKeyCandidates` (`agent-adapters/index.ts:34`) trả `[id, "claude-code:id", "codex:id", …]`. Khóa session store có dạng `${agentSource}:${sessionId}` (`session/store.ts:289`).
- Binding cấp 2 (theo `(spaceId, sessionId)`) cũng lưu `agent_source` (`skill/skill-bridge.ts`, đoạn chú thích về "binding flatten").
- Giai đoạn 3 suy provider từ tiền tố của khóa tìm thấy hoặc từ `agent_source` của binding, rồi ánh xạ `claude-code` sang provider pool `claude` và `codex` sang `codex`. Không đoán mặc định.

## API vai trò (bước 10, chỉ đọc code)

- Route: `POST /v3/internal/meta/user/list-by-instance` (`MemoryCore/src/metadata/router/internal-meta-router.ts:91`).
- Body theo `internalListUsersByInstanceSchema` (`v3-meta-schemas.ts:413`): `instance_id?`, `status?`, `user_type?` (`"normal"` hoặc `"system_admin"`), `user_ids?` (tối đa 100), cộng phân trang.
- Trả về dạng phân trang `{ items, total, … }` bọc trong `data` (`pagination.ts:69`).
- Có thể để Core lọc: gửi `{ "user_ids": ["<id>"], "user_type": "system_admin", "limit": 1 }`. Khi đó `items.length === 1` nghĩa là người này là System Admin. Cách này tránh phải đọc trường `user_type` của từng dòng.
- Proxy hiện chưa gọi route này (`rg list-by-instance MemoryProxy/src` không có kết quả). Gọi với `Authorization: Bearer <serviceToken>` và `x-tdai-service-id: <space>`, giống `core-client.ts` của pool (dòng 31-32).
- Tôi chưa gọi thật vì Core local không chạy.

## Codex gọi `curl` (bước 7, chỉ đọc tài liệu)

- Sandbox mặc định `workspace-write` của Codex **tắt mạng** (`network_access = false`; `codex-rs/protocol/src/protocol.rs` và `config/src/types.rs`). Model phải xin quyền mạng cho từng lệnh, hoặc người dùng bật `network_access` trong `config.toml`.
- Repo đã dùng đúng cơ chế xin quyền: cổng cài hook của Codex trả lời lệnh `curl … | bash` với `sandbox_permissions: "require_escalated"` và `justification`, để TUI hiện hộp xin duyệt (`agents/codex/README.md` mục 9.1.1).
- Hệ quả cho giai đoạn 4: dòng hướng dẫn trong khối `<subscription_tools>` dành cho Codex phải nói rõ "chạy lệnh này ngoài sandbox, xin quyền mạng". Đây là phương án dự phòng thứ ba đã có trong giai đoạn 1.
- Ở `codex exec` (không có người duyệt) thì lệnh sẽ thất bại. Account Switch cho Codex vì vậy chỉ dùng được trong TUI hoặc khi `network_access` đã bật.

## Chưa kiểm

| Việc | Lý do chưa kiểm | Cách kiểm tiếp |
|---|---|---|
| So khóa với dữ liệu thật trong ProxyStorage (bước 4) và `session.space_id` với spaceId trên đường dẫn (bước 5) | Không có stack local, không có tài khoản pool thật | Làm trên prod, chỉ đọc storage, ở giai đoạn 6 |
| Header của subagent Claude Code và Codex | Cần model thật gọi công cụ Agent | Quan sát ở giai đoạn 6; nếu subagent có `x-claude-code-agent-id` mà vẫn giữ `x-claude-code-session-id` của cha thì không cần header cha |
| Codex chạy `curl` thật, và lối tắt trong chế độ TUI / `/sub` trong Claude Code tương tác | Cần phiên tương tác và model thật | Giai đoạn 6 (e2e trên prod) |

## Việc dọn dẹp

- Listener tạm đã dừng (cổng 18099 không còn nghe).
- Các thư mục tạm nằm trong `/tmp/account-switch-spike/` (cấu hình tạm của hai client, script, log bắt gói).
- Không có file lệnh hay skill `sub` nào được tạo trong `~/.claude/commands`, `~/.codex/skills` hay `~/.agents/skills`. Một số file log và cache trong `~/.codex` có đổi trong lúc chạy; đó là file của daemon Codex đang chạy sẵn trên máy, spike dùng `CODEX_HOME` và `HOME` tạm nên không chủ ý ghi vào đó.
- `git status` của Agent-Memory chỉ có thư mục plan; `agents/plans/` đã chưa theo dõi từ trước spike.
