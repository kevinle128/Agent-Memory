# Giai đoạn 8: Panel, tab "Model Provider" và phần nguồn trên tab Subscription Pool

## Quyết định của bạn cho giai đoạn này

- Câu 1: "D" — không đổi tên nguồn sau khi lưu.
- Câu 2: "A" — admin sửa trường nguồn thuê bao ngay trên tab Subscription Pool (tên nguồn chỉ ở bước tạo; model bật; `source_agents`); người khác chỉ đọc. (Bản gốc của câu 2 có nêu `source_enabled`; theo câu 3 "B" nguồn thuê bao bật/tắt cùng pool, nên không có công tắc này trên tab pool.)
- Câu 3: "B" — tắt pool thì nguồn thuê bao của pool cũng tắt; nguồn thuê bao không có công tắc riêng.
- Câu 7: "A" — nhóm `custom_passthrough` không làm nguồn được.
- Câu 8: "A" — pool tắt thì ô xem trước ẩn model của pool.
- Câu 9: "A" (kỹ thuật) — đoạn `models.yml` có ba provider.
- Câu 10: "A" — ô xem trước chỉ có tab omp, hermes, openclaw và một dòng ghi chú về Claude Code/Codex.
- Câu 11: "A" — mỗi pool đúng một nguồn; giới hạn agent/model sửa trên nguồn đó.
- Câu 12: "A" — model của nguồn API key tắt mặc định (lần lấy đầu và model mới về sau), admin tích; bảng model có tìm kiếm và bật/tắt hàng loạt.
- Câu 13: "A" — form tạo nguồn tích sẵn omp, hermes, openclaw trong `source_agents`; admin bỏ tích được.

"the new Panel page is a new nav tab "Model Provider", and it is the custom upstream groups management (API-key sources). Subscription sources stay managed on the existing Subscription Pool tab."

## Bối cảnh

- Panel không có UI nhóm upstream. `ApiKeysPage` chỉ quản lý user key `sk-mem`.
- Tab Subscription Pool: route `team/subscription-pool` (`MemoryPanel/web/src/routes/index.tsx:17, 35`), `PageId` `subscription_pool` (`MemoryPanel/web/src/constants/menu.tsx:28`), mục menu nhóm "organization" `order: 3` (`menu.tsx:57`), icon `menu.tsx:78`, ánh xạ path `MemoryPanel/web/src/layouts/ConsoleLayout.tsx:31`. Mục menu hiện cho mọi người dùng (bộ lọc menu `ConsoleLayout.tsx:140-174` không lọc `subscription_pool`); trang chạy chế độ chỉ đọc khi người dùng không phải global admin (`MemoryPanel/web/src/pages/SubscriptionPoolPage/index.tsx:68`, `readOnly = !auth || !isGlobalAdmin(auth.user, auth.isAdmin)`, hàm ở `MemoryPanel/web/src/services/permissions.ts:20`). Thanh tab đang mở (`TabBar`) ẩn tab pool với người không phải admin (`ConsoleLayout.tsx:224-225`). Tab Model Provider không thêm vào bộ lọc này, nhãn `MemoryPanel/web/src/i18n/en-US.ts:1924-1925` (và `zh-CN.ts`).
- Panel chỉ gọi action trong `ALLOWED_PANEL_ACTIONS` (`MemoryPanel/src/panel/api/meta-actions.ts:117`; action pool ở dòng 89-99; kiểm tra ở `MemoryPanel/src/panel/http/routes/meta/proxy.ts:160`). Action `instance-upstream/*` chưa có.
- Core API nhóm: `v3-meta-router.ts:397-433` cộng 3 action mới của giai đoạn 2-3. Mọi action nhóm hiện gọi `s.assertCanManageUsers(c)` (`metadata-service.ts:797-801`), kể cả `groups/list`, nên người không phải admin hôm nay không đọc được nhóm. `subscription-pool/status` không kiểm tra quyền (`v3-meta-router.ts:451-453`); các action ghi của pool thì có.
- Che key hôm nay: `groups/list` công khai trả `api_key_masked` bằng `maskKeyValue` (`metadata-service.ts:3138-3152`), tức **8 ký tự đầu** của key + "…" (`MemoryCore/src/metadata/utils/user-key.ts:12-16`). List nội bộ cho proxy trả key rõ (`internal-meta-router.ts:103-107`).

