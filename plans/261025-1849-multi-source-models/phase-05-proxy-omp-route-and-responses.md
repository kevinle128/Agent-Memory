# Giai đoạn 5: Route `/omp`, route Responses cho omp/hermes/openclaw

## Bối cảnh

- omp hiện đi `/pi/` và được nhận ra theo User-Agent `omp/`: cổng hook `runners/openai-chat.ts:652-660` (gọi `session/pi/hook-gate.ts`), session id `session/session-key.ts:45-62` (`prompt_cache_key` khi UA `omp/`), session key `openai-chat.ts:635`.
- Route Responses chỉ có cho `/codex`, `/workbuddy`, `/proxy` (`server.ts:261-285, 410-417`). `/hermes/<s>/responses` hôm nay rơi vào catch-all `POST /*` → runner chat (`server.ts:436`).
- `AGENT_PREFIX_RE` thiếu omp/hermes/openclaw (`routes/whitelist.ts:187`); `joinUrl` rơi vào nhánh dự phòng tạo `/chat/completions` (`guard-adapter.ts`, hàm `joinUrl`).
- Codex runner gắn cứng `"codex"` 16 chỗ (grep `"codex"` trong `runners/codex.ts`), gồm `agent: "codex"` ở responses stage (1085) và `resolveForAgent(cfgs, "codex")` (380).
- Bắt gói: omp gửi `/omp/<s>/v1/messages?beta=true` (UA `claude-cli`, `x-claude-code-session-id`), `/omp/<s>/v1/responses`, `/omp/<s>/v1/chat/completions` (UA `omp/`, `prompt_cache_key`). Hermes: `/hermes/<s>/v1/messages`, `/hermes/<s>/responses`, `/hermes/<s>/chat/completions`. OpenClaw: `/openclaw/<s>/v1/messages`, `/openclaw/<s>/responses`, `/openclaw/<s>/chat/completions`.
- Pool chấp nhận nguyên request omp (Claude 200; Codex 200 với `gpt-6-astra`, `gpt-6.1-sol`).

## Thay đổi

### A. omp là agent riêng; bỏ pi (quyết định 10, câu 6 "A")

1. `agent_source` của omp là `omp` (đoạn đầu đường dẫn `/omp/<s>`).
2. Cổng hook omp chạy khi `agentSource === "omp"`, không theo UA. Hàm `resolvePiSessionId` (`session-key.ts:45-62`) đổi tên thành `resolveOmpSessionId`: đọc header rồi `prompt_cache_key`, bỏ kiểm tra UA. Bỏ nhánh UA `omp/` trên `/pi/`.
3. Đổi phần pi hiện có thành omp (đổi tên, không viết mới; header-only, không form): `agent-adapters/pi.ts` → `omp.ts` và `AGENT_SOURCES` (`agent-adapters/index.ts:27, 53`); strategy (`pipeline/strategies/agent/index.ts:45`); profile (`injection/index.ts:485`, `injection/agents/pi/` → `injection/agents/omp/`); `HEADER_ONLY_AGENTS` (`session/preset.ts:35`); cổng hook `session/pi/hook-gate.ts` → `session/omp/hook-gate.ts` (đổi cả tên hằng/hàm còn chữ pi). Sau bước này, grep `"pi"` trong `MemoryProxy/src` (trừ test và chú thích lịch sử) phải ra 0.
3b. Route `/pi/`: đăng ký `app.all("/pi/:spaceId/*")` và `app.all("/pi/*")` trước khối chung (`server.ts:383`), trả HTTP 410, không forward, không ghi L0/Langfuse, không cần user key. Body theo envelope OpenAI (omp trên `/pi/` nói chat completions): `{"error":{"type":"invalid_request_error","code":"agent_route_moved","message":"pi is not supported. Point oh-my-pi at <origin>/omp/<spaceId> (run install.sh --client omp or setup-proxy.sh --agent omp)."},"detail":{"new_base_url":"<origin>/omp/<spaceId>"}}`. `<origin>` lấy bằng `resolveProxyOrigin` sẵn có (`session/hook-gate-core.ts`). Log một dòng info mỗi request (không log key).
4. `install.sh` (`MemoryProxy/assets/client-hooks/install.sh`):
   - `--client omp`: nếu `~/.omp/agent/models.yml` có `baseUrl` chứa `/pi/<space>`, chép tệp sang `models.yml.bak-<thời gian>` trước, kiểm tra bản sao tồn tại và giống tệp gốc, rồi đổi `/pi/` → `/omp/` (chỉ đoạn đường dẫn ngay sau origin của proxy, không đụng chuỗi khác) và in ra số dòng đã đổi cùng đường dẫn bản sao. Không có `/pi/` → không sao lưu, không đổi. Hook báo về `/omp/<s>`.
   - `--client pi`: thoát với lỗi "pi không còn được hỗ trợ; dùng --client omp" (dòng 6, 1187, 1206, 1222-1235); `--uninstall --client pi` vẫn gỡ được phần mở rộng pi cũ.
   - `scripts/qa/codex-omp-hook-gate-e2e.sh` đổi sang `/omp/`; `scripts/qa/codex-pi-e2e.sh` bỏ phần pi, giữ phần Codex.
