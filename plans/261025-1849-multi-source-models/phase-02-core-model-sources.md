# Giai đoạn 2: Core thêm trường nguồn vào nhóm upstream

## Bối cảnh

- Bảng nhóm `meta_instance_upstream_config`: DDL `sqlite-adapter.ts:125-146`; nâng cấp `migrateSubscriptionPool` (`483-529`) dùng `ALTER TABLE ADD COLUMN` theo `pragma_table_info`. Rebuild cũ chép danh sách cột cố định và chỉ chạy khi bảng chưa có `subscription_pool`.
- Kiểm tra nhóm: `metadata-service.ts:2270-2279` (ma trận), `2763-2775` (tạo), `3101-3104` (`agents ≥ 1`); tên nhóm cấm `/` (`2279`).
- Kiểm tra trùng agent: `sqlite-adapter.ts:2408`, `mongodb-adapter.ts:1788, 1862, 2086`. Diff-append default: `sqlite-adapter.ts:2359-2366`, `mongodb-adapter.ts:2253-2259`.
- Bật/tắt pool chỉ cập nhật `agents`, `enabled`, `version` (`sqlite-adapter.ts:2557-2600`).
- Tài khoản cho proxy: `metadata-service.ts:2495-2507` (lọc nhóm pool `enabled`).
- Schema API: `v3-meta-schemas.ts:532` (create), `545` (update). Route: `v3-meta-router.ts:383-433`. List nội bộ: `internal-meta-router.ts:103-107`.

## Thay đổi

### Lưu trữ (chỉ thêm cột)

1. sqlite: thêm vào `instanceUpstreamTableDdl` (cho DB mới) và một hàm nâng cấp mới chạy **sau** `migrateSubscriptionPool` (cho DB cũ) các cột `source_name`, `source_provider`, `source_formats`, `source_agents`, `source_enabled`, `source_models`, `source_models_fetched_at`, `source_models_error` (kiểu và mặc định như `plan.md`). Mỗi cột chỉ thêm khi `pragma_table_info` chưa có.
2. Chỉ mục: `CREATE UNIQUE INDEX IF NOT EXISTS ux_iuc_source_name ON meta_instance_upstream_config(source_name) WHERE source_name != ''`, tạo sau bước nâng cấp.
3. Mongo: trường tùy chọn (thiếu = mặc định); unique index trên `source_name` với `partialFilterExpression: { source_name: { $gt: "" } }`.
4. Ánh xạ dòng ↔ entity và `toPublicGroup`: thêm trường mới. Bản công khai giữ che `api_key` như hôm nay.

### Kiểm tra (metadata-service.ts)

1. `assertAgents` cho custom: hợp lệ khi `agents.length ≥ 1` **hoặc** (`source_name` khác rỗng **và** `source_agents.length ≥ 1`). Nhóm không có `source_name`: y như hôm nay.
2. Chỉ `custom_unified` và `subscription_pool` được có `source_name` (câu 7 "A"). Gửi bất kỳ trường nguồn nào (`source_name`, `source_provider`, `source_formats`, `source_agents`, `source_enabled`, `source_models`) khi tạo/sửa nhóm `custom_passthrough` → `SOURCE_MODE_NOT_ALLOWED` (HTTP 400, "a custom_passthrough group forwards the client credential and cannot be a model source"). Đổi mode một nhóm đang là nguồn sang `custom_passthrough` cũng bị từ chối với cùng mã. `default` và `extraction` không được.
3. `source_name`: đúng dạng, chữ thường, không trùng `source_name` của nhóm khác (kiểm tra trong transaction, cộng chỉ mục duy nhất).
4. `source_agents`: chỉ agent `multi_source: true`. Core không tự điền giá trị mặc định (mặc định "tích sẵn cả ba" của câu 13 "A" là việc của form Panel); thiếu `source_agents` khi gắn `source_name` lần đầu → `INVALID_SOURCE_AGENTS` (vì nhóm chỉ làm nguồn cần ≥1); claude-code và codex → `INVALID_SOURCE_AGENTS`. Không tham gia `assertAgentsNotOverlap` và diff-append (không sửa hai hàm này).
5. `source_formats`: pool đặt cố định (`claude` → `[anthropic-messages]`, `codex` → `[openai-responses]`), `source_provider` của pool đặt `claude`/`openai`. API: khác rỗng, trong 3 giá trị.
6. `model_id` giữ nghĩa cũ cho `agents`. Nếu nhóm chỉ làm nguồn (`agents` rỗng) mà có `model_id`, trả lỗi `MODEL_ID_UNUSED` để tránh hiểu nhầm.
6b. Một pool một nguồn (câu 11 "A"): nhóm pool chỉ có một `source_name` (cột trên chính nhóm), nên không có cách gắn nguồn thứ hai; Core không có API tạo nguồn trỏ tới tài khoản của pool khác nhóm. Giới hạn agent/model sửa trên `source_agents`/`source_models` của nguồn đó.
7. Không đổi tên (câu 1, đã chọn D): `source_name` chỉ đặt một lần, khi nhóm chưa có `source_name`. `groups/update` gửi `source_name` khác giá trị đã lưu → `SOURCE_NAME_IMMUTABLE` (HTTP 400, thông báo "source name cannot be changed after it is saved"). Gửi đúng giá trị cũ thì bỏ qua. Muốn ngừng một nguồn API: đặt `source_enabled = 0`, hoặc xóa nhóm. Nguồn thuê bao ngừng khi tắt pool. Đổi tên là việc có thể làm sau.
8. Thêm `suggestSourceName(kind, provider)`: `sub-claude`, `sub-openai`, `api-<provider>`; trùng `source_name` thì `-2`, `-3`.

