# Kế hoạch: skill toàn cục và skill dự án

Nhánh `feat/server_team`. Nghiên cứu: `plans/reports/researcher-261024-0307-skill-project-scope.md`. Mô hình dự án: `docs/adr/0002-project-scoped-memory.md`.

## Kết quả mong muốn

- Session chỉ nhận skill toàn cục và skill của đúng dự án đang làm (dự án lấy từ báo cáo của hook). Không bao giờ nhận skill của dự án khác. Không biết dự án thì chỉ nhận skill toàn cục.
- Trích xuất tự động chỉ tạo skill dự án. Session không có dự án thì không trích xuất.
- Người dùng tự thêm skill toàn cục hoặc skill dự án, và chuyển được một skill trích xuất thành skill toàn cục.
- Giao diện Panel phân biệt rõ hai loại skill.

## Quyết định đã chốt (không đổi nếu bạn chưa đồng ý)

1. Trích xuất tự động chỉ tạo skill dự án; hệ thống không bao giờ tự tạo skill toàn cục.
2. Người dùng chủ động thêm skill toàn cục hoặc skill dự án.
3. Dự án của session lấy từ báo cáo của hook. Không có dự án (ví dụ `~/Movies`) thì không trích xuất.
4. Chặn ở lúc trích xuất, trong Core. Việc gom hội thoại vẫn như cũ.
5. Xóa toàn bộ 112 skill đã trích xuất cũ.
6. Người dùng chuyển được skill trích xuất thành skill toàn cục bằng thao tác rõ ràng; sau đó skill do người dùng quản lý, bộ trích xuất không sửa nữa.
7. 18 skill mẫu (`api-docs`, `code-review`, `unit-test`) thành skill mẫu, phạm vi toàn cục, sau khi kiểm tra nội dung.
8. Codex và pi được bổ sung phần nhận dự án từ hook.
9. `promptMode` giữ ở mức instance. `code`: theo kiểu mới. `chat`: giữ kiểu cũ (không có dự án, skill trích xuất là skill chung, inject như cũ). Trên production instance là `code`, nên hermes và openclaw không trích xuất skill.
10. Tên dự án là `owner/repo` của remote mà hook dùng (`origin`), ví dụ `kevinle128/paseo`; repo không có remote thì là tên thư mục gốc. `getpaseo/paseo` là dự án riêng. `project_hash` và `project_key` giữ nguyên như hiện tại (không chuyển dữ liệu); tên chỉ để hiển thị trên giao diện và trong khối inject. Bộ trích xuất được đọc skill toàn cục nhưng không được sửa.

11. Skill toàn cục: hệ thống được đề xuất sửa để skill tốt hơn, nhưng chỉ áp dụng khi người dùng duyệt (hỏi bằng `AskUserQuestion`). Skill dự án: hệ thống tự áp dụng, không hỏi. Cả hai có lịch sử sửa, lý do sửa, người duyệt, phiên bản hiện tại và rollback về phiên bản cũ. (Thay cho ý "bộ trích xuất chỉ đọc skill toàn cục" ở mục 10: nay bộ trích xuất được đề xuất, không được tự áp dụng.)
12. Thiết kế phải dễ bảo trì, đúng kiến trúc và design pattern (xem mục "Kiến trúc").

## Kiến trúc

Dựa trên mã hiện có: phiên bản skill đã lưu dạng chỉ thêm (`appendVersion`, `is_head`, `MemoryCore/src/core/store/sqlite/skill-store.ts:273-466`); API lịch sử `/v3/skill/versions` (`gateway/skill-handlers.ts:585`); Panel có màn hình lịch sử chỉ đọc (`SkillDetailPane.tsx`); proxy có form `AskUserQuestion` dùng chung (`MemoryProxy/src/session/form.ts`, `session/claude-code/extractor.ts`, SessionStore). Chưa có: lý do sửa, người duyệt, rollback, trạng thái chờ duyệt.

**Nguyên tắc:**

