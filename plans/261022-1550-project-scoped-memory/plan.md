# Kế hoạch: memory theo phạm vi dự án, mặc định không inject (Agent-Memory, nhánh `feat/server_team`)

## Bối cảnh

Session `d279bb6f…` chạy ở `/Users/dale/Movies` nhưng vẫn bị inject persona "Đang làm việc với Agent-Memory, quy trình video Shorts…" cùng danh sách scene của các dự án khác. Đã kiểm chứng ba nguyên nhân:

1. **Memory không có chiều dự án.** L2/L3 được lưu theo khóa `team|agent` (`MemoryCore/src/core/profile/profile-scope.ts`). Session không mang cwd. `identity.ts:257` chỉ đọc định dạng `Workspace Folder:` của CodeBuddy.
2. **Prompt persona `chat` yêu cầu ghi "trạng thái hiện tại"** (`persona-generation.ts:71-112`) và không cấm thông tin dự án. Prompt `team` (dòng 144-200) đã có đúng các bộ lọc cần thiết.
3. **Request phụ cũng nhận memory.** Bộ phân loại chỉ gắn nhãn `sidequery` khi request không có tool và tắt thinking (`common/cc-request-classifier.ts:56`). Injection chỉ bị bỏ qua với nhãn `sidequery` (`pipeline/runners/anthropic.ts:975`). Vì vậy request đặt tên session và request advisor vẫn bị inject.

Ngoài ra, injector dùng `cacheStrategy: "session_init"`: nội dung được tính ở bước prewarm, khi chưa có request và chưa có cwd, rồi cache theo session.

**Kết quả mong muốn:** thông tin dự án chỉ được inject khi biết chắc request đang ở dự án đó. Không biết dự án thì không inject gì liên quan đến dự án. Request phụ không nhận memory. Mỗi máy bắt buộc cài hook một lần.

### Quyết định bạn đã chốt (không đảo ngược nếu bạn chưa đồng ý)

1. Giải pháp dài hạn: đưa scope thành một chiều chính thức của memory, mặc định không inject. Không có cwd thì không inject thông tin dự án.
2. Danh tính dự án lấy từ hook phía client: git remote đã chuẩn hóa là chính, git toplevel là dự phòng. Thư mục không phải git thì không có dự án.
3. Script cài đặt tự sinh `device_id` vào `~/.agent-memory/device.json`. Hook đọc mã từ file này, không nhúng mã vào `settings.json`.
4. Mỗi máy cài một lần. Server lưu trạng thái cài đặt theo `(user, device_id)`.
5. Bắt buộc cài. Với Claude Code: hỏi "Cài ngay" hoặc "Thoát". "Cài ngay" trả về một `tool_use` Bash để cài và báo cáo ngay cho session hiện tại. "Thoát" thì chặn mọi request.
6. Client không có form: proxy cài luôn, không hỏi. Client không có công cụ shell hoặc không có hệ thống hook: bạn sẽ quyết định cách xử lý sau khi có kết quả nghiên cứu.
7. Request phụ (đặt tên session, request thử model khi chọn advisor) không nhận memory. Compact giữ là `fork`, nhận memory chỉ đọc để giữ prompt cache (bạn chọn ngày 2026-10-22; rủi ro chép memory sai được xử lý bởi chế độ mặc định không inject).

## Định nghĩa dùng chung

- **projectKey** được tính ở server (`MemoryProxy/src/workspace/project-key.ts`):
  - Có remote (ưu tiên `origin`): `git:<host>/<path>`, bỏ scheme, user, credential và đuôi `.git`, viết thường.
  - Không có remote nhưng có toplevel: `local:<device_id>:<toplevel>`.
  - Không phải git: `null`.
  - Worktree dùng chung khóa với repo chính. Thư mục con thuộc về repo chứa nó.
- **projectHash** = 16 ký tự hex đầu của `sha256(projectKey)`, dùng trong đường dẫn lưu trữ.
- **SessionWorkspace** (theo spaceId, user, agentSource, sessionId): `{deviceId, cwd, gitToplevel, gitRemote, projectKey|null, projectHash|null, projectLabel, hookVersion, reportedAt, gate}`.

## Các giai đoạn

Thứ tự được sắp để lớp bảo vệ mặc định không inject có hiệu lực trước tiên. Mỗi giai đoạn là một PR riêng, có cờ cấu hình để tắt khi cần lùi lại.

### Giai đoạn 0: Nghiên cứu (chưa viết mã sản phẩm)

- Kiểm tra hook của Claude Code trên máy thật:
  - `SessionStart` và `UserPromptSubmit` có chạy trong chế độ `-p` không;
  - hook có thừa hưởng `ANTHROPIC_BASE_URL` và token không;
  - báo cáo của `SessionStart` có đến trước request chính đầu tiên không;
  - hook mới cài có hiệu lực ngay trong session đang chạy không;
  - `session_id` thay đổi thế nào khi resume, fork hoặc clear.
