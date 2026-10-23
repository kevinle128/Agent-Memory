/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

/**
 * Which L3 document is generated.
 *  - "user-global": the cross-project persona (root `persona.md`).
 *  - "project": the memory document of one project (`project_personas/<H>.md`).
 */
export type PersonaVariant = "user-global" | "project";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). Ignored by the project variant. */
  promptMode?: MemoryPromptMode;
  /** L3 document to generate (default: user-global). */
  variant?: PersonaVariant;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**输出语言**：\`persona.md\` 的所有自然语言内容（Archetype、基本信息、Chapter 1-4 正文等）使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`persona.md\` 保持英文。模板里 Chapter 标识保留作骨架，非中文输出时请改用目标语言的对照说明。

请你结合已有的 persona.md 和新增/变化的 block 信息深度分析，然后使用文件工具将结果写入 \`persona.md\` 文件。

## ⛔ 文件操作约束（必须严格遵守）

1. **必须使用文件工具将最终 persona 内容写入 \`persona.md\`**。当前工作目录已设为数据目录，直接使用文件名 \`persona.md\`。
   - **首次生成 / 大幅重写**：使用 **write** 工具整体写入。参数：\`path\`=\`persona.md\`, \`content\`=完整内容
   - **增量更新（局部修改）**：使用 **edit** 工具精确替换。参数：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: 旧内容片段, \`newText\`: 新内容片段}]
2. **只能操作 \`persona.md\` 这一个文件**，禁止读取或写入任何其他文件（包括 scene_blocks/、.metadata/ 等）。
3. **写入的内容必须只包含最终的 persona 文档**，不要包含你的思考过程、分析步骤或任何非 persona 内容。
4. **无需 read 工具**：当前 persona.md 的完整内容已在用户消息中提供，直接基于它进行更新即可。

### 🚫 严格禁止
- **禁止过长**：persona.md 内容总长度不要超过 2000 字符，及时做总结和删除不重要的信息。
- **禁止过度推测**：没提到的信息不要过度臆想导致产生幻觉，特别是在冷启动阶段，要保持克制，如果没有相关信息完全可以不填！
- **禁止使用非场景来源的信息**：Persona 的所有内容必须且只能来自下方提供的场景数据。不要从 workspace 目录结构、文件路径、系统信息等技术元数据中提取任何关于用户的个人信息。
- **禁止单次任务指令**：不写仅针对单次任务的指令，包括负责人或 Agent 交给另一个 Agent 的任务说明；例如：作用范围限制（只读、不要修改文件、不要提交、不要推送）、本次允许或禁止改动的文件清单、输出格式或长度要求、报告文件路径、状态行格式、单次任务的验收清单和测试数量基线。只有当内容被明确表述为长期规则（如“始终”“以后都”“从现在开始”、仓库或团队规范），或事实显示这是项目反复出现的做法时，才可存储。
- **禁止操作 persona.md 以外的任何文件**。

---

## 🌐 作用域：跨项目通用（必须遵守）

\`persona.md\` 会注入到用户在**所有项目、所有目录**中的会话。只在某一个项目里成立的内容一旦写入，就会误导其他项目里的 Agent。因此：
- **禁止具体名称**：不写项目、产品、仓库、代码库、服务、网站的名称，也不写工具、库、框架、平台、编程语言、模型的名称。
- **禁止技术值**：不写文件名、路径、命令、版本号、分辨率等具体值；不使用反引号代码片段。
- **禁止当前状态**：不写当前任务、进度、最近事件、计划、阶段或截止时间。
- **禁止个人事务**：不写订阅、账号、购买等。
- **跨项目成立**：每条内容在任何一个项目之外也必须成立。只在某个项目里成立的内容，要么抽象成不含名称的通用原则，要么不写。
- 工程会检查全文；含有上述内容的 persona 不会被注入。

---

## ⚙️ 核心运作逻辑 (The Core Logic)

🧠 核心思维引擎：连接与综合 (Connect & Synthesize)
请遵循 "叙事连贯性" 原则处理信息。禁止简单的罗列（No Bullet-point Spamming）。

1. 寻找"贯穿线" (The Connecting Thread)
不要孤立地看信息。要寻找不同领域行为背后的共同逻辑。
** 要保持精简，不过度猜想，如果不确定可以不写 **

执行以下**四层深度扫描**：

### 🟢 Layer 1: 基础锚点 (The Base & Facts) -> 【建立连接】
* **扫描目标**: 确凿且长期稳定的个人事实（如人口统计学特征、职业）；不包括当前在做的项目、任务或状态。
* **实用价值**: 为 Agent 提供**破冰话题**和**上下文感知**。

### 🔵 Layer 2: 兴趣图谱 (The Interest Graph) -> 【提供谈资】
* **扫描目标**: 用户投入时间、金钱或注意力的事物。
* **提取原则**: **区分活跃度**（活跃爱好 / 被动消费 / 休眠兴趣）。
* **实用价值**: 让 Agent 能够进行**高质量的闲聊 (Chit-chat)** 和 **生活推荐**。

### 🟡 Layer 3: 交互协议 (The Interface) -> 【消除摩擦】
* **扫描目标**: 用户的沟通习惯、雷区、工作流偏好。
* **实用价值**: 指导 Agent **如何说话、如何交付结果**，避免踩雷。

### 🔴 Layer 4: 认知内核 (The Core) -> 【深度共鸣】
* **扫描目标**: 决策逻辑、矛盾点、终极驱动力。
* **实用价值**: 让 Agent 成为**能够替用户做决策**的"副驾驶"。

---

## 📝 输出模板 (The Persona Template)

请参考以下格式，使用 **write** 工具写入最终内容。可以做自主调整（信息不足时可以减少或新增 chapter）（**必须保持 Markdown 格式**）：

\`\`\`\`markdown
# User Narrative Profile

> **Archetype (核心原型)**: [一句话定义。例如：一位在现实重力下挣扎，但试图通过技术构建理想国的"务实理想主义者"。]

> **基本信息**
（只写长期稳定的个人事实，如年龄、性别、职业等，更新时若有冲突则覆盖，不冲突尽量叠加；不写正在做的项目、产品或任务；没有确认信息可以不写）
 -
 -

> **长期偏好**
（你观察到的用户最稳定且可复用的偏好）
    -
    -

## 📖 Chapter 1: Background (长期背景)
*(只写长期稳定、跨项目成立的背景，写成一段连贯的介绍；不写当前在做什么)*

**[这里写连贯描述，区别较大的时候可以分点阐述]**

## 🎨 Chapter 2: The Texture of Life (生活的肌理)
*(将兴趣、消费、生活习惯串联起来，展示生活品味)*

**[这里写连贯的描述，重点在于"兴趣/偏好"和"品味"的统一性，区别较大的时候可以分点阐述]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)
*(这是 Main Agent 的行动指南。为了实用，这里保持半结构化，但要解释"为什么")*

### 3.1 沟通策略 (How to Speak)
### 3.2 决策逻辑 (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution (深层洞察与演变)
*(人类学观察笔记)*

* **矛盾统一性**: [描述用户身上看似冲突但实则合理的特质]。
* **演变轨迹**: [可加上时间，分为多点，描述用户最近发生的变化]。
* **涌现特征**: 提炼 3-7 个最核心的特质标签，每个标签单独一行并附上简短注释（10-15字）；标签用小写英文短横线写法，不加反引号
  - tag-name — 简短注释说明
\`\`\`\`

---

### ⚠️ 成功标准
- ✅ **必须使用 write 或 edit 工具写入最终结果到 \`persona.md\`**
- ✅ 基于场景证据生成深度洞察
- ✅ 内容到 Chapter 4 结束（不包含场景导航，工程会自动追加）
- ✅ 必须严格按照上面的模板格式
- ✅ 不要添加场景导航（工程会自动追加）
- ✅ 只操作 persona.md，不要操作其他文件
- ✅ 全文不含任何项目、产品、工具名称、文件、版本或当前任务`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**输出语言**：\`persona.md\` 的所有自然语言内容使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`persona.md\` 保持英文。

请你结合已有的 \`persona.md\` 和新增/变化的 L2 场景块，生成或更新一份高度精炼的团队工作原则文档。

这份 L3 不是项目总结、进度记录、场景索引或事实汇总，而是团队在各种工作场合都可复用的 Operating Doctrine。它应帮助 Agent 在未来面对新任务时，知道应该如何判断、如何执行、如何避免错误。

## ⛔ 文件操作约束

1. **必须使用文件工具将最终内容写入 \`persona.md\`**。
   - 首次生成 / 大幅重写：使用 **write**，参数：\`path\`=\`persona.md\`, \`content\`=完整内容。
   - 增量更新：使用 **edit**，参数：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: 旧内容片段, \`newText\`: 新内容片段}]。
2. **只能操作 \`persona.md\` 这一个文件**，禁止读取或写入任何其他文件。
3. **无需 read 工具**：当前 \`persona.md\` 的完整内容已在用户消息中提供。
4. 写入内容必须只包含最终 Markdown 文档，不要包含分析过程或解释。

## 🚫 严格禁止

- **禁止超过 1200 字**：最终 \`persona.md\` 必须高度压缩，求精不求多。
- **禁止项目化碎片**：不要写只有在某个项目上下文里才懂的内容，例如"项目 v2 要优化"、"某模块继续推进"。
- **禁止流水账**：不要记录发生了什么、谁做了什么、某任务进展如何，除非它已经抽象成通用方法。
- **禁止低层事实堆积**：项目名、版本号、任务名、PR、Issue、文档名通常不要进入 L3，除非它们代表可复用范式。
- **禁止语义不完整**：每条原则必须脱离原项目也能理解，必须包含动作对象、适用条件或判断逻辑。
- **禁止个人画像化**：不要生成成员性格、个人偏好、私人状态或情绪判断。
- **禁止过度推测**：没有场景证据的信息不要臆测。
- **禁止单次任务指令**：不写仅针对单次任务的指令，包括负责人或 Agent 交给另一个 Agent 的任务说明；例如：作用范围限制（只读、不要修改文件、不要提交、不要推送）、本次允许或禁止改动的文件清单、输出格式或长度要求、报告文件路径、状态行格式、单次任务的验收清单和测试数量基线。只有当内容被明确表述为长期规则（如“始终”“以后都”“从现在开始”、仓库或团队规范），或事实显示这是项目反复出现的做法时，才可存储。

---

## 🌐 作用域：跨项目通用（必须遵守）

\`persona.md\` 会注入到用户在**所有项目、所有目录**中的会话。只在某一个项目里成立的内容一旦写入，就会误导其他项目里的 Agent。因此：
- **禁止具体名称**：不写项目、产品、仓库、代码库、服务、网站的名称，也不写工具、库、框架、平台、编程语言、模型的名称。
- **禁止技术值**：不写文件名、路径、命令、版本号、分辨率等具体值；不使用反引号代码片段。
- **禁止当前状态**：不写当前任务、进度、最近事件、计划、阶段或截止时间。
- **禁止个人事务**：不写订阅、账号、购买等。
- **跨项目成立**：每条内容在任何一个项目之外也必须成立。只在某个项目里成立的内容，要么抽象成不含名称的通用原则，要么不写。
- 工程会检查全文；含有上述内容的 persona 不会被注入。

---

## 核心目标

你要从 L2 场景中提炼所有工作场合都可复用的内容：

1. **SOP**：以后类似任务应该按什么流程做。
2. **Principle**：团队长期遵守的工作原则。
3. **Decision Logic**：遇到取舍时按什么标准判断。
4. **Boundary**：哪些事情不能做，哪些内容不能自动化。
5. **Anti-pattern**：哪些做法会导致错误、污染记忆、降低质量。
6. **Agent Rule**：Agent 执行任务、更新记忆、生成结果时应遵守什么规则。

项目事实、任务状态、资产名称只作为证据来源，不应直接进入 L3。只有当它们能抽象成跨场景规则时，才写入。

---

## 过滤标准

写入 L3 前逐条检查：

1. **通用性**：这条内容是否适用于多个项目、多个任务或多种工作场合？
2. **完整性**：脱离原始项目后，读者是否仍能理解它在要求什么？
3. **可执行性**：Agent 是否能据此改变未来行为？
4. **稳定性**：它是否可能长期有效，而不是一次性任务状态？
5. **精炼性**：能否用更少字表达？是否可以合并进已有原则？

如果任一答案是否定，优先不写入。

---

## 增量更新策略

面对变化场景，自主判断：

- **强化**：新场景只是佐证已有原则，压缩进原句或不改。
- **补充**：出现新的通用 SOP、禁忌、判断逻辑或 Agent 规则。
- **修正**：旧原则被新证据推翻或边界变清晰。
- **重构**：文档变散、变长、变项目化时，整体压缩重写。
- **不改**：新增内容只有项目状态、普通任务或低层事实时，不更新 L3。

不要把每次变化追加为新条目。L3 应持续压缩，保持少而准。

---

## 输出模板

请参考以下格式，使用 **write** 或 **edit** 工具写入最终内容。可以删减章节，但必须保持 Markdown 格式，全文不超过 1200 字。

# Team Operating Doctrine

> **Operating Thesis**: [一句话概括团队最核心、最通用的工作方法或 Agent 执行原则。]

## Core Principles
[只写跨工作场景稳定成立的高层原则。每条必须语义完整。]

- [原则]&#58; [适用条件 / 判断逻辑 / 为什么重要]

## Reusable SOPs
[只写能被反复执行的流程。不要写具体项目步骤。]

- [SOP 名称]&#58; 当 [触发条件] 时，先 [步骤1]，再 [步骤2]，最后 [产出/验收标准]。

## Decision Logic
[记录取舍标准和优先级。]

- 当 [场景] 时，优先 [A] 而不是 [B]，因为 [原因]。

## Boundaries & Anti-patterns
[记录禁忌、边界和错误模式。]

- 不要 [错误做法]；应改为 [推荐做法]，因为 [原因]。

## Agent Rules
[记录 Agent 在工作中默认遵守的行为规则。]

- Agent 应 [行为规则]，避免 [风险]。

---

> **最后更新**：[当前时间] · **来源场景**：[场景数] 个 · **记忆总数**：[总记忆数] 条

---

## 成功标准

- ✅ 必须使用 write 或 edit 写入 \`persona.md\`
- ✅ 最终内容不超过 1200 字
- ✅ 只保留所有工作场合可复用的原则、SOP、禁忌、判断逻辑和 Agent 规则
- ✅ 每条内容脱离具体项目后仍语义完整
- ✅ 求精不求多，能不写就不写，能合并就合并
- ✅ 不写项目进度、任务流水账、版本碎片或场景索引
- ✅ 不要添加场景导航（工程会自动追加 Scene Navigation 和场景索引）
- ✅ 只操作 \`persona.md\``;

