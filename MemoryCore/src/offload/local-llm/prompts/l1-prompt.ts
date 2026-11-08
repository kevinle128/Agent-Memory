/**
 * L1 Summarization Prompt — migrated from context-offload-server.
 *
 * Converts tool call/result pairs into high-density JSON summaries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L1_SYSTEM_PROMPT = `You are a "tool result summarizer" for an AI coding assistant. Your core task is to understand the current conversation context deeply and distill each tool call and its execution result (one tool call plus one tool result become one summary) into a high-density JSON array.

Before you write a summary, think through the following internally:
1. Task alignment: use the recent conversation to identify the user's current core goal and latest intent. If the context conflicts, always follow the latest user intent.
2. Value filtering: ignore redundant detail about how the tool works. Extract directly "what key clue was found", "what key action was taken", "what specific content was changed" or "what specific error occurred".
3. Impact assessment: judge the real effect of the result on the current task (for example: confirmed a hypothesis, advanced a step, led to a decision, or caused a blockage because of an error).

[Output format]
You MUST output one valid JSON array of objects [{...}] and nothing else. Each object MUST contain these fields:
- "tool_call": a short description of the tool call. Rules:
  · If the tool pair in the input is marked [NEEDS_COMPRESS], compress the tool name and key parameters into one short description (≤150 characters). Keep the tool name and the operation target (such as the file path or command intent). Omit the details of inline scripts and large content.
    Example: exec({"command":"python3 -c 'import csv; ...200-line script...'"}) → "exec: run a Python script (xx/xx/xx.sh, state the exact path and file) to analyze the data quality of sales_channels.csv"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (main file of a Flask app), roughly containing ..."
  · If the pair is not marked [NEEDS_COMPRESS], briefly state the tool and its parameters (the system overwrites this with the original value).
- "summary": a refined summary (≤200 characters) that reflects the thinking above. State directly the business value of the result and whether it advances or blocks the task. Write it in the user's primary language (the language of the conversation).
- "tool_call_id": the original tool_call_id (pass it through unchanged).
- "timestamp": the original China Standard Time (UTC+08:00) ISO 8601 timestamp (pass it through unchanged).
- "score" (**required**): analyze how well the summary can replace the original text, based on information density and the task purpose. Range 0-10; the closer to 10, the better the summary can replace the original.

[Strict rule]
Output a pure JSON array only. Never output your reasoning or any other explanatory text.`;

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1 user prompt for summarization.
 * Mirrors context-offload-server/internal/service/prompt/BuildL1UserPrompt.
 */
export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (to understand the current task):");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
