# Việc cần làm: memory theo phạm vi dự án

Kế hoạch chi tiết: [plan.md](plan.md)

- [x] Giai đoạn 0: Nghiên cứu (hook Claude Code, mẫu request phụ, bảng khả năng client, ADR 0002)
- [x] Giai đoạn 1: Request phụ không nhận memory
- [x] Giai đoạn 2: Chế độ mặc định không inject (`profileScopeMode: deny`, `cacheVariant`)
- [x] Giai đoạn 3: L3 toàn cục đã được lọc (prompt mới, bước kiểm tra, sao lưu và tạo lại)
- [x] Giai đoạn 4: Hạ tầng báo cáo của hook (endpoint, bảng đăng ký máy, `hook.sh`, `install.sh`)
- [~] Giai đoạn 5: Gắn dự án khi ghi memory (L0/L1 `project_key`, L2/L3 theo dự án)
- [ ] Giai đoạn 6: Đọc theo dự án (chế độ `scoped`)
- [ ] Giai đoạn 7: Bắt buộc cài hook với Claude Code
- [ ] Giai đoạn 8: Các client khác

## Nhật ký

### 2026-10-22, Giai đoạn 0 (đang làm)
- Hook Claude Code v2.1.289 (thử với `--settings` tạm, server giả ở 127.0.0.1:18765):
  - `-p`: `SessionStart` và `UserPromptSubmit` đều chạy, cả hai trước request đầu tiên.
  - `session_id` của hook trùng header `x-claude-code-session-id`. Resume giữ nguyên id. Fork tạo id mới và có `SessionStart` với nguồn `fork`.
  - Hook nhận được `ANTHROPIC_BASE_URL` và token từ `env` trong settings. `cwd` là đường dẫn thật (ví dụ `/private/tmp/...`).
- Bộ phân loại hiện tại với body thật: đặt tên session → `sidequery`; request chính → `main`; compact → `fork` (sai, vẫn inject); thử model advisor → `main` (sai, vẫn inject).
- Dấu hiệu nhận diện:
  - compact: tin nhắn cuối chứa "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block."
  - thử model advisor: `max_tokens: 1`, không có tool, một tin nhắn.
  - đặt tên session: system chứa "You are naming a coding session".
- Chưa rõ: vì sao request đặt tên session vẫn bị inject ở production dù bộ phân loại xếp `sidequery`. Sẽ kiểm chứng bằng MemoryProxy chạy local.
- Chưa kiểm chứng: hook mới cài có hiệu lực ngay trong session đang chạy (tài liệu nói có); môi trường của Bash tool.
- Dựng MemoryProxy local để phát lại body: dừng ở Giai đoạn 0. Proxy chọn upstream Anthropic theo danh mục model (`anthropicUpstream` trong `config.ts:257-291`), nên cần thêm một mục model trỏ sang server giả trong metadata local. Việc này để sang Giai đoạn 1, cùng với test đầu-cuối.
- ADR: `docs/adr/0002-project-scoped-memory.md`. Bảng khả năng client: `research-client-capabilities.md`.

### 2026-10-22, Giai đoạn 1 (đang làm)
- `cc-request-classifier.ts`: thêm `detectCcSideRequest()` (đặt tên session, thử model `max_tokens <= 1` không tool), chạy trước logic cache marker. GitNexus impact: LOW, một nơi gọi.
- Test mới `src/common/__tests__/cc-request-classifier.test.ts`: 11/11 qua. Toàn bộ MemoryProxy: 238/238 qua. `tsc --noEmit` sạch.
- Body thật: thử advisor giờ là `sidequery`. Compact vẫn là `fork`, đang chờ bạn quyết định.
- Khác với kế hoạch: không thêm cờ `ccRouting.sideRequestMarkers`. Cờ `ccRequestRouting.enabled` có sẵn đã đủ để tắt toàn bộ việc phân loại khi cần lùi lại.
- Quyết định (bạn chọn A, 2026-10-22): compact giữ `fork`, nhận memory chỉ đọc, giữ prompt cache. Đã cập nhật plan.md và ADR 0002.
- Giai đoạn 1 xong. Còn mở: vì sao request đặt tên session bị inject ở production. Sẽ kiểm chứng bằng test đầu-cuối ở local.