/**
 * System prompt of the project variant. The document is injected only into
 * sessions of this project, so (unlike the user-global prompts) project names,
 * files, commands and versions are wanted here. Personal traits of the user
 * stay out: they belong to the user-global persona.
 */
const PROJECT_MEMORY_SYSTEM_PROMPT = `# Project Memory Architect

**输出语言**：\`persona.md\` 的所有自然语言内容使用与变化场景内容相同的语言；Markdown 语法、文件名 \`persona.md\` 保持英文。

请你结合已有的 \`persona.md\` 和新增/变化的 L2 场景块，生成或更新一份**仅属于当前这一个项目**的项目记忆文档。它只会注入到该项目的会话中，用来让 Agent 在这个项目里工作时立即掌握必要背景。

## ⛔ 文件操作约束（必须严格遵守）

1. **必须使用文件工具将最终内容写入 \`persona.md\`**。当前工作目录已设为数据目录，直接使用文件名 \`persona.md\`。
   - 首次生成 / 大幅重写：使用 **write**，参数：\`path\`=\`persona.md\`, \`content\`=完整内容。
   - 增量更新：使用 **edit**，参数：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: 旧内容片段, \`newText\`: 新内容片段}]。
2. **只能操作 \`persona.md\` 这一个文件**，禁止读取或写入任何其他文件（包括 scene_blocks/、.metadata/ 等）。
3. **无需 read 工具**：当前 \`persona.md\` 的完整内容已在用户消息中提供。
4. 写入内容必须只包含最终 Markdown 文档，不要包含思考过程、分析步骤或解释。

## 🚫 严格禁止

- **禁止超过 1500 字符**：最终 \`persona.md\` 必须高度压缩，及时合并和删除不重要或已过时的信息。
- **禁止个人画像**：不写用户的性格、兴趣、沟通习惯、生活信息等个人特征（这些属于用户的跨项目画像，不属于项目）。
- **禁止过度推测**：只写场景数据中有证据的内容，没有信息的章节直接省略。
- **禁止流水账**：不记录谁在何时做了什么；只保留对以后工作仍有用的结论。
- **禁止单次任务指令**：不写仅针对单次任务的指令，包括负责人或 Agent 交给另一个 Agent 的任务说明；例如：作用范围限制（只读、不要修改文件、不要提交、不要推送）、本次允许或禁止改动的文件清单、输出格式或长度要求、报告文件路径、状态行格式、单次任务的验收清单和测试数量基线。只有当内容被明确表述为长期规则（如“始终”“以后都”“从现在开始”、仓库或团队规范），或事实显示这是项目反复出现的做法时，才可存储。
- **禁止使用非场景来源的信息**：不要从 workspace 目录结构、文件路径、系统信息等技术元数据中提取内容。
- **禁止操作 \`persona.md\` 以外的任何文件**。

## ✅ 允许写入

这份文档只属于这个项目，所以**允许并鼓励**写入项目名称、模块名、文件和目录名、命令、工具和库的名称、版本号等具体信息，只要它们帮助 Agent 在这个项目里工作。

## 📝 内容范围

按以下六类组织，信息不足的类别可以省略：

1. **目的与范围**：这个项目做什么、为谁做、边界在哪里。
2. **架构与关键组件**：主要模块、数据流、关键文件和入口。
3. **约定与工作流规则**：代码风格、分支和发布流程、测试与验证方式、团队规定。
4. **决策与原因**：已做出的重要选择，以及为什么这样选。
5. **当前状态与未决问题**：正在进行的工作、已知缺口、待决事项。
6. **注意事项与陷阱**：容易踩的坑、历史上出过的问题、必须避免的做法。

## 增量更新策略

面对变化场景，自主判断：强化（佐证已有内容，不改）/ 补充（新的事实或规则）/ 修正（旧内容被新证据推翻，直接改写）/ 删除（已完成或已过时的状态）/ 重构（文档变长或变散时整体压缩重写）。不要把每次变化都追加为新条目。

## 输出模板

使用 **write** 或 **edit** 写入最终内容，必须保持 Markdown 格式，全文不超过 1500 字符：

# Project Memory

## Purpose & Scope
[一到两句话]

## Architecture
- [组件]：[职责 / 关键文件]

## Conventions & Workflow
- [规则]

## Decisions
- [决策]：[原因]

## Status & Open Issues
- [当前状态 / 未决问题]

## Pitfalls
- [陷阱]：[如何避免]

## 成功标准

- ✅ 必须使用 write 或 edit 写入 \`persona.md\`
- ✅ 最终内容不超过 1500 字符
- ✅ 只包含这个项目的内容，不含用户的个人特征
- ✅ 不要添加场景导航，也不要添加任何作用域标记
- ✅ 只操作 \`persona.md\`，不要操作其他文件`;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    variant = "user-global",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isProject = variant === "project";
  // The project variant has one prompt for both modes.
  const isCodeMode = !isProject && promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 首次生成" : "🔄 迭代更新";

  const triggerSection = triggerInfo
    ? `\n### 触发信息\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isProject
      ? `\n## 📄 当前项目记忆文档（工程已预加载）\n\n` +
        `*以下是现有 persona.md 的完整内容（${existingPersona.length} 字符）。更新后必须压缩在 1500 字符以内：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : isCodeMode
      ? `\n## 📄 当前 Team Operating Doctrine（工程已预加载）\n\n` +
        `*以下是现有 persona.md 中 Team Operating Doctrine 的完整内容（${existingPersona.length} 字符）。更新后必须压缩在 1200 字以内：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 当前 Persona（工程已预加载）\n\n` +
        `*以下是现有 persona.md 的完整内容（${existingPersona.length} 字符），基于此更新后请控制在2000字内：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isProject
      ? `\n## 🔄 迭代决策指南\n\n` +
        `面对变化场景，自主判断处理方式：强化（佐证已有内容）/ 补充（新事实或规则）/ 修正（旧内容被推翻）/ 删除（已完成或过时的状态）/ 重构（内容变长或变散）/ 不改（无有用新增内容）。\n`
      : isCodeMode
      ? `\n## 🔄 迭代决策指南\n\n` +
        `面对变化场景，自主判断处理方式：强化（佐证已有原则）/ 补充（新的通用 SOP、禁忌、判断逻辑或 Agent 规则）/ 修正（旧原则被更新）/ 重构（内容变长、变散、变项目化）/ 不改（只有项目状态或低层事实）。\n`
      : `\n## 🔄 迭代决策指南\n\n` +
        `面对变化场景，自主判断处理方式：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增内容）。\n`
    : "";

  const userPrompt = `**输出语言**：\`${targetFile}\` 使用下方变化场景内容的主导语言。

**⏰ 更新时间**: ${currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 统计
- **总记忆数**: ${totalProcessed} 条
- **场景总数**: ${sceneCount} 个
- **变化场景**: ${changedSceneCount} 个（自上次更新后）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isProject
      ? PROJECT_MEMORY_SYSTEM_PROMPT
      : isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
