---
title: "Nguồn model nhiều nhà cung cấp: tên model dạng <nguồn>/<model> cho omp, hermes, openclaw"
description: "Nhóm upstream custom (API key) và nhóm pool (thuê bao) thành nguồn có tên; proxy trả và định tuyến model dạng <nguồn>/<model>; claude-code và codex không đổi."
status: pending
priority: P1
effort: 53h
branch: feat/server_team
tags: [proxy, core, panel, subscription-pool, instance-upstream, omp, hermes, openclaw]
created: 2026-10-25
---

# Nguồn model nhiều nhà cung cấp (`<nguồn>/<model>`)

Trạng thái: chờ duyệt. Kế hoạch này thay thế `plans/261025-1523-agent-format-upstream/plan.md`. Kết quả bắt gói giai đoạn 0 của kế hoạch cũ vẫn dùng: `plans/261025-1523-agent-format-upstream/reports/capture-261025-omp-and-pools.md` và `.../capture-261025-hermes-openclaw.md`.

Bản sửa 2 (2026-10-25): theo quyết định 8, nguồn API key dùng lại nhóm upstream custom. Không còn bảng nguồn riêng.

## Kết quả mong muốn

- **Nguồn** là một nhóm upstream có `source_name`. Có hai loại:
  - Nguồn API key: nhóm custom `custom_unified` (base URL + key) sẵn có.
  - Nguồn thuê bao: nhóm `subscription_pool` sẵn có (tài khoản Claude/ChatGPT).
- Hệ thống lấy danh sách model của nguồn và lưu trên chính nhóm đó. Nguồn thuê bao bật mọi model. Nguồn API key để admin tích chọn.
- omp, hermes, openclaw gọi `GET /<agent>/<space>/v1/models` và nhận model dạng `sub-openai/gpt-6-sol`, `api-openrouter/deepseek-v4`, kèm `source`, `provider`, `format`.
- Client gửi `model: "sub-openai/gpt-6-sol"`. Proxy đọc tiền tố, tìm nhóm, kiểm tra định dạng endpoint, gửi `gpt-6-sol` lên pool/nhà cung cấp, và trả về tên có tiền tố.
- Panel có tab mới "Model Provider" (ngay sau tab Subscription Pool) quản lý nhóm custom, tức nguồn API key. Như tab pool: mọi người dùng xem được (chỉ đọc, không thấy key); chỉ global admin tạo/sửa/xóa/lấy model, và Core kiểm tra quyền này. Nguồn thuê bao quản lý trên tab Subscription Pool sẵn có (câu 2 "A").
- claude-code và codex chạy y như hôm nay.

## Quyết định của bạn (cố định, không đảo)