## Quyền (theo cách của tab Subscription Pool)

| Việc | Ai | Kiểm tra ở đâu |
|---|---|---|
| Thấy tab, xem danh sách nhóm custom và model | Mọi người dùng đã đăng nhập | Core: action đọc mới `instance-upstream/groups/view` chỉ cần đăng nhập |
| Tạo, sửa, xóa, bật/tắt nhóm; tích model; lấy model (`groups/source-refresh`); gợi ý tên | Chỉ global admin | Core: `assertCanManageUsers` trên mọi action ghi (giữ như hiện có, thêm cho 3 action mới). UI chỉ ẩn nút; không dựa vào UI |

Quy tắc che key:
- `groups/view` (mọi người dùng) **không có trường key nào**: không `api_key`, không `api_key_masked`; chỉ `api_key_configured: boolean`. Lý do: `maskKeyValue` để lộ 8 ký tự đầu, với nhiều nhà cung cấp đó là một phần bí mật của key.
- `groups/list` (admin) giữ nguyên như hôm nay (`api_key_masked`), không đổi hợp đồng.
- Chỉ list nội bộ (service token của proxy) có key rõ. Không action Panel nào trả key rõ.
- `source_models_error` không bao giờ chứa key (giai đoạn 3).

## Thay đổi

### Chung

1. Core (thuộc giai đoạn 2, ghi ở đây để rõ): thêm action `instance-upstream/groups/view` trả nhóm `group_type = custom` (không gồm pool, default, extraction) theo quy tắc che key ở trên; các trường nguồn và `source_models` có trong kết quả. Không đổi `groups/list`.
2. Thêm vào `ALLOWED_PANEL_ACTIONS`: `upstream/supported-agents`, `instance-upstream/groups/view`, `instance-upstream/groups/list`, `groups/create`, `groups/update`, `groups/toggle`, `groups/delete`, `groups/suggest-source-name`, `groups/source-models/update`, `groups/source-refresh`.
3. Client API `MemoryPanel/web/src/lib/api/model-providers.ts` (gọi các action nhóm). Trang pool dùng lại client này cho phần nguồn.

### Tab "Model Provider" (nhóm custom = nguồn API key)

1. `PageId` mới `model_provider`, route `team/model-provider`, path trong `ConsoleLayout.tsx` `PATH_TO_PAGE`, mục menu cùng nhóm "organization" với `order: 4` (ngay sau Subscription Pool; dời các mục sau nếu trùng `order`), hiện cho mọi người dùng (không thêm vào bộ lọc `TabBar`). Nhãn i18n `menu.model_provider` = "Model Provider" (en-US) và bản zh-CN.
2. Trang `MemoryPanel/web/src/pages/ModelProviderPage/`. `readOnly = !auth || !isGlobalAdmin(auth.user, auth.isAdmin)` như trang pool. Chỉ đọc: dữ liệu từ `groups/view`, ẩn nút tạo/sửa/xóa/bật tắt/tích model/làm mới, key hiện "đã cấu hình" hoặc "chưa có". Admin: dữ liệu từ `groups/list` cộng trường nguồn. Chỉ liệt kê nhóm `group_type = custom` với mode `custom_unified`/`custom_passthrough`. Không liệt kê nhóm pool, default, extraction.
3. Danh sách: tên nhóm, provider, base URL, key (che), `agents`, `model_id`, tên nguồn, định dạng, số model bật, `source_agents`, trạng thái lấy model, hai công tắc (`enabled` cho `agents`, `source_enabled` cho nguồn).
4. Tạo/sửa nhóm:
   - Phần chung: tên nhóm, provider (danh sách có sẵn + "khác"), base URL, key (ô mật khẩu), mode.
   - Phần "Dùng cho cả agent": `agents`, `model_id` (nghĩa như hôm nay). Ô chọn `agents` không có claude-code/codex khi chúng đang ở nhóm pool (Core cũng chặn trùng). Đổi nhóm của một agent cần hộp xác nhận.
   - Nhóm `custom_passthrough` (câu 7 "A"): vẫn liệt kê và sửa phần chung/"Dùng cho cả agent" như hôm nay, kèm nhãn "không dùng được làm nguồn" (giải thích: nhóm này gửi key của client lên upstream). Không có phần "Dùng làm nguồn", không có nút lấy model.
   - Phần "Dùng làm nguồn" (chỉ khi mode `custom_unified`): tên nguồn điền sẵn bằng `groups/suggest-source-name`, sửa được, kiểm tra dạng khi gõ, lỗi trùng dưới ô; định dạng; `source_agents` (chỉ agent `multi_source`; khi tạo nguồn tích sẵn cả ba omp, hermes, openclaw theo câu 13 "A", admin bỏ tích được; khi sửa nguồn đã có thì hiện đúng giá trị đã lưu); bảng model có ô tích, ô tìm kiếm theo id/tên, nút "Bật tất cả đang lọc" và "Tắt tất cả đang lọc" (gửi một lần qua `groups/source-models/update`), bộ lọc "chỉ model mới chưa tích", nút "Làm mới", thời điểm lấy, lỗi lần cuối (không có key), model `available=false` hiện mờ; ví dụ model id `<tên>/<model>`.
   - Tên nguồn (câu 1, đã chọn D): sửa được trong form tạo, trước lần lưu đầu. Sau khi lưu, ô tên chỉ đọc, kèm dòng giải thích "Tên nằm trong model id của client nên không đổi được. Muốn tên khác: tạo nhóm mới." Gắn nguồn lần đầu cho một nhóm đã có cũng theo cùng quy tắc.