5. Câu 5 đã chọn **"A"**: cổng hook omp chạy ở cả ba định dạng. Làm thành PR riêng 5b (mục D bên dưới), sau PR 5a (mục A-C).

### B. Route

1. Đăng ký rõ cho từng agent trong `["omp", "hermes", "openclaw"]` (không dùng `/:agent/:spaceId/responses` chung, vì sẽ che `/proxy/:spaceId/responses`), đặt trước khối chung `server.ts:383`:
   - `POST /<a>/:spaceId/responses`, `/v1/responses`, `/responses/compact`, `/v1/responses/compact` → codex runner theo agent, bọc `withClientFacingModel`.
   - `POST /<a>/:spaceId/chat/completions` (không `/v1`) → `handleChatCompletions` (hôm nay đã tới runner này qua catch-all; đăng ký rõ để không phụ thuộc catch-all).
2. Thêm `omp|hermes|openclaw` vào `AGENT_PREFIX_RE`.
3. Không đổi route `/codex/*`, `/workbuddy/*`, `/proxy/*`; handler codex hiện tại vẫn không bọc mask.

### C. Codex runner theo agent

1. `runCodexPipeline` nhận agent từ đường dẫn theo danh sách cho phép (`codex` mặc định, cộng omp/hermes/openclaw). Mọi nhánh riêng codex (hook gate codex, form `request_user_input`, Default gate, nhận diện subagent codex, session-init kiểu codex `session/codebuddy/init.ts:564, 605-612`) giữ điều kiện `agent === "codex"`.
2. Gọi `stageModelSource` (giai đoạn 4) với `format: "openai-responses"` trước `applyMainModel` (`codex.ts:321`) và trước `poolServiceRejection` (`317`). Khi khớp: `body.model` = id thật, `clientFacingModel` = tên có tiền tố, truyền `presetResolution` vào `stageInstanceUpstreamResponses` (tham số tùy chọn mới, như early stage).
3. Pool `sub-openai`: nhánh `openPoolRequest` (provider mặc định `codex`) và `store:false` có sẵn (`codex.ts:1098-1115`).
4. Session ở định dạng Anthropic: `resolveConversationId` đã đọc `x-claude-code-session-id` cho mọi agent (`MemoryProxy/src/session/session-key.ts:28-42`), nên omp (giả Claude Code) có session id không cần sửa. Hermes trên `/v1/messages` không gửi header `x-*` (báo cáo bắt gói), nên session rơi về `resolveSessionKey` như hermes hôm nay; không có hồi quy, ghi lại là giới hạn đã biết.
5. Phản hồi Responses: `maskPayload` chỉ sửa `model` ở cấp đầu và `message.model` (`MemoryProxy/src/response-model-mask.ts:48-62`); sự kiện Responses (`response.created`, `response.completed`) để `model` trong `response`. Thêm nhánh `response.model` (chỉ thêm, payload chat/anthropic không có `response.model`). Test: SSE và JSON Responses trả tên có tiền tố.
6. Session cho pool: thêm `sessionId?: string` vào `PoolRequestInput`; khi có thì dùng thay `extractPoolSessionId`. Runner truyền `prompt_cache_key` cho omp/hermes/openclaw. Codex và claude-code không truyền → không đổi.