1. "Some special agents use many models from many providers at the same time (named so far: omp — new agent with its own route /omp/<space> like hermes/openclaw; hermes; openclaw). Claude Code and Codex stay single-provider: their current subscription pool flow must NOT change or break."
2. "Subscription sources: the system fetches the model list of the subscription automatically; by default all models of the plan are enabled."
3. "API-key sources: admin adds the provider (base URL + key); the system fetches the model list from the provider API; admin ticks which models are enabled."
4. "The model list the proxy returns to clients must carry the source, because the same model can exist in several sources … The client must see the source and choose it explicitly."
5. "Chosen design: put the source into the model name, `<source>/<model>` (like OpenRouter/LiteLLM) … The proxy reads the prefix to route and sends the real model id upstream."
6. (Cập nhật) "the system SUGGESTS the source name (from source type + provider, e.g. sub-openai, api-deepseek, numeric suffix on collision), and the person who creates the source can EDIT it in the UI. So a Panel UI for creating/editing sources is IN scope." Đổi tên: câu hỏi 1 đã chọn "D", xem bên dưới.
7. "Do not break existing flows; plan carefully."
8. (Mới) "API-key sources MUST reuse the existing instance-upstream custom groups (mode custom_unified / custom_passthrough with base_url, api_key, model_id, agents …). Do NOT create a new table that stores keys. Each custom group = one API source; add ONLY the missing fields to the existing group (additive, backup first): source name (system-suggested, editable), format(s), and an enabled model list (replacing/extending the single model_id while keeping old behaviour for groups without the list). Subscription sources keep reusing pools/accounts."
9. (Mới) "the new Panel page is a new nav tab "Model Provider", and it is the custom upstream groups management (API-key sources). Subscription sources stay managed on the existing Subscription Pool tab."
10. (Mới) "support omp only, not pi … omp is the only agent of this family. It gets its own /omp/ route and is a multi-source agent. pi is not a supported agent."
11. (Câu 6, "A") Bỏ pi khỏi danh sách agent hỗ trợ (Core `default-supported-agents.ts` và bản sao Proxy `supported-agents.ts`), khỏi `agents` của nhóm default, và khỏi tên cổng hook (`session/pi` thành `session/omp`). `install.sh --client omp` và `setup-proxy.sh` đổi `baseUrl` `/pi/` → `/omp/` trong `~/.omp/agent/models.yml`, sao lưu trước. Sau đó request tới `/pi/` nhận lỗi rõ nêu URL `/omp/` mới.
12. (Câu 7, "A") Chỉ nhóm `custom_unified` (key do admin nhập) và `subscription_pool` được làm nguồn. Nhóm `custom_passthrough` vẫn chạy như hôm nay cho `agents` của nó nhưng không làm nguồn được: nhóm passthrough gửi lên upstream chính key client gửi (`runners/anthropic.ts:639-642`, `stages/instance-upstream-override.ts:69-71`), mà omp/hermes/openclaw gửi user key `sk-mem`. Prod hôm nay không có nhóm passthrough. Tab Model Provider vẫn liệt kê nhóm passthrough, ghi "không dùng được làm nguồn", không có trường nguồn và không lấy model. Core từ chối trường nguồn trên nhóm passthrough với mã `SOURCE_MODE_NOT_ALLOWED`.
13. (Câu 1, "D") Bản đầu không đổi tên nguồn: tên gợi ý sửa được trước lần lưu đầu, sau đó cố định; Core trả `SOURCE_NAME_IMMUTABLE`. Đổi tên là việc có thể làm sau.
14. (Câu 2, "A") Global admin sửa trường nguồn thuê bao ngay trên tab Subscription Pool (tên chỉ ở bước tạo; model bật; `source_agents`); người khác chỉ đọc.
15. (Câu 3, "B") Công tắc pool và nguồn thuê bao gắn với nhau: tắt pool thì nguồn tắt; nguồn thuê bao không có `source_enabled`; danh sách tài khoản Core gửi proxy không đổi (`metadata-service.ts:2495-2507`).
16. (Câu 4) Danh sách model của gói lấy qua API của provider (đã xác minh trên prod 2026-10-25), như omp; lỗi thì giữ danh sách thành công gần nhất; model mới của gói bật mặc định; model Codex `visibility: "hide"` bị lọc.
17. (Câu 5, "A") Cổng bắt cài hook của omp chạy ở cả ba định dạng, PR riêng 5b; bắt gói omp TUI so với `-p` trước khi viết code.
18. (Câu 8, "A") Pool tắt thì `/v1/models` ẩn model của pool; bật lại thì hiện lại; không có trường trạng thái.
19. (Câu 9, lựa chọn kỹ thuật "A") `models.yml` của omp có ba provider, mỗi định dạng một provider; PR 5b kiểm tra cách khai `api`/`baseUrl` theo từng model.
20. (Câu 10, "A") Ô xem trước chỉ có tab omp, hermes, openclaw, kèm một dòng ghi chú về Claude Code và Codex.
21. (Câu 11, "A") Mỗi pool đúng một nguồn; giới hạn agent/model sửa trên chính nguồn đó.
22. (Câu 12, "A") Model của nguồn API key tắt mặc định ở lần lấy đầu và với model mới về sau; lựa chọn đã có được giữ; bảng model có tìm kiếm và bật/tắt hàng loạt.
23. (Câu 13, "A") Form tạo nguồn tích sẵn omp, hermes, openclaw trong `source_agents`; admin bỏ tích được.
24. (Sửa của bạn) Tab Model Provider như tab Subscription Pool: mọi người dùng xem được (chỉ đọc, không thấy key); chỉ global admin tạo/sửa/xóa/lấy model; Core kiểm tra quyền.

## Sự thật đã kiểm tra trong code

Lấy bằng đọc file/grep trên `feat/server_team`, commit `2f2768bd`. GitNexus `impact resolveForAgent` báo 3 người gọi trực tiếp, rủi ro LOW; index bỏ sót 2 người gọi qua `await import(...)`, nên danh sách dưới lấy bằng grep.