5. Xóa nhóm: hộp xác nhận nêu agent và client nguồn bị ảnh hưởng.

### Tab Subscription Pool (nguồn thuê bao)

1. Luồng bật/tắt pool và tài khoản không đổi.
2. Câu 2 đã chọn **"A"**: mỗi khối provider (`claude`, `codex`) có phần "Dùng làm nguồn", sửa ngay trên tab này.
   - Global admin sửa được: tên nguồn (chỉ ở bước tạo, gợi ý `sub-claude`/`sub-openai`; sau khi lưu chỉ đọc vì không đổi tên, câu 1 "D"), bảng model với ô tích và nút "Làm mới", `source_agents` (chỉ agent `multi_source`; khi tạo nguồn tích sẵn cả ba omp, hermes, openclaw theo câu 13 "A", admin bỏ tích được; khi sửa nguồn đã có thì hiện đúng giá trị đã lưu). Không có công tắc nguồn: trạng thái nguồn đi theo công tắc pool (câu 3 "B").
   - Người khác thấy cùng phần đó ở chế độ chỉ đọc, theo `readOnly` sẵn có của trang (`SubscriptionPoolPage/index.tsx:68`).
   - Ghi: gọi `groups/update` trên nhóm pool, chỉ gửi trường nguồn (không gửi `agents`, `enabled`, `mode`); `groups/source-models/update` và `groups/source-refresh` cho model. Core kiểm tra `assertCanManageUsers` ở mọi action này.
   - Đọc: `subscription-pool/status` (mọi người dùng gọi được, `v3-meta-router.ts:451-453`) trả thêm khối `source` cho mỗi provider: `source_name`, `source_formats`, `source_agents`, `source_active` (= pool bật), `source_models`, `source_models_fetched_at`, `source_models_error`. Khối này không có key (nhóm pool không có `api_key`; token tài khoản không bao giờ nằm trong đó).
3. Trạng thái nguồn: khi pool tắt, phần nguồn hiện nhãn "Nguồn đang tắt vì pool tắt" và ô xem trước model id (`sub-claude/<model>`) hiện mờ kèm nhãn đó. Hộp xác nhận tắt pool (`PoolSwitchConfirmDialog`) thêm dòng: "Nguồn `<tên>` cũng tắt; omp/hermes/openclaw sẽ nhận lỗi `model_source_disabled`" khi pool có `source_name`.
3b. Mỗi khối provider có tối đa một phần "Dùng làm nguồn" (câu 11 "A"); không có nút "thêm nguồn".
4. Khi nhóm pool chưa có (chưa từng bật pool), phần nguồn hiện hướng dẫn "thêm tài khoản và bật pool một lần".
5. Định dạng của nguồn thuê bao cố định, chỉ hiển thị.

### Khung "Client sẽ thấy" (xem trước)

