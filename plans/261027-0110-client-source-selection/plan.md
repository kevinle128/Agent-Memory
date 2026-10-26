---
title: Chọn nguồn model theo client trên trang API Key
status: in_progress
mockup: ../261025-1849-multi-source-models/mockup/client-sources.html
---

# Kế hoạch: chọn nguồn model theo client

## Quyết định đã chốt (người dùng, 26-27/10/2026)

1. Subscription Pool và Model Provider chỉ khai báo provider và chọn model. Không còn chọn agent ở hai trang này.
2. Việc client dùng nguồn nào cài ở trang API Key, phần Client Access Endpoint. Gán chung cho cả instance; admin sửa, thành viên chỉ xem.
3. Claude Code và Codex chọn đúng một nguồn (dropdown chọn một), chỉ nguồn đúng định dạng (Anthropic / Responses). Model giữ nguyên tên, không có tiền tố.
4. Mọi client khác (CodeBuddy, WorkBuddy, dsh, OpenCode, omp, Hermes, OpenClaw) chọn nhiều nguồn (dropdown chọn nhiều, tag), gọi model dạng `<nguồn>/<model>`.
5. Nguồn đang tắt không hiện trong danh sách chọn. Nguồn đang được client nào chọn thì không tắt, không xoá được (kể cả tắt pool); Panel báo client đang dùng, Core trả `SOURCE_IN_USE`.
6. Tab Subscription Pool giữ nguyên giao diện; thêm nút "Selected models" cạnh "Add account", chọn model trong hộp thoại. Tên nguồn pool cố định `sub-claude` / `sub-openai`.
7. Tab Model Provider: bảng nguồn API key, mỗi dòng có "Selected models", công tắc, Delete; "Add provider" mở form trong hộp thoại (không có ô chọn agent). Model mới của nguồn API key mặc định tắt.
8. Thêm omp vào danh sách endpoint.

## Thiết kế dùng lại

- Client nhiều nguồn: trường `source_agents` của nhóm nguồn (đã có).
- Claude Code / Codex: trường `agents` của nhóm (đã có, một agent chỉ ở một nhóm). Chọn pool = agent ở nhóm pool; chọn nguồn API key = agent ở nhóm `custom_unified` đó (đường override đã có, không đổi proxy). Chuyển nhóm bằng `moveAgentBetweenUpstreamGroups` (đã có).

## Giai đoạn

1. Core: `multi_source` cho codebuddy, workbuddy, dsh, opencode; action `client-sources/list` (mọi người) và `client-sources/update` (admin); chặn tắt/xoá/tắt pool khi đang dùng (`SOURCE_IN_USE`); không bắt buộc `source_agents` khi tạo nguồn; pool tự có tên nguồn cố định.
2. Proxy: `multi_source` cho 4 agent trên; runner của chúng gọi định tuyến nguồn; `/v1/models` cho chúng.
3. Panel: trang API Key (dropdown chọn một / chọn nhiều, endpoint lấy từ supported agents gồm omp), tab Pool (bỏ khối nguồn, nút Selected models), tab Model Provider (bảng, Add provider, Selected models), hộp chặn khi nguồn đang dùng.
4. setup-proxy: sinh cấu hình nhiều nguồn cho các client mới có khả năng nhiều nguồn khi định dạng cấu hình của client cho phép.
5. Test đầy đủ, e2e thật (omp, Claude Code, Codex), deploy prod có sao lưu.
