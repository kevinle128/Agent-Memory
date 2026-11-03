---
title: "Account Switch: System Admin xem và đổi Subscription Account của cuộc hội thoại hiện tại"
description: "Proxy chèn khối <subscription_tools> cho System Admin dùng pool; LLM gọi /subscription-bridge để xem hoặc đổi tài khoản trong Session Binding của cuộc hội thoại; có lối tắt /sub (Claude Code) và lệnh tương đương cho Codex."
status: pending
priority: P2
effort: 25h
branch: feat/server_team
tags: [proxy, core, subscription-pool, injection, installer, claude-code, codex]
blockedBy: []
blocks: []
created: 2026-11-03
---

# Account Switch

Trạng thái: chờ duyệt. Không có ADR. Thuật ngữ **Account Switch** đã có trong `CONTEXT.md:36-38`.

## Kết quả mong muốn

- System Admin (Core `user_type: "system_admin"`) đang dùng Claude Code hoặc Codex qua Subscription Pool hỏi bằng lời thường (hoặc gõ lối tắt) thì LLM trả lời: tài khoản nào (email, tên hiển thị) và provider nào đang phục vụ cuộc hội thoại này.
- System Admin yêu cầu "chuyển sang `<email>`" thì Session Binding của **chính cuộc hội thoại này** trỏ sang tài khoản đó. Sau đó binding chạy như thường: pool vẫn tự chuyển khi tài khoản hết quota.
- Người không phải System Admin không thấy khối công cụ, và bridge từ chối nếu họ gọi thẳng.
- Lệnh và câu trả lời đi qua LLM và được ghi nhớ như mọi lượt khác. Không lọc ở đâu cả.

## Quyết định đã chốt (người dùng; không đổi)

1. Chỉ System Admin (`user_type: "system_admin"`). Quyền quyết định ở **một** hàm `canUseAccountSwitch`, dùng chung cho injector và bridge. Không có tính năng cấp quyền, allowlist hay UI.
2. Dùng lại mẫu inject + bridge: khối `<subscription_tools>` như `tdai-tools-injector.ts:68-83` và `skill-tools-injector.ts:59-72`; endpoint `/subscription-bridge/...` như `skill-bridge.ts` (khóa phiên theo `x-conversation-id`, bearer không bao giờ lộ cho LLM).
3. Khối chỉ chèn cho phiên System Admin và chỉ cho client do pool phục vụ: Claude Code (provider `claude`) và Codex (provider `codex`).
4. Xem: email (`account_label`/`display_name`) và provider của tài khoản trong Session Binding. Chưa có binding thì báo "chưa gắn tài khoản". Codex đang dùng login riêng thì báo "đang dùng login của bạn, không qua pool".
5. Đổi: chỉ binding của cuộc hội thoại này; chưa có thì tạo. Từ chối có lý do khi tài khoản không thuộc pool của provider đó, bị tắt, Exhausted (kèm giờ reset), hoặc trên Threshold. Dùng lại luật trong `selector.ts` và `account-cache.ts`.
6. Lối tắt `/sub` và `/sub <email>` do bộ cài hook sẵn có cài (`MemoryProxy/assets/client-hooks/install.sh`). File lệnh chỉ chuyển yêu cầu cho LLM.
7. Câu trả lời do LLM viết từ JSON của bridge. Bridge trả mã lý do và thông điệp tiếng Anh rõ ràng.

## Quyết định thiết kế của kế hoạch này (đã kiểm tra trong code)