1. Có trên tab Model Provider (bên dưới bảng) và trong phần nguồn của tab Subscription Pool. Gộp nguồn API key và nguồn thuê bao, đúng như `GET /<agent>/<space>/v1/models` trả về (giai đoạn 6): chỉ nguồn bật, model bật và còn, agent có trong `source_agents`; pool tắt thì ẩn model của pool (câu 8 "A") và hiện một cảnh báo "Nguồn `<tên>` đang tắt vì pool tắt".
2. Chỉ có tab omp, hermes, openclaw (câu 10 "A"), cộng một dòng ghi chú: "Claude Code và Codex dùng pool riêng và được cài bằng setup-proxy như hôm nay; chúng không dùng tiền tố nguồn."
3. Tab omp có đoạn `~/.omp/agent/models.yml` mà setup-proxy sẽ ghi (ba provider `memory-anthropic`, `memory-responses`, `memory-chat`, câu 9 "A", giai đoạn 7), key hiện `sk-••••`, nút Sao chép. Tab hermes và openclaw hiện danh sách model theo định dạng.
4. Dữ liệu lấy từ `groups/view` (mọi người dùng) hoặc `groups/list` (admin) và `subscription-pool/status`; không gọi proxy. Model cùng tên ở nhiều nguồn có nhãn "n nguồn".

## Tệp

- Sửa: `MemoryPanel/src/panel/api/meta-actions.ts`, `MemoryPanel/web/src/constants/menu.tsx`, `MemoryPanel/web/src/routes/index.tsx`, `MemoryPanel/web/src/layouts/ConsoleLayout.tsx`, `MemoryPanel/web/src/i18n/en-US.ts`, `MemoryPanel/web/src/i18n/zh-CN.ts`, `MemoryPanel/web/src/pages/SubscriptionPoolPage/index.tsx` (và một component mới trong `SubscriptionPoolPage/components/` cho phần nguồn).
- Thêm: `MemoryPanel/web/src/lib/api/model-providers.ts`, `MemoryPanel/web/src/pages/ModelProviderPage/*`.

## Kiểm thử

- Component theo quy ước Panel: tab hiện cho mọi người dùng và nằm sau Subscription Pool; người không phải admin thấy chế độ chỉ đọc, không có nút ghi; kiểm tra dạng tên, lỗi trùng, ô tên chỉ đọc sau khi lưu; ẩn claude-code/codex trong `source_agents`; Model Provider không liệt kê nhóm pool; form tạo nguồn (cả hai tab) có omp, hermes, openclaw tích sẵn; bỏ tích một agent rồi lưu thì `source_agents` không có agent đó; mở lại nguồn đã lưu không tích lại agent đã bỏ; lần lấy đầu của nguồn API: mọi model chưa tích; tìm kiếm rồi "bật tất cả đang lọc" chỉ bật model khớp; làm mới không đổi ô đã tích; nhóm passthrough có nhãn "không dùng được làm nguồn" và không có phần nguồn hay nút lấy model; phần nguồn trên trang pool không gửi `agents`/`enabled`/`source_enabled`; pool tắt → nhãn "tắt vì pool tắt" ở phần nguồn và ô xem trước; hộp xác nhận tắt pool nêu nguồn bị tắt theo; người không phải admin thấy phần nguồn của pool ở chế độ chỉ đọc; `subscription-pool/status` có khối `source` và không có token.
- Thủ công local (Core + Hub): tạo `api-deepseek` chỉ làm nguồn trên Model Provider; gắn `sub-openai` trên Subscription Pool; tích model; thử sửa tên sau khi lưu (Core trả `SOURCE_NAME_IMMUTABLE`); kiểm tra `/omp/<s>/v1/models` sau mỗi bước; bật/tắt pool vẫn như cũ.
- Khung "Client sẽ thấy": chỉ ba tab omp/hermes/openclaw và một dòng ghi chú; tắt pool thì model `sub-*` biến mất và có cảnh báo; đoạn `models.yml` có ba provider.
- Network log trình duyệt không có key rõ sau khi lưu; với tài khoản không phải admin, phản hồi không có `api_key` hay `api_key_masked`.
- Core: người không phải admin gọi trực tiếp `groups/create|update|delete|toggle`, `groups/source-models/update`, `groups/source-refresh`, `groups/suggest-source-name` → `permission_denied`; gọi `groups/view` → 200 không có trường key.

## Rủi ro và lùi lại

- Admin sửa nhầm nhóm của agent khác: hộp xác nhận; Core đã kiểm tra trùng.
- Lùi: deploy image Hub cũ; dữ liệu nhóm không bị ảnh hưởng.
