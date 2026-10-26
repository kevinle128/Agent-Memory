# Giai đoạn 1: Agent `omp` và thuộc tính `multi_source`

## Bối cảnh

- Danh sách agent hỗ trợ có ở hai nơi, phải giống nhau: `MemoryCore/src/metadata/default-supported-agents.ts:42-52` và `MemoryProxy/src/supported-agents.ts:44-60`. SOP thêm agent: `default-supported-agents.ts:36-40`.
- `deploy/compose/core.yaml` trong repo không có `upstream.supportedAgents`, nên fallback có hiệu lực. Tệp trên server phải kiểm tra lại ở giai đoạn 9 (chỉ đọc, không in bí mật).

## Thay đổi

1. Thêm trường tùy chọn `multi_source?: boolean` vào kiểu `SupportedAgent` (Core `MemoryCore/src/metadata/types.ts`, Proxy `supported-agents.ts:30-37`) và schema zod trả về Panel (`MemoryCore/src/metadata/router/v3-meta-schemas.ts`, tìm schema supported-agents).
2. Thêm `{ agent_source: "omp", protocol: "openai-chat", display_name: "oh-my-pi", multi_source: true }` vào cả hai hằng. Đặt `multi_source: true` cho `hermes`, `openclaw`.
3. Proxy: thêm `isMultiSourceAgent(agent)` cạnh `isSupportedAgent` (`supported-agents.ts:68`).
4. Không đổi `protocol` (chỉ để hiển thị).
5. Bỏ `pi` khỏi cả hai hằng (câu 6 "A"). Cập nhật SOP ở `default-supported-agents.ts:36-40`: omp là agent duy nhất của họ pi. Trước khi bỏ, đọc và ghi trong PR cách `listInstanceUpstreamGroups(..., supportedAgents)` và `assertAgents` (`metadata-service.ts:3101-3115`) xử lý nhóm default còn `pi` trong `agents` (dữ liệu cũ). Yêu cầu: đọc nhóm không lỗi; `groups/update` bỏ `pi` thành công; diff-append không thêm lại `pi`. Dữ liệu prod sửa ở giai đoạn 9.

Lưu ý: nhóm default tự thêm agent mới (`sqlite-adapter.ts:2314-2385`, diff-append), nên sau khi deploy `omp` vào nhóm default. Đây là hành vi mong muốn: request omp không tiền tố đi đường cũ.

## Tệp

- Sửa (bỏ `pi`, thêm `omp`): `MemoryCore/src/metadata/default-supported-agents.ts`, `MemoryCore/src/metadata/types.ts`, `MemoryCore/src/metadata/router/v3-meta-schemas.ts`, `MemoryProxy/src/supported-agents.ts`.

## Kiểm thử

- Unit Core: supported-agents trả `omp` và `multi_source`; seed default thêm `omp`.
- Unit Proxy: `isMultiSourceAgent` đúng cho omp/hermes/openclaw, sai cho claude-code/codex; `isSupportedAgent("pi")` là false.
- Unit Core: nhóm default còn `pi` (dữ liệu cũ) vẫn đọc được; `groups/update` bỏ `pi` thành công; seed/diff-append không thêm `pi`; `groups/create` có `pi` trả `INVALID_AGENTS`.

## Rủi ro và lùi lại

- Rủi ro thấp: trường tùy chọn. Lùi bằng revert; `omp` đã thêm vào nhóm default vẫn ở đó (vô hại; gỡ bằng groups/update nếu cần).
