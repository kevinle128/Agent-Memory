# Việc cần làm: memory theo phạm vi dự án

Kế hoạch chi tiết: [plan.md](plan.md)

- [x] Giai đoạn 0: Nghiên cứu (hook Claude Code, mẫu request phụ, bảng khả năng client, ADR 0002)
- [x] Giai đoạn 1: Request phụ không nhận memory
- [x] Giai đoạn 2: Chế độ mặc định không inject (`profileScopeMode: deny`, `cacheVariant`)
- [x] Giai đoạn 3: L3 toàn cục đã được lọc (prompt mới, bước kiểm tra, sao lưu và tạo lại)
- [ ] Giai đoạn 4: Hạ tầng báo cáo của hook (endpoint, bảng đăng ký máy, `hook.sh`, `install.sh`)
- [ ] Giai đoạn 5: Gắn dự án khi ghi memory (L0/L1 `project_key`, L2/L3 theo dự án)
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