| Sự thật | Nguồn |
|---|---|
| `resolveForAgent(items, agent)`: nhóm custom **đầu tiên** có agent trong `agents` (pool → `pool`, còn lại `override`), rồi nhóm default | `MemoryProxy/src/instance-upstream-cache.ts:203-244` |
| Người gọi `resolveForAgent` | `stages/instance-upstream-early.ts:62`, `stages/instance-upstream-responses.ts:86`, `runners/codex.ts:380`, `runners/utility.ts:141`, `runners/workbuddy.ts:1227` |
| Kiểm tra nhóm custom: tên ≤64, không có `/`; `agents ≥ 1`; mode `custom_unified`/`custom_passthrough`/`subscription_pool`; `base_url` bắt buộc trừ pool; `api_key` bắt buộc với unified | `MemoryCore/src/metadata/service/metadata-service.ts:2270-2279, 2763-2775, 3101-3104` |
| Một agent chỉ ở một nhóm (kiểm tra trùng khi ghi) | `sqlite-adapter.ts:2408` (`assertAgentsNotOverlap`), `mongodb-adapter.ts:1788, 1862, 2086` |
| Nhóm default tự thêm agent mới, bỏ agent đã có trong nhóm custom | `sqlite-adapter.ts:2359-2366`, `mongodb-adapter.ts:2253-2259` |
| Override đặt `body.model = row.model_id` khi có, key theo mode | `stages/instance-upstream-override.ts:64-84`; responses stage `instance-upstream-responses.ts:121-134` |
| Bật/tắt pool chỉ cập nhật `agents`, `enabled`, `version` của nhóm | `sqlite-adapter.ts:2557-2600` (câu `UPDATE ... SET agents = ?, enabled = ?`) |
| Tài khoản pool gửi proxy chỉ của nhóm pool đang `enabled` | `metadata-service.ts:2495-2507` |
| Nâng cấp bảng nhóm: rebuild chỉ khi bảng chưa có `subscription_pool`, chép danh sách cột cố định; cột mới thêm bằng `ALTER TABLE ADD COLUMN` theo `pragma_table_info` | `sqlite-adapter.ts:483-529` |
| Thứ tự runner anthropic: `applyPoolService` → `applyMainModel` → early stage → model gate → target → override → pool | `runners/anthropic.ts:506-508, 564, 583, 1043, 1059, 1074-1092`; openai-chat `416-417, 531` |
| `applyMainModel` ghi đè `body.model` | `MemoryProxy/src/mainModel.ts:40-46` |
| Kind `pool` vẫn qua model gate; bảng giá rỗng thì gate cho qua | `instance-upstream-cache.ts:271-278`, `pricing.ts:110-115` |
| `openPoolRequest` đọc `body.model` lúc tạo; lọc tài khoản theo `group_id` + `provider` | `subscription-pool/pool-request.ts:148, 331` |
| `withClientFacingModel` chỉ bọc runner chat và anthropic; `maskPayload` sửa `model` và `message.model` | `server.ts:24-25`, `response-model-mask.ts:48-62` |
| Route Responses chỉ có cho `/codex`, `/workbuddy`, `/proxy`; còn lại rơi vào catch-all chat | `server.ts:261-285, 410-436` |
| `/v1/models` trả danh sách phẳng từ bảng giá; Claude Code gọi `<base>/v1/models?limit=1000` (gatewayDiscovery) | `modelsHandler.ts:28-63`; chuỗi trong binary `claude-code-darwin-arm64/claude` |
| `AGENT_PREFIX_RE` thiếu `omp`, `hermes`, `openclaw` | `routes/whitelist.ts:187` |
| Panel không có trang nhóm upstream; `ApiKeysPage` chỉ quản lý user key `sk-mem`; action nhóm không có trong danh sách cho phép | `MemoryPanel/web/src/pages/`, `MemoryPanel/src/panel/api/meta-actions.ts:89-117` |
| Adapter provider chưa có hàm lấy model | `MemoryCore/src/subscription-pool/providers/types.ts:50-60` |
| Gói Claude: `GET https://api.anthropic.com/v1/models?limit=1000` với bearer token tài khoản, `anthropic-version: 2023-06-01`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `anthropic-dangerous-direct-browser-access: true` → 200, 14 model | Đã xác minh trên prod 2026-10-25 (giai đoạn 0) |
| Gói ChatGPT: `GET https://chatgpt.com/backend-api/codex/models?client_version=0.164.0` với bearer token, `chatgpt-account-id`, `originator: codex_cli_rs` → 200, 9 model (có `codex-auto-review` nội bộ) | Đã xác minh trên prod 2026-10-25 (giai đoạn 0) |
| Prod: Core sqlite; config proxy viết trong `compose.yaml`, không có `upstream`, `creditPricing` | `compose.yaml:22-36, 114-175` |

## Phạm vi pi (quyết định 10 và 11)

omp là agent duy nhất của họ pi. pi không phải agent hỗ trợ: không có trong `source_agents`, `/v1/models`, ô xem trước model id, setup-proxy, tên cổng hook. Các chỗ pi đang có và việc phải làm:

| Chỗ | Nguồn | Việc (giai đoạn) |
|---|---|---|
| Danh sách agent hỗ trợ | `MemoryCore/src/metadata/default-supported-agents.ts:49`, `MemoryProxy/src/supported-agents.ts:57` | Bỏ `pi` (1) |
| Adapter | `MemoryProxy/src/agent-adapters/index.ts:27, 53`, `agent-adapters/pi.ts` | Đổi thành omp (5a) |
| Strategy | `MemoryProxy/src/pipeline/strategies/agent/index.ts:45` | Đổi thành omp (5a) |
| Profile chèn memory | `MemoryProxy/src/injection/index.ts:485`, `injection/agents/pi/profile.ts` | Đổi thành omp (5a) |
| Header-only | `MemoryProxy/src/session/preset.ts:35` | Đổi thành omp (5a) |
| Cổng hook và session id | `MemoryProxy/src/session/pi/hook-gate.ts`, `session/session-key.ts:45-62`, `runners/openai-chat.ts:635, 652` | `session/pi` → `session/omp` (5a) |
| Route `/pi/` | catch-all hiện tại | Trả 410 nêu `/omp/` (5a) |
| Cài hook | `MemoryProxy/assets/client-hooks/install.sh` (dòng 6, 1187, 1206, 1222-1235) | `--client omp` đổi `/pi/` → `/omp/` có sao lưu; `--client pi` báo không hỗ trợ (5a) |
| setup-proxy | `agents/setup-proxy.sh` (không có pi) | `--agent omp` đổi `/pi/` → `/omp/` có sao lưu (7) |
| QA | `MemoryProxy/scripts/qa/codex-pi-e2e.sh` | Bỏ phần pi, giữ phần Codex (5a) |
| Dữ liệu prod | nhóm default có `pi` trong `agents` | Bỏ `pi`, sao lưu trước (9) |

## Thiết kế hiện tại và thiết kế mới (không chồng chức năng)