1. **Một cửa duy nhất cho mọi thay đổi skill (domain service trong Core).** `SkillChangeService.submit(change)` là đường duy nhất làm đổi nội dung skill: bộ trích xuất, người dùng sửa, rollback, chuyển thành toàn cục, tạo mới. Không chỗ nào khác được gọi thẳng `appendVersion`. Quy tắc nằm ở một nơi nên dễ đọc, dễ test, không bị lệch giữa các đường.
2. **Quy tắc duyệt là một chiến lược (Strategy).** `ChangeApprovalPolicy.decide(change, skill)` trả về `apply` hoặc `require_approval`:
   - skill dự án: `apply`;
   - skill toàn cục, thay đổi do hệ thống đề xuất: `require_approval`;
   - thay đổi do chính người dùng làm (sửa tay, rollback, chuyển thành toàn cục): `apply`, người duyệt là người đó;
   - chế độ `chat`: `apply` (giữ kiểu cũ).
   Muốn đổi quy tắc sau này chỉ cần thêm hoặc sửa một policy, không đụng nơi khác.
3. **Lịch sử chỉ thêm, không sửa (append-only audit log).** Mỗi phiên bản ghi: `change_source` (`extracted`, `manual`, `rollback`, `promotion`, `template`), `change_reason`, `change_summary` (tóm tắt cải tiến so với phiên bản trước: thêm gì, sửa gì, bỏ gì, 2-5 ý), `approved_by`, `approved_at`, `base_version`, `proposal_id`. Tóm tắt được tạo lúc sửa và lưu cùng phiên bản, không tính lại mỗi lần xem: bộ trích xuất bắt buộc ghi (thiếu thì thay đổi bị từ chối); sửa tay thì người dùng nhập, hoặc hệ thống tạo và đánh dấu là tự tạo; rollback và chuyển thành toàn cục dùng câu cố định (ví dụ "Khôi phục nội dung v2"). Đề xuất chờ duyệt cũng mang tóm tắt này để người duyệt biết thay đổi đem lại gì. Rollback tạo một phiên bản mới chép nội dung của phiên bản cũ, không xóa gì, nên lịch sử luôn đầy đủ.
4. **Đề xuất có vòng đời rõ ràng (state machine).** Bảng `skill_change_proposals`: `pending` → `approved` | `rejected` | `stale` | `expired`. Đề xuất ghi `base_version`; lúc duyệt, nếu phiên bản hiện tại đã khác `base_version` thì chuyển `stale` và không áp dụng (khóa lạc quan, tránh ghi đè thay đổi mới hơn). Chỉ chuyển trạng thái qua service, có kiểm tra chuyển hợp lệ.
5. **Lưu trữ qua repository có sẵn.** Thêm cột và bảng qua lớp store hiện có (sqlite, mongo, tcvdb) theo mẫu DDL chạy lại an toàn; domain service không biết backend.
6. **Proxy và Panel chỉ là lớp hiển thị (ports and adapters).** Core sở hữu quy tắc và trạng thái. Proxy hỏi người dùng bằng `AskUserQuestion` rồi gọi API duyệt hoặc từ chối của Core. Panel hiện cùng danh sách đề xuất, lịch sử, nút rollback và gọi cùng API. Không lớp hiển thị nào tự quyết định.
7. **Hiển thị đề xuất trong session (proxy).** Dùng lại bộ dựng form và bộ đọc câu trả lời hiện có, thêm một "câu hỏi" mới chứ không viết lại form:
   - chỉ ở request `main` của Claude Code có tool `AskUserQuestion`, không ở fork, subagent, request phụ, và không khi đang ở form khác (khởi tạo session);
   - mỗi lần hỏi một đề xuất, có lý do và tóm tắt cải tiến; lựa chọn: "Duyệt", "Từ chối", "Để sau";
   - "Để sau" giữ `pending` và không hỏi lại trong cùng session; giới hạn số lần hỏi để không làm phiền;
   - người duyệt là user của session (lấy từ xác thực, không lấy từ nội dung request);
   - sau khi trả lời, chuyển tiếp prompt gốc của người dùng như cơ chế hiện có.
8. **Kiểm tra quyền ở Core.** API duyệt kiểm tra người duyệt có quyền với skill đó (chủ agent hoặc team); proxy không tự cấp quyền.

## Định nghĩa

