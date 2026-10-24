# Claude Code (CC)

> agentSource: `claude-code` | 协议: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

### 方式一：环境变量

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<业务用户的 sk-mem-... user_key>"
claude --model <PROXY_UPSTREAM_MODEL 里配的上游模型>
```

### 方式二：配置文件 `~/.claude/settings.json`（推荐，持久化）

编辑 `~/.claude/settings.json`，在 `env` 字段中写入：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<业务用户的 sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

配置完成后直接运行 `claude` 即可，CC 启动时会从 `settings.json` 的 `env` 字段加载环境变量。

### 字段说明

- `ANTHROPIC_BASE_URL`：把 CC 的 API 从 anthropic.com 改指到 proxy；路径里的 `default` 是 memory 实例 ID（`x-tdai-service-id`），本地部署固定叫 `default`
- `ANTHROPIC_AUTH_TOKEN`：**业务用户**的 user_key（从面板 "API Key" 页获取；不建议直接使用 admin key）
- `ANTHROPIC_MODEL`：上游模型名（也可以用 `--model` 命令行参数指定）

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task 表单）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→ 转发到上游 LLM。

客户端发出的请求命中 `POST /claude-code/:spaceId/v1/messages`。

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC 每次启动新会话会自动生成 session ID 并随请求发送，无需手动配置。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

CC 使用 **Anthropic 原生 `tool_use`** 发起交互式 Form：

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- 协议: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 状态机

```
team_select → agent_select → task_select → initialized
```

4 步流程：
1. **team_select** — 选择团队
2. **agent_select** — 选择 Agent
3. **task_select** — 选择 Task（含 isDefault 虚拟项可跳过）
4. **initialized** — 注入资产，进入正常对话

### 3.3 分页

CC 的 `AskUserQuestion` tool 有 **2~4 个选项** 的硬限制（Anthropic 协议约束）。  
当选项超过 3 个时，使用分页机制：

- 每页显示 3 个真实选项 + 1 个 "更多→" 翻页项
- 用户选 "更多→" 后返回下一页
- 最后一页无翻页项

### 3.4 Plan Mode / Default Mode

CC **不存在** Default Mode gate 概念。CC 客户端始终支持 tool_use，form 始终可发。

### 3.5 跳过 Session Init

用户在任何一步输入 "跳过" / "skip" / 选 Other 输入 skip 即可跳过该步骤（`SKIP_RE` 正则匹配）。  
跳过后 proxy 透传请求，不注入资产。

---

## 4. 请求分类

CC 有丰富的请求类型区分：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| **main** | 默认 | 完整链路（注入 + 归档 + 埋点） |
| **fork** | `cache_control` marker 位置分析 | 走完整链路（subagent 共用 session_id） |
| **sidequery** | `cache_control` marker + 特定 pattern | 轻量处理 |
| **compact** | 路径后缀 `/compact` | 辅助请求，跳过注入 |
| **title-gen** | 路径后缀 + body 特征 | 辅助请求，跳过注入 |

CC 的 `cache_control` marker 是主请求 vs 辅助请求的核心判据。

---

## 5. 用户文本提取

从 `body.messages` 最后一条 `role: "user"` 消息中提取：
- 取最后一个 `type: "text"` content block
- **跳过** `<system-reminder>` 开头的 block（这些是系统注入不是用户文本）

---

## 6. 注入 Profile

**Markdown 结构**的 system prompt 注入：

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

注入点在 `body.system` 字段（Anthropic 协议 system 独立于 messages）。

---

## 7. 特殊行为

- **resetEpoch**: 支持 `mem:session-reset` 命令，跨节点 stale check
- **Vertex AI relay**: 支持 `x-vertex-ai-session-id` 透传
- **Fork/Subagent**: CC 的 `task` 命令起 subagent 时 session_id 不换，proxy 会把 subagent 和主 agent 累加归档
- **mem 命令**: 完整支持 `mem:sync` / `mem:create-skill` / `mem:session-reset` 等

---

## 8. 归档触发

- 对话超过阈值（token 数 / 轮次）自动触发 `skill/conversation/add`
- 支持 `skill/conversation/force-archive` 手动归档
- 归档数据写入 L0 (TDAI write)

---

## 9. 环境变量

无 CC 专属变量。使用全局 proxy 配置即可：

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC 的上游
```

