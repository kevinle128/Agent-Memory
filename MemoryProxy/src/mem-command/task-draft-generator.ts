
export interface TaskDraftConfig {
  enabled: boolean;
  model: string;
  /**
   *   openai:    `${url}/chat/completions`
   *   anthropic: `${url}/v1/messages`
   *   responses: `${url}/responses`
   */
  url: string;
  apiKey: string;
  timeoutMs: number;
  protocol?: "openai" | "anthropic" | "responses";
}

export interface DraftMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CurrentTask {
  title: string;
  description: string;
  status: string;
}

export interface TaskDraftInput {
  mode: "create" | "update";
  hint?: string;
  recentMessages: DraftMessage[];
  currentTask?: CurrentTask;
  lockedTitle?: string;
}

export type TaskDraftResult =
  | {
      ok: true;
      title: string;
      description: string;
      suggestedStatus?: string;
      changed: boolean;
    }
  | { ok: false; error: string };

const MAX_STATUS_LEN = 40;
const MAX_TITLE_LEN = 40;
const MAX_DESC_LEN = 300;
const MAX_RECENT_MSGS = 30;
const MAX_MSG_CONTENT_LEN = 800;
const LLM_MAX_TOKENS = 2000;

const LLM_RETRY_MAX_ATTEMPTS = 4;
const LLM_RETRY_BASE_DELAY_MS = 200;

const LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT = 10_000;

function firstAttemptTimeoutMs(configuredTimeoutMs: number): number {
  const raw = process.env.TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS;
  let cap = LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  return Math.min(configuredTimeoutMs, cap);
}

/**
 *   anthropic  → "/v1/messages"
 *   responses  → "/responses"
 *
 *   base=".../v1" + endpoint="/v1/messages" → ".../v1/v1/messages" ❌ 404
 */
export function joinTaskDraftUrl(base: string, endpoint: string): string {
  const normalized = base.replace(/\/+$/, "");
  if (normalized.endsWith(endpoint)) return normalized;
  const segs = endpoint.split("/").filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (normalized.endsWith(prefix)) {
      return normalized + "/" + segs.slice(i).join("/");
    }
  }
  return normalized + endpoint;
}

const COMMAND_KEYWORD_PATTERNS = [
  /^\s*(?:mem:[a-z-]+)\s*[:：、,，]?\s*/i,
  /^\s*(?:fix|refactor|update|create|add|remove)\s+mem:[a-z-]+\s*[:：、,，]?\s*/i,
];

const SYSTEM_PROMPT_CREATE = `You are a task drafting assistant for a coding agent's memory system.

Given the recent conversation, generate ONE task that captures what the user is currently working on.

STRICT rules (violations will be rejected):
- title: MUST be 1 to 40 characters. NEVER exceed 40. Imperative form preferred.
- description: MUST be 1 to 300 characters, plain text. Cover three parts in order:
    background → goal → known constraints
- Write title and description in the primary language of the conversation.
- suggestedStatus: short lowercase word (e.g. "running", "completed").
- NEVER return an empty object {}. If the conversation is unclear, infer a reasonable
  task from the most recent user message and produce a best-effort title + description.

Examples of GOOD output:
  {"title":"Refactor auth module","description":"Background: the auth logic is spread across 3 files. Goal: merge it into auth-service. Constraint: do not change the public API.","suggestedStatus":"running"}

Examples of BAD output (DO NOT produce these):
  {}                                                     // ❌ empty object
  {"title":"Fix mem:create-task LLM JSON parse failure and add retry logic here"}  // ❌ title too long
  {"title":"Refactor","description":""}                  // ❌ empty description

Return ONLY the JSON object with keys: title, description, suggestedStatus. No prose, no markdown fence.`;

const SYSTEM_PROMPT_CREATE_LOCKED_TITLE = `You are a task drafting assistant for a coding agent's memory system.

The user has ALREADY specified the task title. Your ONLY job is to write a good description
based on the recent conversation that matches this title.

STRICT rules:
- description: MUST be 1 to 300 characters, plain text. Cover three parts:
    background → goal → known constraints
- Write the description in the primary language of the conversation.
- NEVER return an empty object {}. If unclear, infer a best-effort description from the title
  and most recent messages.
- Do NOT include title in the output (it is fixed by the user).

Return ONLY a JSON object with a single key: description. No prose, no markdown fence.`;

const SYSTEM_PROMPT_UPDATE = `You are a task update assistant for a coding agent's memory system.

Given an existing task and recent conversation, decide:
1. Whether the conversation adds meaningful updates to the task.
2. If yes, produce an updated description and a suggested status.

Classify what changed into ONE OR MORE of these five categories (only if applicable):
  - goal changes
  - constraint changes
  - progress
  - linked resources / references
  - collaborating agents

STRICT rules:
- If NO meaningful update → return {"changed": false}
- If YES → return {"changed": true, "title": ..., "description": ..., "suggestedStatus": ...}
- title: keep the original title unchanged (return it as-is); the caller ignores any change.
- description: MUST be 1 to 300 characters, rewrite/merge current description with categorized new info. Write it in the primary language of the conversation.
- suggestedStatus: short lowercase word; prefer "completed" if conversation signals done, else "running".
- NEVER return an empty object {}. If truly no update, return {"changed": false} explicitly.

Return ONLY a JSON object. No prose, no markdown fence.`;

