# Proxy adapter PR overlap analysis

Generated: 2026-10-22 00:48 +07 (Asia/Saigon). Base: `feat/server_team` @ 3a83a59d (fork, merged with latest upstream).
Our commits: `4cfb845` (Anthropic server tool definitions), `8a350b6` (images / non-text parts in tool results, url/file image sources, unknown OpenAI parts).
Method: read each PR diff vs its merge-base; `git merge-tree` each PR against HEAD; ran every PR's test file against our HEAD code in a throw-away copy (`/tmp/upr/sandbox`, `git archive HEAD` + symlinked node_modules). No checkout/merge/commit in the repo.

## 1. Empirical results: PR tests run against our HEAD

| PR | Merge vs HEAD | PR tests on our HEAD | Failing assertion |
|---|---|---|---|
| #1726 OpenAI tool content array | CONFLICT openai.ts | 3/3 pass | - |
| #1724 Anthropic image refs | CONFLICT anthropic.ts | 3/3 pass (url, file, base64 + cache_control) | - |
| #1723 OpenAI participant names | CONFLICT openai.ts | 1/5 pass | `name` dropped on system/user/assistant |
| #1661 Anthropic nested tool_result | CONFLICT anthropic.ts | 3/4 pass | expects text-only array flattened to string `"x\ny"`; we keep the array |
| #1136 Anthropic server tools | CONFLICT anthropic.ts (+ types.ts clean) | 1/2 pass | expects `tool.custom` field on AgentTool (implementation detail); wire output already equal |
| #1725 OpenAI unmodelled parts | clean | 2/2 pass | - |
| #1722 single-block system cache | clean | 2/4 pass | single system block with `cache_control` collapsed to string -> marker lost |

Existing local tests (all pass): `anthropic-media.test.ts` (5), `anthropic-tools.test.ts` (2), `openai-media.test.ts` (5).

