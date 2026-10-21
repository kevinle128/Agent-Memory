# Chạy Agent Memory ở máy local (chế độ dev)

Database (MongoDB) chạy trong Docker Compose. Các service (Core, Knowledge, Panel, Proxy) chạy
bằng lệnh trực tiếp trên máy, không dùng Docker. Cách này cho phép sửa code và thấy kết quả ngay.

Nếu bạn muốn chạy toàn bộ stack trong Docker, xem `README.docker.md` và `compose.yaml`.

## Tổng quan cổng

| Thành phần | Thư mục | Lệnh | Cổng | Kiểm tra |
|---|---|---|---|---|
| MongoDB (atlas-local 8.3, có `$search`) | `MemoryCore/` | `docker compose ... up -d mongo-search` | 27017 | `docker ps` báo `healthy` |
| Core (gateway) | `MemoryCore/` | `node --import tsx src/gateway/server.ts` | 8420 | `curl http://127.0.0.1:8420/health` |
| Knowledge | `MemoryKnowledge/` | `npm run dev` | 8421 | `curl http://127.0.0.1:8421/health` |
| Panel server | `MemoryPanel/` | `npm run dev` | 8123 | `curl http://127.0.0.1:8123/health` |
| Panel web (Vite) | `MemoryPanel/web/` | `npm run dev -- --port 5173 --strictPort` | 5173 | mở http://localhost:5173 |
| Proxy | `MemoryProxy/` | `npm run start:config` | 8096 | `curl http://127.0.0.1:8096/health` |

Thứ tự khởi động: MongoDB, rồi Core, rồi các service còn lại. Knowledge, Panel và Proxy đều gọi Core.

## Yêu cầu

- Node.js 22.16 hoặc mới hơn (`node -v`), pnpm và npm.
- Docker Desktop đang chạy.

## Bước 0: Cài dependency (chỉ lần đầu, hoặc khi lockfile thay đổi)

```bash
cd Agent-Memory
(cd MemoryCore && pnpm install)
(cd MemoryKnowledge && pnpm install)
(cd MemoryPanel && pnpm install)
(cd MemoryPanel/web && npm install)
(cd MemoryProxy && npm install)
```

## Bước 1: File cấu hình local

Các file này đã có trên máy. Phần lớn bị gitignore và có thể chứa key. Không commit chúng.

| File | Nội dung chính | Tạo lại từ |
|---|---|---|
| `MemoryCore/tdai-gateway.yaml` | Cổng 8420, LLM (`llm.baseUrl/apiKey/model`), `storeBackend` | file có sẵn trong repo |
| `MemoryKnowledge/.env` | `PORT=8421`, `KNOWLEDGE_DATA_DIR=./data`, `LLM_MODE=proxy`, `TMC_CALLBACK_URL=http://localhost:8123` | `.env.example` |
| `MemoryPanel/.env` | `PORT=8123`, `KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421`, `KNOWLEDGE_LLM_PROXY_BASE_URL=http://127.0.0.1:8096` | `.env.example` |
| `MemoryPanel/config/metadata-instances.json` | instance `default`: `gateway_endpoint` 8420, `proxy_endpoint` 8096, `api_key` (admin key của Core) | `metadata-instances.example.json` |
| `MemoryProxy/config.yaml` | Cổng 8096, `auth.url`, `tdai.endpoint` và `skill.endpoint` trỏ về `http://127.0.0.1:8420` | `config.example.yaml` |

Panel web không cần `.env`. Vite chuyển `/api/v1` và `/health` sang `http://127.0.0.1:8123`, và `/v3`
sang `http://127.0.0.1:8420` (xem `MemoryPanel/web/vite.config.ts`). Dùng `VITE_TMC_BACKEND_URL`
hoặc `VITE_SKILL_GATEWAY_URL` để đổi các địa chỉ đó.

`api_key` trong `metadata-instances.json` và `tdai.apiKey` / `skill.serviceToken` trong
`MemoryProxy/config.yaml` phải khớp với admin key mà Core lưu trong metadata. Nếu bạn xóa dữ liệu
Mongo, bạn phải tạo lại các key đó.

## Bước 2: Khởi động MongoDB (Docker Compose)

```bash
cd Agent-Memory/MemoryCore
docker compose -f docker-compose.local-mongo.yaml \
  -f docker-compose.local-mongo.host-port.yaml up -d mongo-search
```

- Chỉ khởi động service `mongo-search`. Không khởi động service `memory`, vì Core chạy bằng lệnh ở bước 3.
- File `docker-compose.local-mongo.host-port.yaml` mở cổng 27017 ra máy host. File gốc không mở cổng này.
- Tên project Compose là `memorycore`, container là `memorycore-mongo-search-1`. Dữ liệu nằm trong
  các volume `memorycore_mongo-db`, `memorycore_mongo-configdb`, `memorycore_mongo-mongot`.
- Database: `tdai_memory` (memory) và `tdai_metadata_default` (user, team, agent, key).

Chờ đến khi container ở trạng thái `healthy` (replica set đã có primary):

```bash
docker ps --filter name=memorycore-mongo-search-1 --format '{{.Status}}'
```

## Bước 3: Khởi động Core

```bash
cd Agent-Memory/MemoryCore
STORE_MODE=mongodb \
MONGODB_ENDPOINT='mongodb://127.0.0.1:27017/?directConnection=true' \
MONGODB_DATABASE=tdai_memory \
TDAI_METADATA_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
node --import tsx src/gateway/server.ts
```