- `scope`: `global` hoặc `project`.
- `origin`: `extracted`, `manual` hoặc `template`.
- Ràng buộc trong Core (không chỉ trong prompt): `origin = extracted` thì bắt buộc `scope = project` và có `project_hash`. Bộ trích xuất không đặt được `scope`.
- Chế độ `code` hay `chat` lấy từ `promptMode` của instance (`MemoryCore/src/config.ts`). Proxy hỏi Core giá trị này, không có cấu hình riêng.

## Các giai đoạn

### Giai đoạn 0: Tên dự án (Proxy và Core)

- `buildProjectIdentity` (`MemoryProxy/src/project-scope/project-key.ts`) trả thêm `projectName`: `owner/repo` lấy từ phần đường dẫn của remote đã chuẩn hóa (bỏ host); không có remote thì là tên thư mục gốc. `projectHash` và `projectKey` không đổi.
- Lưu `projectName` cùng báo cáo của hook (`SessionWorkspace`), đưa vào `TdaiIdentity`, gửi kèm cho Core (L0 và lượt gom skill) dưới dạng `project_name` để Core có nguồn tên dự án cho giao diện.
- Khối `<project_memory>` dùng tên dự án thay cho 8 ký tự đầu của hash.
- Test: `kevinle128/paseo` từ ssh/https/có port; GitLab nhiều cấp nhóm (`group/sub/repo`); không có remote.

### Giai đoạn 1: Lưu trữ và ràng buộc (Core)

- Thêm vào mỗi phiên bản skill: `scope`, `project_key`, `project_hash`, `project_name`, `origin`, `source_session_id`. SQLite: `ALTER TABLE ... ADD COLUMN` theo mẫu DDL chạy lại an toàn hiện có, cộng index `(team_id, owner_agent_id, is_head, status, scope, project_hash)`. Mongo: thêm trường và index. TCVDB: kiểm tra chi phí thêm trường lọc trước khi làm.
- `SkillCore.create/update` kiểm tra ràng buộc trên. `ensureSkillAsset` không còn ghi cứng `source_type: "extracted"`.
- Trùng tên giữa hai phạm vi: trả mã lỗi riêng để bộ trích xuất đặt tên có tiền tố dự án.
- Test: ràng buộc, migration trên dữ liệu cũ, trùng tên.
- `SkillChangeService` và `ChangeApprovalPolicy` (xem "Kiến trúc"): chuyển mọi đường ghi skill hiện có (bộ trích xuất qua `skill-tools.ts`, API create/update/files của Hub và Panel, nhập session) về một cửa này. Thêm cột lịch sử cho mỗi phiên bản: `change_source`, `change_reason`, `change_summary`, `approved_by`, `approved_at`, `base_version`, `proposal_id`.
- Bảng `skill_change_proposals` với vòng đời `pending` → `approved` | `rejected` | `stale` | `expired`.
- API Core: `POST /v3/skill/rollback` (tạo phiên bản mới từ phiên bản cũ), `POST /v3/skill/proposals/list`, `.../approve`, `.../reject`. `/v3/skill/versions` trả thêm các cột lịch sử.
- Test: policy theo từng trường hợp; đề xuất bị `stale` khi phiên bản đổi; rollback giữ đủ lịch sử; không đường ghi nào bỏ qua service (test kiến trúc: tìm lời gọi `appendVersion` ngoài service).

### Giai đoạn 2: Gắn dự án khi gom hội thoại (Proxy và Core)

- Proxy gửi `project_key`/`project_hash` (từ `tdaiIdentity`, tức là từ hook) với mỗi lượt `conversation/add`: `skill/core-client.ts`, `skill/handler-glue.ts`, các điểm gọi trong `pipeline/runners/anthropic.ts`, `stages/archive.ts`, `stages/mem-command-intercept.ts`.
- Core nhận hai trường này (`gateway/skill-schemas.ts`, kiểm tra 16 ký tự hex thường), ghi vào từng lượt trong buffer.
- Khi dự án của lượt mới khác lượt trước, Core đóng buffer hiện tại trước khi thêm lượt mới, để mỗi task chỉ có một dự án.
- Test: lượt có và không có dự án; đổi dự án giữa session.