- Lưu mẫu request đã che thông tin nhạy cảm cho từng loại: đặt tên session, advisor, compact thủ công và tự động, fork, subagent, request chính.
- Lập bảng khả năng của từng client (claude-code, codebuddy, codex, workbuddy, dsh, opencode, pi, hermes, openclaw): có form không, có công cụ shell không, có hook không. Chia thành ba nhóm:
  - **A:** có form và có hook;
  - **B:** không có form nhưng có shell và hook, sẽ được cài tự động;
  - **C:** không có shell hoặc không có hook, bạn quyết định cách xử lý.
- Kết quả: `docs/adr/0002-project-scoped-memory.md` và các mẫu request.

### Giai đoạn 1: Request phụ không nhận memory

- `common/cc-request-classifier.ts`: thêm `detectCcSideRequest()`, nhận diện theo dấu hiệu lấy từ các mẫu request (system prompt đặt tên session; request thử model `max_tokens <= 1` không tool). Nếu khớp thì trả về `sidequery`. Compact không đổi (vẫn là `fork`). Lùi lại bằng cờ có sẵn `ccRequestRouting.enabled`.
- `anthropic.ts` không đổi logic, vì việc bỏ qua session-init, injection và L0 đã dựa trên nhãn `sidequery`.
- Test: mẫu request đặt tên session và request thử model được xếp `sidequery`; fork vẫn là fork; request chính vẫn là main.

### Giai đoạn 2: Bật chế độ mặc định không inject cho injector

- `injection/types.ts`, `pipeline.ts`, `prewarm.ts`: thêm `cacheVariant`, để khóa cache có dạng `hookId::variant`. Như vậy các khối cũ đã cache sẽ không còn được dùng, kể cả ở session đang chạy.
- `tdai-profile-memory-injector.ts`: thêm cấu hình `profileScopeMode: legacy|deny|scoped`, mặc định `deny`. Ở chế độ `deny`:
  - chỉ inject L3 nếu `persona.md` có dấu `<!-- agent-memory:scope=user-global v1 -->`;
  - không inject danh sách L2;
  - vẫn giữ hướng dẫn dùng tool.
- Ghi metadata lên span Langfuse: `projectKeyHash`, `workspaceSource`, `scopesInjected`, `mode`, `deniedReason`.
- **Phạm vi ảnh hưởng:** chế độ `deny` áp dụng cho mọi agent trên instance, kể cả hermes, openclaw và pi. Từ khi Giai đoạn 2 lên đến khi Giai đoạn 3 xong, memory được inject chỉ còn phần hướng dẫn dùng tool. Đây là lựa chọn có chủ đích theo nguyên tắc "inject sai còn tệ hơn không inject". Vì vậy Giai đoạn 3 được xếp ngay sau.
- Kiểm chứng: session mới ở `~/Movies` không còn chữ "Agent-Memory", "Shorts", "Remotion" hay `scene_blocks`.
- Lùi lại: `profileScopeMode: legacy`.

### Giai đoạn 3: L3 toàn cục đã được lọc

- `persona-generation.ts`: thêm `USER_GLOBAL_PERSONA_SYSTEM_PROMPT`.
  - Bỏ "trạng thái hiện tại" và danh sách việc đang làm.
  - Lấy bộ lọc từ prompt `team`: không tên dự án, không phiên bản, không đường dẫn, không việc đang làm.
  - Kết quả phải bắt đầu bằng dấu scope.
- `persona-generator.ts`: thêm tùy chọn `variant` và một bước kiểm tra cố định sau khi ghi.
  - Bước này loại kết quả chứa đường dẫn, host git, phần mở rộng file hoặc số phiên bản, và nhãn dự án khi đã có bảng đăng ký dự án từ Giai đoạn 4.
  - Nếu lỗi, thử lại một lần, rồi để file không có dấu scope (fail-closed). **Persona không qua được bước kiểm tra sẽ không được inject cho đến khi được tạo lại.** Log và metadata Langfuse ghi rõ lý do để lỗi không bị âm thầm.
- ~~Endpoint admin `POST /v3/admin/persona/regenerate`~~ Đã thay bằng trigger P2.6: persona chưa có dấu thì tự tạo lại từ tất cả scene ở lần L3 kế tiếp, áp dụng cho mọi agent. Bản cũ được sao lưu vào `.backup/persona/` trước khi ghi đè.
- Ngoài bước kiểm tra cố định, có thêm giám khảo LLM chỉ trả văn bản (nhận cả scene index) để bắt tên dự án mà regex không nhận ra. Cả hai fail-closed; không đạt thì thử lại một lần rồi ghi dấu "bị từ chối".
- Kiểm chứng: persona mới của `agt-f0bzvpye01` có dấu scope và không chứa tên các dự án.