---

## 10. 常见问题

**Q: CC 会不会因为 form 选项太多卡住？**  
A: 不会，分页机制保证每次最多 4 个选项。但选项很多时用户需要多次翻页。

**Q: CC subagent 的请求会不会重复 session-init？**  
A: 不会。Subagent 复用主 agent 的 session_id，proxy 检测到已 initialized 直接跳过 form。

**Q: CC 的 auxiliary 请求（title-gen / compact）会走注入吗？**  
A: 不会。proxy 识别到辅助请求后直接透传，不做注入/归档。

---

## 11. 项目上报 Hook

Proxy 只有知道会话属于哪个项目，才能注入项目记忆。Claude Code 的请求本身不带工作目录，所以每台机器需要安装一次 hook：在 `SessionStart` 与 `UserPromptSubmit` 事件上，把会话的工作目录和 git 身份上报给 proxy。

### 11.1 安装

`setup-proxy.sh` 选择 claude-code 或 codex 时会自动安装（失败只告警，不影响配置）。手动安装：

```bash
curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- [--base-url URL] [--client claude-code|codex|pi|omp] [--session SID] [--uninstall]
```

- `--base-url`：默认取环境变量 `ANTHROPIC_BASE_URL`，其次取 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`；`<proxy-origin>` 是它的 `scheme://host[:port]` 部分
- `--session SID`：安装后立即用该 session id 上报一次（严格模式），失败则退出码为 1，用于验证链路
- `--uninstall`：只移除本 hook 的条目与 `~/.agent-memory/hook.sh`，保留 `device.json`
- 需要 `jq`、`python3`、`node` 之一来编辑 JSON；都没有时脚本会提示安装并退出
- 重复运行是安全的：不会生成重复条目；每次修改前备份为 `~/.claude/settings.json.agent-memory-backup-<UTC 时间戳>`

安装结果：

| 路径 | 内容 |
|------|------|
| `~/.agent-memory/hook.sh` | 从 `<proxy-origin>/setup/hook.sh` 下载（权限 0755） |
| `~/.agent-memory/device.json` | `{"device_id": "<uuid>", "created_at": "<ISO-8601 UTC>"}`（目录 0700，文件 0600），标识这台机器 |
| `~/.claude/settings.json` | `hooks.SessionStart` 与 `hooks.UserPromptSubmit` 各追加 `{"hooks":[{"type":"command","command":"<HOME>/.agent-memory/hook.sh claude-code","timeout":5}]}` |

### 11.2 hook 行为

`hook.sh` 从 stdin 读取 `session_id`、`cwd`、`hook_event_name`，向 `${ANTHROPIC_BASE_URL}/v3/hook/report` 发送 POST（`Authorization: Bearer <token>`）：

```json
{"device_id": "...", "session_id": "...", "cwd": "...", "git_toplevel": null, "git_remote": null,
 "hook_event": "UserPromptSubmit", "hook_version": "1", "client": "claude-code",
 "os": "darwin", "arch": "arm64", "hostname": "..."}
```

- 连接信息：先取环境变量 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（其次 `ANTHROPIC_API_KEY`），缺失时读 `~/.claude/settings.json` 的 `env`；仍缺失则静默退出
- `git_toplevel` / `git_remote` 来自 `git rev-parse --show-toplevel` 与 `origin`（没有 origin 时取第一个 remote）；非 git 目录为 `null`
- remote URL 上报前会去掉 `user:token@` 凭据；`git@host:owner/repo` 形式原样保留
- 不向 stdout 输出任何内容（Claude Code 会把 hook 的 stdout 加入模型上下文），始终退出 0；连接超时 1 秒、总超时 2 秒
- 例外：设置 `AGENT_MEMORY_HOOK_STRICT=1` 时，上报失败（连接错误或非 2xx）会向 stderr 写一行错误并退出 1；安装器的 `--session` 使用该模式

