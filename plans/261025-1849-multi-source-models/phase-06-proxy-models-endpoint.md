# Giai đoạn 6: `/v1/models` theo agent và đường thăm dò của Hermes

## Bối cảnh

- `GET /:agent/:spaceId/v1/models` → `handleModels` (`server.ts:384`, `modelsHandler.ts:45-63`): xác thực user key, trả `buildModelsResponse(creditPricing, poolService)` với `owned_by: "context-proxy"`. Trên prod trả `[]` vì không có bảng giá.
- Claude Code gọi `<base>/v1/models?limit=1000` và kiểm tra dạng (gatewayDiscovery trong binary). Codex có gọi route này qua proxy hay không: [UNVERIFIED]; giai đoạn 9 kiểm tra log prod (`grep "GET /codex/.*/models"`). Bảo đảm từng byte vẫn giữ dù có hay không.
- Hermes gọi `GET /hermes/<s>/api/v1/models`, `GET /hermes/<s>/v1/models`, `GET /hermes/<s>/v1/models/<model>`, `POST /hermes/<s>/api/show` (báo cáo bắt gói). `POST .../api/show` hôm nay rơi vào catch-all chat (`server.ts:436`) và bị forward lên upstream.

## Thay đổi

1. `handleModels`: lấy agent từ đoạn đầu đường dẫn. Nếu cờ bật và agent nhiều nguồn: danh sách = mục nguồn (theo thứ tự tên nguồn, rồi model) + danh sách cũ ở sau (bỏ id trùng). Ngược lại: gọi đúng `buildModelsResponse` như hôm nay.
2. Câu 8 "A": model của nhóm pool đang tắt không được liệt kê; bật lại thì liệt kê lại. Không thêm trường trạng thái (`status`, `disabled_reason`) vào mục model.
2b. Nguồn dữ liệu: các dòng nhóm trong cache sẵn có (`getInstanceUpstreamConfigs`) có `source_name`, nguồn đang bật (nhóm custom: `source_enabled`; nhóm pool: `enabled`, câu 3 "B"), agent nằm trong `source_agents`; model lấy từ `source_models` với `enabled && available !== false`. `source_type` = `subscription` khi mode `subscription_pool`, `api` khi `custom_unified`.
3. Mục nguồn:

```json
{ "id": "sub-openai/gpt-6-sol", "object": "model", "created": 0, "owned_by": "sub-openai",
  "source": "sub-openai", "source_type": "subscription", "provider": "openai",
  "format": "openai-responses", "formats": ["openai-responses"], "upstream_model": "gpt-6-sol",
  "display_name": "GPT-6 Sol" }
```

   `format` là định dạng đầu tiên trong `formats` (để setup-proxy chọn provider client).
4. `GET /<agent>/:spaceId/v1/models/:model{.+}` cho agent nhiều nguồn: trả một mục hoặc 404 theo dạng OpenAI.
5. Hermes: `GET /hermes/:spaceId/api/v1/models` dùng cùng handler. `POST /hermes/:spaceId/api/show` trả 404 JSON ngay (không forward). Hermes khi đó dùng context 256k như báo cáo đã thấy (vẫn chạy).

## Tệp

- Sửa: `MemoryProxy/src/modelsHandler.ts`, `MemoryProxy/src/server.ts`.
- Thêm test: `MemoryProxy/src/__tests__/models-handler.test.ts` (hoặc cạnh file theo quy ước).

## Kiểm thử

- claude-code và codex: phản hồi giống từng byte với `buildModelsResponse` cũ (cờ bật và tắt; có và không có nguồn).
- omp: mục nguồn đúng trường; tắt pool codex → mục `sub-openai/*` biến mất, bật lại → xuất hiện lại; model tắt/không còn không xuất hiện; nguồn không cho omp không xuất hiện; danh sách cũ ở sau.
- Không có user key → 401 như cũ.
- Hermes `api/show` → 404, không có request upstream.

## Rủi ro và lùi lại

- Client lạ không chịu trường thêm: OpenAI cho phép trường thêm; chỉ áp dụng cho agent nhiều nguồn.
- Lùi: tắt cờ.