### Giai đoạn 4: Hạ tầng báo cáo của hook (chỉ thu thập, chưa chặn)

- **Proxy** (`server.ts`):
  - `POST /:agent/:spaceId/v3/hook/report` và `POST …/v3/hook/device/register`, xác thực bằng user key `sk-mem-…`;
  - `GET /setup/hooks.sh`.
  - Thư mục mới `MemoryProxy/src/workspace/` gồm `project-key.ts` và `session-workspace-repo.ts` (memory/kv/redis, theo mẫu `db/sessionRepo.ts`).
- **MemoryCore**: thêm `/v3/meta/device/upsert|get|list` theo mẫu `user-session-default`. Bản ghi gồm `{user_id, device_id, client, os, hook_version, status, installed_at, last_seen_at}`.
- **Client:**
  - `agents/hooks/hook.sh`: đọc stdin, đọc `device.json`, chạy git, gửi bằng `curl` với timeout 1-2 giây, **không in gì ra stdout** (vì Claude Code đưa stdout của hook vào context) và luôn thoát với mã 0.
  - `agents/hooks/install.sh`: tùy chọn `--client`, `--session` và `--uninstall`. Script tạo `device.json`, sao lưu và gộp hook vào `settings.json` mà không tạo bản trùng, đăng ký máy, và báo cáo ngay khi có `--session`.
  - `agents/setup-proxy.sh` gọi lại `install.sh` để không lặp logic.
- Kiểm chứng: mở session ở `~/Movies`, ở thư mục gốc repo và ở `MemoryProxy/src`. Khóa nhận được lần lượt là `null`, `git:…/agent-memory` và `git:…/agent-memory`.

### Giai đoạn 5: Gắn dự án khi ghi memory

- **Proxy:** thêm bước `stageResolveWorkspace` trước session-init. `addConversation` gửi `project_key` khi nguồn là hook.
- **MemoryCore:**
  - L0/L1 thêm cột `project_key`, theo mẫu `task_id` (`sqlite/memory-store.ts:512`). Mongo map thêm trường. TCVDB ghi trường này nhưng không đánh index trên các collection cũ.
  - L2 được nhóm theo dự án. Wrapper mới `core/storage/project-scoped-storage.ts` đổi đường dẫn:
    - `scene_blocks/` → `scene_blocks/projects/<h>/`
    - `.metadata/` → `.metadata/projects/<h>/`
    - `persona.md` → `project_personas/<h>.md`
    
    Nhờ đó `SceneExtractor` và `PersonaGenerator` chạy cho từng dự án mà không phải sửa. `classifyPath` đã cho phép thư mục con trong `scene_blocks/` (`profile-row-backend.ts:70-79`).
  - Mở rộng `classifyPath`, `CompositeStorageBackend` và `keysForPrefix` để nhận `project_personas/`. Sửa `handleCoreCount` để chỉ đếm `persona.md`.
  - META của scene thêm trường `project` (chỉ để truy vết). Scene cũ không có trường này vẫn đọc được.
- Lùi lại: `projectScopedProfiles.enabled: false`.

### Giai đoạn 6: Đọc theo dự án

- Injector ở chế độ `scoped`:
  - luôn inject L3 toàn cục (nếu có dấu scope);
  - nếu biết `projectHash`, inject thêm L3 của dự án (`project_personas/<h>.md`) và danh sách L2 dưới `projects/<h>/`.
  - Scene cũ (ở gốc hoặc `_unscoped`) không bao giờ được liệt kê, nhưng vẫn đọc được bằng `tdai_read_scene`.
- cwd đổi giữa session thì variant đổi theo, nên request kế tiếp tự lấy đúng dự án.
- **Kiểm thử đầu-cuối:**
  1. `~/Movies` không có khối dự án.
  2. `MemoryProxy/src` nhận đúng dự án Agent-Memory.
  3. Request phụ không bị inject.

### Giai đoạn 7: Bắt buộc cài hook (Claude Code)