| Quyết định | Căn cứ |
|---|---|
| Khóa binding mà bridge tính: `sessionBindingKey(spaceId, provider, "session:" + x-conversation-id)`. Tách hàm `poolSessionKey(id)` dùng chung với `PoolRequestImpl`. | `pool-request.ts:157-158`, `binding-store.ts:29-32` |
| Claude Code: định danh phiên đọc `x-claude-code-session-id`; pool cũng đọc header này. Codex: cả hai đọc `x-parent-conversation-id` rồi `session-id`. Giai đoạn 1 kiểm tra bằng máy. | `session-key.ts:28-42`, `codex.ts:181-192`, `pool-request.ts:89-96`, `session/codex/hook-gate.ts:37-40` |
| spaceId của khóa binding lấy từ phiên đã tìm thấy (`sessionInfo.space_id`), không lấy từ config. Header `x-tdai-service-id` khác phiên thì từ chối. | `memory-bridge.ts:371-374` (chuỗi fallback cũ, không dùng lại), `session/store.ts:633` |
| Hai "binding" khác nhau: `db/binding-repo.ts` là binding định danh phiên (user/team/agent, dùng cho bridge tìm người gọi). `subscription-pool/binding-store.ts` là Session Binding của pool (ProxyStorage, `nottl/<space>/pool-binding/<provider>/<digest>`). Account Switch ghi vào cái thứ hai. | `binding-repo.ts:23-48`, `binding-store.ts:16-32` |
| Provider của phiên lấy từ tiền tố khóa L1 `claude-code:` / `codex:` hoặc `agentSource` của binding L2. Không có giá trị rõ ràng thì từ chối `not_pool_session`. Không dùng mặc định `"claude-code"` như hai bridge cũ. | `codebuddy/init.ts:553` (codex dùng `${agentSource}:${sessionKey}`), `memory-bridge.ts:130-152`, `skill-bridge.ts:282-302` |
| "Do pool phục vụ" = `resolveForAgent(getInstanceUpstreamConfigs(space), agent).kind === "pool"`; lọc tài khoản theo `group_id` của dòng đó và provider, giống runner. | `instance-upstream-cache.ts:220-244`, `pool-request.ts:327-335` |
| Vai trò lấy từ Core `/v3/internal/meta/user/list-by-instance` (`user_ids: [id]`), đã có, dùng service token. Không cần endpoint Core mới. | `internal-meta-router.ts:91-101`, `v3-meta-schemas.ts:413-418` |
| Core phải thêm `display_name`, `account_label` vào danh sách tài khoản gửi Proxy (endpoint nội bộ đã gửi `access_token`, nên không lộ thêm). Thay đổi cộng thêm, không đổi schema DB. | `metadata-service.ts:2384-2397`, `types.ts:905-914, 952-963` |
| Email khớp: từ đầu tiên của `account_label` có chứa `@`, không phân biệt hoa thường, trong nhóm và provider của phiên. Hai tài khoản khớp thì `account_ambiguous`. | `providers/codex.ts:49`, `providers/claude.ts:148-150` |
| Threshold khi đổi chỉ xét Quota Window dùng chung (`accountUsagePct(account, now, "")`), vì bridge không biết model. Cửa sổ theo model do pool xử lý ở request kế tiếp. | `selector.ts:33-47` |
| Luật từ chối nằm trong `selector.ts` (hàm mới `accountSwitchRejection` dùng `isServable`, `isExhausted`, `accountUsagePct`, `earliestReset`). | `selector.ts:41-67, 118-140` |
| Sổ sách khi đổi: như `persist()` khi binding đổi: chỉ báo `active_sessions` cho tài khoản mới và cũ. Không báo usage. Tách `reportSessionCounts` thành hàm cấp module để dùng chung. | `pool-request.ts:400-420` |
| Trạng thái "login riêng" của Codex chưa được lưu. Ghi một dấu trong bộ nhớ Proxy theo khóa binding, chỉ ở lượt chính (`bindSession: true`); xóa khi lượt chính được tài khoản pool phục vụ hoặc khi Account Switch. Mất khi Proxy khởi động lại; lượt kế tiếp ghi lại. | `pool-request.ts:151-156, 468-472` |
| Injector dùng `cacheStrategy: "session_init"` như hai khối anh em. Phiên cũ (trước deploy) nhận khối ở lượt chính kế tiếp nhờ self-heal khi cache trượt. | `injection/pipeline.ts:285-318` |
| Codex không còn custom prompt `/…` từ 0.117 (đã bỏ). Lối tắt Codex là skill người dùng gọi bằng `$sub <email>`. Giai đoạn 1 xác nhận thư mục và cách nhận tham số. | Đã chốt: `$sub` |
| Bridge mới không gửi `emitBridgeRejectTelemetry` (kiểu `bridgeSource` là union đóng). Chỉ ghi log `account_id`, không ghi email. Cố ý. | `bridge-telemetry.ts:104`, `pool-request.ts:16` |

## Luồng dữ liệu

```
Client (CC/Codex) ──turn──▶ runner ─▶ injection pipeline ─▶ SubscriptionToolsInjector
                                         │ canUseAccountSwitch(space,user)  ─▶ Core user/list-by-instance (cache)
                                         │ resolveSwitchPool(space,agent)   ─▶ instance-upstream cache
                                         └▶ <subscription_tools> (curl + x-tdai-service-id + x-conversation-id)
LLM ──Bash curl──▶ POST /subscription-bridge/v1/{current|switch}
   bridge: header ─▶ session store L1/L2 (user, agent) ─▶ canUseAccountSwitch ─▶ resolveSwitchPool
         ─▶ getPoolSnapshot (Core accounts/list, có label) ─▶ selector.accountSwitchRejection
         ─▶ binding-store get/rebind ─▶ reportPoolSessionCounts ─▶ JSON {code, message, reason?, data}
LLM ──viết câu trả lời──▶ người dùng
```

## Giai đoạn