### API

1. `groups/create` và `groups/update`: nhận các trường nguồn (zod tùy chọn). Không gửi = như cũ.
2. Gắn nguồn cho nhóm pool: dùng `groups/update` (nhóm pool là nhóm custom). Không đổi `subscription-pool/enable|disable`.
3. `groups/source-refresh` trên nhóm passthrough → `SOURCE_MODE_NOT_ALLOWED`.
3b. Thêm action đọc `instance-upstream/groups/view` cho mọi người dùng đã đăng nhập: nhóm `custom` (trừ pool), không có trường key (chỉ `api_key_configured`). Chi tiết quy tắc che key ở giai đoạn 8.
4. Thêm `instance-upstream/groups/suggest-source-name`, `instance-upstream/groups/source-models/update` (tích bật/tắt model), `instance-upstream/groups/source-refresh` (giai đoạn 3; ở đây trả `NOT_IMPLEMENTED`). Đều `assertCanManageUsers`.
5. List nội bộ `/v3/internal/meta/instance-upstream/list`: dòng có thêm cột mới (proxy cũ bỏ qua).
6. `getSubscriptionPoolStatus` (`metadata-service.ts:2368-2394`) trả thêm khối `source` cho mỗi provider (trường nguồn của nhóm pool, không có key/token), để tab Subscription Pool hiện phần nguồn cho mọi người dùng (câu 2 "A"). Chỉ thêm khóa, không đổi khóa cũ.
7. Câu 3 "B": `listSubscriptionAccountsInternal` (`metadata-service.ts:2495-2507`) **không đổi**. `source_enabled` chỉ nhận trên nhóm `custom_unified`; gửi trên nhóm pool → `SOURCE_ENABLED_NOT_ALLOWED`. Trạng thái nguồn thuê bao = `enabled` của nhóm pool. Khối `source` trong `subscription-pool/status` có thêm `source_active` (= pool bật) để Panel hiện "tắt vì pool tắt".

## Tệp

- Sửa: `MemoryCore/src/metadata/store/sqlite-adapter.ts`, `mongodb-adapter.ts`, `interface.ts`, `MemoryCore/src/metadata/types.ts`, `service/metadata-service.ts`, `router/v3-meta-router.ts`, `router/v3-meta-schemas.ts`.

## Kiểm thử

- Hợp đồng chung sqlite `:memory:` + Mongo: tạo nhóm nguồn `agents: []`; nhóm cũ thiếu agent vẫn bị từ chối; passthrough/default/extraction có `source_name` bị từ chối; nhóm passthrough với từng trường nguồn → `SOURCE_MODE_NOT_ALLOWED`; đổi nhóm nguồn sang passthrough → `SOURCE_MODE_NOT_ALLOWED`; nhóm passthrough không có trường nguồn tạo/sửa như hôm nay; tên sai dạng; tên trùng; update đổi `source_name` → `SOURCE_NAME_IMMUTABLE`; update gửi lại đúng tên cũ → thành công; `source_agents` có claude-code bị từ chối; omp trong `source_agents` của hai nhóm được phép; omp vẫn ở nhóm default sau diff-append.
- Bật/tắt pool sau khi gắn nguồn: trường nguồn còn nguyên.
- `listInstanceUpstreamGroupsInternal`: với dữ liệu không có nguồn, JSON giống trước (trừ các khóa mới mang giá trị mặc định).
- Tài khoản: danh sách gửi proxy giống hệt trước, có và không có nguồn, pool bật và tắt.
- `source_enabled` trên nhóm pool bị từ chối; tắt pool rồi bật lại giữ nguyên trường nguồn; `subscription-pool/status` có `source_active` đúng theo pool.
- Nâng cấp bản sao DB thật: cột mới được thêm, dữ liệu cũ giữ nguyên (so sánh `SELECT` các cột cũ trước/sau).

## Rủi ro và lùi lại

- Nới `assertAgents` sai phạm vi → test bảng cho nhóm cũ.
- Lùi: deploy Core cũ; cột mới ở lại, Core cũ không đọc. Nếu cần gỡ dữ liệu: đặt `source_name = ''` cho nhóm (nhóm chỉ làm nguồn có `agents` rỗng thì xóa nhóm trước khi lùi, vì Core cũ coi nhóm custom không agent là không hợp lệ khi sửa).
