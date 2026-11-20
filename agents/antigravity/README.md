# AntiGravity (agy CLI)

> agentSource: `antigravity` | 协议: Gemini API（上游是 Google Cloud Code）| Runner: `MemoryProxy/src/pipeline/runners/antigravity.ts`（独立）
>
> 只支持 **agy CLI**。AntiGravity IDE / App 不支持。

---

## 1. 客户端接入配置

agy 通过**环境变量** `AGY_LLM_GATEWAY_URL` 指向 Proxy：

```bash
export AGY_LLM_GATEWAY_URL=https://<proxy-host>/antigravity/<instanceId>/<业务用户的 sk-mem-... user_key>
```

字段说明：
- `<proxy-host>` — Proxy 地址。**远程 Proxy 必须是 `https://`**；agy 只对 localhost 接受 `http://`
- `antigravity` — agent source
- `<instanceId>` — memory 实例 ID（本地部署是 `default`）
- `<user_key>` — 业务用户的 `user_key`（从面板获取）。agy **不发送任何认证头**，所以 key 只能放在 URL 路径里；Proxy 会在日志和 trace 里遮盖它
- **客户端不需要登录 Google**。Proxy 从订阅账号池里挑一个 AntiGravity 账号，用该账号的 token 调用 Google

一般不需要手写这行：hook 安装器（见 §4）会把它写进 shell profile。