| # | Tệp | Nội dung | Phụ thuộc | Công |
|---|---|---|---|---|
| 1 | [phase-01-spike-session-key-and-clients.md](phase-01-spike-session-key-and-clients.md) | Kiểm khóa phiên = khóa binding cho CC và Codex; curl từ Codex; lệnh tắt Codex; API vai trò | — | 3h |
| 2 | [phase-02-admin-permission-and-role-cache.md](phase-02-admin-permission-and-role-cache.md) | `canUseAccountSwitch`, tra vai trò có cache, `resolveSwitchPool`, `callInternalMeta` | 1 | 3h |
| 3 | [phase-03-subscription-bridge.md](phase-03-subscription-bridge.md) | Core thêm label; `accountSwitchRejection`; dấu login riêng; `/subscription-bridge/v1/current`, `/switch` | 2 | 6h |
| 4 | [phase-04-subscription-tools-injector.md](phase-04-subscription-tools-injector.md) | Khối `<subscription_tools>` chỉ cho System Admin dùng pool | 2, 3 (đường dẫn bridge) | 3h |
| 5 | [phase-05-installer-sub-command.md](phase-05-installer-sub-command.md) | `~/.claude/commands/sub.md` và skill `sub` của Codex trong `install.sh` | 1 | 3h |
| 6 | [phase-06-tests-and-e2e.md](phase-06-tests-and-e2e.md) | Toàn bộ test Proxy/Core, e2e thật với CC và Codex | 3, 4, 5 | 5h |
| 7 | [phase-07-deploy.md](phase-07-deploy.md) | Deploy Core rồi Proxy theo skill `deploy-agent-memory` | 6 | 2h |

Giai đoạn 4 và 5 chạy song song được: tệp không trùng.

## Tiến độ

- Giai đoạn 1 (spike) xong ngày 2026-11-03. Báo cáo: [reports/spike-session-key-and-clients.md](reports/spike-session-key-and-clients.md). Khóa bridge khớp khóa pool cho cả Claude Code và Codex; hai lối tắt đều đưa đúng chữ tới model. Việc chưa kiểm bằng chạy thật (so ProxyStorage, header subagent, `curl` thật từ Codex) dồn sang giai đoạn 6.
- Giai đoạn 2 xong ngày 2026-11-03: `callInternalMeta` (tách từ `callPoolCore`, URL và header không đổi), `canUseAccountSwitch`, `resolveSwitchPool` trong `MemoryProxy/src/subscription-pool/account-switch-access.ts`. 18 test mới, toàn bộ `src/subscription-pool` 177 test qua, `tsc` sạch. GitNexus `impact callPoolCore`: LOW (12 nơi bị ảnh hưởng, 4 gọi trực tiếp). Chưa commit.
- Giai đoạn 3 xong ngày 2026-11-03: Core gửi thêm `display_name`, `account_label`; `accountSwitchRejection` trong `selector.ts`; `subscription-bridge.ts` với `POST /subscription-bridge/v1/current` và `/switch`; dấu "login riêng" của Codex trong `pool-request.ts`. Proxy: 993/993 test qua (222 trong `src/subscription-pool`), `tsc` sạch; Core: 45/45 test của dịch vụ pool. Core không có script typecheck (đã có từ trước). GitNexus: LOW cho phần lớn, MEDIUM cho `PoolRequestImpl`, HIGH cho `noAccountLeft`/`onSuccess` nhưng chỉ thêm thao tác `Map` không ném lỗi. Chưa commit.
- Giai đoạn 4 xong ngày 2026-11-03: `SubscriptionToolsInjector` (`MemoryProxy/src/injection/injectors/subscription-tools-injector.ts`) đăng ký sau `TdaiToolsInjector`, cùng khối `if` với nó, nên khối chỉ có khi tiêm memory đang bật. Curl dùng `-sSk` như hai khối anh em. Injection 88/88 test; full suite 79 file / 1004 test qua ba lần chạy liên tiếp. Chưa commit.
- Giai đoạn 5 xong ngày 2026-11-03: `install.sh` cài `~/.claude/commands/sub.md` (Claude Code) và `$CODEX_DIR/skills/sub/SKILL.md` (Codex); file không có dòng dấu thì giữ nguyên; gỡ chỉ xóa file có dấu; omp không nhận lối tắt. Full suite 79 file / 1025 test qua, `tsc` sạch, máy thật không bị ghi. Lưu ý: khi văn bản lối tắt đổi ở lần deploy sau, `write_if_changed` để lại file `*.agent-memory-backup-<ts>`; client không nạp file này, nhưng thư mục `sub/` của Codex sẽ không rỗng nên lệnh gỡ không xóa được nó.
- Giai đoạn 6, phần test tự động, xong ngày 2026-11-03: thêm ca `invalid_json`, `storage_unavailable` và ca "đổi xong pool vẫn chuyển khi tài khoản hết quota" (đã thử đỏ khi bỏ `markAccountExhausted`). Proxy 79 file / 1028 test qua, `tsc` sạch; Core 81 file / 1398 test qua (1 skip có sẵn); GitNexus `detect-changes --scope all`: 18 file, rủi ro thấp, 0 luồng bị ảnh hưởng. E2E thật chạy sau deploy ở giai đoạn 7.
- Kết quả spike đổi hai điều: khối `<subscription_tools>` cho Codex **luôn** có dòng xin chạy ngoài sandbox (giai đoạn 4); Core có thể lọc vai trò bằng `user_type: "system_admin"` ngay trong lời gọi (giai đoạn 2).

