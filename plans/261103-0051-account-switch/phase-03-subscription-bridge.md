# Giai đoạn 3: Subscription bridge (xem / đổi) và nhãn tài khoản từ Core

## Bối cảnh (đã đọc code)

- Danh sách tài khoản Core gửi Proxy không có email: `toProxySubscriptionAccount` chỉ gửi `account_id, group_id, provider, provider_account_id, status, enabled, access_token, token_expires_at, usage, exhausted_until` (`MemoryCore/src/metadata/service/metadata-service.ts:2384-2397`; kiểu `SubscriptionAccountProxyView` ở `MemoryCore/src/metadata/types.ts:952-963`). Entity có `display_name` và `account_label` ("email gói") (`types.ts:905-914`; dựng ở `subscription-pool/providers/codex.ts:49`, `providers/claude.ts:148-150`).
- Kiểu Proxy `PoolAccount` (`MemoryProxy/src/subscription-pool/types.ts:20-34`).
- Luật chọn: `isServable` (riêng tư), `isExhausted`, `accountUsagePct`, `earliestReset` (`selector.ts:41-67, 118-140`). Bound giữ tới 100 %; tài khoản mới phải `< thresholdPct`.
- Binding: `getBinding`, `rebindSession` (giữ `created_at`), `countSessionsByAccount` (`binding-store.ts:50-108`).
- Khi binding đổi, `persist()` gọi `reportSessionCounts` báo `active_sessions` cho tài khoản mới và cũ (`pool-request.ts:400-420`).
- Rơi về login riêng: `noAccountLeft` khi `clientLoginAllowed` (`pool-request.ts:151-156, 468-472`). Không lưu ở đâu.
- Mẫu bridge: kiểm path/method/content-type, lấy phiên từ `x-conversation-id` + `x-tdai-service-id`, L1 session store rồi L2 `BindingRepo` (`memory-bridge.ts:95-188, 316-380`). Gắn route ở `server.ts:146-154`, trước route theo agent.

GitNexus (`impact`, index 2026-10-24): `toProxySubscriptionAccount` LOW (1 người gọi: `listSubscriptionAccountsInternal`); `isServable` LOW; `reportSessionCounts` LOW; `noAccountLeft` LOW; `openPoolRequest` LOW nhưng index báo 3 người gọi, grep thấy 4: `anthropic.ts:1116`, `codex.ts:1158`, `utility.ts:159`, `workbuddy.ts:524`. Chạy lại impact sau khi làm mới index (giai đoạn 2 bước 1) trước khi sửa.

## Bước

### A. Core: thêm nhãn vào danh sách gửi Proxy

1. `MemoryCore/src/metadata/types.ts`: `SubscriptionAccountProxyView` thêm `display_name: string; account_label: string;`.
2. `metadata-service.ts` `toProxySubscriptionAccount`: thêm hai trường đó. Không đổi gì khác.

### B. Proxy: kiểu và luật

3. `subscription-pool/types.ts` `PoolAccount`: thêm `display_name?: string; account_label?: string;` (tùy chọn: Core cũ không gửi).
4. `selector.ts`: thêm hàm xuất

   ```ts
   export type AccountSwitchRejection =
     | { reason: "account_disabled" }
     | { reason: "account_needs_login" }
     | { reason: "account_exhausted"; resets_at: number | null }
     | { reason: "account_above_threshold"; usage_pct: number; threshold_pct: number; resets_at: number | null };
   export function accountSwitchRejection(account: PoolAccount, now: number, thresholdPct: number): AccountSwitchRejection | null
   ```

   Thứ tự: `!enabled || status === "disabled"` → disabled; `status === "auth_error"` → needs_login; `isExhausted` → exhausted, `resets_at = exhausted_until ?? earliestReset([account], now, thresholdPct, "")`; `!isServable` còn lại → disabled; `accountUsagePct(account, now, "") >= thresholdPct` → above_threshold với `earliestReset([account], now, thresholdPct, "")`; còn lại `null`. Comment: model rỗng nghĩa là chỉ xét Quota Window dùng chung, vì lúc đổi chưa có model; cửa sổ theo model do pool xử lý ở request sau.

### C. Proxy: phần dùng chung trong `pool-request.ts`