### Giai đoạn 3: Chặn khi trích xuất (Core)

- Chế độ `code`: worker (`extract-worker.ts`) xác định dự án của đoạn hội thoại theo quy tắc "mọi lượt cùng một dự án" (như `l1-project.ts`). Buffer cũ chưa gắn dự án thì đối chiếu L0 theo `session_id` trong khung thời gian, dùng index `idx_l0_session_id`, chạy trong worker.
- Không có đúng một dự án: không gọi LLM, không tạo skill, bỏ task với lý do `no_project` hoặc `mixed_project` (log và bộ đếm).
- Có một dự án: bộ trích xuất thấy skill cùng dự án và skill toàn cục. Mọi skill tạo mới là `scope = project` với hash đó. Sửa skill dự án: áp dụng ngay qua `SkillChangeService`. Sửa skill toàn cục: chỉ tạo đề xuất `pending` qua cùng service, kèm lý do; không áp dụng. Bộ trích xuất phải ghi lý do cho mọi thay đổi.
- Prompt trích xuất skill: thêm quy tắc không lưu chỉ dẫn chỉ dùng cho một việc (giống L1). Không có phán đoán toàn cục hay dự án.
- Chế độ `chat`: giữ kiểu cũ, không chặn; skill trích xuất là `scope = global`, `origin = extracted`. Ràng buộc ở Giai đoạn 1 chỉ áp dụng cho chế độ `code`.
- Nhập session thủ công từ Panel và tool `skill_extract` đi qua cùng bước chặn; nhập từ Panel phải chọn dự án.
- Test: không dự án, nhiều dự án, một dự án, buffer cũ, chế độ chat.

### Giai đoạn 4: Inject, tìm kiếm và đọc skill (Core và Proxy)

- Core lọc `listing`, `list`, `search`, `get`, `get-by-name`, `files/read` theo tham số `project_hash`: chỉ `scope = global` cộng `scope = project` có đúng hash. Không có hash thì chỉ skill toàn cục. Core trả lại `project_hash` trong response (như Giai đoạn 6 của memory).
- Proxy: `SkillInjector` và `SkillToolsInjector` dùng `cacheVariantFor(custom)` theo hash (như `tdai-profile-memory-injector.ts`), đổi tên variant để bỏ cache cũ. Bridge lấy hash của session từ `SessionWorkspaceStore`, bỏ qua hash do model gửi.
- Fail-closed: Core không trả lại hash hoặc không có `scope` thì proxy chỉ dùng skill toàn cục.
- Chế độ `chat`: giữ kiểu cũ.
- Test: không dự án chỉ có skill toàn cục; có dự án thêm đúng skill của dự án; skill dự án khác không bao giờ xuất hiện; Core cũ; cache khi đổi dự án.

### Giai đoạn 4b: Hỏi duyệt đề xuất trong session (Proxy)

- Bước mới trong pipeline của Claude Code, chạy sau khởi tạo session, chỉ ở request `main` có tool `AskUserQuestion`: lấy một đề xuất `pending` của skill toàn cục mà agent đang dùng, trả form `AskUserQuestion` (dùng lại bộ dựng form và bộ đọc câu trả lời hiện có).
- Đọc câu trả lời ở request kế tiếp: "Duyệt" hoặc "Từ chối" gọi API Core với người duyệt là user đã xác thực; "Để sau" không hỏi lại trong session. Sau đó chuyển tiếp prompt gốc.
- Giới hạn: tối đa một form mỗi N phút và mỗi session; không hỏi khi đang có form khác; không có tool `AskUserQuestion` thì không hỏi (đề xuất vẫn chờ trên Panel).
- Test: đủ các nhánh trả lời, câu trả lời không đọc được thì giữ `pending`, fork/subagent/request phụ không bị hỏi, prompt gốc được chuyển tiếp nguyên vẹn.

### Giai đoạn 5: Giao diện (Hub và Panel)

