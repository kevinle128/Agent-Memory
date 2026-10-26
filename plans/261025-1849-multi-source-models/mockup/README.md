# Mockup: tab Model Provider và phần nguồn trên tab Pool (Panel)

Mockup bấm được cho giai đoạn 8 của kế hoạch (`../plan.md`, `../phase-08-panel-sources-page.md`). Đây là một tệp HTML tĩnh: CSS và JS nằm trong tệp, không tải gì từ mạng. Mọi key là placeholder (`sk-••••`).

## Mockup thể hiện những gì

- **Tab Model Provider.** Tab mới, nằm ngay sau "Pool tài khoản thuê bao" trong nhóm "Tổ chức & quyền". Tab này **chính là** trang quản lý nhóm upstream custom (nguồn API key).
- **Mỗi nhóm có hai đường độc lập:**
  - **Dùng cho cả agent** (hành vi cũ): gồm `agents`, `model_id`, `enabled`. `model_id` vẫn ghi đè model như hôm nay, nhưng chỉ cho đường này.
  - **Dùng làm nguồn** (mới): gồm `source_name`, `source_formats`, `source_agents`, `source_models`, `source_enabled`. Proxy gửi id model thật lên nhà cung cấp và không đọc `model_id`.
- **Không vướng `agents_overlap`.** Agent nhiều nguồn nằm trong `source_agents`, không nằm trong `agents`, nên quy tắc "một agent chỉ ở một nhóm" không áp dụng cho chúng.
- **Nhóm cũ (chưa có trường nguồn)** chỉ hiện ở cột "Dùng cho cả agent". Admin thấy thêm nút "Dùng làm nguồn".
- **Nguồn thuê bao sửa trên tab Pool tài khoản thuê bao** (câu 2 = A). Mỗi tab Claude Code / Codex có thêm một thẻ "Dùng làm nguồn".
- **Nguồn thuê bao bật/tắt theo công tắc pool** (câu 3 = B). Thẻ nguồn không có công tắc `source_enabled`, chỉ ghi "Nguồn bật/tắt theo pool". Khi pool tắt:
  - thẻ nguồn và màn "Client sẽ thấy" hiện "Nguồn đang tắt vì pool tắt";
  - model `sub-*` không có trong `/v1/models`;
  - hộp xác nhận tắt pool có thêm dòng: nguồn cũng tắt, và omp/hermes/openclaw nhận `model_source_disabled`.

  `source_enabled` chỉ còn trên nhóm của tab Model Provider.
- **Tên nguồn không đổi được sau khi lưu** (câu 1 = D). Tên chỉ nhập lúc tạo, hoặc lúc gắn nguồn lần đầu cho nhóm cũ. Không có luồng đổi tên.
- **`custom_passthrough` không dùng được làm nguồn** (câu 7 = A). Nhóm passthrough vẫn liệt kê và chọn được cho đường "Dùng cho cả agent", có nhãn "không dùng được làm nguồn". Không có trường nguồn, không lấy model.
- **Chỉ omp, không có pi** (quyết định 10, câu 6 = A). pi không có trong danh sách agent.
- **Model của nguồn API key tắt mặc định** (câu 12 = A), cả ở lần lấy đầu và model mới về sau; có ô tìm và "Chọn tất cả" cho kết quả đang lọc.
- **`source_agents` tích sẵn omp, hermes, openclaw khi tạo nguồn** (câu 13 = A).
- **Một pool một nguồn** (câu 11 = A).
- **Ai được làm gì.** Mọi người xem được cả hai tab. Chỉ System Admin sửa được.
- **Claude Code và Codex không đổi.** Chúng hiện là dòng khóa.

## Cách mở

- Mở `index.html` bằng trình duyệt, hoặc mở thẳng một màn: `index.html#1` đến `index.html#7`.
- Thanh tím chỉ có trong mockup. Trên thanh có:
  - nút chọn màn;
  - nút "Xem như: Admin / Thành viên";
  - ô bật/tắt ghi chú thiết kế màu vàng.
- Menu bên trái chuyển được giữa "Pool tài khoản thuê bao" và "Model Provider".
- Dữ liệu chỉ nằm trong bộ nhớ trang. Tải lại trang thì về dữ liệu mẫu.

## Các màn

**1. Model Provider** (`#1`). Bảng các nhóm custom, chia bốn cột:

- **Nhóm:** tên, nhà cung cấp, base URL, mode, trạng thái key ("key đã cấu hình").
- **Dùng cho cả agent:** `agents`, `model_id`, công tắc `enabled`.
- **Dùng làm nguồn (mới):** tên nguồn, định dạng, model bật x/y, `source_agents`, lần lấy model (hoặc lỗi lần cuối), công tắc `source_enabled`.
- **Thao tác.**

Các nhóm mẫu:

- "DeepSeek" dùng cả hai đường: dsh dùng nhóm với `model_id` cố định, còn omp và openclaw gọi `api-deepseek/<model>`.
- "Kimi cho CodeBuddy" là nhóm cũ, có nút "Dùng làm nguồn".
- "Key riêng từng người" là nhóm passthrough cho workbuddy, có nhãn "không dùng được làm nguồn".

Bên dưới bảng có thẻ "Nguồn thuê bao (chỉ xem ở đây)" với link sang tab Pool, và khung "Cách đặt tên model cho client".

**2. Thêm provider** (`#2`). Form có ba phần:

- **Thông tin nhóm (đã có).** Nhà cung cấp (cột mới `source_provider`), `name`, `mode`, `base_url`, `api_key`, `description`.
- **Dùng cho cả agent (hành vi cũ).**
  - Lưới chọn `agents`. Agent đã ở nhóm khác bị khóa và ghi tên nhóm đó. Claude Code và Codex khóa vì đang ở pool.
  - `model_id`, kèm giải thích "như hôm nay, không ảnh hưởng nguồn".
  - Công tắc `enabled`.
- **Dùng làm nguồn (mới).**
  - Công tắc "Dùng làm nguồn".
  - Tên nguồn: gợi ý `api-<nhà cung cấp>`, sửa được, kiểm tra ngay khi gõ, dòng "Không đổi được sau khi lưu".
  - Định dạng: chọn nhiều.
  - `source_agents`: omp, hermes, openclaw; Claude Code và Codex khóa.
  - Bảng model: nút "Lấy danh sách model" / "Làm mới", thời điểm lấy, lỗi lần cuối, ô tìm, "Chọn tất cả" (chỉ áp dụng cho kết quả đang lọc). Model không còn ở nhà cung cấp hiện mờ.
  - Công tắc `source_enabled`.

Form chặn lưu nếu chưa có ít nhất một agent ở `agents` hoặc ở `source_agents` (giống điều kiện của Core).

**3. Sửa provider** (`#3`). Sửa "OpenAI key công ty". Tên nguồn `api-openai` chỉ đọc, kèm dòng giải thích. Model `gpt-5.5` hiện mờ với nhãn "không còn ở nhà cung cấp".

**4. Nhóm cũ → Dùng làm nguồn** (`#4`). Mở nhóm "Kimi cho CodeBuddy" và bật phần nguồn. Phần agent (codebuddy, opencode, `model_id` kimi-k3) giữ nguyên. Tên nguồn được gợi ý (`api-moonshot`) và chỉ sửa được trước lần lưu đầu.

**5. Pool Claude: phần nguồn** (`#5`). Trang Pool tài khoản thuê bao hiện có, rút gọn: tiêu đề, tab Claude Code / Codex, công tắc pool, thẻ tổng quan, bảng tài khoản. Bên dưới là thẻ mới "Dùng làm nguồn" của `sub-claude`:

- Tên nguồn cố định sau khi tạo.
- Định dạng cố định theo pool.
- `source_agents`.
- Bảng model dạng công tắc, mặc định bật tất cả; model mới xuất hiện cũng tự bật.
- Dòng trạng thái "Nguồn bật/tắt theo pool". Không có công tắc riêng.

Bấm công tắc Pool để mở hộp xác nhận. Tắt pool thì thẻ hiện "Nguồn đang tắt vì pool tắt" và `sub-claude/*` biến mất khỏi màn 7. Thay đổi trong thẻ được ghi ngay.

**6. Pool Codex: tạo nguồn** (`#6`). Pool Codex chưa là nguồn, nên thẻ hiện bước tạo:

- Tên nguồn gợi ý `sub-openai`, sửa được, kiểm tra ngay khi gõ, kèm dòng "Tên không đổi được sau khi lưu".
- Định dạng cố định.
- `source_agents`.
- Model lấy tự động, mặc định bật tất cả.
- Nút "Tạo nguồn". Sau khi tạo, tên chuyển sang chỉ đọc và `sub-openai/*` xuất hiện ở màn 7.

**7. Client sẽ thấy** (`#7`). `/v1/models` theo từng agent, gộp nguồn thuê bao (tab Pool, chỉ khi pool bật) và provider (tab này). Nguồn thuê bao đang tắt vì pool tắt có cảnh báo riêng. Chỉ có tab omp, hermes, openclaw (câu 10 = A), kèm một dòng ghi chú: Claude Code và Codex dùng pool riêng và được cài bằng setup-proxy như hôm nay. Tab omp có snippet `~/.omp/agent/models.yml` (ba provider `memory-anthropic`, `memory-responses`, `memory-chat`, theo câu 9 = A và giai đoạn 7) và nút Sao chép.

**Chế độ Thành viên** (chọn "Xem như: Thành viên"):

- Màn 2 và 4 bị khóa.
- Model Provider không có nút thêm, công tắc, sửa, xóa, "Dùng làm nguồn". Cột cuối chỉ có "Xem".
- Form xem khóa mọi ô và không có nút lấy model hay lưu. Key chỉ hiện "Đã cấu hình" / "Chưa có", theo quy tắc của `groups/view` trong phase-08.
- Tab Pool không có công tắc pool, cột thao tác và nút sửa nguồn. Pool chưa là nguồn thì chỉ có dòng "Chỉ System Admin tạo được".

## Dựa trên trang và style nào

Đường dẫn tính từ gốc repo `Agent-Memory/`:

- **Trang mẫu:** `MemoryPanel/web/src/pages/SubscriptionPoolPage/`.
  - `index.tsx:68`: `readOnly = !isGlobalAdmin`.
  - `components/PoolHeader.tsx`, `PoolSummary.tsx`, `AccountTable.tsx`: bỏ cột thao tác khi `readOnly`.
  - `components/DeleteAccountDialog.tsx`.
  - `style.css`.
- **Khung app:**
  - `MemoryPanel/web/src/layouts/ConsoleLayout.tsx`.
  - `layouts/GlobalHeader/style.css`.
  - `layouts/TabBar/style.css`.
  - `src/constants/menu.tsx`.
- **Token:**
  - `MemoryPanel/web/src/index.css`.
  - `src/tea-override.css`.
  - `MemoryPanel/web/node_modules/tea-component/dist/style/mixins/_var-color-light.scss`.
- **Trường nhóm và agent:**
  - `MemoryCore/src/metadata/types.ts:645-690`.
  - `MemoryCore/src/metadata/router/v3-meta-schemas.ts:531-543`.
  - `MemoryCore/src/metadata/default-supported-agents.ts:43-51`.
  - Cột mới theo bảng "Mô hình dữ liệu" trong `../plan.md`.
- **Ngôn ngữ:** Panel có i18n (`src/i18n/zh-CN.ts`, `en-US.ts`), nên mockup dùng tiếng Việt. Tên tab giữ "Model Provider".

## Giả định còn lại (không cần bạn quyết định)

- Snippet omp: một nguồn có nhiều định dạng chỉ được liệt kê dưới provider của **định dạng đầu tiên** (trường `format` của `/v1/models`, giai đoạn 6). Dạng khối `models:` (`- id: <nguồn>/<model>`) khớp schema omp (`models-config-schema-bundle.ts:202-224, 341-351`); PR 5b bắt gói kiểm tra lại, và chỉ chuyển sang một provider với `api`/`baseUrl` theo từng model nếu bắt gói chứng minh omp dùng đúng (câu 9).
- Trong form, chế độ `custom_passthrough` bị khóa khi nhóm đã là nguồn (Core trả `SOURCE_MODE_NOT_ALLOWED`).
- Codex bắt đầu ở trạng thái "chưa là nguồn", nên mặc định màn 7 chưa có `sub-openai/*`. Trạng thái "pool chưa từng bật" chỉ ghi trong ghi chú, chưa vẽ.
- Bước tạo nguồn trên tab Pool vẫn cho tạo khi pool đang tắt; nguồn tạo xong ở trạng thái tắt cho tới khi bật pool (câu 3 = B).