### D. PR 5b: cổng bắt cài hook của omp ở ba định dạng (câu 5 "A")

Bối cảnh:
- Cổng omp hiện có chỉ ở chat completions trên `/pi/`: `MemoryProxy/src/session/pi/hook-gate.ts:108-140`. Quy tắc hôm nay (đã bắt gói omp 18.6.3, ghi ở `hook-gate.ts:24-32`): chỉ chạy khi `stream: true` và body có cả công cụ `ask` và `bash` (`hook-gate.ts:115`); `-p`, rpc, SDK không có `ask`. Câu trả lời của cổng là một lời gọi công cụ `bash` chạy lệnh cài, tiền tố id `call_omp_hook_gate_` (`hook-gate.ts:64`). Lõi dùng chung: `session/hook-gate-core.ts` (`GateClient` có `omp`, dòng 45).
- Bắt gói (`plans/261025-1523-agent-format-upstream/reports/capture-261025-omp-and-pools.md`): ở định dạng Anthropic omp giả Claude Code (UA `claude-cli/...`, `x-app: cli`, `x-claude-code-session-id`, `metadata.user_id.session_id`, khối system "You are Claude Code…") và tên công cụ có tiền tố `_` (`_bash`, `_read`, ...; không thấy `ask`/`_ask` trong lần `-p`). Ở Responses và chat: UA `omp/18.6.3`, `prompt_cache_key`, công cụ `read`, `bash`, ... Chế độ TUI chưa bắt gói.
- Cổng của Claude Code chỉ chạy khi `agentSource === "claude-code"` (`session/claude-code/hook-gate.ts:141`), nên request Anthropic trên `/omp/` không bị cổng Claude Code bắt nhầm dù UA là `claude-cli`. Cổng Codex nằm trong codex runner, chỉ cho `agent === "codex"` (mục C.1).

Bước 0 (bắt buộc trước khi viết code): bắt gói omp TUI và `omp -p` ở cả ba định dạng qua máy chủ ghi request local (cách làm như báo cáo bắt gói), và ghi vào `reports/capture-<ngày>-omp-tui-formats.md`. Cần trả lời cho từng định dạng:
- Dấu hiệu "tương tác" (TUI) khác `-p`: có công cụ hỏi người dùng không, tên gì (`ask`, `_ask`, hay khác); `stream`; header nào khác.
- Tên công cụ chạy lệnh (`bash` hay `_bash`) và dạng tham số.
- Nguồn session id: Anthropic `x-claude-code-session-id` (đã đọc chung ở `session-key.ts:28-42`); Responses/chat `prompt_cache_key`.
- Cách lượt giả của cổng nằm trong lịch sử ở lượt sau (để xóa): `tool_use`/`tool_result` (Anthropic), `function_call`/`function_call_output` (Responses), `tool_calls`/`tool` (chat).

Thay đổi (sau bước 0):
1. Tách quy tắc nhận diện theo định dạng thành bảng trong `session/omp/hook-gate.ts` (chuyển từ `session/pi/`): mỗi định dạng có `isInteractive(body, headers)`, `shellToolName`, cách đọc session id, cách dựng câu trả lời của cổng, cách xóa lượt giả. Giá trị lấy từ báo cáo bước 0, không đoán.
2. Dựng câu trả lời theo định dạng: Anthropic → `tool_use` với tên công cụ chạy lệnh của omp (ví dụ `_bash`), SSE kiểu Anthropic; Responses → item `function_call`, SSE kiểu Responses; chat → `tool_calls` như hôm nay. Id có tiền tố `call_omp_hook_gate_` ở cả ba.
3. Gọi cổng: runner anthropic và codex (theo agent) khi `agentSource === "omp"`; runner openai-chat như hôm nay nhưng theo `omp` (mục A.2). Cổng chạy trước mọi việc lưu/forward, giống chỗ gọi của cổng Claude Code (`runners/anthropic.ts:673-694`).
4. Báo cáo hook lưu theo agent source của đường dẫn (`omp`), nên lệnh cài (`install.sh --client omp`) báo về `/omp/<s>`.
5. Không có session id hoặc không phải tương tác → cho qua (như hôm nay). Sau 2 lần thất bại trong một hội thoại → cho qua (`MAX_FAILED_ATTEMPTS`, `hook-gate-core.ts:33`).

