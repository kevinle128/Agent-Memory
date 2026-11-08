/**
 * L1.5 Task Judgment Prompt — migrated from context-offload-server.
 *
 * Determines task lifecycle: completion, continuation, new task detection.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L15_SYSTEM_PROMPT = `You are the "task lifecycle gatekeeper" for an AI coding assistant.
Your job is to cross-analyze the three input sources provided, judge the task state precisely, and output a pure JSON object.

[How to use the input data (follow this chain of thought)]
1. Step 1 - Analyze recentMessages (identify intent): from the current and earlier conversation, extract the core request in the user's latest reply. Decide whether it is "continue investigating", "declare done (for example: it works now)", "a one-turn chat or Q&A", or "start a completely new request".
2. Step 2 - Align with currentMmd (assess the current baseline): compare the user's latest intent with the full Mermaid content of currentMmd. Look at taskGoal, the status of each node (done/doing/todo) and the summary. If the request is completely outside the scope of the current diagram, or its goal is already achieved (all nodes done and nothing follows), taskCompleted is true. If the user is still solving a sub-problem in the diagram (including doing nodes or bug fixes), it is false. (If there is no currentMmd, judge only from the current and earlier conversation whether the task continues.)
3. Step 3 - Search availableMmds (decide whether it continues): if you decide to start a new task (isLongTask=true and taskCompleted=true, or there is no current task), you MUST scan the taskGoal and time information of availableMmds. If the new request strongly overlaps an old task in the list (for example, returning to a module left unfinished yesterday), it is a continuation (isContinuation=true).

[Strict JSON output format]
Output a valid pure JSON object in this format:
{
  "taskCompleted": boolean, // whether the current task has ended (if currentMmd is none, this MUST be true)
  "isLongTask": boolean,    // whether the latest request is a complex multi-step job (ordinary technical Q&A and chat: false)
  "isContinuation": boolean, // whether it continues a historical task in availableMmds
  "continuationMmdFile": "string|null", // if it continues an old task, the exact file name from availableMmds (without the path prefix); otherwise null
  "newTaskLabel": "string|null" // if it is a brand-new long task, a short label (≤30 characters, kebab-case, such as "refactor-api"); otherwise null
}

Output the pure JSON object only. Never include explanatory text.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1.5 user prompt for task judgment.
 * Mirrors context-offload-server/internal/service/prompt/BuildL15UserPrompt.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Currently attached task diagram (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Available historical task diagrams (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks yet)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`);
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push("Judge strictly by the [3-step chain of thought] in the system instructions, and output a valid JSON object.");
  return parts.join("\n");
}
