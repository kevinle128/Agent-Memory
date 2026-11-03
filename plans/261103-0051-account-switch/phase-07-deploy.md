# Giai đoạn 7: Deploy

Theo skill `operator-master/.claude/skills/deploy-agent-memory/SKILL.md`. Nhánh `feat/server_team`. Không đọc, sao lưu hay sửa `.env` trên server.

## Sao lưu DB

Không cần: không có thay đổi schema hay dữ liệu DB. Core chỉ thêm hai trường vào phản hồi nội bộ; Session Binding nằm trong ProxyStorage, cùng dạng JSON.

## Bước

1. Trước khi commit: `node .gitnexus/run.cjs detect-changes --scope all --repo .` sạch (không `partial`/`truncated`); test giai đoạn 6 qua.
2. Commit theo conventional commits, mô tả thay đổi, không nhắc giai đoạn hay mã kế hoạch. Gợi ý:
   - `feat(core): send account label and display name to the proxy pool list`
   - `feat(proxy): let system admins view and switch the subscription account of a conversation`
   - `feat(hooks): install the sub shortcut for Claude Code and Codex`
   Push lên `origin/feat/server_team`.
3. Deploy Core trước (Proxy cần nhãn để đổi theo email):
   `srv 'cd ~/Agent-Memory && git pull --ff-only && git log --oneline -1 && MEMORY_BUILD_REVISION=$(git rev-parse --short=7 HEAD) docker compose up -d --build --no-deps memory-core'`
   Chờ `agent-memory-memory-core-1` healthy.
4. Deploy Proxy: cùng lệnh với `proxy`. Chờ `agent-memory-proxy-1` healthy và chạy tag mới.
5. Kiểm:
   - `srv 'docker logs --since 5m agent-memory-proxy-1 2>&1 | grep -i -E "error|subscription-bridge|account-switch" | tail -20'` không có lỗi mới.
   - Một request nhỏ qua proxy (bước 3 của mục Check trong skill).
   - `/setup/hooks.sh` trả bộ cài mới: `curl -fsSL <proxy>/setup/hooks.sh | grep -c "account switch shortcut"` ≥ 1.
   - Bridge sống: `curl -sS -X POST <proxy>/subscription-bridge/v1/current -H 'content-type: application/json' -d '{}'` trả 401 `missing_conversation_id` (không phải 404).
   - Nếu `injection.externalGatewayUrl` trỏ tới gateway đứng trước Proxy, gateway phải chuyển `/subscription-bridge/**` như `/skill-bridge/**` (`MemoryProxy/src/types.ts:775-786`). Kiểm cấu hình `/data/config.yaml` trong container proxy; hiện khối inject trỏ thẳng cổng 8096.
6. E2E trên prod (đã chốt) (giai đoạn 6, bước 2-9).

## Tiêu chí đạt

- Hai container healthy, tag = SHA mới.
- Kiểm ở bước 5 đều đạt.
- Một System Admin thật xem được tài khoản của phiên mình trên prod.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Proxy lên trước Core | Thấp × Thấp | Thứ tự cố định; Proxy chịu được thiếu nhãn |
| Đường pool bị ảnh hưởng | Thấp × Cao | Đọc log 5 phút; lùi ngay nếu có lỗi pool mới |

## Lùi lại

`srv 'cd ~/Agent-Memory && MEMORY_BUILD_REVISION=<sha cũ> docker compose up -d --no-deps proxy'` (và `memory-core` nếu cần). Ảnh cũ còn trên server (`docker images agent-memory/proxy`). Không có dữ liệu cần khôi phục.