| Chức năng hiện có | Làm gì | Lý do |
|---|---|---|
| Nhóm upstream custom (`custom_unified`) | **Mở rộng**: thêm trường nguồn. Một nhóm là một nguồn API key | Quyết định 8. Key chỉ lưu ở một chỗ |
| Nhóm `subscription_pool` + tài khoản + `pool-request.ts` | **Mở rộng** nhóm pool bằng cùng các trường nguồn; tài khoản và chọn tài khoản dùng lại | Không có kho tài khoản thứ hai |
| `agents` của nhóm, `resolveForAgent`, kiểm tra trùng, diff-append default | **Giữ nguyên nghĩa**. Trường mới `source_agents` cho agent dùng nhóm qua tiền tố; không tham gia các kiểm tra này | Agent không `multi_source` không thể có trong `source_agents`, nên với chúng mọi thứ như cũ |
| `model_id` của nhóm | **Giữ nguyên** cho đường `agents`. Đường nguồn dùng danh sách `source_models`; `model_id` bị bỏ qua | "keeping old behaviour for groups without the list" |
| Override (`stageInstanceUpstreamOverride`, responses stage) | **Dùng lại**: proxy đưa vào một bản sao của dòng nhóm với `model_id` = id thật | Không sửa stage override |
| Upstream official, bảng giá, alias, model gate | **Giữ nguyên**; request có nguồn bỏ qua gate như nhóm custom | Model của nguồn không có trong bảng giá |
| Model pool service `tdai-code-o5`, `applyMainModel` | **Giữ nguyên**; request có nguồn không đi qua hai hàm này | Cả hai ghi đè `body.model` |
| `/v1/models` | **Mở rộng** chỉ cho agent nhiều nguồn | claude-code và codex nhận đúng phản hồi cũ |
| Che tên model (`response-model-mask.ts`) | **Dùng lại**; thêm nhánh `response.model` cho Responses | Client thấy đúng tên đã gửi |
| Panel | **Thêm** tab "Model Provider" (quản lý nhóm custom, gồm phần nguồn API key). Tab Subscription Pool **mở rộng** phần nguồn thuê bao; luồng bật/tắt pool và tài khoản giữ nguyên | Quyết định 9; hôm nay không có UI nhóm |

### Agent nhiều nguồn dùng nhiều nhóm mà không đổi hành vi agent khác

Ba quy tắc hiện có và cách xử lý:

| Quy tắc | Vấn đề nếu đưa omp vào `agents` của nhiều nhóm | Cách xử lý |
|---|---|---|
| Kiểm tra trùng: một agent một nhóm | Phải nới, và nới ở chỗ claude-code/codex cũng đi qua | Không dùng `agents`. Thêm `source_agents`; kiểm tra trùng không đọc trường này |
| `resolveForAgent` lấy nhóm custom đầu tiên có agent | omp không tiền tố sẽ đi nhóm đầu tiên; proxy cũ (khi lùi) cũng vậy | omp không nằm trong `agents` của nhóm nguồn, nên không bao giờ khớp. omp vẫn ở nhóm default (diff-append thêm tự động), request không tiền tố đi đường cũ |
| Nhóm custom phải có ≥1 agent | Nhóm chỉ làm nguồn có `agents` rỗng | Nới đúng một điều kiện: nhóm custom hợp lệ khi `agents ≥ 1` **hoặc** (`source_name` khác rỗng **và** `source_agents ≥ 1`). Nhóm cũ không có `source_name` kiểm tra y như hôm nay |
| `model_id` ghi đè model | Nguồn cần nhiều model | Đường nguồn bỏ qua `model_id`; đường `agents` giữ |

Một nhóm có thể vừa phục vụ cả agent (`agents: [codebuddy]`, `model_id` cố định) vừa làm nguồn (`source_agents: [omp]`). Hai đường độc lập.

## Mô hình dữ liệu (thêm cột vào bảng nhóm, không bảng mới)

Bảng `meta_instance_upstream_config` (Mongo: cùng tên collection), thêm:

| Cột | Kiểu, mặc định | Ý nghĩa |
|---|---|---|
| `source_name` | TEXT `''` | Tên nguồn trong model id. Rỗng = nhóm không phải nguồn. Dạng `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`, chữ thường. Duy nhất khi khác rỗng (chỉ mục duy nhất có điều kiện). Đặt một lần, không đổi được sau khi lưu (câu hỏi 1) |
| `source_provider` | TEXT `''` | `claude`/`openai` cho pool; slug cho API (`openai`, `anthropic`, `deepseek`, `openrouter`, ...). Dùng để gợi ý tên và chọn cách xác thực khi lấy model |
| `source_formats` | TEXT JSON `'[]'` | Tập con của `anthropic-messages`, `openai-chat`, `openai-responses`. Pool cố định theo provider; API admin chọn, mặc định `[openai-chat]` |
| `source_agents` | TEXT JSON `'[]'` | Chỉ agent `multi_source` (omp, hermes, openclaw) |
| `source_enabled` | INTEGER `0` | Chỉ cho nhóm `custom_unified` (tab Model Provider): công tắc của nguồn, độc lập với `enabled`. Cần vì một nhóm custom có thể vừa phục vụ `agents` vừa làm nguồn, và tắt `enabled` sẽ chặn các agent đó (`resolveForAgent` trả `blocked`). Nhóm pool không dùng cột này: nguồn thuê bao bật khi và chỉ khi pool bật (`enabled` của nhóm pool, câu 3 "B"); Core từ chối `source_enabled` trên nhóm pool |
| `source_models` | TEXT JSON `'[]'` | Danh sách `{id, display_name, enabled, available, first_seen_at, last_seen_at}`. `id` là id thật (có thể chứa `/`) |
| `source_models_fetched_at`, `source_models_error` | TEXT NULL | Kết quả lấy danh sách gần nhất (không chứa key) |