## Sở hữu tệp

| Giai đoạn | Tệp |
|---|---|
| 2 | `MemoryProxy/src/subscription-pool/core-client.ts`, mới `MemoryProxy/src/subscription-pool/account-switch-access.ts` |
| 3 | `MemoryCore/src/metadata/service/metadata-service.ts`, `MemoryCore/src/metadata/types.ts`, `MemoryCore/v3-api-memorycore-doc.md`, `MemoryProxy/src/subscription-pool/{types,selector,pool-request}.ts`, mới `MemoryProxy/src/subscription-pool/subscription-bridge.ts`, `MemoryProxy/src/server.ts` |
| 4 | mới `MemoryProxy/src/injection/injectors/subscription-tools-injector.ts`, `MemoryProxy/src/injection/index.ts` |
| 5 | `MemoryProxy/assets/client-hooks/install.sh` |
| 6 | chỉ tệp test (`__tests__`, `*.test.ts`) |

## Ma trận kiểm thử (tóm tắt; chi tiết ở giai đoạn 6)

| Lớp | Nội dung |
|---|---|
| Unit Proxy | `accountSwitchRejection`; email khớp/mơ hồ; cache vai trò (TTL, lỗi Core → từ chối); `resolveSwitchPool`; bridge view/switch mọi mã lý do; injector có/không khối; `poolSessionKey` khớp khóa runner |
| Unit Core | `listSubscriptionAccountsInternal` có `display_name`, `account_label`, vẫn không có `refresh_token` |
| Installer | cài/gỡ file lệnh CC và skill Codex; không ghi đè file người dùng; chạy lại không đổi |
| E2E thật | CC và Codex: admin xem, đổi, lượt sau đi đúng tài khoản; người thường không có khối và bị 403; Exhausted/Threshold bị từ chối |

## Lùi lại

- Proxy: deploy lại image cũ (`MEMORY_BUILD_REVISION=<sha cũ>`). Khối biến mất ở lượt sau; binding đã đổi vẫn hợp lệ với code cũ (cùng dạng JSON).
- Core: deploy lại image cũ. Proxy chịu được thiếu label (xem hiện `account_id`, đổi theo email trả `account_not_in_pool`).
- File lệnh trên máy người dùng: `install.sh --uninstall` gỡ file có dấu của bộ cài.
- Không có thay đổi schema DB, nên không cần sao lưu DB.

## Tiêu chí hoàn thành (đo được)

1. `cd MemoryProxy && npm test && npm run typecheck` qua; `cd MemoryCore && npx vitest run src/metadata/store/subscription-pool.service.test.ts` qua.
2. E2E: với admin, sau `switch` sang email B, log Proxy của lượt kế tiếp có `account_id` của B, và `current` trả email B.
3. E2E: người thường không thấy `<subscription_tools>` trong system prompt (kiểm Langfuse/log injection) và `curl` thẳng bridge nhận HTTP 403 `not_system_admin`.
4. E2E: đổi sang tài khoản Exhausted nhận `account_exhausted` kèm `resets_at`.
5. Prod sau deploy: container healthy, không có lỗi mới trong log 5 phút, và một lần `current` thật trả đúng tài khoản.

## Quyết định đã chốt sau khi lập kế hoạch (người dùng, 03/11/2026)

1. Codex dùng lối tắt `$sub` và `$sub <email>` (skill người dùng `sub`), vì Codex đã bỏ custom prompt `/…`. Claude Code giữ `/sub`.
2. E2E chạy trên prod bằng tài khoản System Admin, sau giai đoạn 7.
3. Khớp email theo `account_label` là đủ. Các tài khoản thật trong pool đều có email trong nhãn (Panel hiện email). Không thêm luật khớp theo `display_name`.
4. Người dùng hiện có chạy lại bộ cài hook thì mới có lối tắt. Hỏi bằng lời thường vẫn chạy mà không cần cài lại.

## Câu hỏi mở

1. Pool Codex trên prod hiện chỉ có 1 tài khoản. E2E đổi tài khoản cho Codex cần ít nhất 2. Nếu lúc e2e pool vẫn chỉ có 1, chỉ kiểm được `current` và các ca từ chối cho Codex.