- Nhãn trên từng skill: "Toàn cục" hoặc "Dự án <tên>", với tên dự án dạng `owner/repo` (ví dụ `kevinle128/paseo`). Core cung cấp danh sách dự án (hash và tên) từ dữ liệu đã gắn dự án.
- Bộ lọc theo dự án và theo loại.
- Hộp thoại tạo skill có lựa chọn phạm vi (toàn cục hoặc chọn một dự án). Nhập session phải chọn dự án.
- Thao tác "Chuyển thành toàn cục" cho skill trích xuất: đổi thành `scope = global`, `origin = manual`, có xác nhận.
- Ở chế độ `chat`, giao diện không hiện phần dự án.
- Lịch sử phiên bản: tóm tắt cải tiến của từng phiên bản (và của phiên bản hiện tại ở đầu trang), lý do sửa, nguồn sửa, người duyệt, thời điểm; đánh dấu phiên bản hiện tại; nút "Rollback về phiên bản này" (có xác nhận); xem khác biệt giữa hai phiên bản.
- Danh sách đề xuất chờ duyệt của skill toàn cục, có Duyệt và Từ chối (cho client không có `AskUserQuestion`).
- Test: component và API.

### Giai đoạn 6: Codex và pi nhận dự án từ hook

- Nghiên cứu trước: Codex và pi có hệ thống hook không, gửi `session_id` thế nào, có khớp session id ở proxy không (đã biết pi có vấn đề không khớp session id).
- Mở rộng bộ cài hook (`assets/client-hooks/install.sh`) cho hai client này, và cho runner của chúng gọi `withSessionProject`.
- Test: báo cáo của hook gắn đúng dự án cho session Codex và pi.

### Giai đoạn 7: Dữ liệu trên production

Làm sau khi Giai đoạn 1-4 đã deploy, để không có skill nào được trích xuất lại theo kiểu cũ. Theo `operator-master/tasks/lessons.md`:

1. Sao lưu: `vectors.db` (sqlite backup) và bản tar toàn bộ volume. Kiểm tra cả hai trước lệnh ghi đầu tiên.
2. Danh sách: 112 skill `extracted` cũ (mọi phiên bản, file đính kèm, asset, FTS) và 18 skill mẫu.
3. Kiểm tra nội dung 18 skill mẫu không có tên dự án.
4. Chạy thử toàn bộ trên bản sao local (Core local với bản sao lưu), đo thời gian mỗi lệnh.
5. Trên production, tôi tự làm: xóa theo lô 10 skill, sau mỗi lô kiểm tra sức khỏe Core và số lỗi xác thực của proxy; dừng ngay khi có lỗi hoặc một lệnh quá 2 giây. Đánh dấu 18 skill mẫu `origin = template`, `scope = global`.
6. Kiểm tra lại số lượng và ghi kết quả.

## Thứ tự deploy

Core trước (nhận trường mới, có giá trị mặc định), rồi proxy, rồi Hub. Giai đoạn 4b chỉ bật sau khi API đề xuất của Core đã chạy. Proxy mới gặp Core cũ thì chỉ dùng skill toàn cục.

## Kiểm chứng tổng thể

- Vitest cho Core, Proxy, Hub, Panel; `tsc --noEmit` cho Proxy; GitNexus `impact` trước khi sửa và `detect_changes` trước khi commit.
- Review độc lập cho từng nhóm thay đổi.
- Langfuse với session thật: `~/Movies` chỉ có skill toàn cục (18 skill mẫu); repo có dự án thì thêm đúng skill của dự án đó; không session nào thấy skill của dự án khác.
- Một session ở `~/Movies` không tạo task trích xuất; log có lý do `no_project`.
- Panel hiện đúng nhãn và lọc đúng.

## Rủi ro

1. Core nằm trên đường xác thực của mọi request: bộ lọc mới phải dùng index; việc đối chiếu L0 chạy trong worker; dọn dữ liệu chỉ theo lô nhỏ.
2. Sau khi xóa, agent không có skill trích xuất cho đến khi có hội thoại mới trong dự án.
3. Agent và client chưa có hook (6 trong 7 agent, hermes, openclaw) ngừng trích xuất skill.
4. Fork và repo gốc là hai dự án riêng (theo quyết định); submodule là dự án của chính nó.
5. TCVDB chưa kiểm tra chi phí thêm trường lọc.

## Câu hỏi còn mở

Không có.