Mặc định `enabled` của model: pool `true` (cả model xuất hiện về sau); API `false`. Model không còn trong lần lấy mới: `available=false`, giữ `enabled`, không liệt kê, bị từ chối.

Chỉ nhóm `group_type = custom` với mode `custom_unified` hoặc `subscription_pool` được có `source_name`. `extraction`, `default`, `custom_passthrough` không.

Tương thích: Core cũ đọc dòng bỏ qua cột lạ; `groups/update` của Core cũ không ghi các cột này nên giữ nguyên; rebuild cũ không chạy (bảng đã có `subscription_pool`). Proxy cũ thấy nhóm `agents: []` → không khớp agent nào → vô hại.

Thuộc tính mới trên SupportedAgent (Core và Proxy): `multi_source?: boolean`; thêm agent `omp`.

## Luồng dữ liệu

```
Admin (Panel tab Model Provider: nhóm custom | tab Subscription Pool: trường nguồn của nhóm pool) → Core v3/meta/instance-upstream/groups/* (thêm trường nguồn)
                                  → v3/meta/instance-upstream/groups/source-refresh → lấy model → ghi source_models
Proxy: Core /v3/internal/meta/instance-upstream/list (đã có) trả cả cột mới → cache sẵn có (TTL 30s)

client → /<agent>/<space>/{v1/messages | v1/chat/completions | chat/completions | responses | v1/responses}
  → parse body → stageModelSource(agent, format, body.model)
       ├ agent không multi_source / cờ tắt → none (không đọc gì)
       ├ không "/" hoặc đoạn đầu không phải source_name → none (đường cũ)
       ├ agent không trong source_agents → 400 model_source_not_allowed
       ├ nguồn tắt (API: source_enabled=0; thuê bao: pool enabled=false) → 400 model_source_disabled
       ├ sai định dạng → 400 model_format_mismatch
       ├ model không bật/không còn → 400 model_not_enabled
       └ khớp → body.model = id thật; clientFacingModel = "<nguồn>/<model>"
                pool → {kind:"pool", row}; API → {kind:"override", row: {...row, model_id: id thật}}
  → runner chạy tiếp như nhóm custom/pool hôm nay → stream về client với tên có tiền tố
  → không tính credit (như pool/override); Langfuse thêm nhãn nguồn
```

## Bảo đảm cho claude-code và codex

- Không đổi: `resolveForAgent`, kiểm tra trùng, diff-append, `stageInstanceUpstreamOverride`, `applyPoolAuth`, `extractPoolSessionId`, bộ chọn tài khoản, bật/tắt pool, route `/claude-code/*` và `/codex/*`, cách bọc runner codex.
- Kiểm tra nhóm của Core chỉ thêm nhánh khi `source_name` khác rỗng. Nhóm pool của claude-code/codex có thêm trường nguồn cũng không đổi `agents`, `enabled`, `mode`.
- Có thêm một lời gọi `stageModelSource` trong runner anthropic, openai-chat và codex; trả `none` ngay khi agent không `multi_source` hoặc cờ tắt, trước khi đọc cache hay sửa body.
- `/v1/models` của claude-code và codex: test so sánh từng byte với `buildModelsResponse` cũ.
- Danh sách tài khoản gửi proxy không đổi: vẫn chỉ tài khoản của pool đang bật (`metadata-service.ts:2495-2507`, câu 3 "B").
- Cờ `modelSources.enabled` trong config proxy, mặc định `false`; `modelSources.agents` (tùy chọn) thu hẹp thêm.
- Bộ hồi quy ở mọi giai đoạn: `MemoryProxy/scripts/qa/hook-gate-e2e.sh`, `codex-pi-e2e.sh` (phần Codex; phần pi bỏ ở giai đoạn 5a), `codex-omp-hook-gate-e2e.sh` (giai đoạn 5 đổi sang `/omp/`), `codex-tui-smoke.py`; unit `src/subscription-pool/__tests__/*` (gồm `pool-off-identical.test.ts`, `claude-pool-forwarding.test.ts`, `pool-forwarding.test.ts`, `resolve-pool.test.ts`), `runners/__tests__/anthropic-hook-gate.test.ts`; Core `metadata/store/subscription-pool.service.test.ts`, `subscription-pool/*.test.ts` và test nhóm upstream hiện có.

## Các giai đoạn (mỗi giai đoạn một PR)

| # | Giai đoạn | Gói | Phụ thuộc | Ước lượng | Tệp |
|---|---|---|---|---|---|
| 0 | Spike: API danh sách model của gói Claude và ChatGPT (**xong**) | không đổi code | – | 1.5h | [phase-00](phase-00-subscription-model-list-spike.md) |
| 1 | Agent `omp`, thuộc tính `multi_source` | MemoryCore, MemoryProxy | – | 1.5h | [phase-01](phase-01-supported-agent-omp-multi-source.md) |
| 2 | Core: trường nguồn trên nhóm, kiểm tra, tên cố định, tài khoản pool | MemoryCore | 1 | 6h | [phase-02](phase-02-core-model-sources.md) |
| 3 | Core: lấy danh sách model vào `source_models` | MemoryCore | 0, 2 | 5h | [phase-03](phase-03-core-model-catalog-fetch.md) |
| 4 | Proxy: `stageModelSource`, cờ, runner anthropic + openai-chat, Langfuse | MemoryProxy | 2 | 6h | [phase-04](phase-04-proxy-model-source-routing.md) |
| 5 | 5a: Proxy route `/omp`, route Responses cho omp/hermes/openclaw, codex runner theo agent, bỏ pi và trả 410 trên `/pi/`. 5b (PR riêng): cổng hook omp ở ba định dạng | MemoryProxy, `install.sh`, QA | 1, 4 (5b sau 5a) | 8h + 5h | [phase-05](phase-05-proxy-omp-route-and-responses.md) |
| 6 | Proxy: `/v1/models` theo agent, đường thăm dò của Hermes | MemoryProxy | 4, 5 | 3h | [phase-06](phase-06-proxy-models-endpoint.md) |
| 7 | setup-proxy: sinh cấu hình omp/hermes/openclaw từ `/v1/models` | `agents/` | 5, 6 | 4h | [phase-07](phase-07-setup-proxy-clients.md) |
| 8 | Panel: tab "Model Provider" (nhóm custom) và phần nguồn trên tab Subscription Pool | MemoryPanel | 2, 3 | 10h | [phase-08](phase-08-panel-sources-page.md) |
| 9 | Deploy, dữ liệu prod, kiểm tra trên prod | vận hành | 1-8 | 3h | [phase-09](phase-09-deploy-and-prod-data.md) |