Kiểm thử PR 5b:
- Unit cho mỗi định dạng: TUI → cổng trả lời đúng dạng; `-p` → cho qua; lượt giả bị xóa ở lượt sau; không có session id → cho qua; claude-code trên `/claude-code/` vẫn chạy cổng Claude Code, omp trên `/omp/` không chạy cổng Claude Code.
- E2E thật: omp TUI ba định dạng không có hook → nhận lệnh cài, chạy xong thì lượt sau đi model; `omp -p` ba định dạng không bị chặn. Cập nhật `scripts/qa/codex-omp-hook-gate-e2e.sh` (hoặc thêm `omp-hook-gate-formats-e2e.sh`).
- Hồi quy: `hook-gate-e2e.sh` (Claude Code), cổng Codex TUI.

## Tệp

- Sửa: `MemoryProxy/src/server.ts`, `routes/whitelist.ts`, `pipeline/runners/codex.ts`, `pipeline/runners/openai-chat.ts`, `pipeline/stages/instance-upstream-responses.ts`, `session/session-key.ts`, `session/pi/hook-gate.ts` → `session/omp/hook-gate.ts`, `session/preset.ts`, `agent-adapters/index.ts`, `agent-adapters/pi.ts` → `omp.ts`, `pipeline/strategies/agent/index.ts`, `injection/index.ts`, `injection/agents/pi/` → `injection/agents/omp/`, `subscription-pool/pool-request.ts` (chỉ thêm trường tùy chọn), `assets/client-hooks/install.sh`, `scripts/qa/codex-omp-hook-gate-e2e.sh`, `scripts/qa/codex-pi-e2e.sh`.

## Kiểm thử

- Unit: `joinUrl` cho `/omp|hermes|openclaw/<s>/{responses, v1/responses, v1/messages, v1/chat/completions, chat/completions}`; codex runner với agent `omp` không chạy nhánh riêng codex.
- `/pi/`: `POST /pi/<s>/v1/chat/completions`, `GET /pi/<s>/v1/models`, `POST /pi/<s>/v1/messages` → 410, body có `code: "agent_route_moved"` và `detail.new_base_url` đúng `<origin>/omp/<s>`; không có request upstream, không ghi L0, không gọi Core.
- `install.sh` (chạy với HOME tạm): `models.yml` có `/pi/` → có tệp `.bak-*` giống tệp gốc, tệp mới chỉ khác ở `/pi/` → `/omp/`; chạy lần hai không đổi gì và không tạo bản sao mới; tệp không có `/pi/` → không có bản sao; `--client pi` → mã thoát khác 0 và thông báo dùng omp.
- Pool: `sub-openai/gpt-6-astra` qua `/omp/<s>/v1/responses` → `chatgpt.com/backend-api/codex/responses`, `body.model = gpt-6-astra`, binding theo `prompt_cache_key`.
- E2E local: `omp -p` ba định dạng; `omp` TUI; `codex-omp-hook-gate-e2e.sh` (đã sửa); hồi quy phần Codex của `codex-pi-e2e.sh`, `hook-gate-e2e.sh`, `codex-tui-smoke.py`.

## Rủi ro và lùi lại

- Codex runner tham số hóa làm hỏng Codex: Thấp × Cao. Diff phải cho thấy mọi chỗ `"codex"` cũ hoặc giữ nguyên, hoặc nằm sau `agent === "codex"`. Chạy e2e Codex TUI trước khi merge.
- Người dùng omp cũ trên `/pi/`: nhận 410 nêu URL mới; chạy lại `install.sh --client omp` hoặc setup-proxy để đổi cấu hình (có sao lưu).
- Lùi: deploy image cũ; client omp đã chuyển `/omp/` sẽ gặp catch-all cũ → cần lùi cả cấu hình client (sao lưu `models.yml` do install.sh tạo).