请求路径（agy 会在 URL 后面自己追加）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/antigravity/:spaceId[/analyse]/:key/v1/models` | 订阅池模型，`{"data":[{"id":...}]}` |
| `GET`  | `/antigravity/:spaceId[/analyse]/:key/v1beta/models` | 订阅池模型，Gemini 列表格式 |
| `POST` | `/antigravity/:spaceId[/analyse]/:key/v1beta/models/<model>:streamGenerateContent` | 模型调用（SSE）；`:generateContent` 返回单个回答 |

`/antigravity/:spaceId/` 下的其他路径返回 404。

---

## 2. Session ID

| 优先级 | 来源 |
|--------|------|
| 1 | `body.labels.cascade_id`（等于 hook 上报的 `conversationId`） |

agy 自动生成，无需用户配置。同一个 id 把 hook 的上报/recall 和 Proxy 的 L0 归档关联起来。

---

## 3. Session Init

AntiGravity 的 session init 与 Claude Code / Codex 一样，按下面的顺序决定 Team / Agent / Task：

1. **账号级默认**（user session default）已配置：直接注册，不提问
2. **Header 预选**：agy 不能发送自定义 header，实际上跳过
3. **自动选择**：只有一个 Team / 一个 Agent / 一个 Task 时自动选定
4. 否则 Proxy 在对话里返回**文本菜单**（与 WorkBuddy 文本模式相同的渲染器，目前是中文）：先问「关联团队资产？是/否」（`sessionInit.skipAssetConfirm` 为 true 时跳过），再依次问 Team、Agent、Task，用数字回答或选择跳过

菜单这几轮在请求发往 Google 之前就被移除，最后一次选择之后，Proxy 回答用户最初的问题。

提前配置账号级默认值可以完全避免提问。

---

## 4. 安装 hook（项目上报 + recall）

```bash
curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --client antigravity --base-url <proxy-origin>/antigravity/<instanceId>/<user_key>
```

参数：
- `--base-url` — 完整网关 URL（含 key），或 `<proxy-origin>/antigravity/<instanceId>`（此时 key 用 `--key <KEY>` 或环境变量 `AGENT_MEMORY_KEY` 提供）
- `--key KEY` — user key
- 都不传时：用环境变量 `AGY_LLM_GATEWAY_URL`，再用上次安装写下的 `~/.agent-memory/antigravity.url`
- `<proxy-origin>/antigravity/<instanceId>` 且没有 key 时：先复用上次安装里同一 Proxy、同一 instanceId 的 key，再在终端（`/dev/tty`，不回显）提示输入；没有终端时以 exit 1 退出，并提示用 `--key`
- 没有 hook 时 Proxy 在 agy 对话里给出的安装命令是 `curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --client antigravity --base-url <proxy-origin>/antigravity/<instanceId>`：不含 key（key 会留在对话历史里）也不含 `--session`；安装后 agy 在每次模型调用前由 PreInvocation hook 上报 conversationId，下一条消息即可通过

不想让 key 出现在进程列表里时，用环境变量传 key：

```bash
curl -fsSL <proxy-origin>/setup/hooks.sh | AGENT_MEMORY_KEY=<user_key> bash -s -- --client antigravity --base-url <proxy-origin>/antigravity/<instanceId>
```

安装器会做这几件事（改动已有文件前先备份，每次运行每个文件一份）：

| 位置 | 内容 |
|------|------|
| `~/.gemini/config/hooks.json` | 新增 hook 条目 `agent-memory`（事件 `SessionStart`、`PreInvocation`），保留其他 hook |
| `~/.zshrc`（`$SHELL` 是 zsh）或 `~/.bashrc` | 带标记的 `export AGY_LLM_GATEWAY_URL=...` 块，再次运行会替换这个块 |
| `~/.agent-memory/antigravity.url` | 网关 URL（权限 600）。agy 不把环境变量传给 hook 时，hook 从这里读 |
| `~/.agent-memory/hook.sh` | hook 脚本（与 Claude Code / Codex 共用） |

`setup-proxy.sh` 选择 AntiGravity 时会调用同一个安装器：

```bash
bash agents/setup-proxy.sh --agent antigravity
```

向导会先探测 `GET <网关 URL>/v1beta/models`（期望 200 和 `models` 数组），再运行安装器。

### 4.1 hook 做什么

- `SessionStart`：上报 session 与项目（device、工作目录、git remote）。每 6 小时最多检查一次 hook 自更新
- `PreInvocation`：`invocationNum=0` 且带用户输入时，向 Proxy 请求 recall；Proxy 返回 `{"injectSteps":[{"ephemeralMessage":"..."}]}`，agy 把记忆放在这条用户消息旁边
- agy 要求每次 hook 运行都在 stdout 输出恰好一个 JSON 对象，所以 hook 在任何失败下都输出 `{}`，不阻塞会话
- `AGENT_MEMORY_RECALL=0` 关闭本机 recall；`AGENT_MEMORY_HOOK_UPDATE=0` 关闭 hook 自更新

### 4.2 Recall 的时机

recall 在 session 已经存在之后、每一轮的第一次模型调用时发生。recall 还要求工作目录是 git 项目（和 Claude Code 一样，按项目默认拒绝）。**新对话的第一条消息可能还没有 recall**（此时 session 刚刚上报）。

### 4.3 强制安装（hook 门禁）

会话还没有 hook 上报时，Proxy 不转发上游，而是返回一条 Gemini SSE 消息，内容是上面的安装命令。同一会话回答 2 次后放行（fail open）。已有上报即视为已安装。

---

## 5. 模型

- 模型列表来自订阅池分组的模型目录，没有目录时来自 Google 的 `fetchAvailableModels`。`chat_*`、`tab_*`、`*-disabled`、`*-tiered`、`*-sonar` 和图像模型会被过滤
- **可用模型取决于账号的套餐**。运行 `agy models` 查看当前列表
- **思考强度后缀**（`-low` / `-medium` / `-high`）：agy 在网关模式下去掉后缀，把强度放进 `generationConfig.thinkingConfig.thinkingLevel`；Proxy 在请求没有后缀时按这个值补回 `<model>-<level>` 再发给 Google，不用用户处理
- 请求体按 agy 发来的样子放进 Cloud Code 信封发往上游，回答逐行解开信封；不做格式转换

---

## 6. 订阅账号池

AntiGravity 只通过订阅账号池工作（Proxy 没有 API key 上游）。

0. 在 Memory Core 的环境变量中设置 `ANTIGRAVITY_OAUTH_CLIENT_ID` 和 `ANTIGRAVITY_OAUTH_CLIENT_SECRET`（AntiGravity CLI 登录所用的 Google OAuth 客户端，见 `deploy/global-images/.env.example`）。未设置时添加账号和刷新 token 会报错 "AntiGravity OAuth is not configured"，Claude/Codex 不受影响
1. System Admin 打开 **组织与权限 → 订阅账号池**，切到 **AntiGravity** 标签页，打开账号池开关
2. 点击 **添加账号**，在新标签页用 Google 账号登录。浏览器随后打开 `http://localhost:51121/oauth-callback?...`，页面无法加载属于正常现象；复制地址栏中的完整地址，粘贴到对话框。每个账号重复一次
3. 在 **API Key** 页面为 AntiGravity 客户端选择来源 `sub-antigravity`（订阅池分组需要包含 `antigravity` agent）
4. 调整阈值（可选，默认 95%）