### 2026-10-22, Giai đoạn 2 (xong phần mã và test đơn vị; còn test đầu-cuối)
- `injection/types.ts`: thêm `InjectionHook.cacheVariant` và `hookCacheId()`. `pipeline.ts` (đọc, ghi, hybrid) và `prewarm.ts` (ghi) dùng `hookCacheId`. GitNexus impact: LOW cho `resolveHookBlocks`, `prewarmAll`, `TdaiProfileMemoryInjector`.
- Cấu hình `tdai.memory.profileScopeMode`: mặc định `deny`; chỉ giá trị `legacy` viết đúng mới bật lại hành vi cũ. Đã ghi vào `config.example.yaml`.
- Injector ở chế độ `deny`: chỉ inject L3 có dấu `<!-- agent-memory:scope=user-global v1 -->` (bỏ dấu trước khi inject), không gọi `listL2ForCtx`, dùng hướng dẫn tool không nhắc tới L2. Cache variant `deny:v2`. Chế độ `legacy` giữ nguyên cache id và nội dung cũ.
- Observer chép `scope` (mode, scopesInjected, deniedReason) lên span Langfuse.
- Test mới: `pipeline-cache-variant.test.ts` (7), `tdai-profile-memory-injector.test.ts` (6), `config-profile-scope-mode.test.ts` (3). Toàn bộ MemoryProxy: 254 test qua. `tsc --noEmit` sạch.
- Còn lại: test đầu-cuối với MemoryProxy chạy local (session ở `~/Movies` không có thông tin dự án).
- Lưu ý khi deploy: nếu deploy Giai đoạn 2 một mình, mọi agent chỉ còn nhận hướng dẫn tool cho đến khi Giai đoạn 3 xong. Nên deploy Giai đoạn 2 và 3 cùng lúc.

### 2026-10-22, deploy Giai đoạn 1 và 2 lên server (bạn yêu cầu)
- Commit trên `feat/server_team` (đã push): `1537b894` (bộ phân loại), `f72261c9` (chế độ deny), `8fe85671` (tài liệu), `e7cda9f5` (đổi tên trường `scope` thành `memoryScope` trên span), `6e1b4be6` (văn bản hướng dẫn tool theo chế độ scope).
- Deploy proxy: `agent-memory/proxy:6e1b4be`, healthy, không có lỗi trong log.
- Hai lỗi chỉ lộ ra khi chạy trên server, đã sửa: (1) Langfuse SDK ghi đè trường `scope`; (2) hướng dẫn của `tdai-memory-tools-injector` vẫn nói L2 đã được inject.
- Tái hiện ở `/Users/dale/Movies` (session `7be12f40`, `93c182c8`, `2ae71542`): không có khối persona, không có danh sách scene, không có "Agent-Memory" hay "Shorts". Request thử advisor và request đặt tên session không bị inject. Span ghi `memoryScope: {"mode":"deny","scopesInjected":[],"deniedReason":"no-user-global-l3"}`. Agent trả lời rằng nó gần như không biết gì về công việc hiện tại.
- Các session khác trên instance (video-sentences, english-translate, một máy Windows) cũng ở chế độ deny: không có persona cho đến khi Giai đoạn 3 xong.
- Lùi lại: thêm `tdai.memory.profileScopeMode: legacy` vào `/data/config.yaml` của proxy, hoặc chạy image cũ `8227558`.

