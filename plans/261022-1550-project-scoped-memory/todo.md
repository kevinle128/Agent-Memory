# Việc cần làm: memory theo phạm vi dự án

Kế hoạch chi tiết: [plan.md](plan.md)

- [x] Giai đoạn 0: Nghiên cứu (hook Claude Code, mẫu request phụ, bảng khả năng client, ADR 0002)
- [x] Giai đoạn 1: Request phụ không nhận memory
- [ ] Giai đoạn 2: Chế độ mặc định không inject (`profileScopeMode: deny`, `cacheVariant`)
- [ ] Giai đoạn 3: L3 toàn cục đã được lọc (prompt mới, bước kiểm tra, sao lưu và tạo lại)
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
