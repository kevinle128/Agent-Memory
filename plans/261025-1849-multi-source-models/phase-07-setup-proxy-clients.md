# Giai đoạn 7: setup-proxy sinh cấu hình client từ `/v1/models`

## Bối cảnh

- `agents/setup-proxy.sh`: `write_hermes` (dòng 1018) ghi một provider `custom`, không `api_mode`; `write_openclaw` (dòng 1047) ghi `openai-completions` và khóa `request` mà OpenClaw 2026.3.13 từ chối ("Unrecognized key: request", báo cáo bắt gói).
- Hai bản script khác nhau đúng khối `info` 3 dòng: `agents/setup-proxy.sh` và `agents/skills/setup-proxy/setup-proxy.sh`. Mọi thay đổi phải áp dụng cho cả hai.
- Client hỗ trợ nhiều provider theo định dạng: omp `api` (`anthropic-messages`, `openai-responses`, `openai-completions`); OpenClaw `models.providers` với `api`; Hermes `custom_providers` với `api_mode` (`anthropic_messages`, `codex_responses`, `chat_completions`).
- Hermes chọn `extra_headers` theo base URL (mục đầu thắng). setup-proxy ghi cùng giá trị `x-*` cho mọi provider của một lần cài, nên việc trùng base URL không gây sai.

## Thay đổi

1. `--agent omp` mới; `hermes`, `openclaw` dùng cùng luồng.
2. Gọi `GET <proxy>/<agent>/<space>/v1/models` với user key; nhóm mục có trường `source` theo `format`. Không có mục nguồn → giữ cấu hình một provider như hôm nay.
3. Mỗi định dạng có model → một provider client:

| Định dạng | omp (`~/.omp/agent/models.yml`) | OpenClaw | Hermes |
|---|---|---|---|
| anthropic-messages | `api: anthropic-messages`, `baseUrl: <proxy>/omp/<s>` | `api: anthropic-messages`, `baseUrl: <proxy>/openclaw/<s>` | `api_mode: anthropic_messages`, `base_url: <proxy>/hermes/<s>` |
| openai-responses | `api: openai-responses`, `baseUrl: <proxy>/omp/<s>/v1` | `api: openai-responses`, `baseUrl: <proxy>/openclaw/<s>` | `api_mode: codex_responses`, `base_url: <proxy>/hermes/<s>` |
| openai-chat | `api: openai-completions`, `baseUrl: <proxy>/omp/<s>/v1` | `api: openai-completions`, `baseUrl: <proxy>/openclaw/<s>` | `api_mode: chat_completions`, `base_url: <proxy>/hermes/<s>` |

   Model id ghi đúng `id` có tiền tố. Tên provider client: `memory-anthropic`, `memory-responses`, `memory-chat`.
4. omp: giữ `compat` mà `install.sh` đang ghi (session affinity, `supportsPromptCacheKey`). Đổi `baseUrl` `/pi/` → `/omp/` trong `~/.omp/agent/models.yml` (câu 6 "A"): sao lưu trước bằng `backup_file` sẵn có, kiểm tra bản sao, rồi đổi; in số dòng đã đổi và đường dẫn bản sao. setup-proxy không có `--agent pi` và không thêm.
5. OpenClaw: bỏ khóa `request`.
5b. Câu 8 "A": setup-proxy chỉ ghi model có trong `/v1/models` lúc chạy; pool đang tắt thì model của nó không được ghi. In ra một dòng nhắc chạy lại setup-proxy sau khi bật pool nếu thiếu nguồn thuê bao. Dạng khối `models` trong `models.yml` của omp theo câu 9 "A" (ba provider, mỗi định dạng một provider); đổi sang một provider chỉ khi bắt gói PR 5b chứng minh omp dùng `api`/`baseUrl` theo từng model.
6. Sao lưu tệp cấu hình trước khi ghi (`backup_file` có sẵn). Không in key.

## Tệp

- Sửa: `agents/setup-proxy.sh`, `agents/skills/setup-proxy/setup-proxy.sh`, tài liệu skill setup-proxy nếu có mô tả cờ.

## Kiểm thử

- Chạy với proxy local (mock Core có 3 nguồn): tệp sinh ra hợp lệ (`omp` khởi động được, `openclaw` không báo config invalid, `hermes chat` chạy); mỗi provider gửi đúng path (đối chiếu log proxy).
- Không có mục nguồn: tệp giống hôm nay (trừ bỏ `request` cho OpenClaw).
- omp với `models.yml` cũ trỏ `/pi/`: có bản sao lưu giống tệp gốc; tệp mới trỏ `/omp/`; chạy lần hai không đổi gì.
- `diff` hai bản script chỉ còn khối `info` 3 dòng.

## Rủi ro và lùi lại

- Ghi đè cấu hình người dùng: đã có sao lưu. Lùi: khôi phục tệp sao lưu; revert script.