- `form.ts`: tách hàm `buildSyntheticAssistantSse`, giữ khối thinking rỗng và chữ ký giả để tương thích DeepSeek (`form.ts:59-85`). Thêm `buildToolUseResponse` và `buildTextResponse`. Có snapshot test để đảm bảo form cũ cho ra kết quả y hệt.
- `hook-gate.ts` chạy trước session-init, chỉ cho request `main` của Claude Code:
  - Đã có báo cáo của hook: cho qua.
  - Chưa có: trả form "Cài ngay" / "Thoát".
  - "Cài ngay": trả `tool_use` Bash `curl -fsSL <proxy>/setup/hooks.sh | bash -s -- --session <sid>`. Khi nhận được kết quả của tool, đọc lại báo cáo (chờ tối đa khoảng 3 giây). Nếu đã có thì bỏ các lượt giả khỏi hội thoại và chuyển tiếp prompt gốc.
  - "Thoát": mọi request đều nhận một câu trả lời cố định và không được chuyển lên model.
  - Claude Code luôn thêm lựa chọn "Other" để người dùng gõ tự do. Câu trả lời không nhận ra được thì hỏi lại form.
  - Nếu `body.tools` không có công cụ Bash (ví dụ chạy với `--disallowedTools Bash`), trả câu trả lời dạng text kèm lệnh cài để người dùng tự chạy.
  - Request bị chặn không ghi L0.
- Lùi lại: `hookGate.enabled: false`.

### Giai đoạn 8: Các client khác

- Nhóm B: tự động trả lệnh gọi công cụ shell của client qua adapter trong `agent-adapters/*.ts`, rồi mở chặn khi có báo cáo.
- Nhóm C: giữ chỉ inject memory toàn cục cho đến khi bạn quyết định.

## Hàm và mẫu tái sử dụng

| Mẫu | Vị trí |
|---|---|
| Form giả và cách bóc câu trả lời | `session/claude-code/form.ts`, `extractor.ts`, `cleaner.ts` |
| Nhận diện subagent | `session-trace/subagent.ts` |
| Session id | `session/session-key.ts:35` |
| Phân loại request | `agent-adapters/*`, `common/cc-request-classifier.ts` |
| Migration chỉ cộng thêm cột | mẫu `task_id` trong `sqlite/memory-store.ts` |
| Endpoint metadata | `user-session-default` trong `metadata/router/v3-meta-router.ts` |
| Bộ lọc dự án | `TEAM_MEMORY_SYSTEM_PROMPT` |
| Sửa `settings.json` bằng `jq` | `agents/setup-proxy.sh` |

## Kiểm chứng tổng thể

- Chạy Vitest trong cả MemoryProxy và MemoryCore cho từng giai đoạn.
- Chạy GitNexus `impact` trước khi sửa các symbol chính (`classifyCcRequest`, `TdaiProfileMemoryInjector`, `resolveHookBlocks`, `buildFormResponse`, `classifyPath`, `PersonaGenerator`, `SceneExtractor`…), và `detect_changes` trước mỗi commit.
- Kiểm chứng trên Langfuse với session thật ở ba nơi: `~/Movies`, gốc repo và thư mục con. Kiểm tra cả request phụ.
- Kiểm chứng việc chặn trên một máy đã gỡ hook: "Thoát" bị chặn; "Cài ngay" thì prompt gốc được trả lời; session sau không bị hỏi nữa.
- Commit theo conventional commit, có DCO sign-off, mỗi giai đoạn một PR.
- Khi bắt đầu triển khai, chép kế hoạch này vào `Agent-Memory/plans/261022-…-project-scoped-memory/` và cập nhật `tasks/todo.md`.

## Rủi ro

1. Nếu `-p` hoặc chế độ headless không chạy `SessionStart`, việc chặn sẽ làm hỏng CI. Giai đoạn 0 sẽ trả lời câu hỏi này.
2. Hook gửi báo cáo lỗi do mạng sẽ khiến người dùng bị hỏi cài lại. Cài lại không gây hại vì script chạy lại an toàn.
3. Prompt cache bị tính lại khi variant đổi.
4. LLM có thể vẫn để lọt thông tin dự án vào L3 toàn cục. Bước kiểm tra cố định và cơ chế fail-closed chặn trường hợp này.
5. Installer và hook cần `jq`, mà macOS không cài sẵn.
6. Các tool `tdai_memory_search` và `tdai_scenario_ls` vẫn trả kết quả của dự án khác khi model chủ động gọi.

## Câu hỏi còn mở (sẽ hỏi từng câu khi đến giai đoạn liên quan)

1. Các tool tra cứu memory có mặc định lọc theo dự án hiện tại cộng memory toàn cục không?
2. Agent dùng chung trong team: có chấp nhận việc mọi thành viên cùng remote dùng chung memory dự án không?
3. Scene của session không thuộc git: không bao giờ inject (mặc định của kế hoạch), hay inject khi session cũng không thuộc dự án nào?
4. Cách xử lý nhóm client C.
5. Với `-p` và chế độ headless: bỏ qua việc chặn hay vẫn chặn?
6. Có cần hỗ trợ hook trên Windows không?
7. Scene cũ: có cần công cụ gán lại vào dự án, hay để cách ly vĩnh viễn?