行为：
- 每个新会话分配下一个账号，同一会话保持在同一账号上
- 401：刷新 token 一次
- 429 `RESOURCE_EXHAUSTED`：在同一账号上重试一次，之后立即检查额度，额度用满就换账号。Google 的 429 不带重试时间
- 503 `UNAVAILABLE`（"No capacity ..."）：换下一个账号，不把账号标记为用尽
- 所有账号都到上限：返回 429 和最早的重置时间。没有"自带登录"回退，因为客户端不登录 Google
- 上游主机是 `https://daily-cloudcode-pa.googleapis.com`（prod 主机在测试中返回 429）。可以用订阅池分组的 `base_url` 或 `upstream.agents.antigravity.url` 覆盖
- AntiGravity 没有 reset credits

> ⚠️ 共用个人 Google 账号可能违反 Google 的条款，账号可能被封禁；登录接口使用的是 AntiGravity CLI 的公开登录，可能随 Google 的改动失效。

---

## 7. 验证

打开一个**新的终端**（profile 里的变量只在新 shell 生效），然后：

```bash
agy models            # 应列出订阅池模型
agy -p "say pong"     # 应返回回答
```

在 agy 里输入 `/hooks`，应看到 `agent-memory` hook 处于启用状态。

排查：

| 现象 | 原因 |
|------|------|
| `agy models` 没有模型 | 订阅池没有 AntiGravity 账号，或客户端没有选 `sub-antigravity` 来源 |
| 401 / 404 | key 或 instanceId 错误（`GET <网关 URL>/v1beta/models` 能直接验证） |
| agy 报 TLS / 地址错误 | 远程 Proxy 用了 `http://` |
| 没有记忆注入 | 选择了跳过；工作目录不是 git 项目（recall 按项目默认拒绝）；或这是新对话的第一条消息（见 §4.2） |
| 每次都收到安装命令 | hook 没装好：检查 `/hooks`，重新运行 §4 的安装命令 |

---

## 8. 卸载

```bash
curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --client antigravity --uninstall
```

只删除安装器写入的内容：`hooks.json` 里的 `agent-memory` 条目、`~/.zshrc` 和 `~/.bashrc` 里带标记的块、`~/.agent-memory/antigravity.url`。其他 hook 和 `device.json` 保留；没有其他客户端使用时 `hook.sh` 也一并删除。

---

## 9. 限制

- 只支持 agy CLI（不支持 IDE / App）
- 模型取决于账号套餐
- 不做工具伪装，不做格式转换；唯一的改动是 Cloud Code 信封的包装和解开
- L0 归档由 Proxy 根据请求和回答写入；不做 skill 抽取
- 新版本 agy 可能改变网关行为

---

## 10. 与 Claude Code / Codex 的差异

| 维度 | Claude Code | Codex | AntiGravity |
|------|-------------|-------|-------------|
| 协议 | Anthropic Messages | OpenAI Responses | **Gemini API（Cloud Code 信封）** |
| 配置位置 | env / `settings.json` | `~/.codex/config.toml` | **shell profile 的 `AGY_LLM_GATEWAY_URL`** |
| URL 前缀 | `/claude-code/<spaceId>` | `/codex/<spaceId>` | `/antigravity/<spaceId>/<user_key>` |
| Key 传递 | env `ANTHROPIC_AUTH_TOKEN` | TOML `experimental_bearer_token` | **URL 路径（agy 不发认证头）** |
| Session ID | `x-claude-code-session-id` | `session-id` | `labels.cascade_id` |
| Session init | 交互式 Form | 交互式 Form + Default Gate | **文本菜单（同 WorkBuddy 文本模式）；账号默认 / 单选自动选择优先** |
| 客户端登录 | 可选（回退） | 可选（回退） | **不需要，也没有回退** |