- Core đọc `./tdai-gateway.yaml` trong thư mục hiện tại. Dùng `TDAI_GATEWAY_CONFIG=<path>` để chọn file khác.
- `STORE_MODE=mongodb` ghi đè `memory.storeBackend: sqlite` trong file yaml.
- `TDAI_METADATA_MONGO_URI` đưa metadata vào Mongo. Nếu bỏ biến này, metadata dùng SQLite cục bộ
  và bạn sẽ không thấy user/team cũ.
- `directConnection=true` là bắt buộc. Nếu thiếu, driver tìm host `mongo-search` (tên trong Docker)
  và không kết nối được.

Log đúng có các dòng:

```text
[META-V3] metadata store pool ready (backend=mongodb)
[gateway] Store backend = mongodb (endpoint=mongodb://127.0.0.1:27017/?directConnection=true, database=tdai_memory)
Gateway listening on http://127.0.0.1:8420
```

Dòng `[file-logger] failed to init log file ... mkdir '/data/log/'` là bình thường khi chạy ngoài
Docker. Log vẫn in ra console.

## Bước 4: Khởi động Knowledge, Panel và Proxy

Mỗi lệnh chạy trong một terminal riêng:

```bash
cd Agent-Memory/MemoryKnowledge && npm run dev            # :8421
cd Agent-Memory/MemoryPanel && npm run dev                # :8123, tsx watch tự tải lại khi sửa code
cd Agent-Memory/MemoryPanel/web && npm run dev -- --port 5173 --strictPort   # :5173
cd Agent-Memory/MemoryProxy && npm run start:config       # :8096 (dùng npm run dev:config để tự tải lại)
```

Proxy có thể in cảnh báo `connectivity.check ... creditReport: FAIL: fetch failed`. Đây là cảnh báo
vô hại: `creditReport.url` mặc định là địa chỉ mẫu `gateway.example.com`. Chỉ cần `upstream` và
`auth` báo `ok`.

## Chạy nền tất cả bằng một lần (tùy chọn)

Lệnh này khởi động các service ở chế độ nền, ghi log và PID vào `/tmp/agent-memory-logs/`.
Chạy từ thư mục `Agent-Memory/`, sau khi MongoDB đã `healthy`:

```bash
L=/tmp/agent-memory-logs; mkdir -p $L
(cd MemoryCore && STORE_MODE=mongodb \
  MONGODB_ENDPOINT='mongodb://127.0.0.1:27017/?directConnection=true' MONGODB_DATABASE=tdai_memory \
  TDAI_METADATA_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
  nohup node --import tsx src/gateway/server.ts > $L/core.log 2>&1 & echo $! > $L/core.pid)
until curl -fsS -o /dev/null http://127.0.0.1:8420/health; do sleep 1; done
(cd MemoryKnowledge && nohup npm run dev > $L/knowledge.log 2>&1 & echo $! > $L/knowledge.pid)
(cd MemoryPanel && nohup npm run dev > $L/panel.log 2>&1 & echo $! > $L/panel.pid)
(cd MemoryPanel/web && nohup npm run dev -- --port 5173 --strictPort > $L/web.log 2>&1 & echo $! > $L/web.pid)
(cd MemoryProxy && nohup npm run start:config > $L/proxy.log 2>&1 & echo $! > $L/proxy.pid)
```

## Kiểm tra toàn bộ

```bash
for p in 8420 8421 8123 8096; do curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:$p/health; done
curl -s -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:5173/
```

Tất cả phải trả về `200`. Sau đó mở http://localhost:5173 và đăng nhập bằng user key.

## Lỗi thường gặp

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| `EADDRINUSE` trên một cổng | Một bản cũ của service vẫn đang chạy | `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Nếu tiến trình đó là service này trong chế độ watch, dùng lại nó. Nếu không, dừng nó. Không đổi sang cổng khác. |
| Core báo `STORE_MODE=mongodb requires MONGODB_ENDPOINT, MONGODB_DATABASE` | Thiếu biến môi trường | Dùng đúng lệnh ở bước 3 |
| Core không kết nối Mongo, hoặc lỗi server selection timeout | Mongo chưa `healthy`, hoặc thiếu `directConnection=true`, hoặc chưa mở cổng 27017 | Chờ `healthy`; dùng file override ở bước 2 |
| Panel báo 401 khi gọi Core | `api_key` trong `metadata-instances.json` không khớp admin key trong metadata Mongo | Sửa `api_key` cho đúng |
| Mất `$search` index sau khi tạo lại container | Volume `mongo-mongot` bị xóa | Chỉ dùng `down -v` khi bạn muốn xóa hết dữ liệu |

## Dừng

```bash
# Dừng các service chạy nền (nếu dùng lệnh chạy nền ở trên)
for f in /tmp/agent-memory-logs/*.pid; do pkill -TERM -P "$(cat $f)" 2>/dev/null; kill "$(cat $f)" 2>/dev/null; done

# Dừng MongoDB, giữ dữ liệu
cd Agent-Memory/MemoryCore
docker compose -f docker-compose.local-mongo.yaml -f docker-compose.local-mongo.host-port.yaml stop mongo-search
```

Lệnh `down -v` xóa toàn bộ dữ liệu Mongo và `$search` index. Sao lưu trước khi dùng
(ví dụ `docker exec memorycore-mongo-search-1 mongodump --archive > backup.archive`).