### 11.3 排查

```bash
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Manual"}' \
  | AGENT_MEMORY_HOOK_STRICT=1 ~/.agent-memory/hook.sh claude-code
```

退出码 0 且无输出表示 proxy 已收到上报；退出码 1 时 stderr 会给出原因（例如 `HTTP 401`）。

### 11.3.1 强制安装（hook 门禁）

交互式会话所在机器没有安装 hook 时，proxy 在第一个模型请求前返回一个 `AskUserQuestion` 表单：

- **Install now**：proxy 返回一个 `Bash` 工具调用，执行 `curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --client claude-code --session <session_id>`（Claude Code 会先让你批准这条命令）。命令结束后 proxy 再查一次上报（最多等约 3 秒）：已有上报则去掉这几轮合成对话，继续回答原来的问题；没有则返回错误说明和手动安装命令
- auto mode 的分类器可能拒绝执行安装命令（"Unauthorized Persistence"）。此时 proxy 返回错误说明和手动命令，在终端执行，或在 Claude Code 里在命令前加 `!` 直接执行，然后重新发送问题即可
- **Exit**：本会话之后的每个请求都只收到一条固定说明，不会发给模型；只要 proxy 收到该会话的上报（例如在终端或用 `!` 执行说明里的安装命令），同一个会话再发消息即可继续，不必新开会话
- 在表单里选 "Other" 输入自由文本时，proxy 会重新弹出表单
- 请求里没有 `Bash` 工具（例如 `--disallowedTools Bash`）时不弹表单，直接返回带安装命令的说明，由你在终端执行
- 无头运行（`claude -p`、CI）不拦截：请求里没有 `AskUserQuestion` 工具，原样放行（这类运行本来就没有项目，不会注入项目记忆）。Agent SDK 会提供 `AskUserQuestion`，所以按 User-Agent 入口（`sdk-ts`、`sdk-py`、`sdk-cli` 等以 `sdk` 开头）放行；入口只用于放行，从不作为拦截依据。子 agent 请求与标题、模型探测等旁路请求也不拦截
- 只拦截 `/claude-code/<space>/v1/messages`（有对应 `/v3/hook/report` 的路径）；`/v1/messages`、`/claude-code/v1/messages`、`cost-guard`、`analyse` 等路径原样放行
- 防循环：历史里表单结果读不出来（报错、被宿主拒绝、自由文本）达到 2 次后，该会话不再询问，请求直接放行
- 每次放行（包括关闭门禁、fork、`claude -p --resume`）都会先从历史里去掉门禁的合成对话，不会把占位 thinking 签名或假的工具调用发给模型
- 已有上报（包括不在 git 目录里的无项目上报）即视为已安装，之后不再询问
- 被拦截的请求不转发上游、不写 L0、不计费
- 安装命令里的 proxy 地址默认取 `x-forwarded-proto`/`x-forwarded-host`，其次 `Host`；反向代理改写了 Host 时，在配置里设置 `hookGate.publicOrigin: "https://proxy.example.com"`（scheme://host[:port]，无路径），它优先于请求头
- 门禁是安装引导，不是安全控制：它 fail open。禁用 `AskUserQuestion`、使用 SDK、无头运行、上报查询失败、历史被压缩都会使请求放行或重新询问，不能用来强制合规
- 回滚：proxy 配置 `hookGate.enabled: false`（默认 `true`），关闭后不拦截任何请求（同一个开关也管 Codex 与 oh-my-pi，见 `agents/codex/README.md` §9.1.1 与本文 §11.5）

### 11.4 Codex、pi 与 oh-my-pi