### 2026-10-22, Giai đoạn 3 (đã deploy, đang chờ L3 chạy thật)
- `MemoryCore/src/core/persona/user-global-scope.ts`: dấu "đã duyệt" và "bị từ chối", bước kiểm tra cố định, và giám khảo LLM chỉ trả văn bản (nhận cả scene index). Cả hai đều fail-closed.
- `persona-generator.ts`: persona không có dấu "đã duyệt" được viết lại từ tất cả scene và không cho model thấy bản cũ; kiểm tra scope, thử lại một lần kèm danh sách cần xóa, rồi ghi dấu. Code tự ghi dấu, model không bao giờ ghi. Sao lưu `.backup/persona/` ở chế độ storage.
- `persona-trigger.ts`: P2.6, persona không có dấu thì tạo lại ngay. Persona bị từ chối thì đợi ngưỡng thường, nên không lặp vô hạn.
- Prompt: bỏ "trạng thái hiện tại"; thêm mục scope dùng chung cho cả prompt chat và team; tag chữ thường, không backtick.
- `createL3Runner` nhận thêm `scopeJudgeRunner` (chỉ trả văn bản); credit của giám khảo được cộng vào credit L3.
- Khác với kế hoạch (theo đề xuất của advisor, không đụng quyết định của bạn): dùng thêm giám khảo LLM ngoài regex, vì regex không bắt được tên như "Remotion" hay "Udemy". Không làm endpoint admin regenerate; thay bằng trigger P2.6, nên mọi agent tự được chuyển ở lần L3 kế tiếp.
- Test: MemoryCore 432/432 (38 test mới), MemoryProxy 260/260 (có test chuỗi dấu giống nhau giữa hai package). Kiểm tra kiểu: 51 lỗi có sẵn, trước và sau như nhau.
- GitNexus: CRITICAL cho `PersonaGenerator`, `shouldGenerate`, `createL3Runner` (đường tạo L3 của mọi agent); `detect_changes` mức high, đúng phạm vi.
- Sao lưu trước deploy: `~/backups/agent-memory-core-data-20261022-172614-before-user-global-persona.tgz` trên server (41 MB, có 3 persona.md).
- Deploy: `agent-memory/core:8abc164`, healthy. Lùi lại: chạy image `929b07e` và khôi phục persona từ file nén hoặc `.backup/persona/`.
- Kết quả thật trên server (2026-10-22 17:32-17:34):
  - L3 của `agt-f0bzvpye01` chạy với trigger P2.6, chế độ `first`, đọc 6 scene; persona mới qua kiểm tra scope ngay lần đầu; ghi 4.713 ký tự trong 64 giây.
  - Persona mới bắt đầu bằng dấu "đã duyệt"; thân persona không có tên dự án (Agent-Memory, Shorts, Remotion, Udemy, YouTube, Fluently...). Tên dự án chỉ còn trong mục Scene Navigation, mà proxy cắt bỏ.
  - Bản sao lưu persona cũ: `.backup/persona/2026-10-22T10-32-03-747Z-offset0.md` (6.381 byte) trong thư mục profile của agent.
  - Lần L3 kế tiếp: "No trigger conditions met", không tạo lại lặp vòng.
  - Session ở `~/Movies` (`bca91533`): khối persona chỉ có L3 toàn cục, không có L2, không lộ dấu, không có tên dự án. Span ghi `memoryScope: {"mode":"deny","scopesInjected":["global-l3"],"deniedAgentCount":0}`. Agent trả lời rằng nó không biết bạn đang làm gì.
- Hai agent còn lại (`agt-i8ntpqq1fp`, `agt-i7922llw41`) sẽ tự chuyển ở lần dùng kế tiếp.

### 2026-10-22, Giai đoạn 4 (đang làm)
- Proxy (tôi làm):
  - `src/project-scope/project-key.ts`: `normalizeRemote`, `buildProjectIdentity` (`git:<host>/<path>`, rồi `local:<device>:<toplevel>`, rồi null), `projectHash` (16 hex).
  - `src/project-scope/session-workspace.ts`: lưu `workspace.json` cạnh `inj-sess.json` trong `ttl/<space>/<user>/<agent>/<session>/` qua `ProxyStorage` (production: sqlite). Không bật storage thì dùng `MemoryStorage`.
  - `src/routes/hook-report.ts`: `POST /:agent/:spaceId/v3/hook/report`, xác thực bằng `stageAuth` (giống route model), trả 204; cập nhật bản ghi máy ở Core, mỗi máy tối đa một lần mỗi 10 phút (lần `Install` luôn cập nhật).
  - `src/routes/setup-scripts.ts`: `GET /setup/hooks.sh` và `GET /setup/hook.sh`, đọc từ `assets/client-hooks/`.
  - `meta/client.ts`: `upsertDeviceSetup`, `listDeviceSetups`.
  - Test: `project-key.test.ts` (18), `hook-report.test.ts` (17).
