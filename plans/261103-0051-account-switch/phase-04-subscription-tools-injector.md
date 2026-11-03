# Giai đoạn 4: Khối `<subscription_tools>` chỉ cho System Admin dùng pool

## Bối cảnh (đã đọc code)

- Hai khối anh em: `renderTdaiMemoryToolsBlock` (`MemoryProxy/src/injection/injectors/tdai-tools-injector.ts:68-171`), `renderSkillToolsBlock` (`skill-tools-injector.ts:59-200`). Header curl: `x-tdai-service-id: <space_id>`, `x-conversation-id: <session_id>`.
- `TdaiMemoryToolsInjector`: `point = "system.suffix"`, `cacheStrategy = "session_init"`, `execute` lấy `getTdaiIdentity(ctx.metadata.custom)` và `session.space_id`; `prewarm` lấy `input.sessionInfo` (`tdai-tools-injector.ts:178-232`).
- `InjectionHook.execute` và `prewarm` được phép trả Promise (`injection/types.ts:370, 376`). `AgentContextMetadata` có `agentSource`, `userId`, `spaceId` (`types.ts:78-98`); `PrewarmInput` có `userId`, `agentSource`, `spaceId`, `sessionInfo` (`types.ts:290-319`).
- Cache: khóa `ttl/<space>/<user>/<agent>/<session>/inj-hook/<hookId>.json` (`db/kv-hook-cache-repo.ts:7`), tức theo từng phiên. Cache trượt → gọi `execute` và ghi lại (trừ request fork `readOnly`) (`injection/pipeline.ts:285-318`). Vậy phiên cũ nhận khối ở lượt chính kế tiếp; `execute` trả rỗng thì không ghi, lượt sau hỏi lại (cache vai trò trong bộ nhớ làm việc này rẻ).
- Đăng ký: `TdaiToolsInjector` đăng ký khi `proxyBaseUrl` có giá trị (`injection/index.ts:418-420`); `proxyBaseUrl` tính ở `index.ts:276-308`.
- Codex nhận cùng văn bản inject qua `<tdai_injections>` (`pipeline/runners/codex.ts:850-903`).

## Bước

1. Tệp mới `MemoryProxy/src/injection/injectors/subscription-tools-injector.ts`:
   - `renderSubscriptionToolsBlock(proxyBaseUrl, sessionId, spaceId): string` (hàm thuần). Văn bản tiếng Anh, ngắn:
     - Mở `<subscription_tools>`, đóng `</subscription_tools>`.
     - Nói đây là công cụ Account Switch dành cho System Admin; gọi bằng Bash + curl tới proxy; proxy tự gắn định danh.
     - Chỉ gọi khi người dùng hỏi tài khoản nào đang phục vụ cuộc hội thoại, hoặc yêu cầu đổi rõ ràng (kể cả qua lối tắt `/sub`, `$sub`). Không bao giờ tự đổi tài khoản.
     - Tool `subscription_current`: `POST <base>/subscription-bridge/v1/current`, body `{}`.
     - Tool `subscription_switch`: `POST <base>/subscription-bridge/v1/switch`, body `{"email": "<email>"}`.
     - Mẫu curl đầy đủ: `curl -sS -X POST <base>/subscription-bridge/v1/current -H 'content-type: application/json' -H 'x-tdai-service-id: <space>' -H 'x-conversation-id: <session>' -d '{}'`.
     - Đọc JSON: `code == 0` là thành công; ngược lại báo `message` cho người dùng và không thử lại với 4xx. Trả lời bằng ngôn ngữ của người dùng.
     - Với Codex: luôn có một dòng nói xin phê duyệt chạy lệnh ngoài sandbox, vì sandbox mặc định tắt mạng (spike giai đoạn 1, đọc tài liệu Codex). Claude Code không cần dòng này.
   - `class SubscriptionToolsInjector implements InjectionHook`: `id = "subscription-tools-injector"`, `point = "system.suffix"`, anchor và priority đặt ngay sau `TdaiMemoryToolsInjector` (`HOOK_PRIORITY.MEMORY + 6`), `cacheStrategy = "session_init"`.
   - `execute(ctx)` (async): lấy `userId` từ `getTdaiIdentity(ctx.metadata.custom)?.userId ?? ctx.metadata.userId`, `spaceId` từ `custom.session.space_id ?? ctx.metadata.spaceId`, `sessionId` từ identity; thiếu gì → `[]`. Gọi `shouldOffer(spaceId, userId, agentSource)` → `[]` hoặc một block.
   - `prewarm(input)` (async): tương tự với `input.userId`, `input.spaceId ?? input.sessionInfo.space_id`, `input.agentSource`, `input.sessionInfo.session_id`.
   - `shouldOffer` = `(await canUseAccountSwitch(config, { spaceId, userId })) && (await resolveSwitchPool(config, spaceId, agentSource)) !== null`. Không có điều kiện quyền nào khác ở đây.
   - Comment đầu tệp: vì sao chỉ admin + pool, vì sao tĩnh (giữ prompt cache), và bridge kiểm lại quyền bằng cùng hàm.
2. `injection/index.ts`: ngay sau dòng đăng ký `TdaiToolsInjector` (`index.ts:418-420`), trong cùng điều kiện `typeof proxyBaseUrl !== "undefined"`, đăng ký `new SubscriptionToolsInjector({ proxyBaseUrl, config })`. Không thêm cờ config. Đây là thêm một dòng đăng ký trong khối dựng registry; không đổi người gọi nào. Chạy `impact getInjectionPipeline` (`index.ts:540`) sau khi làm mới index và ghi vào PR.

## Tệp

- Thêm: `MemoryProxy/src/injection/injectors/subscription-tools-injector.ts`, `MemoryProxy/src/injection/injectors/__tests__/subscription-tools-injector.test.ts`.
- Sửa: `MemoryProxy/src/injection/index.ts`.

## Kiểm thử

`cd MemoryProxy && npx vitest run src/injection/injectors/__tests__ src/injection/__tests__`

Ca: "renders curl recipes with the session and instance headers"; "offers the block to a system admin on a pool-served Claude Code session"; "offers the block on a pool-served Codex session"; "returns nothing for a normal user"; "returns nothing when the client is not served by the pool"; "returns nothing for other clients"; "returns nothing when the role lookup fails"; "prewarm and execute render the same text" (giữ byte để cache khớp).

## Tiêu chí đạt

- Test trên qua; `npm run typecheck` qua.
- Snapshot của văn bản không chứa token hay user key (`rg -n "Bearer|sk-" ` trên chuỗi render trong test trả rỗng).
- Phiên admin trong e2e (giai đoạn 6) có `<subscription_tools>` đúng một lần trong system prompt.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Phiên admin cũ nhận khối mới giữa chừng → một lần trượt prompt cache | Trung bình × Thấp | Một lần duy nhất mỗi phiên; chấp nhận |
| Tra vai trò lỗi lúc prewarm → admin không có khối tới lượt sau | Thấp × Thấp | Không ghi cache khi rỗng; lượt sau hỏi lại |
| Model tự gọi `switch` khi không được yêu cầu | Thấp × Trung bình | Văn bản cấm rõ; bridge vẫn chỉ đổi trong pool hợp lệ |

## Lùi lại

Revert commit. Khối đã cache trong phiên còn ở hook cache tới khi phiên hết hạn; bridge cũ không còn thì curl trả 404 và model báo lỗi. Muốn xóa ngay: deploy lại và khối không được đăng ký → pipeline không đọc hook id này nữa.
