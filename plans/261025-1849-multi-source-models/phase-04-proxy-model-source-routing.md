# Giai đoạn 4: Proxy định tuyến theo `<nguồn>/<model>` (anthropic + openai-chat)

## Bối cảnh

- Thứ tự runner anthropic: parse body (`runners/anthropic.ts:500`) → `applyPoolService` (506) → `applyMainModel` (508) → `stageInstanceUpstreamEarly` (564) → model gate (583) → `stageResolveTargetFull` (1043) → override (1059-1071) → pool (1074-1092). Runner openai-chat: `applyPoolService` 416, early stage 531.
- `applyMainModel` ghi đè `body.model` (`mainModel.ts:40-46`); `openPoolRequest` đọc `body.model` lúc tạo (`pool-request.ts:148`).
- Kind `pool` hiện vẫn qua model gate (`instance-upstream-cache.ts:271-278`).
- Dòng nhóm đã có trong cache proxy (`getInstanceUpstreamConfigs`, `instance-upstream-cache.ts:147-193`); sau giai đoạn 2 dòng có thêm cột nguồn.

## Thay đổi

1. Config: `modelSources?: { enabled: boolean; agents?: string[] }` trong `MemoryProxy/src/types.ts` và `config.ts`; mặc định `enabled: false`.
2. Kiểu `InstanceUpstreamRow` (`instance-upstream-cache.ts:52-75`): thêm trường tùy chọn `source_name`, `source_provider`, `source_formats`, `source_agents`, `source_enabled`, `source_models`. Không đổi `fetchFromCore`, cache, `resolveForAgent`.
3. Stage mới `MemoryProxy/src/pipeline/stages/model-source.ts`:
   - Đầu vào: `config`, `agent`, `spaceId`, `format`, `model`.
   - Bước 1: cờ tắt, agent không `multi_source`, hoặc ngoài `modelSources.agents` → `{ kind: "none" }`. Không đọc cache, không sửa gì.
   - Bước 2: model không có `/` → `none`. Tách tại `/` đầu tiên; đoạn đầu (chữ thường) so với `source_name` của các dòng `group_type = custom`. Không khớp → `none`.
   - Bước 3: agent không trong `source_agents` → 400 `model_source_not_allowed`. Nguồn tắt → 400 `model_source_disabled` ("source 'sub-claude' is disabled because its subscription pool is off" hoặc "... is disabled"): nhóm `custom_unified` xét `source_enabled`; nhóm pool xét `enabled` của dòng pool (câu 3 "B"). Sai định dạng → 400 `model_format_mismatch` (nêu định dạng phục vụ). Model không có trong `source_models` với `enabled && available !== false` → 400 `model_not_enabled`.
   - Dòng pool lấy theo chính dòng khớp. Khi pool tắt, Core cũng không gửi tài khoản của nó (`metadata-service.ts:2495-2507`), nên kiểm tra ở bước 3 là bắt buộc để trả lỗi rõ thay vì lỗi "không còn tài khoản" của pool.
   - Bước 4: `{ kind: "matched", clientModel, upstreamModel, row, resolution }`. Mode `subscription_pool` → `{ kind: "pool", row }`. Mode `custom_unified` → `{ kind: "override", row: { ...row, model_id: upstreamModel } }` (bản sao; không sửa dòng trong cache). Lỗi trả envelope theo runner, cùng dạng `instance-upstream-early.ts:84-115`.
4. Runner anthropic và openai-chat: gọi stage ngay sau parse body, trước `applyPoolService`. Khi `matched`:
   - `body.model = upstreamModel`; `c.set("clientFacingModel", clientModel)`.
   - Bỏ `applyPoolService` và `applyMainModel` cho request này.
   - Truyền `presetResolution` (tham số tùy chọn mới) vào `stageInstanceUpstreamEarly`. Có tham số → dùng nó thay `resolveForAgent` và đặt `isCustomUpstream = true` (bỏ model gate). Không có → code cũ y nguyên.
   - Pool (`sub-claude`, anthropic): nhánh `openPoolRequest(... provider: "claude")` sẵn có. API: nhánh override sẵn có thay URL (`joinUrl`), key (`custom_unified`), `body.model` (`model_id` của bản sao).
   - Runner openai-chat không có nhánh pool; nhóm pool không có `openai-chat` trong `source_formats`, bước 3 đã chặn.
5. Credit: pool và override đã đặt `skipCreditReport = true` (`anthropic.ts:1072, 1089`). Ghi rõ trong PR.
6. Langfuse: thêm vào `observationMetadata` (`MemoryProxy/src/langfuse.ts:222, 409, 440`) các khóa `model_source` (tên lúc request), `model_source_group_id`, `source_type` (`subscription`/`api`), `upstream_model`, `client_model`. Vị trí dựng metadata trong từng runner: tìm khi làm (chưa trích được dòng).
7. Log một dòng info cho request khớp: agent, nguồn, định dạng, kind. Không log key.

## Tệp

- Thêm: `MemoryProxy/src/pipeline/stages/model-source.ts`, `pipeline/stages/__tests__/model-source.test.ts`.
- Sửa: `MemoryProxy/src/types.ts`, `config.ts`, `instance-upstream-cache.ts` (chỉ kiểu), `pipeline/stages/instance-upstream-early.ts`, `pipeline/runners/anthropic.ts`, `pipeline/runners/openai-chat.ts`, `config.example.yaml`.

## Kiểm thử

- Bảng stage: cờ tắt; agent claude-code/codex (spy `fetch`, không có lời gọi); không `/`; tiền tố lạ; agent không được phép; nhóm custom `source_enabled` tắt; nhóm pool `enabled=false` → `model_source_disabled`; sai định dạng; model tắt/không còn; id có `/` (`api-openrouter/deepseek/deepseek-v4`); chữ hoa trong tiền tố; dòng trong cache không bị sửa.
- `resolveForAgent` với dữ liệu prod hiện tại cộng các nhóm nguồn (`agents: []`): kết quả cho 9 agent giống hệt trước.
- Runner anthropic với mock Core: `sub-claude/<model>` → `api.anthropic.com/v1/messages`, `body.model` id thật, header như `claude-pool-forwarding.test.ts`, phản hồi JSON/SSE có tên tiền tố; nhóm pool `enabled=false` → 400 `model_source_disabled`, không có request upstream.
- Runner openai-chat: `api-deepseek/deepseek-chat` → `<base_url>/chat/completions`, key của nhóm; nhóm đó có `model_id` cho `agents` khác vẫn không ghi đè model nguồn.
- `TDAI_PROXY_MAIN_MODEL_FILE` đặt sẵn: request có nguồn không bị ghi đè.
- Hồi quy: `src/subscription-pool/__tests__`, `runners/__tests__`, `hook-gate-e2e.sh`, `codex-pi-e2e.sh` (phần Codex).

## Rủi ro và lùi lại

- Tham số mới của early stage đổi hành vi khi không truyền → test so sánh cũ/mới.
- Lùi: tắt cờ; hoặc deploy image cũ.