同一个安装器也支持 Codex、pi 与 oh-my-pi（`omp`），用 `--client` 选择。两者上报的内容和 Claude Code 相同，proxy 用上报的 session id 关联请求。

**Codex（`--client codex`）**

- 读取 `$CODEX_HOME/config.toml`（默认 `~/.codex`）中当前 model provider 的 `base_url` 与 key。`base_url` 必须是 Agent-Memory 的 Codex 路由（`.../codex/<space>`），否则不上报，key 不会发往其他 host
- key 的读取顺序与 proxy 认证一致：`x-tdai-user-key`（`http_headers`，其次 `env_http_headers` 指定的环境变量），然后 `experimental_bearer_token`，最后 `env_key`。支持 `profile` 选择的 provider
- 在 `config.toml` 第一个 table 之前写入两个带标记的块：`SessionStart`（matcher `startup|resume|clear|fork`）与 `UserPromptSubmit` 的 hook，以及 hook trust（`[hooks.state."<key>"] trusted_hash`）。trust 的 key 和 hash 由 `codex app-server` 的 `hooks/list` 给出；没有 `codex` 命令时 hook 不被信任，需在 Codex 中执行 `/hooks`
- 每个块的副本保存在 `~/.agent-memory/codex-hooks.block` 与 `codex-trust.block`。重新安装或卸载前会逐行比对：块被改过（例如 Codex 把别的 table 写进了块内）时，脚本退出 1、不修改文件，并列出需要手动移走的行
- Codex 之后追加的 table（`codex mcp add`、项目信任等）写在块之外，重新安装和卸载都会保留
- 写入后若 Codex 无法加载配置或没有列出这两个 hook，脚本恢复备份并退出 1
- 注意：hook 的 key 包含它在 `config.toml` 中的位置。如果之后在它前面加了别的 hook，trust 会失效、上报静默停止；重新运行安装器即可

**pi（`--client pi`）**

- 把 extension 写入 `$PI_CODING_AGENT_DIR/extensions/agent-memory.ts`（默认 `~/.pi/agent`），在 `session_start` 与 `input` 事件上报
- extension 使用当前 model 的 `baseUrl` 与 key，只在 model 走 `.../pi/<space>/v1` 路由时上报，超时 2 秒，从不抛错
- 在 `models.json` 中所有指向 `.../pi/<space>/v1` 的 provider 上设置 `compat.sendSessionAffinityHeaders: true`，让 pi 在请求中带 `session_id` 头；proxy 只对 pi 用这个头作为 session key。修改前备份，JSON 无效时不改文件
- 卸载会删除 extension，保留 compat 设置（无害）
- 需要支持 `compat.sendSessionAffinityHeaders` 的 pi 版本，且 API 类型为 `openai-completions`

**oh-my-pi（`--client omp`）**

oh-my-pi 是 pi 的 fork，走同一条 `/pi/<space>/v1` 路由，同一个 extension 文件可以直接使用，但配置目录不同。