- Khác với kế hoạch: gộp `device/register` vào `hook/report`, vì báo cáo đã mang đủ thông tin máy.
- Subagent: bảng đăng ký máy ở Core (`/v3/meta/device/upsert|list`); script `hook.sh`, `install.sh` và thay đổi trong `setup-proxy.sh`.
- Test local (proxy chạy ở 127.0.0.1:18096, HOME tạm, Claude Code thật): cài lần hai không tạo hook trùng; `permissions` sẵn có giữ nguyên; `device.json` có quyền 0600. `~/Movies` cho `project=none`; gốc repo và `MemoryProxy/src` cùng cho `github.com/kevinle128/agent-memory` (hash `db73c988534bc1c8`). Báo cáo đến trước request model; log không có token.
- Lỗi khi commit, đã sửa trước khi push: mẫu `workspace/` trong `.gitignore` gốc chặn `src/workspace/`, và `git add` vẫn stage các file khác, nên một commit bị gộp và thiếu file. Đã đổi tên thư mục thành `src/project-scope/` và tách lại commit.
- Deploy (sao lưu trước: `~/backups/agent-memory-core-data-20261022-181257-before-device-registry.tgz`): core và proxy cùng ở `5a3c698`, đều healthy.
- Test trên server (HOME tạm, token thật, proxy production): cài từ `/setup/hooks.sh` thành công; ba thư mục cho kết quả giống hệt bản local; bảng `meta_device_setups` trong Core có một bản ghi (`darwin`, `arm64`, hook phiên bản 1); `proxy_kv` có `workspace.json` cho từng session; không có lần cập nhật máy nào thất bại. Bản ghi máy `93895e8b…` là dữ liệu test.
- Phát hiện riêng (không do thay đổi này): Core lặp lỗi `[skill-worker-pool] standalone SkillExtractor unavailable` khoảng 300 lần mỗi giây, CPU khoảng 79%. Diff hôm nay không chạm phần tạo skill extractor. Cần bạn quyết định có điều tra hay không.

### 2026-10-23, sửa lỗi skill worker (ngoài kế hoạch)
- Core lặp lỗi `standalone SkillExtractor unavailable` khoảng 34.000 lần mỗi phút, CPU 108%. Nguyên nhân: `core.yaml` thiếu `skill.extraction.enabled`, cộng ba lỗ hổng trong mã. Báo cáo: `plans/reports/debugger-261023-1345-skill-worker-hot-loop.md`.
- Sửa: không chạy pool và trả `skipped` khi phần trích xuất tắt (`68413711`); bật trích xuất trong cấu hình theo lựa chọn A của bạn (`63ce17a2`); log tranh khóa chuyển sang debug theo lựa chọn C của bạn (`dc71f524`). Sau deploy: 0 lỗi, CPU 3–20%.
- Sơ suất: lần deploy Core lúc 14:23 kéo cả PR #3 (reset-credits, có `ALTER TABLE … ADD COLUMN`) mà chưa sao lưu ngay trước đó. Đã sao lưu sau: `~/backups/agent-memory-core-data-20261023-142448-after-reset-credits-merge.tgz`.

