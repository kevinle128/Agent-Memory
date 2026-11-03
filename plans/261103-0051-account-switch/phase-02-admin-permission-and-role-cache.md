# Giai đoạn 2: Hàm quyền `canUseAccountSwitch`, tra vai trò có cache, kiểm "do pool phục vụ"

## Bối cảnh (đã đọc code)

- Proxy chưa tra `user_type` ở đâu (`rg -n "user_type|system_admin" MemoryProxy/src` không có kết quả ngoài test).
- Core có sẵn `POST /v3/internal/meta/user/list-by-instance` (`MemoryCore/src/metadata/router/internal-meta-router.ts:91-101`), body `instance_id?`, `status?`, `user_type?`, `user_ids?` (≤100) + phân trang (`v3-meta-schemas.ts:413-418`), trả `{ items, total, limit, offset }` (`v3-api-memorycore-doc.md:1284-1290`). `UserEntity` có `user_type` (`MemoryCore/src/metadata/types.ts:79`). Không cần endpoint Core mới.
- Proxy gọi endpoint nội bộ qua `callPoolCore` (`MemoryProxy/src/subscription-pool/core-client.ts:20-47`), nhưng hàm này cố định tiền tố `/v3/internal/meta/subscription-pool` và một union đường dẫn.
- `resolveForAgent` trả `{ kind: "pool", row }` khi agent ở nhóm custom `subscription_pool` đang bật (`instance-upstream-cache.ts:220-244`); `getInstanceUpstreamConfigs` có cache 30 s (`instance-upstream-cache.ts:164-207`).

GitNexus (index ngày 2026-10-24, cũ hơn HEAD `789d819e`): `impact callPoolCore` chưa chạy được trên index mới. Bước 1 bắt buộc chạy lại.

## Bước

1. Làm mới index rồi chạy impact:
   `node .gitnexus/run.cjs analyze --index-only`, rồi `node .gitnexus/run.cjs impact callPoolCore --direction upstream --repo .`. Người gọi theo grep: `account-cache.ts:140`, `pool-request.ts:303, 449`, `reporter.ts:92`. Ghi rủi ro vào PR.
2. `core-client.ts`: thêm `callInternalMeta<T>(config, spaceId, path, body, signal?)` gửi tới `${endpoint}/v3/internal/meta/${path}`, cùng header, timeout, cách đọc envelope, ném `PoolCoreError` như hiện nay. `callPoolCore` gọi `callInternalMeta(config, spaceId, \`subscription-pool/${path}\`, …)`. Kiểu đường dẫn của `callPoolCore` giữ nguyên.
3. Tệp mới `MemoryProxy/src/subscription-pool/account-switch-access.ts`:
   - `canUseAccountSwitch(config, { spaceId, userId }): Promise<boolean>`: **nơi duy nhất** quyết định quyền. Đúng khi Core trả `user_type === "system_admin"` cho `userId` trong instance `spaceId`. Gọi Core với `{ user_ids: [userId], user_type: "system_admin", limit: 1 }`: có đúng một dòng **và** dòng đó có `user_id` bằng `userId` và `user_type === "system_admin"` thì mới đúng (spike giai đoạn 1). Kiểm lại dòng ở Proxy vì một Core cũ không có bộ lọc `user_type` sẽ bỏ qua nó và trả người dùng thường; khi đó phải từ chối. Thiếu `spaceId`/`userId` hoặc `userId === "anonymous"` → `false`.
   - Cache trong bộ nhớ, khóa `<spaceId>\0<userId>`: kết quả đúng giữ 5 phút, kết quả sai giữ 1 phút, tối đa 1 000 mục (xóa mục cũ nhất). Lỗi Core (mạng, HTTP, envelope) → trả `false`, **không** cache, log `warn` một dòng không có token. Gộp các lời gọi đồng thời cùng khóa bằng một Promise đang chờ.
   - `resolveSwitchPool(config, spaceId, agentSource): Promise<{ provider: "claude" | "codex"; row: InstanceUpstreamRow } | null>`: `claude-code` → `claude`, `codex` → `codex`, agent khác → `null`; rồi `resolveForAgent(await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream), agentSource)`; `kind !== "pool"` → `null`.
   - `resetAccountSwitchAccessForTests()`.
   - Comment đầu tệp nói vì sao: quyền nằm ở một chỗ để khối inject và bridge không bao giờ lệch nhau; lỗi Core thì từ chối.
4. Không thêm config, cờ hay allowlist.

## Tệp

- Sửa: `MemoryProxy/src/subscription-pool/core-client.ts`.
- Thêm: `MemoryProxy/src/subscription-pool/account-switch-access.ts`, `MemoryProxy/src/subscription-pool/__tests__/account-switch-access.test.ts`.

## Kiểm thử

`cd MemoryProxy && npx vitest run src/subscription-pool/__tests__/account-switch-access.test.ts src/subscription-pool/__tests__/reporter.test.ts src/subscription-pool/__tests__/pool-forwarding.test.ts`

Ca test (tên mô tả tình huống):
- "allows a system admin and caches the answer" (một lời gọi `fetch` cho hai lần hỏi).
- "denies a normal user", "denies when the user is missing from the instance".
- "denies and does not cache when Core fails" (lần sau gọi lại Core).
- "keys the cache by instance" (cùng user khác space → hai lời gọi).
- "shares one Core call between concurrent checks".
- `resolveSwitchPool`: pool cho `claude-code` → `claude`; pool cho `codex` → `codex`; `codebuddy` → `null`; nhóm `custom_unified` → `null`; nhóm pool tắt → `null`.
- Hồi quy `callPoolCore`: URL và header không đổi (test có sẵn của pool vẫn qua).

## Tiêu chí đạt

- Test trên qua; `npm run typecheck` qua.
- `rg -n "system_admin" MemoryProxy/src --glob '!**/__tests__/**'` chỉ ra `account-switch-access.ts`.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Đổi `callPoolCore` làm hỏng đường pool | Thấp × Cao | Chỉ tách hàm, URL giữ nguyên; chạy toàn bộ `src/subscription-pool/__tests__` |
| Admin bị hạ quyền vẫn dùng được tối đa 5 phút | Thấp × Thấp | TTL ngắn; chấp nhận |
| Core chậm làm chậm lượt chính khi inject | Thấp × Trung bình | Timeout `coreSkill.timeoutMs` (mặc định 3 s) của `callInternalMeta`; cache |

## Lùi lại

Revert commit. Không có dữ liệu lưu lâu dài.