- 把 extension 写入 `$PI_CODING_AGENT_DIR/extensions/agent-memory.ts`，默认 `~/.omp/agent`（omp 不扫描 `~/.pi`）
- omp 对自定义 provider 不发 session 头，只有在 `~/.omp/agent/models.yml`（或 `models.yaml`）里该 provider 设置 `compat.supportsPromptCacheKey: true` 后，才在 body 里带 `prompt_cache_key`，值等于 extension 上报的 session id。安装器对所有 `baseUrl` 指向 `.../pi/<space>/v1` 的 provider 设置该开关：按文本编辑（不需要 YAML 工具），修改前备份，只改该 provider 层的 `compat`（不改 `models[].compat`），已设置则不改文件；`compat` 写成行内 `{ ... }` 时不改，提示手动设置。找不到指向 proxy 的 provider 时只打印要添加的内容，不猜测
- proxy 只对 User-Agent 以 `omp/` 开头的 pi 路由请求读取 `prompt_cache_key` 作为 session id（要求字符集同 hook 上报路由，`[A-Za-z0-9._:-]{1,128}`）；普通 pi 仍只读 `session_id` / `x-session-affinity` 头
- `--session SID`：运行中的 omp 不会加载刚装好的 extension，所以安装器自己用该 provider 的 `baseUrl` 与 `apiKey`（环境变量名，或 key 本身；`!命令` 形式不支持，会提示）上报一次，`client` 字段为 `omp`
- 卸载会删除 extension，保留 compat 设置（无害）
- provider 示例（`~/.omp/agent/models.yml`，新用户的模板必须带 `compat.supportsPromptCacheKey: true`，否则 proxy 收不到 session id，门禁不会生效）：

  ```yaml
  providers:
    am-proxy:
      baseUrl: https://<proxy-origin>/pi/<space>/v1
      apiKey: AM_USER_KEY          # 环境变量名，或 key 本身
      api: openai-completions
      compat:
        supportsPromptCacheKey: true
      models:
        - id: <model>
  ```
- `$PI_CODING_AGENT_DIR` 对 pi 与 omp 是同一个变量：为 pi 设置过它再运行 `--client omp`，extension 会写进那个目录；不设置时 omp 用 `~/.omp/agent`。`models.yml` 必须是 LF 换行，CRLF 会被拒绝并提示
- `omp` 的用户文本是数组，第一段是 `<system-reminder>`（日期和工作目录）；pi adapter 提取用户文本时会跳过这类段落，所以 `mem:` 命令与 L0 只看用户键入的内容
- 不支持 omp 的 `anthropic-messages` 模型：omp 会伪装成 Claude Code 的 User-Agent 与 header，proxy 会把它当作 Claude Code

**验证**：`MemoryProxy/scripts/qa/codex-pi-e2e.sh` 在临时 HOME 中用真实的 codex 与 pi 检查上报、session 关联与 L0 的项目字段；`MemoryProxy/scripts/qa/codex-omp-hook-gate-e2e.sh` 用真实的 Codex TUI 与 omp 检查强制安装门禁。

### 11.5 Codex 与 oh-my-pi 的 hook 门禁

Codex TUI 与 omp 没有表单，门禁直接返回一个 shell 工具调用，执行 `curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --client <codex|omp> --session <session_id>`。Codex 的细节见 `agents/codex/README.md` §9.1.1。

- **omp**：只拦截 User-Agent 以 `omp/` 开头、`stream: true`、且请求同时提供 `ask`（只有交互模式有）与 `bash` 工具的 `/pi/<space>/v1/chat/completions`。`omp -p`、rpc、SDK 与普通 pi 原样放行。调用是 `bash`（参数 `command` 与必填的 `i`），omp 默认的 approval 模式（`yolo`）直接执行，不弹批准框；其他 approval 模式会弹出
- **session id**：omp 的 `prompt_cache_key`（见 §11.4）。请求里没有可用的 session id 时不拦截，proxy 第一次在日志里警告，之后每个请求以 debug 级别记录一行。报告按路由段 `pi` 存取，所以查找用的 agent source 是 `pi`
- 命令结果回来后，proxy 再查一次上报（最多等约 3 秒）：有则去掉合成对话并继续；命令被拒绝或仍无上报则返回带手动命令的文本（以 `[Agent-Memory hook gate]` 开头）。同一会话 2 次失败后放行（fail open）
- 合成的 assistant 消息（`tool_calls` id 前缀 `call_omp_hook_gate_`）、对应的 `role: tool` 消息、以及以上述标记开头且没有 `tool_calls` 的文本回复，每次请求都会被去掉（包括关闭门禁时）。omp 没有消息 id，标记前缀是文本回复唯一的识别信号
- 被拦截的请求不转发上游、不写 L0、不计费
- 回滚：`hookGate.enabled: false`（同一个开关，三个客户端）
