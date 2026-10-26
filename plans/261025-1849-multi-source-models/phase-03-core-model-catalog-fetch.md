# Giai đoạn 3: Core lấy danh sách model vào `source_models`

## Bối cảnh

- Endpoint và header đã xác minh trên prod ở giai đoạn 0 (`phase-00-subscription-model-list-spike.md`). Cách gọi giống omp (`@oh-my-pi/pi-catalog/src/provider-models/openai-compat.ts`, `discovery/codex.ts`).
- Adapter provider: `MemoryCore/src/subscription-pool/providers/types.ts:50-60`, Claude `providers/claude.ts:189-273`, Codex `providers/codex.ts:174-242`, đăng ký `providers/index.ts`.
- Tài khoản: dữ liệu của `listSubscriptionAccountsInternal` (`metadata-service.ts:2495-2507`; chỉ pool đang bật, đúng với câu 3 "B"). Làm mới token: `MemoryCore/src/subscription-pool/token-refresher.ts`. Hẹn giờ: `timer-queue.ts`.
- `~/.codex/models_cache.json` (Codex CLI 0.163.0, lấy 2026-10-25) cho thấy mỗi model có `visibility` (`list`/`hide`) và `supported_in_api`; `gpt-reserve` và `codex-auto-review` có `visibility: "hide"`, 7 model còn lại `list`.

## Thay đổi

1. Thêm `fetchModels(accessToken, providerAccountId): Promise<SourceModelReading[]>` vào `SubscriptionProviderAdapter`, làm cho cả hai adapter:
   - Claude: `GET https://api.anthropic.com/v1/models?limit=1000`, header `Authorization: Bearer <access_token>`, `anthropic-version: 2023-06-01`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `anthropic-dangerous-direct-browser-access: true`. Đọc `data[].id`, `display_name`. Nếu phản hồi có `has_more: true` thì đọc trang kế bằng `after_id` (14 model hôm nay vừa một trang).
   - Codex: `GET https://chatgpt.com/backend-api/codex/models?client_version=<v>`, header `Authorization: Bearer <access_token>`, `chatgpt-account-id: <provider_account_id>`, `originator: codex_cli_rs`. `client_version` lấy từ config Core, khóa mới `subscription_pool.codex_client_version`, mặc định `0.164.0`. Đọc `models[].slug` làm `id`, `display_name` nếu có.
2. Quy tắc lọc Codex: giữ model có `visibility === "list"`, hoặc không có trường `visibility`. Bỏ `visibility === "hide"` (theo cache hôm nay là `gpt-reserve`, `codex-auto-review`). Nếu có `supported_in_api === false` thì cũng bỏ. Đây là đúng tập model mà Codex CLI hiện trong bộ chọn model. Model bị lọc không được ghi vào `source_models`. Bước triển khai phải đọc lại `visibility` trong phản hồi thật trên prod (cache local có thể khác) trước khi khóa test fixture.
3. Nhóm pool: dùng tài khoản `enabled` và `status = active` của nhóm, thử lần lượt cho tới khi một tài khoản trả 200. Hợp danh sách của các tài khoản thành công (gói khác nhau có thể có model khác nhau). 401 → làm mới token qua `token-refresher.ts` một lần, rồi chuyển tài khoản kế tiếp. Pool tắt → không lấy (nguồn đã tắt theo câu 3 "B").
4. Chỉ nhóm `custom_unified` và `subscription_pool` được lấy model; nhóm `custom_passthrough` không bao giờ được lấy (câu 7 "A"), kể cả trong timer.
4b. Nhóm API (`custom_unified`): `GET <base_url>/models` (không thêm `/v1` nếu base đã có), `Authorization: Bearer <api_key>`; `source_provider = anthropic` thì `x-api-key` + `anthropic-version`. Đọc `data[].id`. Timeout 10s, không theo redirect.
5. Ghép vào `source_models`:
   - Model mới: pool → `enabled = true` (quyết định 2); API → `enabled = false` ở lần lấy đầu và ở mọi lần lấy sau (quyết định 3, câu 12 "A").
   - Model đã có: giữ `enabled`.
   - Model biến mất: `available = false`, giữ `enabled`.
   - Lần lấy lỗi (mọi tài khoản lỗi, mạng, 5xx): **giữ nguyên danh sách thành công gần nhất**, chỉ ghi `source_models_error` và giữ `source_models_fetched_at` cũ. Không có danh sách dự phòng nào khác.
   - Thao tác store riêng `updateGroupSourceModels(group_id, merge)` trong một transaction, tăng `version`.
6. Khi nào: khi gắn `source_name` lần đầu (không chặn lưu nếu lỗi), khi admin bấm làm mới (`groups/source-refresh`), và mỗi 24h cho nguồn đang bật (nhóm custom có `source_enabled`, nhóm pool có `enabled`), một timer trên `timer-queue.ts`.
7. An toàn: không ghi token/key vào log hay `source_models_error`; log ghi `account_id`, không ghi token. Chặn `base_url` trỏ vào địa chỉ nội bộ của server (`localhost`, `127.0.0.0/8`, `memory-core`) cho lệnh lấy model của nhóm API.

## Tệp

- Sửa: `providers/types.ts`, `providers/claude.ts`, `providers/codex.ts`, `MemoryCore/src/subscription-pool/config.ts`, `metadata-service.ts`, store sqlite/mongo (hàm `updateGroupSourceModels`), `MemoryCore/src/gateway/server.ts` (đăng ký timer nếu cần).
- Thêm: `MemoryCore/src/subscription-pool/model-catalog.ts`; fixture trong `providers/fixtures/` lấy từ phản hồi thật đã che dữ liệu riêng (14 model Claude, 9 model Codex).

## Kiểm thử

- Adapter: đúng URL và header từng provider (so với giai đoạn 0); parser từ fixture; Claude phân trang `has_more`.
- Lọc Codex: fixture 9 model → 7 model (bỏ `gpt-reserve`, `codex-auto-review`); thiếu `visibility` → giữ.
- Ghép: model mới bật theo loại (API: lần đầu và lần sau đều tắt); giữ `enabled` qua lần làm mới; `available=false` khi biến mất.
- Lỗi: mọi tài khoản lỗi → `source_models` giữ nguyên, có `source_models_error`, không chứa token; 401 → làm mới token một lần.
- Lấy model không đổi `agents`, `enabled`, `model_id`, `api_key` của nhóm.

## Rủi ro và lùi lại

- ChatGPT đổi yêu cầu `client_version`: lần lấy lỗi, danh sách cũ vẫn dùng; admin đổi khóa config.
- Lùi: revert; `source_models` đã ghi ở lại và vẫn dùng được.