### 2026-10-23, Giai đoạn 5a (đang làm)
- Cách lưu đã chốt: tiền tố đường dẫn trong scope `team|agent`, không dùng scope có dự án. Lý do: `ProfileFilter` không có chiều dự án (advisor xác nhận, đúng ADR 0002).
- Proxy: `TdaiIdentity.projectKey/projectHash`; `withSessionProject()` tra `SessionWorkspace` theo `sessionKey`; nối vào runner anthropic, runner openai-chat và lệnh `mem:`; `addConversation` gửi `project_key`/`project_hash` chỉ khi có cả hai. Test: `session-project.test.ts` (8). Proxy 356/356, `tsc` sạch.
- Core (subagent): cột hoặc trường `project_key`/`project_hash` cho L0 và L1 trên sqlite, tcvdb và mongo; L1 lấy dự án từ các tin nguồn chỉ khi tất cả cùng một dự án.
- Core (subagent): `resolveIsolation` lấy cặp `project_key`/`project_hash` từ một nguồn duy nhất (body, nếu không có thì header), cặp thiếu hoặc hash sai thì bỏ qua; cột sqlite và `ALTER`, index `project_hash`; mongo và tcvdb map trường (tcvdb chỉ đánh index cho collection mới); L1 lấy dự án qua `l1-project.ts` khi tất cả tin nguồn cùng một dự án. FTS chưa mang dự án (cần dựng lại bảng; chưa cần). Core 545/545.
- Test local: L0 có dự án được lưu đúng; không có dự án thì rỗng; hash sai thì rỗng và request vẫn thành công.
- Commit `5aab6c0d` (`promptMode: code`) do phiên khác tạo; bạn chọn A, deploy cùng. Server đã chạy nó từ trước.
- Deploy (sao lưu trước: `~/backups/agent-memory-core-data-20261023-153439-before-project-columns.tgz`): core và proxy ở `1ae3aea`, 0 lỗi; hai bảng L0 và L1 đã có hai cột mới.
- Test trên server (HOME tạm, token thật): session ở repo cho L0 có `git:github.com/kevinle128/agent-memory`/`db73c988534bc1c8`; session ở `~/Movies` cho L0 rỗng. Việc L1 nhận dự án sẽ được kiểm khi L1 chạy.

### 2026-10-23, Giai đoạn 5b (đã deploy)
- Subagent: `core/storage/project-scoped-storage.ts` và `project-paths.ts` (lớp bọc đổi đường dẫn theo dự án, view hợp scene của mọi dự án); runner L2 nhóm theo `(scope, projectHash)`; persona toàn cục đọc hợp scene, trigger tính cả scene dự án; checkpoint gốc được cộng sau mỗi lần chạy của dự án; rowfs nhận `project_personas/<H>.md`; `/core/count` chỉ đếm `persona.md`; profile sync tách hàng của dự án khỏi hàng gốc (subagent phát hiện thêm lỗi ghi đè persona dự án lên gốc và đã sửa).
- Tôi bổ sung: các route `scenario/ls|count|read` ở gốc ẩn `projects/`; hash không hợp lệ quay về nhóm gốc.
- Review độc lập kết luận SHIP_WITH_FIXES. Đã sửa: chặn cách vượt bằng `./projects` (chuẩn hóa phần `.` và phần rỗng, không phân biệt hoa thường), chặn `write`/`rm` vào `projects/`, giới hạn 80.000 ký tự scene trong một prompt persona (phần thừa chỉ liệt kê tóm tắt).
- Test: Core 602/602. HTTP local: `ls`/`count`/`read` ở gốc không thấy scene dự án; `./projects`, `Projects`, `/projects` đều bị chặn; `write`/`rm` trả 404; file dự án còn nguyên.
- Để sau (theo review): tool file của L3 nên chỉ đọc với `scene_blocks/`; tín hiệu cập nhật persona của dự án chưa đẩy lên gốc; trên rowfs checkpoint có thể trùng giữa các team (lỗi sẵn có).
- Deploy (sao lưu trước: `~/backups/agent-memory-core-data-20261023-162947-before-project-scenes.tgz`): core `75b7501`, 0 lỗi.
- Production: L0 có 2 dòng mang dự án (từ session thử), L1 chưa có, nên chưa có scene dự án. Cần lưu lượng thật từ máy đã cài hook để kiểm chứng.
- 2026-10-23 16:55: cài hook trên máy thật của bạn (bạn chọn A). Bộ cài thêm đúng một nhóm vào `SessionStart` và một nhóm vào `UserPromptSubmit`; phần còn lại của `settings.json` giữ nguyên (đã so dấu vân tay); có bản sao lưu `~/.claude/settings.json.agent-memory-backup-20261023T095514Z`. Máy `23484a13…` đã có trong bảng đăng ký. Session thật trong repo: hook báo `github.com/kevinle128/agent-memory`, L0 mang `db73c988534bc1c8`. Bảng còn hai bản ghi máy test: `93895e8b…`, `5b6b9331…`.
- 2026-10-23 17:50: 5b đã được kiểm chứng trên production. Agent `agt-f0bzvpye01` có scene của 3 dự án (`db73c988…` là Agent-Memory, `79c7a6c2…`, `95383b78…`); mỗi dự án chỉ thấy scene của chính nó.

