# Giai đoạn 0: Spike API danh sách model của gói thuê bao (đã xong)

Trạng thái: **xong**, 2026-10-25. Chạy trên prod từ trong container Core, với một tài khoản pool đang hoạt động cho mỗi provider. Không in token. Mỗi provider một request GET, không gửi hội thoại, không đổi dữ liệu tài khoản.

Cách gọi giống omp: `@oh-my-pi/pi-catalog/src/provider-models/openai-compat.ts` (`anthropicModelManagerOptions`, `buildAnthropicDiscoveryHeaders`) và `discovery/codex.ts`.

## Kết quả (đã xác minh)

| Provider | Request | Kết quả |
|---|---|---|
| Claude (pool `claude`) | `GET https://api.anthropic.com/v1/models?limit=1000`; header `Authorization: Bearer <access_token>`, `anthropic-version: 2023-06-01`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `anthropic-dangerous-direct-browser-access: true` | 200, 14 model (ví dụ `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`, ...) |
| ChatGPT (pool `codex`) | `GET https://chatgpt.com/backend-api/codex/models?client_version=0.164.0`; header `Authorization: Bearer <access_token>`, `chatgpt-account-id: <provider_account_id>`, `originator: codex_cli_rs` | 200, 9 model: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-reserve`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex-auto-review` |

Tài khoản lấy từ dữ liệu của `subscription-pool/accounts/list` nội bộ (trường `provider`, `status`, `enabled`, `access_token`, `provider_account_id`).

## Kết luận cho giai đoạn 3

- Cả hai provider có API danh sách model. Không cần danh sách gốc trong config (câu hỏi 4 đã quyết định).
- Codex trả cả model nội bộ (`codex-auto-review`) và model ẩn. Quy tắc lọc ở giai đoạn 3.
