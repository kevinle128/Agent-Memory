# Giai đoạn 9: Deploy, dữ liệu prod, kiểm tra trên prod

Làm theo skill `operator-master/.claude/skills/deploy-agent-memory/SKILL.md` (pull, build theo SHA, `--no-deps`, không đọc/sửa/sao lưu `.env` của server).

## Trước khi deploy (chỉ đọc)

1. Kiểm tra `deploy/compose/core.yaml` trên server không có `upstream.supportedAgents` (nếu có, phải thêm `omp` và `multi_source` vào đó trước). Không in nội dung bí mật: chỉ `grep -n supportedAgents`.
2. Tìm tệp sqlite metadata trong container Core: `find /data/tdai-memory -name metadata.db` (dạng `<baseDir>/<dbName>/metadata.db`, `MemoryCore/src/metadata/store/db-name.ts:47-54`; baseDir trên prod chưa xác minh).
3. Kiểm tra log proxy xem Codex có gọi `/v1/models` qua proxy không: `docker logs --since 72h agent-memory-proxy-1 2>&1 | grep -c "GET /codex/.*/models"`.
4. Đếm request `/pi/` 72h gần nhất (`docker logs --since 72h agent-memory-proxy-1 2>&1 | grep -c " /pi/"`) để biết còn bao nhiêu máy omp trỏ `/pi/`; báo bạn con số trước khi deploy proxy (các máy đó sẽ nhận 410 cho tới khi chạy lại `install.sh --client omp`).
5. Ghi lại hiện trạng để so sánh: `groups/list` (agents, mode, enabled của 3 nhóm), `subscription-pool/status`, và `GET /claude-code/default/v1/models` (lưu phản hồi).

## Thứ tự deploy

1. Sao lưu sqlite metadata trước (cách ở mục Dữ liệu prod, bước 1), vì Core mới thêm cột vào bảng nhóm lúc khởi động. Rồi deploy `memory-core` (giai đoạn 1-3). Kiểm tra: healthy; `groups/list` giống hiện trạng, chỉ thêm `omp` vào nhóm default; cột mới có trong `meta_instance_upstream_config` (`sqlite3 <metadata.db> "PRAGMA table_info(meta_instance_upstream_config)"`, chỉ đọc); các cột cũ của 3 nhóm giữ nguyên giá trị.
2. `proxy` (giai đoạn 4-6) với `modelSources.enabled: false`. Kiểm tra: một prompt claude-code và một prompt codex qua pool (như trước); `/claude-code/default/v1/models` giống hệt bản đã lưu.
3. `memory-hub` (giai đoạn 8). Kiểm tra: trang pool như cũ; tab "Model Provider" nằm sau Subscription Pool, hiện cho mọi người dùng, chưa có nhóm nào (prod chưa có nhóm custom ngoài hai pool); với một tài khoản không phải admin, trang chỉ đọc và phản hồi `groups/view` không có trường key.
4. Bật cờ: sửa khối `configs.proxy-config` trong `compose.yaml` (thêm `modelSources: { enabled: true }`), commit, push, pull trên server, `docker compose up -d --no-deps proxy`. Kiểm tra lại claude-code/codex.

## Dữ liệu prod

1. Sao lưu trước mọi thay đổi dữ liệu: trong container Core chạy `sqlite3 <metadata.db> ".backup /data/tdai-memory/backup-<ngày>-model-sources.db"`, rồi `sqlite3 <bản sao> "PRAGMA integrity_check"` phải ra `ok`. Mongo (chỉ triển khai Mongo, không phải prod): `mongodump` các collection `meta_instance_upstream_config`, `meta_upstream_subscription_account`.
2. Bỏ `pi` khỏi nhóm default (câu 6 "A"), sau bước 1 (sao lưu đã kiểm tra) và sau khi deploy Core mới: `groups/update` nhóm default với `agents` = danh sách hiện tại trừ `pi` (dùng `version` vừa đọc). Đọc lại `groups/list`: nhóm default không còn `pi`, các agent khác giữ nguyên.
3. Gắn nguồn thuê bao trên tab Subscription Pool bằng tài khoản global admin (câu 2 "A"): nhóm "claude subscription pool" → `source_name: sub-claude`; nhóm "codex subscription pool" → `sub-openai`; `source_agents: [omp, hermes, openclaw]`. Nguồn bật vì hai pool đang bật (câu 3 "B"). Không đổi `agents`, `enabled`, `mode` của hai nhóm. Nhóm API key (ví dụ `api-deepseek`) chỉ tạo khi bạn đưa key qua kênh an toàn (không dán vào chat/lịch sử shell).
4. Đọc lại: `groups/list` có trường nguồn và `source_models` đã lấy; `agents`, `enabled`, `mode` của mọi nhóm giống hiện trạng, trừ nhóm default có thêm `omp` và không còn `pi`; `subscription-pool/status` giống hiện trạng; `GET /omp/default/v1/models` có mục `sub-*`.

## Kiểm tra trên prod

| Ca | Cách | Kỳ vọng |
|---|---|---|
| omp + `sub-claude/<model>` | `omp -p` qua `/omp/default` | 200; Langfuse: `agent_source=omp`, `model_source=sub-claude`, `upstream_model` đúng, tài khoản provider `claude` |
| omp + `sub-openai/gpt-6-astra` | `omp -p` định dạng responses | 200; tài khoản `codex` |
| hermes, openclaw | một prompt mỗi nguồn | 200; nhãn đúng |
| Sai định dạng | gửi `sub-openai/...` tới `/v1/messages` | 400 `model_format_mismatch` |
| `/pi/<s>/v1/chat/completions` | một request | 410, `code: agent_route_moved`, `detail.new_base_url` nêu `/omp/<s>`; không có request upstream |
| claude-code, codex | một prompt mỗi bên | Như trước; Langfuse không có `model_source` |
| Log | `docker logs --since 10m agent-memory-proxy-1` | Không có lỗi mới; không có key |

## Lùi lại

1. Nhanh nhất: tắt cờ trong `compose.yaml` → `up -d --no-deps proxy`. Client nhiều nguồn quay về đường cũ; claude-code/codex không đổi.
2. Proxy: `MEMORY_BUILD_REVISION=<sha cũ> docker compose up -d --no-deps proxy`.
3. Core: deploy SHA cũ. Bảng mới ở lại, không ai đọc.
4. Dữ liệu: muốn trả `pi` cho nhóm default thì `groups/update` thêm lại (chỉ sau khi đã lùi Core và Proxy cũ, vì Core mới coi `pi` là agent lạ). Đặt `source_enabled = 0` cho mọi nhóm nguồn API (tắt ngay, không cần deploy); nguồn thuê bao không có công tắc riêng, nên dùng bước 1 (tắt cờ proxy) để ngừng chúng mà không tắt pool của claude-code/codex; và xóa nhóm chỉ làm nguồn (`agents` rỗng) qua API trước khi lùi Core. `source_name` trên nhóm pool để lại: Core và proxy cũ không đọc cột này; nếu cần trả cả DB, dừng Core, chép bản sao lưu đã kiểm tra về đúng đường dẫn, khởi động, đọc lại `groups/list` và `subscription-pool/status`.
