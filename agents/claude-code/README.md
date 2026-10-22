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

`setup-proxy.sh` 选择 claude-code 时会自动安装（失败只告警，不影响配置）。手动安装：

```bash
curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- [--base-url URL] [--client claude-code] [--session SID] [--uninstall]
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