Extra checks behind the verdicts:
- Adapter instances are singletons (`MemoryProxy/src/injection/index.ts:254-255`) and no code clones `ctx`/`AgentTool` (`structuredClone` / JSON round-trip absent in `src/injection`, `src/pipeline`; `tools.prepend` at `src/injection/pipeline.ts:485-496` re-uses the same objects). So the `WeakMap` in our `4cfb845` keeps its identity from parse to serialize.
- Block metadata (`raw_source`, `raw_content`, `parsed_text`) is never read or persisted outside the adapters (grep over `src` is empty). Hook cache stores hook output blocks, not parsed request blocks (`src/injection/pipeline.ts:306`). So storing base64 in `raw_source` (our 1724 equivalent) costs only a reference.
- Downstream readers of `tool_result.content` (`src/pipeline/runners/anthropic.ts:240-260`, `src/pipeline/runners/openai-chat.ts:202-215`) already accept string or array, so keeping text-only arrays as arrays (our behavior, the one #1661 assertion we fail) breaks nothing.

## 2. Per-PR verdict

### #1726 keep OpenAI tool message content parts as an array -> (a) covered by ours; ours is broader
- PR: on parse, keeps `content_parts` and sets block text to `JSON.stringify(array)`; on serialize, returns the parts only if text still equals that JSON.
- Ours (`8a350b6`, `tool-result-content.ts`): hooks see the joined text (not a JSON blob), the original array is returned when text is unchanged, and non-text parts (images) survive a hook rewrite. #1726 drops images on any rewrite and gives hooks JSON text.
- All 3 PR tests pass on our code. Decision: drop PR code, optionally add its test file as-is.

### #1724 preserve Anthropic image references -> (a) equivalent
- PR stores `image_source` only for non-base64 sources; we store `raw_source` always and use it only when `source_type !== "base64"`. Same wire output; base64 path rebuilt from `block.content` in both (so hook edits to data still apply).
- All 3 PR tests pass (url, file, base64 with `cache_control`). Decision: drop PR code, add its test file as-is.

### #1723 preserve OpenAI participant names -> (d) different bug we still have; merge with manual resolution
- We drop `name` on every role. 4/5 PR tests fail on our HEAD.
- Conflict is only in the tool-role branch (both sides changed it). Resolution in `openai.ts`:
  - `parseMessage`: add `const metadata = typeof m.name === "string" ? { name: m.name } : undefined;`; tool branch keeps our `parseToolResultContent(...)` block and returns `{ role, blocks, metadata }`; assistant `const msg: ContextMessage = { role, blocks, metadata }`; tail `return { role, blocks, metadata }`.
  - `serializeMessage`: add the `identity` object at the top; tool branch = `{ ...identity, content: serializeToolResultContent(toolResult), tool_call_id: ... }`; assistant `result = { ...identity }`; text-only and mixed-part returns use `...identity`.

### #1661 keep non-text blocks nested in Anthropic tool_result -> (c) ours covers more
- Same idea as ours (keep original array, rewrite = new text + non-text blocks). Difference: #1661 keeps the array only when a non-text block exists and flattens text-only arrays to a string; ours keeps every array as-is (lossless: keeps nested `cache_control`, `citations`, etc. on text blocks). Our helper is also shared with the OpenAI adapter.
- 3/4 PR tests pass; the failing one asserts the flattening. Decision: drop PR code; port tests 1-3 (they duplicate `anthropic-media.test.ts`; optional) and, if ported, change test 4 to expect the array.

### #1136 lossless forwarding for Anthropic server tools -> (c) keep ours; PR has a defect
- PR moves unknown tool fields into a new `AgentTool.custom` field (`types.ts`) and, on serialize, deletes `description`/`input_schema` whenever `custom.type` is a string (PR diff, `serializeTool`: `if (typeof tool.custom.type === "string") { delete out.description; delete out.input_schema; }`). That also strips them from a tool sent as explicit `type: "custom"` (a valid custom-tool form) -> broken tool. Ours checks `type !== "custom"`.
- Wire output is identical for its two fixtures (test 1 passes; test 2 fails only on asserts about the internal `tool.custom` field). Our `anthropic-tools.test.ts` also covers the Claude Code advisor server tool and hook edits to parsed custom tools.
- Trade-off accepted: ours ignores hook edits to a *server* tool (returned verbatim) and depends on object identity (verified safe above). Decision: drop PR code incl. `types.ts` change; optionally add its test file with the three `tool.custom` asserts removed.
- PR-vs-PR: #1136 and #1661 both add `__tests__/anthropic.test.ts` (add/add conflict). Moot if both are dropped; if their tests are ported, rename them (for example `anthropic-server-tools.test.ts`, `anthropic-tool-result.test.ts`).

### #1725 restore unmodelled OpenAI content parts on serialize -> (b) stricter than ours for this case; merge, then trim ours
- Merges clean against HEAD: adds a guarded `case "custom"` (accepts only a JSON object) before our modified `default`.
- After merge, our `default` `JSON.parse` only runs for block types that parse never creates (hook-injected), and it can push a non-object (`"123"` -> number). Decision: merge #1725, then restore `default` to the upstream line `parts.push({ type: block.type, content: block.content, ...block.metadata });`. Our `openai-media.test.ts` "keeps unknown user content parts" still passes through #1725's path (verified).

### #1722 preserve single-block system cache markers -> (d) different bug we still have; merge
- Our `serializeSystemMessage` collapses a single text system block to a string, dropping its `cache_control` (prompt-cache breakpoint lost -> cache miss). 2/4 PR tests fail on HEAD. Merges clean; touches no line our commits changed.

## 3. Overlaps between the PRs
- #1726 / #1723 / #1725 all edit `openai.ts` `parseMessage`/`serializeMessage`. #1725 + #1723 apply together (`patch` applied #1723 on top of #1725 with only the tool-branch hunk rejected, resolved as above).
- #1724 / #1661 / #1136 / #1722 all edit `anthropic.ts` in separate methods; only #1136 and #1661 collide (test file add/add).
- #1726 and our helper solve the same tool-array problem; #1726 and #1723 both rewrite the tool-branch return.

## 4. Test files covering the adapters
Present on HEAD (`MemoryProxy/src/injection/adapters/__tests__/`):
- `anthropic-media.test.ts` (5): tool_result images, text+image order, hook rewrite, string tool_result, url image source.
- `anthropic-tools.test.ts` (2): advisor server tool round-trip after 181 custom tools; hook edits on parsed custom tool + injected tool.
- `openai-media.test.ts` (5): image in tool message, text-part array, string, hook rewrite, unknown user parts.
No other test file in `MemoryProxy` imports `AnthropicAdapter`/`OpenAIAdapter` (only `src/subscription-pool/__tests__/test-harness.ts` matched the grep, by name only).
New from PRs: `openai-tool-array-content` (#1726), `anthropic-image-references` (#1724), `openai-message-names` (#1723), `anthropic.test.ts` (#1661 and #1136, same name), `openai-custom-parts` (#1725), `anthropic-system-cache` (#1722).

## 5. Recommended merge plan
1. Merge #1722 (clean). No resolution.
2. Merge #1725 (clean). Then edit `openai.ts` `default:` back to the single upstream `parts.push({ type: block.type, content: block.content, ...block.metadata });` (removes our unguarded `JSON.parse`).
3. Merge #1723 with the manual resolution in section 2 (keep `parseToolResultContent` / `serializeToolResultContent`; add `metadata`/`identity`). Note: the conflict shape above came from `patch` (1 of 8 hunks rejected), not `git merge`; a 3-way merge can draw the markers differently. After resolving, confirm (a) the tool branch still calls `serializeToolResultContent`, and (b) the final `return { ...identity, content: parts }` sits after #1725's `case "custom"` (the only place #1725 and #1723 touch adjacent lines).
4. Do not merge #1726, #1724, #1661, #1136 code. Add their tests instead (all pass on our code):
   - #1726, #1724: as-is.
   - #1661: optional (duplicates `anthropic-media.test.ts`); if kept, rename file and change test 4 to expect the array.
   - #1136: optional; rename file, remove the three `tool.custom` asserts.
   Reply on the upstream PRs if wanted: #1726/#1724/#1661/#1136 are superseded by our fork commits (consider upstreaming `8a350b6` / `4cfb845`; mention the `type: "custom"` defect in #1136).
5. Keep from our code: all of `4cfb845` (WeakMap tool definitions) and all of `8a350b6` (`tool-result-content.ts`, Anthropic `raw_source`, OpenAI tool-result path, `storage/factory.ts` change) except the OpenAI `default:` branch replaced by #1725.

### Verification of the combined end state
Built in `/tmp/upr/sandbox` (HEAD + #1722 + #1725 + #1723 resolved + `default` revert + all 7 PR test files, #1661/#1136 tests adjusted as in step 4). Diff of the adapters vs HEAD: `/tmp/upr/out/overlap-combined.diff`.
- Baseline HEAD: `vitest run` 20 files / 185 tests pass; `tsc --noEmit` exit 0.
- Combined: `vitest run` 27 files / 208 tests pass (+23 PR tests); `tsc --noEmit` exit 0.

## Open questions
- Should hook edits to an Anthropic *server* tool (for example renaming `advisor`) be honored? Ours ignores them; #1136 would apply them. No current injector edits existing tools, so no action now.
- Upstream the fork commits so the four superseded PRs can be closed upstream? Business decision.

Status: DONE

Summary: Of the seven upstream PRs, two fix bugs our fork still has and should be merged: #1722 (single system block loses `cache_control`, clean merge) and #1723 (OpenAI `name` dropped, manual resolution in the tool branch that keeps our shared tool-result helper). #1725 merges clean and is stricter than our unguarded `JSON.parse` for unmodelled OpenAI parts, so merge it and revert our `default:` branch to upstream. #1726, #1724, #1661 and #1136 are already covered by our commits `8a350b6` and `4cfb845` (ours is equal or broader, and #1136 has a `type: "custom"` defect); drop their code and keep their tests, with #1661 test 4 and #1136 `tool.custom` asserts adjusted. The combined end state was built in `/tmp/upr/sandbox`: full `vitest run` 208/208 pass (baseline 185/185) and `tsc --noEmit` clean; the adapter diff is in `/tmp/upr/out/overlap-combined.diff`.