function buildUserMessage(input: TaskDraftInput): string {
  const lines: string[] = [];

  if (input.mode === "update" && input.currentTask) {
    lines.push(
      "=== Current Task ===",
      `Title: ${input.currentTask.title}`,
      `Description: ${input.currentTask.description}`,
      `Status: ${input.currentTask.status}`,
      "",
    );
  }

  if (input.mode === "create" && input.lockedTitle) {
    lines.push(
      "=== Task Title (fixed by user, DO NOT change) ===",
      input.lockedTitle,
      "",
    );
  }

  if (input.hint && input.hint.trim().length > 0) {
    lines.push("=== User Hint ===", input.hint.trim(), "");
  }

  lines.push("=== Recent Conversation ===");
  const msgs = input.recentMessages.slice(-MAX_RECENT_MSGS);
  for (const m of msgs) {
    const content = m.content.length > MAX_MSG_CONTENT_LEN
      ? `${m.content.slice(0, MAX_MSG_CONTENT_LEN)}...[truncated]`
      : m.content;
    lines.push(`[${m.role}] ${content}`);
  }

  return lines.join("\n");
}

export function extractJsonObject(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    // fall-through
  }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall-through
    }
  }

  const balanced = findBalancedJsonObject(raw);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall-through
    }
  }

  return null;
}

function findBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * mode:
 */
function normalizeStr(
  v: unknown,
  maxLen: number,
  mode: "strict" | "clip" = "strict",
): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) {
    return mode === "clip" ? s.slice(0, maxLen).trim() : null;
  }
  return s;
}

function stripCommandKeywords(s: string): string {
  let out = s;
  for (const pat of COMMAND_KEYWORD_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

function normalizeStatus(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_STATUS_LEN) return undefined;
  return s;
}

export async function generateTaskDraft(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
): Promise<TaskDraftResult> {
  if (!cfg.enabled) {
    return { ok: false, error: "task_draft LLM disabled (config.memCommand.taskDraft.enabled=false)" };
  }
  if (input.mode === "update" && !input.currentTask) {
    return { ok: false, error: "update mode requires currentTask" };
  }
  if (!input.recentMessages || input.recentMessages.length === 0) {
    return { ok: false, error: "no recent messages to draft from" };
  }

  console.log(
    `[task-draft] START mode=${input.mode} protocol=${cfg.protocol ?? "openai"} url=${cfg.url} model=${cfg.model} msgs=${input.recentMessages.length}${input.lockedTitle ? ` lockedTitle="${input.lockedTitle}"` : ""}`,
  );

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      const titlePreview = "title" in result && result.title
        ? result.title.length > 40 ? `${result.title.slice(0, 40)}...` : result.title
        : "(no-title)";
      const retryTag = attempt > 1 ? " RETRY_SUCCEEDED" : "";
      console.log(
        `[task-draft] OK${retryTag} mode=${input.mode} attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} title="${titlePreview}"${attempt > 1 ? ` prev_error=${JSON.stringify(lastError)}` : ""}`,
      );
      return result;
    }
    lastError = result.error;
    if (attempt < LLM_RETRY_MAX_ATTEMPTS) {
      const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[task-draft] mode=${input.mode} RETRY attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} error=${JSON.stringify(result.error)} next_delay_ms=${delay}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(
    `[task-draft] mode=${input.mode} ALL_ATTEMPTS_FAILED total=${LLM_RETRY_MAX_ATTEMPTS} last_error=${JSON.stringify(lastError)}`,
  );
  return { ok: false, error: `LLM draft failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts: ${lastError}` };
}

