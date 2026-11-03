# Giai đoạn 5: Lối tắt `/sub` (Claude Code) và `$sub` (Codex) trong bộ cài hook

## Bối cảnh (đã đọc code)

- Bộ cài: `MemoryProxy/assets/client-hooks/install.sh`, phục vụ ở `/setup/hooks.sh` và đọc từ đĩa mỗi request (`MemoryProxy/src/routes/setup-scripts.ts:6-24`), nên deploy Proxy là cập nhật bộ cài.
- `main()` ở `install.sh:1135`: gỡ (`1168-1178`, nhánh `codex) codex_uninstall` ở `1172`), cài Codex (`codex_install` gọi ở `1241`), cài Claude Code (`update_settings add` ở `1255`). Biến `CLAUDE_DIR`, `CODEX_DIR` ở `install.sh:55-57`. Hàm `write_if_changed` ở `install.sh:758`.
- Cổng cài hook của Codex tự chạy bộ cài cho phiên chưa có báo cáo hook (`agents/codex/README.md:197-199`), nên mọi người dùng Codex đều nhận file lệnh, không riêng admin. Bộ cài không biết vai trò.
- Claude Code đọc lệnh Markdown ở `~/.claude/commands/<tên>.md`, thay `$ARGUMENTS`.
- Codex bỏ custom prompt (`~/.codex/prompts`, gọi `/prompts:<tên>`) từ 0.117; thay bằng skill (`SKILL.md`), gọi `$<tên>`. Thư mục chính xác do giai đoạn 1 xác nhận (`~/.codex/skills/sub/SKILL.md` hoặc `~/.agents/skills/sub/SKILL.md`).

## Bước

1. Hằng số trong `install.sh`: `CLAUDE_SUB_FILE="$CLAUDE_DIR/commands/sub.md"`, `CODEX_SUB_FILE="<thư mục từ giai đoạn 1>/sub/SKILL.md"`, và dòng dấu `SUB_MARKER="<!-- agent-memory: account switch shortcut -->"`.
2. Nội dung (heredoc trong `install.sh`, không thêm route mới):
   - Claude Code `sub.md`: frontmatter `description: Show or switch the subscription account of this conversation`, `argument-hint: [email]`; dòng dấu; thân: "Use the subscription_tools block. If the text after /sub is empty, show the subscription account of this conversation. If it is an email, switch this conversation to that account. Arguments: $ARGUMENTS. If there is no subscription_tools block in your instructions, say that Account Switch is only for System Admins on a subscription pool."
   - Codex `SKILL.md`: frontmatter `name: sub`, `description:` như trên; dòng dấu; thân như trên nhưng nói "the text after $sub".
3. Hàm `install_sub_shortcut <file>`: tạo thư mục cha; nếu file đã có mà **không** chứa `SUB_MARKER` thì giữ nguyên và in một dòng ghi chú (file của người dùng); ngược lại ghi bằng `write_if_changed` (chạy lại không đổi gì). Ghi chú in ra `>&2` như mọi ghi chú khác của `install.sh` (ví dụ đuôi `codex_install`). Dòng thành công cuối (`Agent-Memory hooks installed …`) giữ nguyên trên stdout, vì cổng cài hook Codex đọc stdout để biết cài xong (`session/codex/__tests__/hook-gate.test.ts:84`).
4. Hàm `remove_sub_shortcut <file>`: chỉ xóa khi file chứa `SUB_MARKER`; với Codex xóa luôn thư mục `sub/` nếu rỗng.
5. Gọi: sau `update_settings add` (Claude Code) và sau `codex_install` (Codex); trong nhánh gỡ, cùng chỗ với `update_settings remove` và `codex_uninstall`. Không gọi cho `omp`/`pi`.
6. Cập nhật khối chú thích đầu `install.sh` (mục Install claude-code, Install codex, Uninstall) một dòng mỗi mục.
7. Cập nhật tài liệu người dùng ngắn: `agents/codex/README.md` (mục hook) và `agents/claude-code/README.md` — một dòng nói lối tắt và rằng chỉ System Admin dùng được.

## Tệp

- Sửa: `MemoryProxy/assets/client-hooks/install.sh`, `agents/codex/README.md`, `agents/claude-code/README.md`.
- Test: `MemoryProxy/src/__tests__/client-hooks.test.ts` (khối `install.sh with the %s JSON tool`, dòng 370), `MemoryProxy/src/__tests__/client-hooks-codex-omp.test.ts` (khối `install.sh --client codex`, dòng 305).

## Kiểm thử

`cd MemoryProxy && bash -n assets/client-hooks/install.sh && npx vitest run src/__tests__/client-hooks.test.ts src/__tests__/client-hooks-codex-omp.test.ts`

Ca: "installs the sub command for Claude Code"; "installs the sub skill for Codex"; "keeps a sub command that the user wrote"; "a second install changes nothing"; "uninstall removes only the installer's sub command"; "omp install writes no sub shortcut".

## Tiêu chí đạt

- Test trên qua; `bash -n` qua.
- Sau cài trong `HOME` tạm: `grep -c "agent-memory: account switch shortcut" "$HOME/.claude/commands/sub.md"` = 1; với Codex tương tự ở thư mục đã chốt.
- E2E giai đoạn 6: `/sub` trong Claude Code và `$sub` trong Codex đưa tới đúng lời gọi bridge.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Ghi đè lệnh `/sub` người dùng tự viết | Thấp × Trung bình | Chỉ ghi/xóa file có dòng dấu |
| Codex đổi thư mục skill lần nữa | Trung bình × Thấp | Hỏi bằng lời thường vẫn chạy; sửa đường dẫn một chỗ |
| Người thường gõ `/sub` | Cao × Thấp | Văn bản lệnh bảo model trả lời "chỉ dành cho System Admin" |

## Lùi lại

Revert commit. Trên máy người dùng: `curl -fsSL <proxy>/setup/hooks.sh | bash -s -- --uninstall --client <client>` gỡ file có dấu.