Sở hữu tệp: 1 → 2 → 3 nối tiếp (cùng `MemoryCore/src/metadata/types.ts`, `metadata-service.ts`, adapter sqlite/mongo). 4 → 5 → 6 nối tiếp (cùng runner, `server.ts`, `instance-upstream-cache.ts`). 7 (`agents/`) và 8 (`MemoryPanel/`) không chung tệp, chạy song song sau khi phụ thuộc xong.

Thứ tự PR (đã xong giai đoạn 0): Core 1 (1.5h) → 2 (6h) → 3 (5h); Proxy 4 (6h) → 5a (8h) → 5b (5h) → 6 (3h); sau đó 7 (4h, cần 5a và 6) và 8 (10h, cần 2 và 3) song song; cuối cùng 9 (3h). Proxy 4 bắt đầu được khi Core 2 đã merge (proxy chạy được cả khi Core chưa có cột mới). Tổng 53h, gồm 1.5h giai đoạn 0 đã làm.

## Rủi ro chính

| Rủi ro | Khả năng × Tác động | Giảm thiểu |
|---|---|---|
| Nới điều kiện "≥1 agent" làm lọt nhóm sai | Thấp × Trung bình | Nhánh mới chỉ khi `source_name` khác rỗng; test bảng cho nhóm cũ |
| Thay đổi runner làm lệch claude-code/codex | Thấp × Cao | Stage trả `none` trước mọi việc; cờ mặc định tắt; test từng byte; bộ hồi quy |
| Ghi `source_models` đụng CAS khi admin đang sửa nhóm | Trung bình × Thấp | Làm mới model là thao tác store riêng trong transaction; Panel tải lại khi gặp lỗi `version` |
| Provider đổi endpoint hoặc yêu cầu `client_version` mới | Thấp × Thấp | Lần lấy lỗi giữ danh sách thành công gần nhất, ghi `source_models_error`; Panel hiện lỗi |
| Client cần tên nguồn khác sau khi đã dùng | Thấp × Thấp | Bản đầu không đổi tên (câu 1, "D"); tạo nhóm mới và chạy lại setup-proxy. Đổi tên có alias là việc có thể làm sau |
| Admin tắt pool cho claude-code mà quên rằng `sub-claude` của omp/hermes/openclaw cũng tắt theo | Trung bình × Trung bình | Đây là hành vi đã chọn (câu 3 "B"). Hộp xác nhận tắt pool liệt kê nguồn và `source_agents` bị tắt theo; tab pool và ô xem trước model id hiện "nguồn đang tắt vì pool tắt"; proxy trả lỗi rõ `model_source_disabled` |
| Người không phải admin thấy key nhà cung cấp | Thấp × Cao | Action đọc `groups/view` không có trường key; `maskKeyValue` (8 ký tự đầu, `MemoryCore/src/metadata/utils/user-key.ts:12-16`) chỉ dùng cho admin như hôm nay; mọi action ghi kiểm tra `assertCanManageUsers` ở Core |
| Tab Model Provider cho gán claude-code/codex vào nhóm custom, đẩy chúng ra khỏi pool | Thấp × Cao | Tab không liệt kê nhóm pool; ô chọn `agents` ẩn agent đang ở nhóm pool; Core đã kiểm tra trùng; hộp xác nhận |
| Codex runner theo agent làm hỏng Codex | Thấp × Cao | Mọi nhánh riêng codex giữ điều kiện `agent === "codex"`; e2e Codex TUI |

## Ma trận kiểm thử

| Mức | Nội dung |
|---|---|
| Unit Core | Hợp đồng chung sqlite + mongo cho cột mới; nâng cấp DB cũ (bản sao) giữ nguyên dữ liệu; kiểm tra nhóm cũ không đổi; nhóm nguồn `agents: []`; từ chối passthrough/extraction/default có `source_name`; tên, trùng, `SOURCE_NAME_IMMUTABLE`; `source_agents` từ chối claude-code/codex; bật/tắt pool giữ trường nguồn; danh sách tài khoản không đổi; `source_enabled` trên nhóm pool bị từ chối; parser model |
| Unit Proxy | Bảng `stageModelSource`; claude-code/codex không đổi; `resolveForAgent` với dữ liệu có nhóm nguồn cho kết quả như trước với 9 agent; `/v1/models` từng byte cho claude-code/codex; `joinUrl` cho đường mới |
| E2E client thật (local) | omp TUI và `omp -p` ba định dạng qua `/omp/`; hermes, openclaw ba provider; bộ hồi quy claude-code/codex |
| Prod | Một prompt mỗi (agent, nguồn); Langfuse: `agent_source`, `model_source`, `upstream_model`, tài khoản pool đúng provider; claude-code và codex như trước |

