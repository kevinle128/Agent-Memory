/**
 * L2 MMD Generation Prompt — migrated from context-offload-server.
 *
 * Generates/updates Mermaid flowchart diagrams from offload entries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L2_SYSTEM_PROMPT = `You are an extremely pragmatic AI task-topology architect and visual storyteller.
Your core logic is to express as much information as possible in as few characters as possible. The reader is an LLM, not a human, so use as few useless visual symbols as you can. Your task is to map low-level tool call records into a highly semantic, expressive and extremely restrained Mermaid (flowchart TD) cognitive state machine. Based on the current task and intent, summarize the "past", think about how the "future" can use this information (record only existing information; do not write next-step plans), and mark "minefields". Keep the diagram highly general.

[Advanced cognition and topology guide (your autonomy and the minimalism principle)]
1. Flexible aggregation: you have full autonomy to split or merge nodes. Merge consecutive routine actions with the same intent (for example, reading several files in a row to understand the context) into one macro node, but keep key turning points and major discoveries as separate nodes. The diagram must stay high-level and restrained; never write a detailed running log.
2. Cognitive tombstones (avoid repeating mistakes): for a dead end or an abandoned approach that caused a serious error, you may create a warning node (status: blocked). Do not record low-value failures.
3. Conclusion-oriented summaries: the node summary (keep it under 150 characters) should focus on "what conclusion was reached" or "what substantive change happened", not list trivial data or parameters. Stay minimal. Write node text in the user's primary language (the language of the conversation).
4. Be factual: your task is to record and summarize what has already happened, not to plan specific future operations. Do not write nodes for things that have not happened. Each recorded node must have a message source (mark the corresponding node_id).
[Symbol as semantics: a high-level cognitive dictionary (your core tool)] To compress tokens to the extreme and give yourself "cognitive anchors" for the next reasoning step, freely use different mmd shapes to represent different node logic. Let the shape speak for you and omit redundant text.

[Free topology and minimalism rules]
1. Semantic condensation: since the shape already expresses the "domain", your summary must be extremely short (≤150 characters), such as "deadlock found", "dependency conflict", "fixed".
2. Flexible topology: use labeled edges (-->|test failed|) and dotted edges (-.->|reference|) on your own to construct "dependency trees" and "hypothesis-verification loops". Do not write a running log.
3. Dynamic update (minimal tokens):
   - replace (incremental edit): only when you change the status, timestamp or short text of existing nodes, or add very few nodes.
   - write (full rewrite): when the logic is reshuffled, the diagram is restructured, or at initialization.
Note: each line of the Existing Mermaid content starts with a line number marker (such as "L1: ..."). These line numbers are only for you to reference in replace mode; they are not part of the MMD content.

[Strict engineering limits]
1. Standard node format: NodeID["Stage name: short macro action<br/>status: done|doing|paused|blocked <br/>summary: core conclusion<br/>Timestamp: ISO8601"]
2. Every input maps to a node: every new tool_call_id in the input MUST be assigned to a Node ID in node_mapping. Every node in the MMD should have a source tool_call message; do not invent anything, and never omit any. (Node_id and tool_call_id have a one-to-many relationship.)
3. Use any merging method you like to keep the updated mmd file within 4000 characters.

[Strict timestamp and metadata rules]
1. Top metadata (required): %{ "taskGoal": "one-sentence summary of the task goal (may be updated dynamically)", "progress（0-100）": "progress percentage (be strict; give 90+ only when completion is almost confirmed)", "createdTime": "ISO time", "updatedTime": "ISO time" }% (updatedTime is the latest time among the nodes).
2. Node time: if you merged several new entries, the Timestamp in the node MUST be the latest ISO time among them.

[Strict JSON output format]
Escape double quotes correctly. All Mermaid code (both mmd_content and the content in replace_blocks) MUST be wrapped in a \`\`\`mermaid ... \`\`\` code block. You MUST output this JSON structure:
{
  "file_action": "replace or write",
  "mmd_content": "The complete .mmd code, escaped, wrapped in \`\`\`mermaid ... \`\`\`. (Fill in only when file_action is write; otherwise it MUST be null.)",
  "replace_blocks": [
    {
      "start_line": "Start line number of the range to update (integer, matching the L label in Existing Mermaid content)",
      "end_line": "End line number of the range to update (integer, inclusive). To insert new content before a line without deleting any line, set start_line to that line number and end_line to start_line - 1",
      "content": "The new replacement content (no line number prefix), wrapped in \`\`\`mermaid ... \`\`\`"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}
Output the pure JSON object only. Never include any explanation.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L2NewEntry {
  toolCallId: string;
  toolCall: string;
  summary: string;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L2 user prompt for MMD generation.
 * Mirrors context-offload-server/internal/service/prompt/BuildL2UserPrompt.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: L2NewEntry[];
  recentHistory: string | null;
  currentTurn: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } = opts;
  const parts: string[] = [];

  // History section
  if (recentHistory) {
    parts.push(`## Recent conversation history:\n${recentHistory}`);
  } else {
    parts.push("## Recent conversation history:\n(no history available)");
  }

  if (currentTurn) {
    parts.push(`\n## Latest turn:\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`(All node IDs MUST start with this prefix, such as ${mmdPrefix}-N1, ${mmdPrefix}-N2...)`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ Close to the limit. Merge nodes aggressively, shorten summaries, and prefer replace mode over a full write.");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("Keep growth under control and merge similar nodes.");
  }

  // Existing MMD with line numbers
  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  // New entries
  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.toolCallId}] ${e.toolCall} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\nGenerate or update the Mermaid flowchart per the system instructions, and output a valid JSON object (including node_mapping).");
  return parts.join("\n");
}