async function attemptDraftOnce(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<TaskDraftResult> {
  let resp: Response;
  const effectiveTimeoutMs = attempt === 1 ? firstAttemptTimeoutMs(cfg.timeoutMs) : cfg.timeoutMs;
  const protocol = cfg.protocol ?? "openai";
  let fetchUrl = cfg.url;
  try {
    if (protocol === "anthropic") {
      fetchUrl = joinTaskDraftUrl(cfg.url, "/v1/messages");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          Authorization: `Bearer ${cfg.apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else if (protocol === "responses") {
      fetchUrl = joinTaskDraftUrl(cfg.url, "/responses");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          instructions: systemPrompt,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: userMessage }] },
          ],
          temperature: 0.3,
          max_output_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else {
      fetchUrl = joinTaskDraftUrl(cfg.url, "/chat/completions");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=fetch_error protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} error=${JSON.stringify(msg)}`,
    );
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  console.log(
    `[task-draft] mode=${input.mode} attempt=${attempt} HTTP status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model}`,
  );

  if (!resp.ok) {
    let errBodyPreview = "";
    try {
      const errText = await resp.text();
      errBodyPreview = errText.length > 500 ? `${errText.slice(0, 500)}...[truncated]` : errText;
    } catch {
      errBodyPreview = "[read body failed]";
    }
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} body=${JSON.stringify(errBodyPreview)}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let finishReason = "unknown";
  let completionTokens = -1;
  let content: string | undefined;

  if (protocol === "openai") {
    const sse = await parseOpenAiStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else if (protocol === "anthropic") {
    const sse = await parseAnthropicStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else {
    const sse = await parseResponsesStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  }

  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  const obs = `attempt=${attempt} protocol=${protocol} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

  const parsed = extractJsonObject(content);
  if (parsed === null) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=json_parse ${obs} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not valid JSON" };
  }
  if (typeof parsed !== "object") {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=not_object ${obs} parsed_type=${typeof parsed} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (input.mode === "update" && obj.changed === false) {
    return {
      ok: true,
      changed: false,
      title: input.currentTask!.title,
      description: input.currentTask!.description,
      suggestedStatus: input.currentTask!.status,
    };
  }

  //
  if (input.mode === "create" && input.lockedTitle) {
    const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
    if (!description) {
      console.log(
        `[task-draft] mode=create-locked FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
      );
      return { ok: false, error: `description missing or empty` };
    }
    const suggestedStatus = normalizeStatus(obj.suggestedStatus);
    return {
      ok: true,
      changed: true,
      title: input.lockedTitle,
      description,
      ...(suggestedStatus ? { suggestedStatus } : {}),
    };
  }

  const rawTitle = typeof obj.title === "string" ? stripCommandKeywords(obj.title) : obj.title;
  const title = normalizeStr(rawTitle, MAX_TITLE_LEN, "clip");
  if (!title) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=title ${obs} keys=${JSON.stringify(Object.keys(obj))} title_type=${typeof obj.title} title_len=${typeof obj.title === "string" ? obj.title.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `title missing or empty` };
  }
  const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
  if (!description) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `description missing or empty` };
  }
  const suggestedStatus = normalizeStatus(obj.suggestedStatus);

  return {
    ok: true,
    changed: true,
    title,
    description,
    ...(suggestedStatus ? { suggestedStatus } : {}),
  };
}

function previewContent(s: string): string {
  const MAX = 500;
  return s.length > MAX ? `${s.slice(0, MAX)}...[truncated ${s.length - MAX}]` : s;
}

function previewObj(obj: Record<string, unknown>): string {
  try {
    return previewContent(JSON.stringify(obj));
  } catch {
    return "[unserializable]";
  }
}

async function parseOpenAiStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const choices = evt.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      if (first.finish_reason && typeof first.finish_reason === "string") {
        finishReason = first.finish_reason;
      }
      const delta = first.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        parts.push(deltaContent);
      }
    }

    const usage = evt.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.completion_tokens === "number") {
      completionTokens = usage.completion_tokens;
    }
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 *   event: message_start
 *   data: {"type":"message_start", "message":{...,"usage":{"input_tokens":N,"output_tokens":M}}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 *   - completionTokens = message_delta.usage.output_tokens
 */
async function parseAnthropicStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evtType = evt.type;

    if (evtType === "content_block_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        parts.push(delta.text);
      }
      continue;
    }

    if (evtType === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        finishReason = delta.stop_reason;
      }
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        completionTokens = usage.output_tokens;
      }
      continue;
    }

    if (evtType === "message_start") {
      const message = evt.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number" && completionTokens < 0) {
        completionTokens = usage.output_tokens;
      }
      continue;
    }
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 *   event: response.created
 *   data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress",...}}
 *
 *   event: response.output_item.added
 *   data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message",...}}
 *
 *   event: response.content_part.added
 *   data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text",...}}
 *
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"..."}
 *
 *   event: response.output_text.done
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":42},...}}
 *
 *   - completionTokens = response.completed.response.usage.output_tokens
 */
async function parseResponsesStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let doneText: string | null = null;
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evtType = evt.type;

    if (evtType === "response.output_text.delta") {
      const delta = evt.delta;
      if (typeof delta === "string" && delta.length > 0) {
        parts.push(delta);
      }
      continue;
    }

    if (evtType === "response.output_text.done") {
      const t = evt.text;
      if (typeof t === "string" && t.length > 0) {
        doneText = t;
      }
      continue;
    }

    if (evtType === "response.completed") {
      const response = evt.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.status === "string") {
          finishReason = response.status;
        }
        const usage = response.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          completionTokens = usage.output_tokens;
        }
      }
      continue;
    }
  }

  const content = parts.length > 0 ? parts.join("") : (doneText ?? "");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}