### 2026-10-23, Giai đoạn 5c (đã deploy)
- Subagent: runner L3 tạo `project_personas/<H>.md` cho từng dự án sau lượt persona toàn cục, chỉ từ scene của dự án đó, với trigger và checkpoint riêng. Biến thể `project`: prompt `PROJECT_MEMORY_SYSTEM_PROMPT`, không gọi giám khảo scope, bỏ mọi dấu scope, không phụ thuộc `promptMode`. Trigger của dự án không dùng quy tắc tạo lại persona chưa có dấu.
- API đọc nhận `project_hash` (16 ký tự hex thường): `core/read`, `scenario/ls|read|count`. Không có hash thì như cũ. `write`/`rm` vẫn từ chối đường dẫn dự án. Client proxy (`readL3ForCtx`, `listL2ForCtx`, `readL2ForCtx`) gửi `project_hash` chỉ khi có.
- Review độc lập: không có lỗi CRITICAL hay HIGH; 8 điều kiện cách ly đều đạt. Đã sửa: persona toàn cục lỗi thì báo lỗi ngay, không chạy các dự án (tránh thất thoát credit); abort sau khi sinh thì không đẩy checkpoint; dấu scope nằm chung dòng cũng bị bỏ; `path`/`path_prefix` là `.` không còn gây 500; log provenance của dự án ghi `variant: "project"`.
- Để sau: mỗi task L3 duyệt mọi dự án (chi phí đọc tăng theo số dự án); `memoryPrompt` tùy chỉnh của team cũng nối vào prompt dự án (cần bạn quyết định); dự án không dùng cổng JEV.
- Test: Core 667/667, Proxy 365/365, tsc sạch. HTTP local: không hash thì chỉ thấy gốc; có hash thì chỉ thấy đúng dự án, đường dẫn tương đối; hash viết hoa, `../`, `projects/<khác>/` đều bị chặn hoặc trả rỗng.
- Commit `d5cb4423` (core), `29870e68` (proxy). Deploy (sao lưu trước: `~/backups/agent-memory-core-data-20261023-104457-before-project-personas.tgz`, tên theo giờ UTC): core `29870e6`, 0 lỗi mới. Proxy chưa deploy (chưa có nơi gọi tham số mới; sẽ deploy cùng Giai đoạn 6).
- Production: gọi không hash trả persona toàn cục có dấu như cũ; có hash trả đúng scene của từng dự án; hash sai trả 400.
- 2026-10-23 17:59: task L3 đầu tiên sau deploy tạo persona cho cả 4 dự án của `agt-f0bzvpye01` (cold start), mỗi file khoảng 1.500 ký tự, chỉ chứa nội dung của dự án đó, không có dấu scope. Persona toàn cục được tạo lại lúc 17:58, vẫn có dấu "đã duyệt". Lưu ý chất lượng: persona của Agent-Memory lấy nhiều câu từ prompt giao việc cho subagent (ví dụ "không sửa, không commit"), ghi thành quy ước của dự án.