## Deploy và lùi lại (chi tiết ở giai đoạn 9)

Sao lưu sqlite trước khi deploy Core (cột mới thêm lúc Core khởi động). Thứ tự: Core → Proxy với cờ tắt → Hub → bật cờ trong `compose.yaml` → gắn trường nguồn cho nhóm trên prod (sao lưu lại, đọc lại). Lùi: tắt cờ → lùi proxy → lùi Core; cột mới ở lại, Core cũ không đọc.

## Các câu đã hỏi (tất cả đã quyết định)

Không còn câu hỏi mở. Thứ tự theo số câu; quyết định tương ứng ở danh sách "Quyết định của bạn".

### Câu 1. Đổi tên nguồn xử lý thế nào? (đã quyết định)

Bạn chọn **"D"**: bản đầu không hỗ trợ đổi tên. Tên hệ thống gợi ý sửa được trong form tạo, trước lần lưu đầu; sau khi lưu, tên nguồn cố định. Core từ chối đổi `source_name` khi update với mã `SOURCE_NAME_IMMUTABLE`. Không có `source_aliases` và không định tuyến theo alias. Đổi tên (ví dụ giữ tên cũ làm alias) là tính năng có thể làm sau.

### Câu 2. Trường nguồn của nhóm pool sửa ở đâu? (đã quyết định)

Bạn chọn **"A"**: global admin sửa trường nguồn thuê bao ngay trên tab Subscription Pool (tên nguồn chỉ ở bước tạo, vì không đổi tên; model bật; `source_agents`; bản gốc có nêu `source_enabled`, nhưng theo câu 3 "B" nguồn thuê bao bật/tắt cùng pool nên không có công tắc riêng). Người khác thấy phần này ở chế độ chỉ đọc. Core kiểm tra quyền ở mọi action ghi. `subscription-pool/status` trả thêm khối `source` (không có key/token) để mọi người dùng xem được. Chi tiết ở giai đoạn 8.

### Câu 3. Tắt pool cho claude-code/codex có tắt luôn nguồn thuê bao không? (đã quyết định)

Bạn chọn **"B"**: công tắc pool và nguồn thuê bao gắn với nhau. Tắt pool (công tắc hiện có) thì nguồn thuê bao của pool đó cũng tắt. Hệ quả trong kế hoạch:
- Nguồn thuê bao không có công tắc riêng; `source_enabled` chỉ dùng cho nhóm custom (tab Model Provider).
- Core giữ nguyên `metadata-service.ts:2495-2507`: chỉ gửi tài khoản của pool đang bật.
- Proxy coi nguồn thuê bao là tắt khi dòng pool có `enabled=false` và trả 400 `model_source_disabled`; `/v1/models` không liệt kê model của nó.
- Tab Subscription Pool và ô xem trước model id hiện nguồn ở trạng thái "tắt vì pool tắt"; hộp xác nhận tắt pool nêu nguồn bị tắt theo.

### Câu 4. Lấy danh sách model của gói thuê bao thế nào? (đã quyết định, đã xác minh)

Đã xác minh trên prod ngày 2026-10-25: cả hai gói có API danh sách model, gọi giống omp (chi tiết ở giai đoạn 0). Core dùng một tài khoản đang hoạt động và bật của pool. Lần lấy lỗi thì giữ danh sách thành công gần nhất; không có danh sách dự phòng trong config. Model mới mặc định bật. Model Codex có `visibility: "hide"` (ví dụ `codex-auto-review`, `gpt-reserve`) bị lọc bỏ (giai đoạn 3).

### Câu 5. Cổng bắt cài hook của omp có chạy ở định dạng Anthropic và Responses không? (đã quyết định)

Bạn chọn **"A"**: cổng chạy ở cả ba định dạng (Anthropic messages, OpenAI Responses, OpenAI chat), làm thành PR riêng (5b). Vì ở định dạng Anthropic omp giả Claude Code (UA `claude-cli`, `x-claude-code-session-id`) và tên công cụ có tiền tố `_` (`_bash`, không thấy `ask`), cách nhận diện "tương tác hay `-p`" và công cụ chạy lệnh được định nghĩa riêng cho từng định dạng từ báo cáo bắt gói, và phải bắt gói lại omp TUI so với `-p` ở cả ba định dạng trước khi viết code. Chi tiết ở giai đoạn 5, mục D.

### Câu 6. Route `/pi/` và cấu hình omp đang trỏ `/pi/` xử lý thế nào? (đã quyết định)

Bạn chọn **"A"**: bỏ pi khỏi danh sách agent hỗ trợ (Core và Proxy), khỏi `agents` của nhóm default, và khỏi tên cổng hook (`session/pi` → `session/omp`). `install.sh --client omp` và `setup-proxy.sh` đổi `baseUrl` `/pi/` → `/omp/` trong `~/.omp/agent/models.yml`, sao lưu trước. Sau đó request tới `/pi/` nhận lỗi rõ nêu URL `/omp/` mới. Việc làm nằm ở giai đoạn 1, 5a, 7, 9 (bảng "Phạm vi pi").