5. `export function poolSessionKey(sessionId: string): string` trả `session:${sessionId}`; constructor `PoolRequestImpl` dùng nó (`pool-request.ts:158`). Khóa `user:` giữ nguyên.
6. Đưa `reportSessionCounts` ra cấp module: `export function reportPoolSessionCounts(config: PoolCoreConfig, storage, spaceId, provider, accountIds, now): void`, thân giữ nguyên; method cũ gọi hàm này.
7. Dấu login riêng: `Map<string, number>` cấp module (khóa binding → thời điểm), tối đa 10 000 mục (xóa mục cũ nhất), bỏ qua mục cũ hơn `BINDING_TTL_MS`.
   - Ghi trong `noAccountLeft` ngay trước `doFetch({ kind: "client" })`, chỉ khi `input.bindSession` đúng và có khóa binding.
   - Xóa trong `onSuccess` khi `input.bindSession` đúng (lượt chính được tài khoản pool phục vụ).
   - Xuất `isSessionOnClientLogin(bindingKey, now)` và `clearSessionClientLogin(bindingKey)`.
   - Comment: dấu sống trong bộ nhớ của một Proxy (binding store cũng chỉ hỗ trợ một replica); sau khởi động lại, lượt chính kế tiếp ghi lại.

### D. Proxy: bridge

8. Tệp mới `MemoryProxy/src/subscription-pool/subscription-bridge.ts`, `createSubscriptionBridgeHandler(config)`:
   - Chỉ `POST /subscription-bridge/v1/current` và `POST /subscription-bridge/v1/switch`; path khác 404, method khác 405, content-type không phải JSON 415 (như `memory-bridge.ts:325-357`).
   - Phiên: id từ `x-parent-conversation-id`, rồi `x-conversation-id` (cùng thứ tự `memory-bridge.ts:95-109`). Thiếu id → 401 `missing_conversation_id`.
   - spaceId: header `x-tdai-service-id` chỉ dùng để tra L2. Khi đã tìm thấy phiên, spaceId lấy từ `sessionInfo.space_id` (L1) hoặc từ chính spaceId đã dùng để tra L2. Header khác `sessionInfo.space_id` → 409 `not_pool_session`. **Không** lấy spaceId từ config: spaceId sai cho ra một khóa binding hợp lệ mà không ai đọc, nên `current` báo sai "unbound" và `switch` ghi vào chỗ vô ích.
   - Tìm phiên và agent: thử `getSessionStore().get("claude-code:" + id)` rồi `"codex:" + id` (trạng thái `initialized`, có `sessionInfo.user_id`). Không có thì `getSessionStore().getBindingRepo()?.getBinding(spaceId, id)` với `outcome === "initialized"` và `agentSource` là `claude-code` hoặc `codex`. Không tìm được phiên → 401 `session_not_initialized`. Có phiên nhưng agent khác → 409 `not_pool_session`. **Không** mặc định `claude-code`.
   - `canUseAccountSwitch(config, { spaceId, userId })` sai → 403 `not_system_admin`.
   - `resolveSwitchPool(config, spaceId, agent)` null → 409 `not_pool_session`.
   - `getProxyStorage(config.storage)` ném lỗi → 503 `storage_unavailable`.
   - `getPoolSnapshot(config.coreSkill, spaceId, config.instanceUpstream, now, forceRefresh)`; `current` dùng cache (`false`), `switch` đọc mới (`true`). `unavailable` → 503 `pool_unavailable`. Lọc `group_id === row.group_id && provider === provider` (như `pool-request.ts:333`).
   - Khóa: `sessionBindingKey(spaceId, provider, poolSessionKey(id))`.
9. `current` trả `{ code: 0, message: "ok", data }` với `data = { provider, state, account }`:
   - `state: "own_login"` khi `isSessionOnClientLogin(key, now)`; `account: null`; message "This conversation uses your own login, not the pool."
   - `state: "bound"` khi có binding và tài khoản còn trong danh sách đã lọc; `account = { email, display_name, account_label }` (email = từ đầu có `@` của `account_label`, rỗng nếu không có).
   - `state: "unbound"` khi không có binding, hoặc tài khoản đã bị xóa khỏi pool; message "No account is bound to this conversation yet. The pool picks one on the next request."
10. `switch` body `{ "email": string }`:
    - Email rỗng, không có `@`, dài hơn 254 → 400 `invalid_email`.
    - Khớp theo luật ở `plan.md` (từ đầu có `@` của `account_label`, không phân biệt hoa thường). 0 → 404 `account_not_in_pool` ("No <provider> account with this email is in the pool of this conversation."). Hơn 1 → 409 `account_ambiguous`.
    - `accountSwitchRejection` khác null → 409 với `reason` đó; `data` có `resets_at` (ISO 8601 và epoch ms), với Threshold có thêm `usage_pct`, `threshold_pct`. Thông điệp tiếng Anh, ví dụ "The account is exhausted until 2026-11-03T12:00:00Z."
    - Đã gắn đúng tài khoản đó và không ở login riêng → 200, `data.changed = false`.
    - Còn lại: `previous = getBinding(...)`; `rebindSession(storage, key, target.account_id, now)` (tạo khi chưa có, ghi đè khi có, giữ `created_at`); `clearSessionClientLogin(key)`; `reportPoolSessionCounts(config.coreSkill, storage, spaceId, provider, [target, previous?.account_id], now)`; log `info` `[subscription-bridge] account switch space=… provider=… from=<account_id|none> to=<account_id>` (không email, không token).
    - Trả `{ code: 0, message: "ok", data: { provider, changed: true, previous: { email } | null, current: { email, display_name } } }`.
