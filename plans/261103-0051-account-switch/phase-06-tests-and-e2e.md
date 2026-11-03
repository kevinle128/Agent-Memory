# Giai đoạn 6: Kiểm thử đầy đủ và e2e thật với Claude Code và Codex

Giai đoạn này chỉ thêm/sửa tệp test và script QA. Không sửa code sản phẩm; lỗi tìm thấy thì quay lại giai đoạn sở hữu tệp đó.

## Lệnh test

| Phần | Lệnh |
|---|---|
| Proxy, toàn bộ | `cd MemoryProxy && npm test && npm run typecheck` |
| Proxy, pool | `cd MemoryProxy && npx vitest run src/subscription-pool/__tests__` |
| Proxy, injection | `cd MemoryProxy && npx vitest run src/injection` |
| Proxy, bộ cài | `cd MemoryProxy && bash -n assets/client-hooks/install.sh && npx vitest run src/__tests__/client-hooks.test.ts src/__tests__/client-hooks-codex-omp.test.ts` |
| Core | `cd MemoryCore && npx vitest run src/metadata/store/subscription-pool.service.test.ts` rồi `npm test` |
| Đồ thị thay đổi | `node .gitnexus/run.cjs analyze --index-only && node .gitnexus/run.cjs detect-changes --scope all --repo .` (không chấp nhận `partial`/`truncated`) |

## Ma trận unit/integration

| Tình huống | Nơi test |
|---|---|
| `accountSwitchRejection`: tắt, cần login, Exhausted (có/không `exhausted_until`), hết Exhausted, đúng Threshold, cửa sổ theo model bị bỏ qua | `subscription-pool/__tests__/selector.test.ts` |
| `canUseAccountSwitch`: admin, thường, không có user, lỗi Core, cache theo instance, gọi đồng thời | `subscription-pool/__tests__/account-switch-access.test.ts` |
| `resolveSwitchPool`: claude-code/codex/khác, nhóm không phải pool, pool tắt | như trên |
| Bridge: mọi mã lý do (`missing_conversation_id`, `session_not_initialized`, `not_system_admin`, `not_pool_session`, `storage_unavailable`, `pool_unavailable`, `invalid_email`, `account_not_in_pool`, `account_ambiguous`, `account_disabled`, `account_needs_login`, `account_exhausted`, `account_above_threshold`); header `x-tdai-service-id` khác `space_id` của phiên → `not_pool_session` | `subscription-pool/__tests__/subscription-bridge.test.ts` |
| Bridge → runner: đổi xong, `openPoolRequest` thật với cùng `x-conversation-id` dùng tài khoản mới; pool vẫn chuyển khi tài khoản đó trả 429 có xác nhận hết quota | như trên, dùng `test-harness.ts` |
| Dấu login riêng: ghi khi rơi về login riêng ở lượt chính, không ghi ở lượt phụ (`bindSession: false`), xóa khi pool phục vụ lại | `pool-forwarding.test.ts` |
| Không đổi hành vi khi không dùng tính năng | `pool-off-identical.test.ts`, `claude-pool-forwarding.test.ts` vẫn qua |
| Injector: có/không khối, prewarm = execute | `injection/injectors/__tests__/subscription-tools-injector.test.ts` |
| Core gửi `display_name`, `account_label`, không gửi `refresh_token` | `MemoryCore/src/metadata/store/subscription-pool.service.test.ts` (mở rộng ca ở dòng 109-115) |
| Bộ cài | xem giai đoạn 5 |

## E2E thật

Môi trường: prod sau giai đoạn 7, bằng tài khoản System Admin (đã chốt). Cần: một user System Admin, một user thường, pool mỗi provider có ít nhất 2 tài khoản (A, B). Tiến trình dev: kiểm `lsof -i :8096 -i :8420`, dùng lại tiến trình đang chạy; log ở `/tmp/agent-memory-logs/`; dừng những gì mình mở khi xong.

Với từng client (Claude Code 2.1.289, Codex 0.166):

1. Cài lối tắt: `curl -fsSL <proxy>/setup/hooks.sh | bash -s -- --client <client>`.
2. Admin, phiên mới: hỏi "tài khoản subscription nào đang phục vụ cuộc hội thoại này?". Đạt khi: model gọi `subscription-bridge/v1/current`; câu trả lời nêu email A hoặc B và provider; log Proxy của lượt trước có cùng `account_id`.
3. Admin: `/sub <email B>` (Claude Code) hoặc `$sub <email B>` (Codex). Đạt khi: bridge log `account switch … to=<id B>`; lượt kế tiếp log pool dùng `account_id` B; `/sub` trả email B.
4. Admin: đổi sang email không có trong pool → câu trả lời nêu lý do (`account_not_in_pool`).
5. Admin: đánh dấu B Exhausted (Panel "Check now" hoặc tài khoản thật hết quota) rồi đổi sang B → nêu giờ reset.
6. Admin, Codex có login riêng (`setup-proxy.sh --codex-own-login`) và pool hết tài khoản phục vụ được → `/sub` báo đang dùng login riêng.
7. Subagent: trong phiên admin, cho subagent hỏi tài khoản → cùng kết quả với phiên cha.
8. User thường: system prompt không có `<subscription_tools>` (xem log injection/Langfuse của lượt); `curl` thẳng bridge với `x-conversation-id` của chính phiên đó → HTTP 403 `not_system_admin`.
9. Ghi nhớ: lượt `/sub` có trong L0 (tìm bằng `tdai_conversation_search`), tức không bị lọc.

Ghi kết quả vào `plans/261103-0051-account-switch/reports/e2e-account-switch.md`: client, bước, kết quả, `account_id` (không email người khác, không token).

## Tiêu chí đạt

- Mọi lệnh test ở bảng đầu qua.
- E2E bước 2-9 đạt cho cả hai client, hoặc ghi rõ bước nào không làm được và vì sao.

## Rủi ro

| Rủi ro | Khả năng × ảnh hưởng | Giảm thiểu |
|---|---|---|
| Không có tài khoản thật để e2e local | Cao × Trung bình | Đã chốt: e2e trên prod sau deploy |
| E2E đổi binding của phiên thật | Thấp × Thấp | Dùng phiên thử riêng; binding tự hết hạn sau 2 ngày |
| Tiến trình dev bị bỏ lại | Trung bình × Thấp | Ghi PID, dừng khi xong |

## Lùi lại

Không có thay đổi sản phẩm ở giai đoạn này. Dừng tiến trình đã mở.