### Câu 7. Nhóm `custom_passthrough` có được làm nguồn không? (đã quyết định)

Bạn chọn **"A"**: không. Chỉ `custom_unified` và `subscription_pool` làm nguồn; passthrough chạy như hôm nay cho `agents` của nó. Xem quyết định 12.

### Câu 8. `/v1/models` có ẩn model của pool khi pool tắt không? (đã quyết định)

Bạn chọn **"A"**: khi pool tắt, `/v1/models` ẩn model của pool đó; bật lại thì hiện lại. `/v1/models` không có trường trạng thái. Client vẫn gửi model đó thì nhận 400 `model_source_disabled`. setup-proxy chạy lúc pool tắt sẽ không ghi các model đó. Xem giai đoạn 6 và 7.

### Câu 9. setup-proxy ghi khối `models` trong `~/.omp/agent/models.yml` theo dạng nào? (đã quyết định, lựa chọn kỹ thuật)

Chọn **"A"**: ba provider trong `models.yml`, mỗi định dạng một provider (`memory-anthropic`, `memory-responses`, `memory-chat`), mỗi provider có `api`, `baseUrl` và danh sách `models[]` tĩnh (`id` có tiền tố). Schema omp cho phép mỗi model khai `api`/`baseUrl` riêng (`packages/coding-agent/src/config/models-config-schema-bundle.ts:202-224, 341-351`, bản `efbc17154a`). Bước bắt gói của PR 5b kiểm tra điều này; chỉ chuyển sang một provider với `api`/`baseUrl` theo từng model nếu bắt gói chứng minh omp dùng đúng, và ghi kết quả vào báo cáo bắt gói. `discovery: openai-models-list` không dùng (danh sách gộp mọi định dạng). Xem giai đoạn 5 (mục D) và 7.

### Câu 10. Ô xem trước có tab cho Claude Code và Codex không? (đã quyết định)

Bạn chọn **"A"**: ô xem trước chỉ có tab omp, hermes, openclaw, cộng một dòng ghi chú: Claude Code và Codex dùng pool riêng và được cài bằng setup-proxy như hôm nay. Xem giai đoạn 8.

### Câu 11. Có cho nguồn thuê bao thứ hai trên cùng một pool không? (đã quyết định)

Bạn chọn **"A"**: mỗi pool thuê bao có đúng một nguồn; không có nguồn thứ hai trên cùng pool. Muốn giới hạn agent hoặc model thì sửa `source_agents` và `source_models` của chính nguồn đó. Mô hình "nhóm pool = một nguồn" giữ nguyên (cột `source_name` trên nhóm pool). Xem giai đoạn 2 và 8.

### Câu 12. Model của nguồn API key tắt mặc định ở lần lấy đầu tiên? (đã quyết định)

Bạn chọn **"A"**: mọi model tắt mặc định ở lần lấy đầu, admin tích. Model mới tìm thấy ở các lần lấy sau của nguồn API key cũng tắt mặc định; lựa chọn đã có được giữ. Bảng model có ô tìm kiếm và nút bật/tắt hàng loạt. Xem giai đoạn 3 và 8.

### Câu 13. omp, hermes, openclaw có được tích sẵn trong `source_agents` khi tạo nguồn không? (đã quyết định)

Bạn chọn **"A"**: khi tạo nguồn (tab Model Provider) hoặc gắn nguồn cho pool lần đầu (tab Subscription Pool), form tích sẵn cả ba agent `multi_source` (omp, hermes, openclaw); admin bỏ tích được. Mặc định này chỉ ở form Panel; API của Core không tự thêm agent khi `source_agents` không được gửi. Xem giai đoạn 8.

## Kết quả triển khai (26/10/2026)

- Commit: d702aa10, 31049a05, df3bbad4, 9b0755c4, dfde5e9c, ae252dee, 07e86a5d, 359a5a49, c5c98248, a77be29f, 144f92e3, e8c3f482, cb52d893 (bật cờ), 45d727da, e28e6070.
- Test đầy đủ trước khi deploy: Core 1342/1342, Proxy 892/892, Panel 181/181.
- E2e local với omp 18.6.3 thật: `-p` và TUI ở cả ba định dạng; cổng hook chặn session chưa có hook, omp tự chạy lệnh cài, câu hỏi gốc được trả lời, lượt giả không lên upstream, prompt sau không bị chặn. setup-proxy chạy thật với omp, OpenClaw 2026.3.13, Hermes v0.21.2.
- Prod: sao lưu `metadata.db` (integrity ok) trước khi deploy Core; bỏ `pi` khỏi nhóm default; gắn `sub-claude` (14 model) và `sub-openai` (7 model) cho omp, hermes, openclaw; bật `modelSources`.
- Kiểm tra prod: `/v1/models` của claude-code và codex giống từng byte bản trước; Claude Code và Codex (pool) chạy như cũ; `/pi/` trả 410; omp `-p` qua `sub-claude` và `sub-openai` trả lời đúng; sai định dạng trả 400 `model_format_mismatch`.
- Lỗi tìm thấy trên prod và đã sửa (45d727da): tài khoản Claude subscription trả 429 cho request không mở đầu bằng dòng nhận diện Claude Code, nên hermes và openclaw không dùng được `sub-claude`. Proxy nay thêm dòng đó cho request qua nguồn Claude; sau deploy hermes và openclaw trả 200.