11. Lỗi trả `{ code, message, reason, data? }` với `code` dạng số như bridge cũ (40001, 40101, 40301, 40401, 40901, 50301). Không bao giờ trả `access_token`.
12. `server.ts`: ngay sau memory bridge (`server.ts:153-154`), thêm `app.post("/subscription-bridge/*", (c) => subscriptionBridgeHandler(c));`. Đây là thêm route trong `createApp` (`server.ts:32`); không đổi người gọi nào. Chạy `impact createApp` sau khi làm mới index và ghi vào PR.
13. Tài liệu Core: `MemoryCore/v3-api-memorycore-doc.md:1317-1319` (mục `accounts/list`) thêm một câu: mỗi dòng có `display_name` và `account_label`. Tài liệu Proxy `MemoryProxy/v3-api-memoryproxy-doc.md:300` nói bridge nằm ngoài phạm vi tài liệu v3, nên không thêm ở đó; hợp đồng bridge nằm ở comment đầu `subscription-bridge.ts` (đường dẫn, body, mã lý do).
14. Không gọi `emitBridgeRejectTelemetry` (union `bridgeSource` đóng ở `bridge-telemetry.ts:104`); log thay thế. Ghi rõ trong PR.

## Tệp

- Sửa: `MemoryCore/src/metadata/types.ts`, `MemoryCore/src/metadata/service/metadata-service.ts`, `MemoryCore/v3-api-memorycore-doc.md`, `MemoryProxy/src/subscription-pool/types.ts`, `selector.ts`, `pool-request.ts`, `MemoryProxy/src/server.ts`.
- Thêm: `MemoryProxy/src/subscription-pool/subscription-bridge.ts`, `__tests__/subscription-bridge.test.ts`; ca mới trong `__tests__/selector.test.ts`, `__tests__/binding-store.test.ts` (hoặc `pool-forwarding.test.ts` cho dấu login riêng).

## Kiểm thử

- `cd MemoryProxy && npx vitest run src/subscription-pool/__tests__`
- `cd MemoryCore && npx vitest run src/metadata/store/subscription-pool.service.test.ts`

Ca chính (tên mô tả): "rejects a disabled account", "rejects an account that needs a new login", "rejects an exhausted account with its reset time", "releases an account whose exhausted_until has passed", "rejects an account at the threshold on shared windows", "ignores a full per-model window at switch time"; bridge: "shows the bound account", "shows no account before the first request", "shows own login after the pool fell back to the client login", "switches and the next pool request uses the new account" (dùng `openPoolRequest` thật với storage bộ nhớ), "creates a binding when none exists", "reports active sessions for the new and old account", "refuses a normal user", "refuses a session of another client", "refuses an unknown email", "refuses an ambiguous email", "never returns access tokens".

## Tiêu chí đạt

- Test trên qua; `npm run typecheck` qua ở MemoryProxy.
- `rg -n "access_token" MemoryProxy/src/subscription-pool/subscription-bridge.ts` không có kết quả.
- Test "switches and the next pool request uses the new account" chứng minh khóa bridge và khóa runner là một.
- `node .gitnexus/run.cjs detect-changes --scope all --repo .` chỉ liệt kê các symbol nêu trên.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Sửa `pool-request.ts` làm hỏng đường pool | Thấp × Cao | Chỉ tách hàm và thêm dấu; chạy toàn bộ test pool và `pool-off-identical.test.ts` |
| Một lượt đang chạy ghi đè binding vừa đổi: nhánh `bound` gọi `rebindSession` với tài khoản cũ khi `last_used_at` cũ hơn 5 phút (`pool-request.ts:381-382`) | Thấp × Thấp | Trong phiên đang hoạt động binding vừa được chạm, nên điều kiện 5 phút hiếm khi đúng; chấp nhận, ghi trong PR |
| Ai có `x-conversation-id` của phiên admin thì gọi được bridge | Thấp × Trung bình | Cùng mô hình tin cậy với skill/memory bridge; vẫn cần chủ phiên là System Admin; chấp nhận |
| Core cũ chưa gửi nhãn | Trung bình × Thấp | Deploy Core trước; Proxy chịu được trường thiếu |

## Lùi lại

Revert commit Proxy và Core. Binding đã đổi có cùng dạng JSON, code cũ đọc bình thường. Không đổi schema DB.
