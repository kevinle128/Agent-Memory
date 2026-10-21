# Upstream PR ledger

This file is the single source of truth for which upstream pull requests our fork has merged, skipped, or still has to decide.
Read it before you triage upstream PRs again. Update a row when its status changes. Do not re-review a PR that has a final status unless upstream pushed new commits to it.

- Upstream: `TencentCloud/TencentDB-Agent-Memory`. Our base: `feat/server_team`.
- Triage date: 2026-10-22 (Asia/Saigon).
- Our HEAD at triage: `3a83a59d` (it already contains upstream `6a4bb55e`).
- Scope: all 498 PRs that were open upstream at triage time.
- Detailed per-area reports: `plans/upstream-sync/reports/triage-261022-*.md`. The rubric is in `triage-261022-rubric.md`.

## Status values

| Status | Meaning | Final? |
|---|---|---|
| `merged` | Merged into our fork. Write our merge commit SHA in the Reason column. | yes |
| `pending-approval` | Recommended for merge now. Waiting for the owner's approval. | no |
| `consider` | Useful, but needs an owner read, a product decision, or a partial port. | no |
| `wait` | Correct but low value for us. Pick it up when we sync upstream. | no |
| `covered-by-ours` | Our fork already fixes the same bug. Do not merge the code. | yes |
| `duplicate` | Same fix as another PR. The Reason column names the preferred PR. | yes |
| `skip` | Not relevant to our deployment, wrong, or too large or risky. | yes |
| `skip-draft` | Draft PR. Not reviewed. Re-check it if it leaves draft. | no |
| `out-of-scope` | Targets `main` or `feat/server`, not our base. Not reviewed. | yes |

"Merge vs HEAD" values: `clean` merges cleanly onto our HEAD. `conflict-ours` conflicts only because of our fork changes. `conflict-upstream` conflicts with upstream itself (stale), so it needs a manual port. `noref` means the PR head could not be fetched.

## How to re-check a PR

```bash
git fetch upstream '+refs/pull/*/head:refs/upr/*'            # fetch all PR heads as local refs
git diff $(git merge-base upstream/feat/server_team refs/upr/N) refs/upr/N
git merge-tree --write-tree --name-only HEAD refs/upr/N         # exit code 0 = clean merge
```

Our deployment, which sets "relevance": docker `compose.yaml` runs MemoryCore (standalone, sqlite), Hub (Panel and Knowledge), and MemoryProxy.
The clients are Claude Code and Codex. We do not use Hermes, OpenClaw, dsh, WorkBuddy, CodeBuddy, OpenHands, PI, TAPD, iWiki, Podman, Windows hosts, the `deploy/global-images` scripts, or the SDKs in `sdk/`.

## Pending approval (26 PRs)

None of these are merged yet. Merge each group in the order shown, then run the tests of the touched package.

**MemoryProxy injection adapters.** The end state was verified in a sandbox: 208/208 vitest tests pass and `tsc` is clean. See `triage-261022-overlap.md` and `triage-261022-overlap-combined.diff`.
1. #1722: clean merge.
2. #1725: clean merge. Then revert our `default:` branch in `MemoryProxy/src/injection/adapters/openai.ts` to the upstream line.
3. #1723: manual conflict fix. In the tool-role branch, keep our `parseToolResultContent` and `serializeToolResultContent`, and add their `metadata` and `identity`.

**MemoryProxy, other.**
- #1517: fixes a ReDoS in the frontmatter regex (verified: 40 lines take 5.3 s). Merge it before #1521 and #1519, which edit the same function.
- #1080: adds the `codex:` session prefix to the memory and skill bridge lookups. Four agents found this bug independently. Duplicates: #1260, #1265, #1472, #1005.
- #1349: the auth/verify call must send a Bearer token once `TDAI_GATEWAY_API_KEY` is set. Duplicate: #1211.

**MemoryCore.**
- #959: L1 dedup must not be scoped to the current session.
- #1173: sqlite ignores the `recordIds` filter, so `atomic/update` edits the wrong row. Also take the tests from #1488. Duplicates: #821, #1082, #1583, #1584 and #1585 (recordIds part).
- #1717: an L2 group failure must not advance the cursor. Caveat: a group that always fails blocks the groups behind it. Duplicate: #1719.
- #814: a task that throws synchronously stalls the SerialQueue. Duplicate: #904.
- #1040: `SerialQueue.clear()` leaves `onIdle()` waiters hanging. Duplicate: #1584.
- #1344: StorePool drops `sendDimensions`.
- #1348: keyword (FTS) search hits lose their session, user, and agent fields. Duplicate: #1492.
- #1594: skill versions land in the "default" team. Duplicate: #1580.
- #1220: an extra repair pass for LLM JSON with stray quotes.
- #1311: L3 is not enqueued after a skipped L2, so the persona stops updating.
- #1366: `/session/end` never runs L1. The PR has no test, so smoke-test this endpoint after the merge.
- #1527: `acl/check` must honour explicit grants on restricted assets.

**MemoryKnowledge.**
- #1754: invalid LLM merge output must not overwrite a wiki page.
- #1470: multi-hop wiki search loses a later, better score.
- #1390: wiki summaries come back empty with reasoning models.
- #1262: the auto-sync build concurrency limit has no effect.
- #1141: the Knowledge process must exit when startup fails.

**MemoryPanel.**
- #1588: template allocation deletes fixed-asset bindings past the first 20.
- #1637: the Hub hides knowledge-service items past the first 20.
- #1713: the L2 row "more actions" menu cannot be opened with the mouse or keyboard.

Known overlaps when you combine these merges: 1344/845/777, 959/1641/1320, 1173/1488/1583, 1348/1492/1752, 1220/1595, 1517/1521/1519.

## Owner decisions (2026-10-22)

1. **L1 cursor on LLM failure: fix it properly, not a stopgap.** Port the approach of commit `a4d39853` from #1595: a retry must not re-insert groups that already succeeded, and failures must not advance the cursor. Do not merge #1619, #1397 or #1556 as the fix (status `skip`, superseded by this decision).
2. **Admin endpoint auth: approved.** Port only the auth wrapper for `/v3/admin/rate-limits` (from #808, #673 or #685) and set `TDAI_PROXY_ADMIN_API_KEY` in `compose.yaml`. Do not take the rest of those PRs.
3. **Do not push fork fixes upstream.** Our SQLite `meta_instance_upstream_config` fix and commits `4cfb845` and `8a350b6` stay in our fork only.

## Open decisions for the owner

1. **Claude Code fork misclassification (#1197).** First check the proxy logs for `kind=fork` on normal sessions. If you confirm the bug, cherry-pick only the classifier role check.
2. **Codex input layout (#1416, #1279).** Capture one Codex 0.163 request body to check whether `input[0]` is always the developer message.
3. **Repeated L0 user-message writes per tool step (#1623 commit `59fd609f`, #1278).** This needs an owner read because it touches MemoryProxy session code.

## All PRs

| PR | Title | Base | Area | Merge vs HEAD | Relevance | Status | Reason |
|---|---|---|---|---|---|---|---|
| #1763 | fix(sdk/python): reject non-finite timeout in v3 transport options | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only. |
| #1757 | fix(memory-core): compact OpenClaw tool results without breaking call pairing | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload compaction only. |
| #1754 | fix(knowledge): preserve wiki pages when LLM merge output is invalid | feat/server_team | MemoryKnowledge | clean | high | `pending-approval` | Invalid/empty LLM merge output currently overwrites an existing wiki page with only the new material (silent data loss); fix throws so commitCandidates keeps the old page and records mergeErrors (verified catch at MemoryKnowledge/src/engines/wiki/ingest-v2/... |
| #1752 | perf(memory-core): reuse short-lived query embeddings | feat/server_team | MemoryCore-A | clean | med | `consider` | 30 s per-service cache coalesces L0/L1 query embeds (fewer embedding calls per recall); performance only. |
| #1751 | fix(offload): raise the body limit for /v2/offload/compact | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Offload compact endpoint, which our clients likely do not hit. |
| #1749 | fix(memory-core): recalculate compaction token totals after fast-path replacements | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload compaction only. |
| #1748 | fix(memory-core): restore per-agent agentId in the OpenClaw plugin | feat/server_team | MemoryCore-B | clean | low | `skip` | OpenClaw client plugin; we do not run it. |
| #1743 | fix(proxy): route bare GET /v1/models so Claude Code can discover models | feat/server_team | MemoryProxy | clean | low | `wait` | Only matters when Claude Code base URL has no /agent/space prefix; our clients use the prefixed /:agent/:spaceId/v1/models route, already served by handleModels. |
| #1742 | fix(deploy): skip host-gateway flag on Podman so containers can start | feat/server_team | other | clean | low | `skip` | Podman only, and global-images scripts only; we run Docker compose. |
| #1734 | fix(proxy): record dsh turns that arrive as notices, forms, or a closed stream | feat/server_team | MemoryProxy | clean | low | `skip` | DSH-specific, but it also edits shared code: tdai-l1-recall-injector walks back past tool_result turns, which would make Claude Code run L1 recall on every tool round instead of skipping it, and it overlaps #1517/#1519/#1521 in user-query-extractor.ts. |
| #1727 | feat(proxy): verify session user_key for bridge requests | feat/server_team | MemoryProxy | clean | low-med | `wait` | Adds a core auth/verify round trip on every bridge call, but it verifies the user_key already stored in the session binding, not a caller credential, so a leaked conversation id still passes; real gain is only revoked-key enforcement, at the cost of latency... |
| #1726 | fix(proxy): keep OpenAI tool message content parts as an array | feat/server_team | MemoryProxy | conflict-ours | - | `covered-by-ours` | Covered by our commit 8a350b6 (broader). Drop code; optionally port its test (3/3 pass on HEAD). |
| #1725 | fix(proxy): restore unmodelled OpenAI content parts on serialize | feat/server_team | MemoryProxy | clean | low | `pending-approval` | Merge (clean), then revert our `default:` branch in injection/adapters/openai.ts to the upstream line; theirs is stricter (ours can push a non-object into parts). Verified in sandbox. Supersedes the proxy-live "skip" verdict. |
| #1724 | fix(proxy): preserve Anthropic image references | feat/server_team | MemoryProxy | conflict-ours | - | `covered-by-ours` | Equivalent to our commit 8a350b6. Drop code; optionally port its test (3/3 pass on HEAD). |
| #1723 | fix(proxy): preserve OpenAI participant names | feat/server_team | MemoryProxy | conflict-ours | - | `pending-approval` | Merge with a manual fix in the OpenAI tool-role branch: keep our parse/serializeToolResultContent, add their metadata/identity. Our fork drops participant `name` (PR tests 1/5 pass on HEAD). |
| #1722 | fix(proxy): preserve single-block system cache markers | feat/server_team | MemoryProxy | clean | med | `pending-approval` | Merge (clean). A single system block loses its cache_control marker; our fork still has this bug. Verified by PR tests in sandbox. |
| #1721 | fix(sdk-ts): export public skill method types | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK type export. |
| #1720 | fix(sdk-ts): accept undefined alternate generation-log selector | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only. |
| #1719 | fix(memory-core): propagate L2 extraction failures to pipeline worker | feat/server_team | MemoryCore-A | clean | med-high | `skip` | Duplicate of 1717 with extra gateway quota-credit plumbing. |
| #1717 | fix(memory-core): propagate L2 extraction failures | feat/server_team | MemoryCore-A | clean | med-high | `pending-approval` | A failed L2 group is skipped and the cursor moves past it, so those L1s never reach scenes; minimal fix with a test (a group that always fails now retries every run and blocks the groups behind it). |
| #1716 | fix(memory-core): trim oversized JEV state on overflow instead of silently deferring | feat/server_team | MemoryCore-A | clean | low-med | `skip` | needs-owner-read (ships MemoryProxy/src/injection/injectors/skill-injector.ts): superset of 1623 plus opt-in semantic/chunked JEV rewrite; default policy stays "defer". |
| #1714 | fix(knowledge): handle Windows wiki paths correctly | feat/server_team | MemoryKnowledge | clean | low | `wait` | Windows path separators only; we run Linux containers, behavior unchanged on POSIX. |
| #1713 | fix(panel): keep the L2 row's more-actions menu usable with mouse and keyboard | feat/server_team | Panel-sdk | clean | med (ui bug in panel we run) | `pending-approval` | The "more actions" menu on L2 rows cannot open by mouse (row scale on :active moves the button) or keyboard (row handler swallows Enter/Space). |
| #1710 | docs(memory-core): add the external task source guide | feat/server_team | MemoryCore-B | clean | low | `wait` | Docs only. |
| #1707 | fix(knowledge): reject credentials in repository metadata | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1705 | Keep Wiki route manager-failure diagnostics private | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1704 | fix(knowledge): escape generated wiki index links | feat/server_team | MemoryKnowledge | clean | low | `wait` | Escapes index.md link labels/paths; percent-encoded paths may confuse agents that pass the link back to page/read (no decode in resolvePageRef), and ingest filenames are normally slugs. |
| #1703 | fix(proxy): assemble multiline SSE data in session traces | feat/server_team | MemoryProxy | clean | low-med | `wait` | Spec-correct SSE data-line joining for session traces (Codex runner uses parseSseData); trace-only, no forwarding impact, our upstreams send single-line data. |
| #1702 | fix(proxy): assemble legacy streamed function call traces | feat/server_team | MemoryProxy | clean | low | `wait` | Session-trace assembler support for deprecated OpenAI function_call deltas; Claude Code and Codex do not emit them. |
| #1701 | fix(memory-core): interpret false local task judgments correctly | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload local-LLM parser. |
| #1700 | fix(memory-core): retain concurrent session registry updates | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload session registry. |
| #1699 | fix(memory-core): page the complete local object set | feat/server_team | MemoryCore-A | clean | low | `wait` | Local storage listing capped at 10k objects. |
| #1698 | fix(memory-core): preserve strings during JSON comma repair | feat/server_team | MemoryCore-B | clean | low | `wait` | Offload local-LLM parser only. |
| #1697 | fix(memory-core): retain outer offload response arrays | feat/server_team | MemoryCore-B | clean | low | `wait` | Offload parsers only. |
| #1696 | fix(memory-core): retain long managed timer deadlines | feat/server_team | MemoryCore-A | clean | low | `wait` | Delays above 2^31-1 ms fire immediately; rare. |
| #1695 | fix(memory-core): share concurrent offload session initialization | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload only. |
| #1694 | fix(memory-core): support empty local storage deletion prefix | feat/server_team | MemoryCore-A | clean | low | `wait` | `deleteByPrefix("")` on the local storage backend (instance teardown). |
| #1693 | fix(sdk-py): preserve API errors across process boundaries | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK pickling fix. |
| #1692 | fix(sdk-py): retain pagination when list selectors are omitted | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only. |
| #1691 | fix(sdk-py): preserve null when clearing user key expiration | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only. |
| #1690 | fix(sdk-py): preserve zero per-request timeout overrides | feat/server_team | Panel-sdk | clean | low (sdk) | `skip` | Makes an explicit per-request `timeout=0` effective, which is probably not what callers want; low value. |
| #1685 | Check Wiki ownership before source credential use | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1684 | Reject iWiki MCP redirects and sanitize provider failures | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1683 | fix(knowledge): keep MCP diagnostics private and off stdout | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1682 | fix(knowledge): require configured service keys for reads and tools | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1681 | fix(knowledge): sanitize global exception diagnostics and responses | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1679 | feat(memory-core): add Qdrant memory store backend | feat/server_team | MemoryCore-A | conflict-ours | low | `skip` | New backend we do not run (the .env.example conflict is trivial). |
| #1677 | Keep private payloads out of Knowledge access logs | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1676 | fix(tapd): paginate combined results using bounded page offsets | feat/server_team | MemoryCore-B | clean | low | `skip` | TAPD task source not used. |
| #1675 | Refuse Knowledge MCP redirects and sanitize client failures | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1669 | fix(deploy): preserve memory-core gateway config across restarts | feat/server_team | other | conflict-ours | low | `wait` | Fixes the global-images script overwriting a hand-edited `tdai-gateway.yaml`; our compose mounts a static repo file, so the bug does not affect us. Not related to our SQLite restart fix (see Top picks). |
| #1665 | Handle Hermes Gateway failures consistently | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1664 | Protect Hermes diagnostics, tool errors and child log targets | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1663 | Validate Opik import acknowledgments and contain diagnostics | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1662 | Preserve existing Wiki content when restoring indexes | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1661 | fix(proxy): keep non-text blocks nested in Anthropic tool_result | feat/server_team | MemoryProxy | conflict-ours | - | `covered-by-ours` | Ours covers more (keeps array and nested cache_control). Drop code; if porting its test, expect an array. |
| #1659 | Add native Wiki bundle import and interrupted-import recovery | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1658 | fix(memory-core): delete FTS rows by rowid instead of scanning record_id | feat/server_team | MemoryCore-A | clean | med | `consider` | Every L0/L1 upsert runs `DELETE ... WHERE record_id=?` on an UNINDEXED FTS column (full FTS scan); adds rowmap tables with an atomic backfill (schema change). |
| #1656 | Add authenticated native Wiki bundle export API | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1655 | Add bounded native OKF bundle preflight API | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1653 | Fix Jieba native version enforcement in Core tokenization and BM25 | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1651 | Patch known Knowledge dependency advisories and SimpleGit factory imports | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1650 | Add tolerant OKF frontmatter and advisory metadata helpers | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1648 | Reject redirects and bound error diagnostics in Hermes HTTP client | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1643 | fix(knowledge): pass instance identity and repair MCP startup | feat/server_team | MemoryKnowledge | clean | low | `wait` | Fixes the stdio MCP server (missing x-tdai-service-id header, broken bin/mcp.mjs -> dist/*.js path) but makes KNOWLEDGE_API_SERVICE_ID mandatory; our deployment does not use the stdio MCP binary. Best of the MCP cluster. |
| #1641 | fix(memory-core): opt-in fail-closed mode for L1 batch dedup failures | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Default off; only meaningful after a cursor-defer fix; same line as 959. |
| #1637 | fix(panel): page through KS list in fetchKsOnlyItems so >20 code graphs show | feat/server_team | Panel-sdk | clean | med | `pending-approval` | KS-only wiki/code-graph items past the default page of 20 never show in the Hub; small contained fix. |
| #1634 | fix(gateway): let /v3/scenario/write create missing L2 blocks (upsert) | feat/server_team | MemoryCore-B | clean | low-med | `wait` | Contract alignment with the v3 doc; MemoryProxy does not expose scenario/write and Panel edits only existing blocks. |
| #1633 | fix(proxy): restore L0-flush audit loop lost in pipeline refactor | feat/server_team | MemoryProxy | clean | low | `wait` | tee()-based audit loop so OpenAI chat-completions streams still write L0 when the client disconnects early (Hermes tool rounds); Claude Code uses the Anthropic runner and Codex the Responses runner, so it does not touch our traffic; large pipeline change (n... |
| #1630 | feat(pi): integrate durable outbox into proxy capture | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Pi only; we do not run Pi, and it is a large new subsystem. |
| #1624 | test: cover service and SDK boundaries with unit and integration suites | feat/server_team | Panel-sdk | clean | med (bundles real fixes in memorycore/knowledge/panel) | `consider` | Too large to take whole; cherry-pick candidates: SerialQueue sync-throw deadlock, expired local extract-lock renew, ingest-progress stale run clear, nested L2 scene_blocks in profile-sync; restricted-asset ACL change in metadata-service.ts needs owner read ... |
| #1623 | fix(proxy): deduplicate repeated L0 user-message writes within a turn | feat/server_team | MemoryCore-A | clean | high | `consider` | needs-owner-read: fork-sync bundle (CI workflow, Dockerfile, skill-injector, JEV trim); the valuable part is proxy commit 59fd609f (Claude Code/Codex tool loops re-send the user message every step), which touches MemoryProxy and needs an owner read. |
| #1619 | fix(memory-core): keep the L1 cursor when extraction fails so the batch is retried | feat/server_team | MemoryCore-A | clean | high | `skip` | Owner decision 2026-10-22: fix the L1 cursor properly by porting the approach of #1595 commit a4d39853, not this PR. |
| #1617 | feat(memory-core): record memory data-plane usage in a sidecar sqlite | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | New usage-metrics feature, stale (conflicts in gateway/config.ts). |
| #1616 | perf(knowledge): make the wiki ingest catalog a cacheable prefix | feat/server_team | MemoryKnowledge | clean | med | `consider` | Moves the stable existing-page catalog to the front of all three ingest prompts so provider prefix caching works; cuts wiki ingest token cost but reorders prompts (owner should spot-check ingest quality). |
| #1611 | fix(deploy): make global-images scripts work under Windows Git Bash (#1609) | feat/server_team | other | clean | low | `wait` | Windows Git Bash only; best PR of the Windows cluster. |
| #1610 | feat(openhands): OpenHands SDK adapter + v2 proxy registration (supersedes #1018, #526) | feat/server_team | other | clean | low | `skip` | OpenHands is not used; its MemoryProxy edits (bridge L1 prefixes, HEADER_ONLY_AGENTS) only add values, but they touch session code. |
| #1604 | feat(memory-core): add caller-approved atomic L1 create API | feat/server_team | MemoryCore-B | conflict-upstream | low-med | `wait` | Clean design for creating L1 notes; feature, not a fix; preferred over the upsert half of #1082. |
| #1603 | fix(skill): compensate a create whose asset registration failed | feat/server_team | MemoryCore-B | clean | med | `wait` | Fixes orphan skill row after meta_assets failure; rare on our sqlite setup. |
| #1602 | fix(sdk-ts): give credential invalidation a generation | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | Better of the STS-refresh pair (see Duplicates). |
| #1600 | fix(hermes-plugin): kill the whole Gateway process tree on Windows shutdown | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes + Windows; dup of #1383. |
| #1595 | feat(core): add structured output for L1 memory extraction | feat/server_team | MemoryCore-A | clean | med-high | `consider` | Owner decision 2026-10-22: port only the L1 cursor retry logic of commit a4d39853 (no re-insert of succeeded groups). Do not take the structured-output feature. |
| #1594 | fix(skill): write paths land the version row in the head's team, not "default" | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | Skill patch/edit without team_id appends into "default" team and hits a UNIQUE(skill_id, version) error; we use skills via the proxy. |
| #1591 | fix(core): enforce the scene-block character budget at the write path | feat/server_team | MemoryCore-A | clean | med | `skip` | Bug: scene-extractor calls `enforceSceneBlockBudget(raw, file)` with the filename as the numeric budget (NaN, type error, would wipe block bodies); tail truncation also drops content. |
| #1588 | fix(panel): page through fixed assets before template allocate (#928) | feat/server_team | Panel-sdk | clean | med | `pending-approval` | `agent-fixed-asset/set` replaces the full set, so reading only the first 20 bindings silently deletes bindings past 20 when template knowledge is allocated. |
| #1585 | fix(memory-core): validate the embedding count returned by the API (#1020) | feat/server_team | MemoryCore-A | clean | med | `consider` | Stacked on 1584; cherry-pick only commit 4fea3352 (count mismatch silently mis-maps vectors). |
| #1584 | fix(core,knowledge): release onIdle() waiters from SerialQueue.clear() (#1039) | feat/server_team | MemoryCore-A | clean | low-med | `skip` | Stacked on 1583; its new code is identical to 1040. |
| #1583 | fix(memory-core): keep the L3 cascade when destroy() flushes L2 (#1049) | feat/server_team | MemoryCore-A | clean | med | `consider` | Bundles a second recordIds fix (IN query, same bug as 1173) with a MemoryPipelineManager destroy fix (plugin mode only); pick one recordIds fix. |
| #1580 | fix(skill): append new versions in the head's team when team_id is omitted (#1577) | feat/server_team | MemoryCore-A | clean | med | `skip` | Duplicate of 1594, which is tested and keeps an explicit team_id. |
| #1579 | fix(proxy): scope Claude Code session init to requested team | feat/server_team | MemoryProxy | clean | med-high | `consider` | We run headerAutoSelect; today a metadata timeout during Claude Code session-init persists bypassed=true, so the whole session runs without memory; this PR passes through and retries next request instead, and loads only the header team's directory; touches ... |
| #1575 | fix(proxy): honor the external gateway URL environment override | feat/server_team | MemoryProxy | conflict-upstream | low | `wait` | Our compose sets `injection.externalGatewayUrl` in YAML (compose.yaml:155), so the env override is optional. |
| #1574 | refactor(core): share hybrid candidates between recall entry points | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Refactor; stale. |
| #1572 | fix(core): fall back when the default log directory is unavailable | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Stale (CHANGELOG conflict only); minor. |
| #1571 | docs(knowledge): explain wiki creation and asset registration | feat/server_team | MemoryKnowledge | conflict-upstream | low | `skip` | Docs only and stale against upstream. |
| #1570 | fix(sdk): preserve STS refresh ownership during invalidation | feat/server_team | Panel-sdk | conflict-upstream | low (sdk) | `skip` | Duplicate of 1602, stale. |
| #1568 | fix(sdk-py): validate prompt ID collections before deduplication | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only. |
| #1567 | fix(hermes-plugin): read agent_id from MEMORY_TENCENTDB_AGENT_ID (#1545) | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only; overlaps #1121. |
| #1563 | feat(gateway): add core/delete to remove L3 persona per triplet (#1525) | feat/server_team | MemoryCore-B | clean | low-med | `wait` | New endpoint, not a bug fix. |
| #1560 | feat(gateway,plugin): per-user memory stores behind multiUser.enabled | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1558 | fix(MemoryCore): replace pnpm-workspace.yaml build placeholders with explicit decisions | feat/server_team | MemoryCore-B | clean | low | `wait` | Our pnpm-workspace.yaml has literal placeholder strings; only affects pnpm local dev (Docker uses npm). |
| #1557 | fix(prompts): stop L2 scene blocks from growing monotonically | feat/server_team | MemoryCore-A | clean | med | `consider` | L2 prompt forces full rewrite on UPDATE and a hard 1500-char budget; safe prompt-only path for scene bloat. |
| #1556 | fix(core): default llm.stream to false and preserve L1 cursor on failure | feat/server_team | MemoryCore-A | clean | high | `skip` | Owner decision 2026-10-22: fix the L1 cursor properly by porting the approach of #1595 commit a4d39853, not this PR. |
| #1555 | fix(build): restore seed-v2 build with placeholder fixtures | feat/server_team | MemoryCore-B | clean | low | `skip` | Duplicate of #998 with a heavier, less clear change. |
| #1554 | fix(security): harden gateway errors, callbacks, Git sources, and proxy forwarding | feat/server_team | MemoryKnowledge | conflict-upstream | high (proxy/panel), med (knowledge) | `skip` | Bundles 5 security changes across Core/Panel/Proxy/Knowledge; MemoryPanel/src/panel/config/panel-config.ts inserts `callbackToken:` inside resolveSessionSecret() (syntax error) and makes Knowledge->Panel callbacks fail closed (503) unless KNOWLEDGE_CALLBACK... |
| #1553 | Fix/issue 1550 | feat/server_team | MemoryKnowledge | conflict-upstream | med | `wait` | Superset of #1518 plus auto-sync revision probe; 8.6k lines, conflicts with upstream itself. |
| #1542 | fix(proxy): restore strict typecheck and verify Panel onboarding | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1541 | feat(panel): manage normal user keys by account | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1540 | feat(panel): allow self-owned Team creation for Teamless users | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1539 | feat(panel): memory review UI for the change ledger | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Large stale feature. |
| #1538 | feat(core): unified change ledger for after-the-fact memory review | feat/server_team | MemoryCore-A | conflict-upstream | low | `skip` | Very large; stale. |
| #1537 | feat(panel): add independent admin user directory | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Stale feature. |
| #1536 | fix(panel): recover new user after team member add fails | feat/server_team | Panel-sdk | conflict-ours | low-med (admin create-user flow; orphan user + lost key if member add fails) | `wait` | Conflict is trivial (see below), but value is an edge case of an admin-only flow. |
| #1535 | docs: skills framework README (DE), MemoryPanel pnpm align, orchestration wiring | feat/server_team | other | conflict-ours | low | `skip` | Its AGENTS.md/CLAUDE.md would replace ours (GitNexus rules), and its `.gitignore` adds `docs/*.md`, which would hide our docs. |
| #1527 | fix: acl/check honors explicit grants on restricted assets | feat/server_team | MemoryCore-B | clean | med | `pending-approval` | acl/check denied restricted assets even with an explicit grant; Panel skill-fork/knowledge flows use restricted visibility + ACL. |
| #1521 | fix(proxy): unwrap Claude Code queued user messages before stripping system-reminders | feat/server_team | MemoryProxy | clean | med | `consider` | Claude Code puts instructions typed while a tool runs inside <system-reminder> ("The user sent a new message while you were working:"), which the extractor drops, so L0 misses them and L1 recall gets an empty query; exact-marker unwrap, complementary to #15... |
| #1519 | fix(proxy): filter Claude Code harness messages from user queries | feat/server_team | MemoryProxy | clean | med | `consider` | Strips more Claude Code harness blocks (task-notification, local-command-*, bash-*, command-*, compact "This session is being continued" summary) from the L0 write and the L1 recall query, so memory stops storing harness noise; touches injection/injectors/t... |
| #1518 | fix(knowledge): preserve last-good CodeGraph index on refresh failure | feat/server_team | MemoryKnowledge | conflict-upstream | med | `wait` | Last-good CodeGraph index on refresh failure is valuable but 7.8k lines/54 files and stale; take after upstream lands it. |
| #1517 | fix(MemoryProxy): harden user-query-extractor frontmatter regex against ReDoS (#1510) | feat/server_team | MemoryProxy | clean | high | `pending-approval` | Verified locally: the current regex (common/user-query-extractor.ts:182) backtracks exponentially - "---\n" + 40 "foo:" lines takes 5.3 s in node, and every added line about doubles it; extractUserQueryText runs on the request path (tdai-l1-recall-injector,... |
| #1507 | fix(sdk-ts): reject non-object success data in both transports | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK only; complements 1335. |
| #1506 | fix(recall): rank L1 FTS hits by query-token coverage before BM25 | feat/server_team | MemoryCore-A | clean | med | `consider` | Changes sqlite keyword ranking and adds per-token FTS queries per recall. |
| #1504 | fix(sdk-py): normalize only null data in the v3 transport envelope | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | Same code change as 1243; prefer this one (clearer comment, more tests). |
| #1503 | fix(sdk-py): tolerate null or non-dict data in the v2 transport envelope | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | SDK v2 transport counterpart of 1504. |
| #1500 | fix(memory-core): deterministically normalize L1 "user (name)" attribution | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Regex strips every bracketed name unless it is in an allowlist that defaults to empty, so legit names are lost. |
| #1499 | fix(sdk-ts): encode COS object paths in file reader URLs | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | TS half of a pair with 1497 (not duplicates). |
| #1498 | fix(sdk): enforce session limits after merging legacy delete IDs | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | Same change is also inside 1624; take one. |
| #1497 | fix(sdk-py): encode COS object paths in file reader URLs | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | Python half of 1499. |
| #1492 | feat(v2): add /conversation/sessions listing and stop dropping session dims from search hits | feat/server_team | MemoryCore-A | clean | low-med | `wait` | New sqlite-only endpoint; superset of 1348 in conversation-search.ts. |
| #1491 | perf(sqlite): add idx_l0_user_agent_ts so L0 pagination stops rebuilding its sort | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Small Panel pagination performance gain. |
| #1490 | perf(gateway): build the v3 management-plane route table once at module load | feat/server_team | MemoryCore-B | clean | low | `wait` | Micro-perf only. |
| #1489 | chore(v2-router): drop unreachable legacy block in handleConversationCount | feat/server_team | MemoryCore-B | clean | low | `wait` | Dead code removal. |
| #1488 | test(memory-core): enforce store contracts and L1 query filters | feat/server_team | MemoryCore-A | clean | high | `consider` | Same recordIds bug as 1173, but as a post-filter after a full scan; take the 1173 fix and keep these contract tests (same function, will conflict). |
| #1487 | fix(metadata): retry relation-id collisions for async inserts | feat/server_team | MemoryCore-B | clean | low | `wait` | MongoDB metadata adapter only; we run sqlite. |
| #1482 | fix(proxy): read SessionInfo fields directly instead of through Record casts | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Typing cleanup on the old handlers; the runners were since rewritten. |
| #1481 | fix(proxy): declare traceId on RequestLogEntry | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded: `traceId?` is already declared at HEAD (MemoryProxy/src/types.ts:1175). |
| #1480 | fix(proxy): keep CreditReportOutcome's optional members through the skip ternary | feat/server_team | MemoryProxy | conflict-upstream | low | `wait` | A type-inference fix for credit reporting with no runtime effect we depend on. |
| #1478 | fix(proxy): declare sessionInit.skipAssetConfirm in RawYamlConfig | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded: already declared at HEAD (types.ts:1083); duplicates #1357. |
| #1477 | fix(proxy): strip workbuddy question text before the skip check | feat/server_team | MemoryProxy | clean | low | `skip` | WorkBuddy-only arrow-form unwrapping; the PR itself notes the Claude Code path already gets a bare answer. |
| #1476 | fix(proxy): auto-select solo agent in split-stage session init | feat/server_team | MemoryProxy | conflict-upstream | med (codex uses this state machine) | `skip` | Superseded: HEAD already auto-selects a solo agent (session/codebuddy/init.ts:1490); duplicates #1180. |
| #1475 | feat(memory-core): activate skill vector search on the PostgreSQL backend | feat/server_team | MemoryCore-B | clean | low | `skip` | PostgreSQL backend; we run sqlite; superset of #1466. |
| #1474 | feat(knowledge): add knowledge-wiki-sync (two-way wiki <-> local git sync) | feat/server_team | MemoryKnowledge | clean | low | `skip` | New two-way wiki<->git sync CLI (1.1k lines); feature we did not ask for, also rewrites bin/mcp.mjs and http-client.ts. |
| #1473 | fix: resume pending-backlog sessions after restart (standalone Gateway) | feat/server_team | MemoryCore-B | clean | high | `consider` | We run standalone in Docker and lose L1 drain after restart; but the boot re-arm uses sessionKey only (no teamId/agentId), so owner must confirm the drained L1 keeps team/agent scope. |
| #1472 | fix(bridge): probe all known agent sources for L1 session lookup | feat/server_team | MemoryCore-B | conflict-upstream | high | `duplicate` | Same Codex `codex:` bridge-prefix fix as #1080; prefer #1080. |
| #1470 | fix(knowledge): propagate improved scores in multi-hop wiki search | feat/server_team | MemoryKnowledge | clean | med | `pending-approval` | Multi-hop wiki graph search dropped score improvements found later in the same layer (only first visit was propagated), so neighbors of the strongest seed got wrong scores; small contained fix with an exhaustive bounded-walk test. |
| #1466 | feat(metadata): PostgreSQL metadata store backend (schema per instance) | feat/server_team | MemoryCore-B | clean | low | `skip` | PostgreSQL; we run sqlite; subset of #1475. |
| #1463 | fix(memory-core): support string-only content in strict LLM endpoints | feat/server_team | MemoryCore-A | clean | low | `wait` | Opt-in shim for strict OpenAI-compatible endpoints. |
| #1458 | feat(pi): interactive /tdai-memory-forget with redacted preview and confirm gate | feat/server_team | MemoryProxy | clean | low | `skip` | Pi-plugin feature plus a new Pi-only proxy route; we do not run Pi. |
| #1457 | feat(panel): add hierarchical wiki page navigation | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Stale UI feature. |
| #1456 | fix(core): honor LOG_LEVEL in gateway logger | feat/server_team | MemoryCore-B | clean | low-med | `wait` | Useful ops knob (default stays debug); not a bug. |
| #1455 | fix(gateway): distinguish store failure from not-found in DELETE /memories | feat/server_team | MemoryCore-A | clean | med | `consider` | Returns 502 instead of a false "not found"; also adds the isolation filter to tcvdb deleteL1; partial deletes before an error skip audit rows. |
| #1453 | fix(panel): allow agent deletion when SkillCore is disabled | feat/server_team | Panel-sdk | clean | med (only if skillcore disabled in our deploy) | `consider` | Without SkillCore the agent delete always fails; useful only if our MemoryCore runs with no skill module - owner must confirm our config. |
| #1439 | fix(gateway): report degraded vector stores in health | feat/server_team | MemoryCore-B | clean | med | `wait` | /health stays 200 but adds vectorStoreStatus; nice observability, our healthcheck only curls -f. |
| #1437 | fix(store): don't cache a StorePool entry whose init failed | feat/server_team | MemoryCore-A | clean | med | `consider` | One transient DB error at first contact leaves the instance degraded forever (silent [] reads); `getStore` now throws, so callers' error paths change. |
| #1431 | fix(proxy): version injection cache by hook config | feat/server_team | MemoryProxy | clean | low | `wait` | Stops session_init hook-cache entries from serving stale tool blocks after proxyBaseUrl/allowLlmWrite/SKILL_VIEW_MODE change; only matters on config change, and it does not version prompt-template text, so it does not cover template edits like #1361; touche... |
| #1430 | feat(memory-core): add an opt-in time window for LLM pipeline tasks | feat/server_team | MemoryCore-A | clean | low | `skip` | Feature we do not need. |
| #1429 | fix(proxy): allow taskless session initialization | feat/server_team | MemoryProxy | clean | med | `consider` | Teams with zero tasks currently bypass session-init (no memory injection, no L0 write) for Claude Code and the codebuddy/codex init path; this registers with team+agent and no task, which reverses upstream's stated "team+agent+task or nothing" contract - pr... |
| #1427 | fix(proxy): resolve Pi sessions from bridge L1 | feat/server_team | MemoryProxy | conflict-upstream | low | `wait` | Pi-focused, but its shared L1 candidate helper built from the AgentKind registry would also fix the missing `codex:` bridge lookup (see #1416). |
| #1426 | fix(gateway): never strand L0 backlog on a stale conversation_count + standalone manual L1 drain endpoint | feat/server_team | MemoryCore-B | conflict-upstream | high | `consider` | Our server.ts:3039 still skips timer-fired L1 when conversation_count==0, which can strand backlog; complements #1473; needs manual port. |
| #1423 | fix(pi): disable developer role for strict upstreams | feat/server_team | MemoryCore-B | clean | low | `skip` | Pi client not used. |
| #1421 | feat(pi): sync mined skills into native Pi skills | feat/server_team | MemoryCore-B | clean | low | `skip` | Pi feature. |
| #1418 | fix(proxy): restore memory identity when auth is disabled | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Only affects `auth.enabled=false`; ours is `true` (MemoryProxy/config.yaml:19), and it rewrites all four old handlers. |
| #1417 | fix(hermes): read conversation search hits from data.messages | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only; dup of #835. |
| #1416 | fix(proxy): support ChatGPT auth and Codex memory round-trips | feat/server_team | MemoryProxy | conflict-upstream | high | `consider` | Port only the Codex injection part (inject when input[0] is not the developer message). Its `codex:` bridge prefix is covered by #1080. Confirm the Codex request layout first. |
| #1415 | feat(pi): isolate memory across /tree branches | feat/server_team | MemoryCore-B | clean | low | `skip` | Pi feature; touches MemoryProxy session-key.ts (needs-owner-read if ever taken). |
| #1412 | fix(memory-core): document and surface the per-strategy semantics of recall.scoreThreshold | feat/server_team | MemoryCore-A | clean | low | `wait` | Docs and logs only. |
| #1410 | fix(proxy): stop Pi profile splitting sections inside nested XML blocks | feat/server_team | MemoryProxy | clean | low | `skip` | Pi agent profile only; we do not run Pi. |
| #1409 | fix(hermes-plugin): bridge MEMORY_TENCENTDB_LLM_* to TDAI_LLM_* when spawning the Gateway | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only; same bug as #1115. |
| #1408 | fix(memory-core): make CJK recall work without jieba via character-bigram fallback | feat/server_team | MemoryCore-A | clean | low | `wait` | Only matters when the jieba native module is missing; our Linux image ships it. |
| #1407 | feat(gateway): multi-provider llm config via activeProvider + providers[] | feat/server_team | MemoryCore-B | clean | low-med | `wait` | Config feature; we use one provider via env. |
| #1406 | feat(memory-core): port #228's multi-dialect disableThinking strategies to v3 | feat/server_team | MemoryCore-A | clean | low | `wait` | Opt-in fetch rewrite for reasoning models; conflicts with 1463/1183 in llm-runner. |
| #1405 | fix(memory-core): pin L1 user-name attribution to explicit self-introduction | feat/server_team | MemoryCore-A | clean | med | `consider` | Prompt-only fix for third-party names leaking into "用户（X）"; prefer it over 1500. |
| #1404 | fix(proxy): expose safe network error cause | feat/server_team | MemoryProxy | clean | low-med | `wait` | Logs allowlisted err.cause fields (code/syscall/address/port) so "fetch failed" upstream errors become diagnosable; observability only; one hunk targets the WorkBuddy handler. |
| #1401 | feat(memory-core): per-layer LLM overrides (llm.layers.{l1,l2,l3}) | feat/server_team | MemoryCore-B | conflict-upstream | med | `wait` | Useful to give L1 a small JSON budget (reasoning-model truncation) but a feature and stale. |
| #1400 | fix(proxy): capture final DSH headless turns | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | DSH only. |
| #1399 | feat(panel): support renaming Wiki knowledge bases | feat/server_team | Panel-sdk | conflict-upstream | low | `wait` | Small feature; take on next upstream sync if it lands. |
| #1397 | fix(memory-core): defer L1 extraction failures instead of advancing the cursor | feat/server_team | MemoryCore-A | clean | high | `skip` | Owner decision 2026-10-22: fix the L1 cursor properly by porting the approach of #1595 commit a4d39853, not this PR. |
| #1390 | fix(knowledge): raise wiki-summary maxOutputTokens 1024 → 4096 | feat/server_team | MemoryKnowledge | clean | med | `pending-approval` | Wiki summary capped at 1024 output tokens returns empty text on reasoning models (hidden reasoning eats budget); one-line raise to 4096. Our LLM_MODEL is env-configurable, so this can bite us. |
| #1387 | feat: PostgreSQL storage backend (pgvector + tsvector) with Skill module alignment | feat/server_team | MemoryCore-A | clean | low | `skip` | New backend we do not run (prefer it over 1353 if ever needed). |
| #1384 | feat: skill extraction pipeline fix + rate limiting (ponytail) | feat/server_team | MemoryCore-A | conflict-upstream | low | `skip` | Mixed-scope PR; stale. |
| #1383 | fix(hermes): terminate the Gateway process tree on Windows | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes + Windows; dup of #1600. |
| #1378 | fix(proxy): skip DSH permission notice in fresh-session detection | feat/server_team | MemoryProxy | clean | low | `skip` | DSH-only; we do not run DSH. |
| #1376 | feat(memory-core): reinforce L1 memories selected by agents | feat/server_team | MemoryCore-A | clean | low-med | `skip` | New usage-boost feature plus `tdai_memory_use` tool (plugin contract); not for our clients now. |
| #1371 | feat(memory-core): add direction A memory evaluation | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Evaluation data/docs. |
| #1369 | feat(memory-core): add source-feedback evaluation and budgeted retrieval example | feat/server_team | other | clean | low | `skip` | 59k-line `examples/memory-ac` research artifact, no runtime value. |
| #1368 | feat(integrations): add pluggable subscription memory hooks | feat/server_team | other | clean | low | `skip` | Hook-based client integration (Codex/zcode) as an alternative to the proxy; we route through MemoryProxy. |
| #1367 | feat(proxy): support ZCode Agent Memory integration | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Adds a new client (ZCode) that we do not use. |
| #1366 | fix(gateway): let flush tasks fall through to executeL1 | feat/server_team | MemoryCore-B | clean | med | `pending-approval` | Our server.ts:3246 executeFlush calls handleSessionEnd -> StatefulPipelineManager.flushSession, which only enqueues another flush task, so /session/end never runs L1; removing it uses the worker fallback at pipeline-worker.ts:995. |
| #1364 | feat(memory-core): implement vec0 KNN + RRF hybrid path for sqlite skill store | feat/server_team | MemoryCore-A | noref | low | `skip` | No ref fetched. |
| #1361 | fix(proxy): correct skill resource download behavior and recipes | feat/server_team | MemoryProxy | clean | med | `consider` | The injected skill_files_read recipe tells agents that adding curl -o to files/read returns raw bytes, but the server returns a JSON envelope (only files/download returns bytes), so saved scripts contain JSON; also fixes zero-byte files returned as an envel... |
| #1360 | fix(proxy): record completed skill download calls in telemetry | feat/server_team | MemoryProxy | clean | low | `wait` | Adds the missing bridge_call telemetry row for successful skill files/download; analytics accuracy only. |
| #1359 | fix(proxy): honor read-only mode in skill listing instructions | feat/server_team | MemoryProxy | conflict-upstream | med | `consider` | HEAD still tells the model to call `skill_patch` / update skills (skill-injector.ts:85-88) while `allowLlmWrite=false`, so CC/Codex call a tool that gets a 403. |
| #1358 | fix(memory-core): expose extraction configuration in skill archive responses | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Response-shape change + SDK, stale. |
| #1357 | fix(types): declare skipAssetConfirm in RawYamlConfig.sessionInit | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded (types.ts:1083). |
| #1355 | fix(memory-core): publish L3 persona after successful generation | feat/server_team | MemoryCore-A | conflict-upstream | med | `wait` | Atomic persona publish is worth taking at next sync; stale. |
| #1353 | feat(memory-core): add PostgreSQL storage backend (pgvector + tsvector) | feat/server_team | MemoryCore-A | clean | low | `skip` | New backend we do not run; 1387 is a superset. |
| #1349 | fix(proxy): send a configurable bearer on the auth verify call | feat/server_team | MemoryProxy | clean | med | `pending-approval` | MemoryCore protects /v3/meta/* with server.apiKey (gateway/server.ts:1029, 1311), and our compose.yaml wires TDAI_GATEWAY_API_KEY, but proxy auth.ts:76-84 sends no Authorization on /v3/meta/auth/verify, so setting a gateway key makes every proxy request 401... |
| #1348 | fix(memory-core): preserve source fields in conversation search | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | The FTS branch of L0 search drops session_id/user_id/agent_id, so hits differ by which strategy won. |
| #1347 | fix(injection): curl 配方补 Windows 说明（PowerShell 别名导致调用失效） | feat/server_team | MemoryProxy | clean | low | `skip` | Windows/PowerShell-only prompt text; our clients run on macOS/Linux and the change adds tokens to every injected block. |
| #1346 | fix(mem-command): session-reset 在真实客户端报文下的识别缺陷 | feat/server_team | MemoryProxy | clean | low-med | `consider` | Claude Code 2.x appends a system message / <system-reminder> block after the user text, so `mem:session-reset` and other mem: commands are missed, and a tool_result turn can replay an old command (form shown twice); fix is sound but loosens command parsing ... |
| #1344 | fix(store-pool): forward sendDimensions to the sqlite embedding service | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | Gateway StorePool sqlite path drops `sendDimensions` (verified store-pool.ts:459), so `sendDimensions:false` is ignored. |
| #1339 | fix(session): unblock dsh session-init for pi-ai / headerless OpenAI-compatible channels (#1179) | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | DSH / pi-ai only. |
| #1335 | fix(sdk-ts): validate v3 response envelopes before accessing fields | feat/server_team | Panel-sdk | clean | low (sdk) | `wait` | Same envelope check is also inside 1624. |
| #1334 | feat(agent-adapters): Hermes 交互式 tools 接入 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Hermes only. |
| #1333 | fix(memory-core): stop compact truncation loops spinning on oversized tool results | feat/server_team | MemoryCore-B | clean | low | `wait` | Infinite CPU loop, but only in offload_server compaction used by OpenClaw. |
| #1332 | fix(proxy): preserve WorkBuddy memory routing | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | WorkBuddy answer-line parsing; we do not run WorkBuddy. |
| #1330 | fix(deploy): make global-images scripts work under Git Bash on Windows | feat/server_team | other | conflict-upstream | low | `skip` | Duplicate of 1611 (Windows), and stale. |
| #1328 | feat(obs): memory-access 审计覆盖读路径（recall / search / query / read） | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Opik observability stack; we use Langfuse. |
| #1326 | chore(proxy): 修复 feat/server_team 基线类型错误（MemoryProxy tsc 0） | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Fixes a baseline that has since moved; stale. |
| #1325 | feat(agent-adapters): add OpenClaw adapter + DSH/OV research notes | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1324 | docs: refresh contribution workflow and L1 backlog comment | feat/server_team | other | conflict-upstream | low | `wait` | Docs plus a comment only; stale. |
| #1323 |  fix(memory): cascade-delete agents on member/user removal and allow admin deletion (#1321) | feat/server_team | MemoryCore-B | clean | med | `consider` | Fixes orphan agents in team mgmt we use via Panel, but hard-deletes agents on member removal (policy decision) and changes sqlite tx (SAVEPOINT) + Panel; owner review. |
| #1320 | fix(memory-core): compute L1 dedup timestamps in code instead of trusting the model | feat/server_team | MemoryCore-A | clean | med | `consider` | Stops trusting model-invented merged_timestamps, but falls back to `store` when source IDs are missing (possible more duplicates). |
| #1319 | fix(memory-bridge): populate agent_source in SessionIdFields | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded: `agent_source` exists at HEAD (memory-bridge.ts:81, :350). |
| #1315 | feat(session-init): headless web-link fallback for dsh/hermes | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Only for headless clients we do not run; one of three competing versions (#1255, #1315). |
| #1314 | feat(hermes): minimal interactive session-init via clarify tool | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Hermes only; competes with #1215 and #1334. |
| #1312 | feat(l2): deterministic scene maintenance (semantic dedup + heat decay + cold eviction) | feat/server_team | MemoryCore-A | clean | low-med | `skip` | Default-on automatic scene dedup, decay, and eviction (archives scenes) controlled by env vars; untested behavior change. |
| #1311 | fix(l3): enqueue L3 when L2 is skipped so persona can (re)generate | feat/server_team | MemoryCore-B | clean | high | `pending-approval` | Once L2 is skipped (maxScenes reached or L1 drained) L3 is never enqueued, so persona stops updating; PersonaTrigger still gates LLM cost. |
| #1310 | feat(obs): Opik create/span 批量上报队列 | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1309 | feat(obs): request_log 可配置 + 失败 trace 正常收尾 | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1307 | feat(obs): Opik traceId 按轮次提问归组 | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1305 | feat(proxy): add structured skill access telemetry | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1297 | fix(panel): 修复分配记忆弹窗空 Agent 提示竖排 | feat/server_team | Panel-sdk | conflict-upstream | low | `wait` | Cosmetic. |
| #1294 | feat(recall): deepen RRF candidate pool for L1 hybrid search | feat/server_team | MemoryCore-A | clean | med | `consider` | candidateK goes from k*3 to max(50, k*10) for L1 hybrid; better recall of rare matches, more DB and vector work per query. |
| #1291 | fix(proxy): register opencode in AGENT_PREFIX_RE | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | We do not use opencode; duplicates #1247, which is better (derives the regex from the registry). |
| #1290 | feat(proxy): add native [OI]-compatible /v1/models endpoint | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | `modelsHandler.ts` already exists upstream (that is the conflict); duplicates #1114. |
| #1284 | Fix/proxy legacy session hydration | feat/server_team | MemoryProxy | clean | low-med | `wait` | Hydrates pre-space-migration 3-part session rows to _default space; only matters if our session DB has rows older than the space migration; touches db/sessionRepo (session path). |
| #1283 | fix(knowledge): rewrite CJK code-graph queries to identifier tokens | feat/server_team | MemoryKnowledge | conflict-upstream | low | `wait` | CJK query rewrite for code-graph search; we do not query in CJK; conflicts upstream. |
| #1281 | feat(proxy): add dynamic skill queue strategies | feat/server_team | MemoryProxy | conflict-upstream | low-med | `skip` | A large change to skill injection strategy on hot injection paths; not a bug fix. |
| #1279 | fix(proxy): 将 Codex 资产注入 Responses instructions | feat/server_team | MemoryProxy | clean | high (codex) | `consider` | Today injectCodexAssets (pipeline/runners/codex.ts:244) silently skips injection when input[0] is not a message with array content; moving the block into body.instructions fixes that but changes the cache-leading prefix every turn and may be rejected by the... |
| #1278 | fix(proxy+core): L0 重复写入、L1 同批冲突与主语误归因 (#1245 #1217 #1213) | feat/server_team | MemoryCore-A | conflict-upstream | high | `consider` | needs-owner-read: targets Codex L0/L1 duplication via MemoryProxy/src/pipeline/runners/codex.ts; stale; overlaps the 1623 L0 dedup. |
| #1277 | feat(proxy): 支持 Chat/Responses ↔ Anthropic 协议转换 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Cross-protocol conversion we do not need (the pool serves Codex natively); competes with #1226/#1253. |
| #1276 | feat(memory-core): add opt-in feedback-driven memory policy self-optimization | feat/server_team | other | clean | low | `skip` | Huge feature: it edits `l1-extractor.ts` and `.github/workflows/pr-ci.yml` and adds 12k-line lockfiles; too risky for no need. |
| #1272 | fix(knowledge): emit local-time ISO 8601 timestamps from logger | feat/server_team | MemoryKnowledge | clean | low | `wait` | Logger switches from UTC to local time with offset (dayjs already a dependency); cosmetic, containers usually run in UTC anyway. |
| #1270 | feat(obs): Opik 可观测接入与 memory 审计线 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Opik, not Langfuse. |
| #1266 | feat(openclaw): add native session bridge and web session init | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | OpenClaw only; also touches MemoryCore. |
| #1265 | fix(proxy): bridge session resolution + Pi first-class (companion to #1260) | feat/server_team | MemoryCore-B | clean | high (proxy part) | `duplicate` | Same Codex `codex:` bridge-prefix fix as #1080; prefer #1080. |
| #1262 | fix(knowledge): enforce auto-sync build concurrency | feat/server_team | MemoryKnowledge | clean | med | `pending-approval` | Auto-sync scheduler released its concurrency slot when the build was only enqueued, so the configured limit did not bound real builds; now awaits cgService.onIdle(id) (exists at code-graph-service.ts:545). |
| #1260 | fix(proxy): bridge session resolution + make Pi a first-class client | feat/server_team | MemoryCore-B | clean | high (proxy part) | `duplicate` | Same Codex `codex:` bridge-prefix fix as #1080; prefer #1080. |
| #1258 | fix(deploy): honor PROXY_UPSTREAM_PROTOCOL in LLM connectivity checks | feat/server_team | other | clean | low | `wait` | Correct fix for the verify.sh/interactive setup on Anthropic proxy upstreams, but global-images only. |
| #1256 | feat(memory-proxy): 支持 OpenClaw/Hermes 无 Task 接入与会话自动续接 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | OpenClaw/Hermes only, and it changes claude-code/init.ts, which is risky for us. |
| #1255 | feat(proxy+panel): web-link session-init fallback for headless agents | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Headless clients only; #1315 is its smaller replacement. |
| #1253 | feat(protocol): 协议接线 + 上游能力自动探测 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Second layer of the #1226 protocol stack; too large, not needed. |
| #1252 | fix: make services start and work correctly on Windows | feat/server_team | MemoryKnowledge | conflict-upstream | low | `skip` | Windows startup fixes; Windows hosts not used. Overlaps #1714. |
| #1251 | feat(session): Session 隔离新方案— 边界/生命周期/记忆归属隔离 | feat/server_team | MemoryProxy | conflict-upstream | med (design) | `skip` | Rewrites session identity and storage keys; it would collide with our pool and session fixes, and is too risky. |
| #1247 | fix(proxy): derive agent URL prefixes from AgentKind registry | feat/server_team | MemoryProxy | conflict-upstream | low | `wait` | A good structural fix, but the regex already covers claude-code and codex (whitelist.ts:187). |
| #1244 | feat: add expected-version CAS for atomic memory updates | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1243 | fix(sdk-py): reject malformed falsey response data | feat/server_team | Panel-sdk | clean | low (sdk) | `skip` | Duplicate of 1504. |
| #1241 | fix(proxy): align dsh config and runtime compatibility | feat/server_team | other | conflict-upstream | low | `skip` | dsh is not used, it is stale, and it touches `pipeline/runners/openai-chat.ts`/`server.ts` (needs-owner-read if it ever comes back). |
| #1230 | fix: preserve accurate agent memory layer counts | feat/server_team | Panel-sdk | clean | med-high (panel shows wrong l0/l1 for an agent because it filters by asset owner user_id, while proxy clients write with other user ids) | `consider` | Real bug, but v2 conversation/atomic query/count no longer filter by the default user bucket when body omits user_id, which widens reads for every caller (needs-owner-read); also overlaps 909 on `parseChatMemoryAssetId`. |
| #1229 | fix(memory-core): route standalone Skill assets by request instance | feat/server_team | MemoryCore-B | clean | low-med | `wait` | Matters only with multiple x-tdai-service-id instances on one standalone gateway. |
| #1228 | fix(hermes): clarify memory provider activation | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only. |
| #1226 | feat(protocol): OpenAI Chat/Responses ↔ Anthropic 转换层与一致性 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Protocol-conversion feature we do not use. |
| #1220 | fix(sanitize): repair unescaped ASCII quotes inside JSON string values from LLM output | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | Third-pass repair runs only when the existing two passes still fail to parse, so it can only recover L1 batches that were otherwise lost. |
| #1216 | fix(memory-core): update skill usage_count/last_used_at on read (#1189) | feat/server_team | MemoryCore-B | clean | low | `wait` | Stats only. |
| #1215 | Feat/hermes clarify session init | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Hermes; #1314 is its smaller replacement. |
| #1211 | fix(proxy): send Authorization Bearer on auth/verify when gateway key is configured | feat/server_team | MemoryProxy | clean | med | `skip` | Same fix as #1349 (auth.serviceToken + expandEnv) but bundles unrelated deploy/global-images script changes (opencode upstream override, defaultTaskId, externalGatewayUrl, Spanish comments); prefer #1349. |
| #1205 | feat(proxy): session-init autoDefault 静默默认 + 超时收敛 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | DSH-driven UX feature for the codebuddy init path. |
| #1197 | fix(proxy): CC main-dialog agentic loop misclassified as fork — L0 writes silently skipped for all sessions | feat/server_team | MemoryProxy | conflict-upstream | high (if the claim holds) | `consider` | HEAD still classifies any request with the marker at n-2 as fork (cc-request-classifier.ts:44), which skips L0 + skill buffer for CC; the PR bundles unrelated changes. |
| #1188 | docs: document OrcaRouter as a first-class upstream LLM | feat/server_team | other | clean | low | `skip` | Vendor promotion plus a `live-test-orcarouter.sh` at repo root. |
| #1187 | feat(deploy): docker-compose orchestration for the full memory stack (core + hub + proxy) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1186 | feat(pi): interactive Team→Agent→Task picker (parity with CC/Codex/OpenCode) | feat/server_team | MemoryCore-B | clean | low | `skip` | Pi feature. |
| #1185 | fix(memory-core): make embedding reindex non-destructive | feat/server_team | MemoryCore-A | conflict-upstream | med | `wait` | Useful on embedding model change, but large and stale. |
| #1184 | fix(memory-core): make remote embeddings token-aware and resilient | feat/server_team | MemoryCore-A | conflict-upstream | med | `wait` | Stale; revisit at next sync. |
| #1183 | fix(memory-core): probe local LLM capabilities | feat/server_team | MemoryCore-A | clean | low | `skip` | Local-LLM backend profiles; not our setup. |
| #1182 | fix(memorycore): normalize reasoning wrappers before structured extraction | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Mostly offload paths, which our clients do not exercise. |
| #1180 | fix(proxy): handle selected single-agent Team for OpenCode | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded by the solo-agent cascade at HEAD; duplicates #1476. |
| #1178 | feat(memory-core): add L1 atomic memory import API with dedup | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Large stale feature touching gateway schemas. |
| #1177 | feat(proxy): per-user corporate API key passthrough | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Our subscription pool covers upstream credentials. |
| #1173 | fix(store): honor recordIds filter in sqlite queryL1Records | feat/server_team | MemoryCore-A | clean | high | `pending-approval` | Sqlite ignores `recordIds` and returns the whole table, so `/atomic/update` takes `existing[0]` (wrong record) at v2-router.ts:1065 and l1-writer.ts:194 does a full scan per merge. |
| #1172 | fix(core): self-heal store init cache after failed init or closed store | feat/server_team | MemoryCore-A | clean | med | `consider` | The TdaiCore `initStores` cache keeps a failed or closed bundle forever; complements 1437 (different layer). |
| #1171 | fix(core): keep Node's global proxy dispatcher when loading undici@8 | feat/server_team | MemoryCore-A | clean | low-med | `wait` | Eager undici@8 import (we pin ^8.1.0) overwrites Node's env-proxy dispatcher; matters only with NODE_USE_ENV_PROXY. |
| #1170 | fix(tcvdb): prevent silent over-deletion in deleteL0 | feat/server_team | MemoryCore-A | clean | low | `skip` | TCVDB only, on the old tcvdb.ts path; we run sqlite. |
| #1167 | perf(proxy): optimize tool injection prompts and add reproducible LLM evaluation | feat/server_team | MemoryProxy | conflict-upstream | med | `skip` | Rewrites the injected prompts that every CC/Codex turn sees; would need its own evaluation, so we should not take it as is. |
| #1164 | feat(panel): add manual refresh button to Memory page | feat/server_team | Panel-sdk | clean | low | `wait` | Cosmetic convenience button. |
| #1163 | fix(deploy): add upstream.agents, restart policy, and proxy data volume | feat/server_team | other | clean | low | `skip` | Our compose already has the restart policy and the proxy volume, and the agents block targets clients we do not use. |
| #1156 | fix(hermes): surface gateway outages instead of going silently dark | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1153 | perf(memory-core): reduce checkpoint memory allocations, +18% throughput | feat/server_team | MemoryCore-A | clean | low | `wait` | Performance only; writes compact JSON; same lines as 771. |
| #1151 | perf(memory-core): optimize ScopedStorageBackend.key() hot path | feat/server_team | MemoryCore-B | clean | low | `skip` | Hand-rolled rewrite of the path-traversal guard plus a key cache for micro-perf; risk exceeds gain. |
| #1143 | fix(install): make OpenClaw runtime patch opt-in | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1142 | feat(gateway): add retry-safe conversation idempotency | feat/server_team | MemoryCore-A | conflict-upstream | med | `wait` | Large idempotency-key feature for /conversation/add; stale. |
| #1141 | fix(knowledge): exit when server startup fails | feat/server_team | MemoryKnowledge | clean | med | `pending-approval` | Startup failure only set exitCode, so with Langfuse handles open the Knowledge process hung alive instead of exiting; now process.exit(1) so start-combined.sh / restart policy can react. |
| #1137 | feat(memory-core): authenticate Hermes memory by user scope | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Hermes auth; stale. |
| #1136 | fix(memory-proxy): implement lossless forwarding for Anthropic server tools | feat/server_team | MemoryProxy | conflict-ours | - | `covered-by-ours` | Keep our commit 4cfb845. PR strips description/input_schema from explicit type:"custom" tools. |
| #1124 | test(proxy): lock WorkBuddy question tool schema | feat/server_team | MemoryProxy | clean | low | `skip` | Test-only for WorkBuddy, which we do not run. |
| #1123 | fix(hermes): stop retry loop after gateway breaker opens | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only. |
| #1122 | fix(proxy): guide agents after session initialization | feat/server_team | MemoryProxy | clean | low | `wait` | Adds one prompt line to the skill/memory tool blocks telling the agent not to probe /openapi.json etc.; cosmetic prompt tuning, changes injected text (cache-prefix churn once). |
| #1121 | fix(hermes): allow configured v3 agent identity | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only; overlaps #1567. |
| #1120 | test(proxy): cover Claude Code tool-result capture | feat/server_team | MemoryProxy | clean | low | `wait` | Test-only for recorder.extractLatestUserMessage; no behavior change. |
| #1119 | fix(hermes): preserve line breaks in recall output | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only. |
| #1117 | fix(skill): expose extraction action outcomes | feat/server_team | MemoryCore-A | clean | low | `wait` | Logging and observability only. |
| #1116 | fix(memory-core): track persona counters per profile scope | feat/server_team | MemoryCore-A | clean | med | `consider` | L1 increments the global checkpoint's persona counter, but PersonaTrigger reads the profile-scoped one, so the count-based L3 trigger is off; changes L3 cadence. |
| #1115 | fix(gateway): accept Hermes LLM environment aliases | feat/server_team | MemoryCore-B | clean | low | `skip` | Adds MEMORY_TENCENTDB_LLM_* aliases in gateway config for Hermes; same bug as #1409. |
| #1114 | fix(proxy): add OpenAI-compatible model discovery | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Upstream already has `modelsHandler.ts` (that is the conflict). |
| #1112 | feat: enhance code graph repository support | feat/server_team | MemoryKnowledge | conflict-upstream | low | `skip` | Code-graph repository support feature (554 lines, 24 files) conflicting with upstream. |
| #1111 | fix(memory-core): drain L3 cascade during pipeline destroy | feat/server_team | MemoryCore-A | clean | low | `skip` | Duplicate of 1583; affects only MemoryPipelineManager (plugin/local mode), while the gateway uses StatefulPipelineManager. |
| #1108 | fix(proxy): send ask_followup_question questions as array, not string | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | CodeBuddy form only. |
| #1107 | fix(knowledge): normalize bracketed IPv6 and IPv4-mapped addresses in SSRF validator | feat/server_team | MemoryKnowledge | clean | med | `consider` | SSRF validator misses bracketed IPv6 and IPv4-mapped addresses; fix is good but the fc00:/fd00: prefixes only match those literal hextets (not all of fc00::/7). #1554 has a better regex (fc[0-9a-f]{2}:). |
| #1103 | OpenClaw Plugin / OpenClaw插件 - Integration with Multi-Agent Framework + Auto Select Agent / 集成多Agent框架+自动选择TDAI Agent | feat/server_team | MemoryCore-B | clean | low | `skip` | OpenClaw feature. |
| #1099 |  perf(memory-core): optimize fastEstimateTokens hot path | feat/server_team | MemoryCore-B | clean | low | `wait` | Offload token estimator (OpenClaw path). |
| #1094 | fix(gateway): search TDAI_DATA_DIR when resolving the config file | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1091 | fix(deploy): Windows Git Bash 一键部署兼容性修复 | feat/server_team | other | clean | low | `skip` | Windows deploy part duplicates 1611; the bundled integration is out of scope. |
| #1086 | fix(MemoryKnowledge): return status field for non-ready wikis in search/graph | feat/server_team | MemoryKnowledge | clean | low-med | `wait` | Adds status/internal_status/sync_error to empty search/graph responses for non-ready wikis; additive, helps agents understand empty results. |
| #1082 | fix(memory-core): upsert L1 notes in atomic/update and honor recordIds lookup | feat/server_team | MemoryCore-B | clean | high (recordids part) | `duplicate` | Its recordIds hunk is the sqlite filter bug fixed by #1173; prefer #1173. Do not take its "missing id creates a note" behaviour. |
| #1081 | feat(deploy): proxy 配置支持 externalGatewayUrl 与 redis 开关 | feat/server_team | other | clean | low | `wait` | Our compose already sets `injection.externalGatewayUrl`; global-images only. |
| #1080 | fix(proxy): 补全 bridge L1 会话前缀候选，修复 dsh/codex/workbuddy 检索 401 | feat/server_team | MemoryProxy | clean | med | `pending-approval` | memory-bridge and skill-bridge L1 lookup only tries bare, codebuddy:, claude-code: keys, so Codex sessions (stored as codex:<id>) miss L1 and depend on the L2 binding fallback or get 401; adds codex/workbuddy/dsh prefixes. |
| #1075 | test(panel): add unit tests for domain + kernel transport, type wiki graph | feat/server_team | Panel-sdk | clean | low | `wait` | No runtime behavior change. |
| #1057 | fix(proxy): honor x-tdai-user-key and preserve client credentials on codex passthrough | feat/server_team | MemoryProxy | conflict-upstream | low for us | `skip` | Duplicate of part of #1416; HEAD stageAuth already reads x-tdai-user-key (pipeline/stages/auth.ts:65), and the pool sets Codex credentials. |
| #1055 | docs: correct the branch table on feat/server — main is not the default branch | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #1054 | docs: correct the branch table on main — main is not the default branch | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #1053 | docs: fix stale branch names in CONTRIBUTING and maxScenes default comment | feat/server_team | other | conflict-upstream | low | `wait` | Docs/comment only; stale. |
| #1051 | fix(proxy): strip session-init form artifacts before forwarding | feat/server_team | MemoryProxy | conflict-upstream | low-med | `wait` | Only hits Anthropic-compatible thinking upstreams such as DeepSeek; dropping whole assistant turns can break role alternation. |
| #1042 | fix(openclaw): isolate remote memory by runtime agent | feat/server_team | MemoryCore-B | clean | low | `skip` | OpenClaw plugin; dup intent of #1748. |
| #1040 | fix(queue): resolve idle waiters when clearing queued tasks | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | `SerialQueue.clear()` leaves `onIdle()` waiters hanging (Core and Knowledge); identical code is also in 1584, and 1040 is the minimal copy. |
| #1037 | fix(sdk/python): annotate context manager exit arguments with object | feat/server_team | Panel-sdk | clean | low | `wait` | Typing only. |
| #1026 | feat(memory-core): maintain L1 memories with source evidence | feat/server_team | MemoryCore-A | clean | med | `wait` | Large feature (source_message_ids across stores, plus one extra LLM recall-planning call per batch); revisit later. |
| #1024 | fix(proxy): accept SSE data fields without the optional space | feat/server_team | MemoryProxy | clean | low-med | `wait` | Spec-correct `data:` parsing in the Anthropic thinking-fix stream and stream consumer, plus a real fix for rewriting every data line in a frame; our Anthropic/subscription upstreams always send `data: `; touches pipeline/runners/anthropic.ts (needs-owner-re... |
| #1013 | fix(skill-bridge): stop excluding skills the live listing sees as "already injected" | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded: the subtraction was already removed at HEAD (skill-bridge.ts:779). |
| #1011 | feat(memory-core): implement GitStorageBackend (experimental) | feat/server_team | MemoryCore-A | conflict-upstream | low | `skip` | Large experimental storage feature. |
| #1008 | fix(panel): restore skill asset actions | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1007 | fix(proxy): write TDAI L0 only for final answers | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #1005 | fix(proxy): resolve bare Hermes bridge session IDs | feat/server_team | MemoryProxy | clean | low | `duplicate` | Edits the same lines as #1080; prefer #1080. |
| #1004 | fix(deploy): expose agent-reachable tool URLs | feat/server_team | MemoryKnowledge | clean | med | `consider` | Refreshes a stale persisted service_url on idempotent wiki/code-graph create when KNOWLEDGE_PUBLIC_BASE_URL changes (our compose default is host.docker.internal, which a host-side agent may not resolve); the deploy/global-images part is unused by us - cherr... |
| #998 | fix(memory-core): don't fail npm run build when scripts/seed-v2/ source is absent | feat/server_team | MemoryCore-B | clean | low | `wait` | Our checkout lacks scripts/seed-v2 so local `npm run build` fails; Docker does not build. Preferred over #1555/#775. |
| #997 | fix(sqlite): ensure reads see committed data after stale transactions in WAL mode (#987) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #996 | feat(panel): add safe agent memory import CLI | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #991 | feat(recall): add task-aware LLM memory selection | main | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #989 | fix(proxy): preserve space id during hook prewarm | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Superseded: HEAD prewarm already passes spaceId (pipeline/runners/anthropic.ts:819, codex.ts:662). |
| #988 | fix(proxy): finalize OpenAI streams on DONE | feat/server_team | MemoryProxy | conflict-upstream | low | `wait` | Chat Completions path only (pi/dsh/opencode); CC uses Anthropic and Codex uses Responses. |
| #979 | docs: add Russian README translation | feat/server_team | other | clean | low | `wait` | Translation only, no value to our deployment. |
| #977 | test(gateway): regression coverage for conversation delete isolation (#871) | feat/server_team | MemoryCore-B | clean | low-med | `wait` | Test only; harmless. |
| #975 | chore(knowledge): remove unused louvain dep & fix wiki_graph description | feat/server_team | MemoryKnowledge | clean | low | `wait` | Removes unused graphology-communities-louvain dep (no src usage) and fixes a tool description; lockfile not updated but builds use npm install. |
| #971 | fix(gateway): honor TDAI_EMBEDDING_* env vars and report real version in /health | feat/server_team | MemoryCore-B | clean | low-med | `wait` | We configure embedding in deploy/compose/core.yaml, not env. |
| #970 | feat(proxy): support per-user upstream LLM API key configuration | feat/server_team | Panel-sdk | conflict-upstream | low (overlaps our subscription pool design in memoryproxy) | `skip` | Stale; touches MemoryProxy/src/handler.ts and would collide with our pool routing. |
| #967 | fix(proxy): emit knowledge: config section so knowledge-tools injector registers (#957) | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Fixes `start-proxy.sh` config generation; we deploy with compose.yaml. |
| #963 | fix(proxy): strip session-init form artifacts before forwarding (400 in extended-thinking mode) | feat/server_team | MemoryProxy | conflict-upstream | low-med | `skip` | Duplicate of #1051, which is smaller. |
| #962 | [feat-20260812-001] feat: add read-only knowledge-card evaluation center | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Large feature plus deploy Dockerfile changes. |
| #961 | feat(knowledge): production-grade private repo auth for code graph | feat/server_team | MemoryKnowledge | conflict-upstream | med | `skip` | Private repo auth for code graph (2.3k lines, 25 files); conflicts with upstream, Hub image already has KNOWLEDGE_SSH_KEY_DIR so upstream may have its own variant. |
| #960 | fix(proxy): 修复 Hermes Bridge 会话识别与 Knowledge 注入 | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Hermes + start-proxy.sh. |
| #959 | fix(memory-core): drop sessionId from dedup recall/delete filter so c… | feat/server_team | MemoryCore-A | clean | high | `pending-approval` | L1 dedup recall and merge deletes are filtered by the current session, so corrections in later sessions never update old memories and duplicates pile up (still on HEAD: l1-extractor.ts:323, l1-writer.ts:281). |
| #958 | fix(proxy), feat(panel): Added support for use with the CodeBuddy CLI, fixed compatibility issues with DeepSeek/CodeBuddy's "thinking" process, and added support for deleting chat history | feat/server_team | Panel-sdk | conflict-upstream | low (codebuddy unused) | `skip` | Huge mixed PR touching MemoryProxy pipeline/runners; stale. |
| #955 | feat: add dark mode toggle to Memory Hub UI | feat/server_team | Panel-sdk | conflict-upstream | low | `skip` | Cosmetic feature. |
| #953 | feat(codex): add TencentDB Agent Memory integration plugin | feat/server_team | other | clean | low | `skip` | Codex plugin via hooks/MCP instead of the proxy; also edits gateway `server.ts` (capture `startedAt`) and route constants. Too large for an approach we do not use. |
| #948 | fix(deploy): brace admin key path expansion | feat/server_team | other | clean | low | `wait` | The fix is already in our tree (`start-memory-core.sh:303`); merging adds only a shell test. |
| #945 | feat(knowledge): support Code Graph sparse checkout (#941) | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #943 | docs(benchmark): align SWE-bench token reduction (#813) | feat/server_team | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #938 | fix(memory-core): filter English FTS stop words | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Recall tuning; stale. |
| #937 | fix(l1): inject user display name into extraction prompt | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Name-attribution tweak; stale. |
| #933 | Add a request timeout to the MCP http client | feat/server_team | MemoryKnowledge | clean | low | `wait` | 30s timeout on stdio MCP HTTP client; we do not use the stdio MCP; overlaps #1643 in http-client.ts. |
| #930 | fix(memory-proxy): allow members to select team-visible agents | feat/server_team | MemoryProxy | conflict-upstream | med | `wait` | HEAD still lists only owner-scoped agents (codebuddy/init.ts:313); a product choice, and the PR leaves claude-code/init.ts:124 unchanged, so CC and Codex would differ. |
| #923 | fix: replace Unicode ellipsis (U+2026) before ByteString conversion | feat/server_team | MemoryCore-A | clean | low | `wait` | Global sanitizeText change for an offload backend issue; it rewrites stored text for everyone. |
| #922 | fix: remove legacy monkey-patch postinstall reference | feat/server_team | MemoryCore-B | conflict-upstream | low | `wait` | Our postinstall has ` |
| #918 | fix(memory-core): apply recall score threshold to vector search | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Recall-tuning semantics; 1412 documents a conflicting intent for hybrid. |
| #912 | ci(compat): add OpenClaw compatibility matrix testing | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #911 | feat(compatibility): update OpenClaw version compatibility settings | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #909 | fix(panel): parse legacy chat_memory asset id without agt prefix | feat/server_team | Panel-sdk | clean | low (our agent ids use `agt-` prefix, memorycore/src/metadata/utils/id-generator.ts:23) | `wait` | Only matters for v2.0.0-era assets; 1230 rewrites the same function with a stricter regex. |
| #908 | fix(proxy): patch missing reasoning_content in assistant messages for… | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | DeepSeek on the Chat Completions path only. |
| #905 | feat(hermes-v2): inject team/agent identity headers for asset registration | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #904 | feat(hermes): mirror built-in memory writes into TencentDB L1 | feat/server_team | MemoryCore-A | clean | low | `skip` | Hermes client is not used; its SerialQueue part duplicates 814. |
| #900 | gateway: end-to-end top_k for /recall (RecallRequest → handleRecall → auto-recall, clamp 1..50) | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #899 | feat(gateway): llm.disableThinking — inject thinking={type:disabled} into chat-completions bodies | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #898 | fix(hermes-plugin): always advertise tool schemas so they are routable before initialize() | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #897 | hermes-plugin: fence recalled content, seal session on compress/switch, bound recall timeout | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #896 | wayneos/local-fix-patches: 4 fixes verified end-to-end on Aug 7+9 2026 | feat/server_team | MemoryCore-A | conflict-upstream | low | `skip` | Personal grab-bag patch set that also touches MemoryProxy/handler.ts. |
| #894 | docs(memory-core): 提议 Git 记忆存储后端 RFC | feat/server_team | MemoryCore-B | clean | low | `skip` | RFC only. |
| #893 | fix(offload): resolve session manager in assemble/afterTurn without sessionKey | feat/server_team | MemoryCore-B | clean | low | `skip` | OpenClaw offload; overlaps #863/#886. |
| #891 | fix(i18n): ConsoleLayout hardcoded Chinese + scan-chinese scanner improvements | feat/server_team | Panel-sdk | conflict-upstream | low | `wait` | i18n only. |
| #886 | refactor(offload): replace dist-patch dependency with getSessionMessages | feat/server_team | MemoryCore-B | clean | low | `wait` | OpenClaw offload. |
| #883 | fix(panel): gate AdminResourceLock on global system_admin only | feat/server_team | Panel-sdk | conflict-upstream | low-med (likely a ui-only gate; not verified) | `wait` | Small UI permission gate; stale, re-check on sync. |
| #882 | fix(offload): resolve session manager in assemble() without sessionKey (#878) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #870 | fix(memory-core): carry instance ID through local timer callbacks | feat/server_team | MemoryCore-A | conflict-upstream | high | `skip` | Already fixed on HEAD (local-backend.ts:127 passes instanceId; server.ts:1888 uses entry.instanceId). |
| #869 | fix(proxy): parse tdai.anonymous config block so anonymous fallback works | feat/server_team | MemoryProxy | conflict-upstream | low | `skip` | Anonymous fallback; we run with auth enabled. |
| #865 | refactor: replace dist-file patch with official OpenClaw getSessionMessages API | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #863 | fix(offload): resolve session manager from sessionId when sessionKey is missing in compact() | feat/server_team | MemoryCore-B | clean | low | `skip` | OpenClaw offload; overlaps #893. |
| #860 | fix(metadata): bind v3 subject-scoped list endpoints to caller | feat/server_team | MemoryCore-B | conflict-upstream | med | `wait` | Part of SashaMIT authz series; stale. |
| #859 | fix(metadata): authorize v3 team-scoped list endpoints by caller | feat/server_team | MemoryCore-B | conflict-upstream | med | `wait` | Same series; stale. |
| #858 | fix(metadata): authorize v3 agent-fixed-asset read endpoints by caller | feat/server_team | MemoryCore-B | clean | med | `consider` | Closes an enumeration hole, but readableAgentForCaller has no isSystemAdmin bypass (unlike getAssetForCaller) and MemoryProxy calls list-with-detail with a per-user key while caching per agent (core-client.ts:253); needs owner check. |
| #857 | fix(metadata): authorize v3 team/agent/task get by caller | feat/server_team | MemoryCore-B | clean | med | `consider` | Same hardening for team/agent/task get; no system-admin bypass and requireCallerId throws without x-tdai-user-key, which can break MemoryProxy meta client agent/get and Panel admin views. |
| #856 | fix(metadata): bind acl/check and list-accessible subject to caller | feat/server_team | MemoryCore-B | conflict-upstream | med | `wait` | Same series; stale. |
| #852 | fix(recall): preserve prompt boundaries for recalled content | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #848 | fix(metadata): enforce caller authorization on v3 asset read endpoints | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Superseded: our asset/get already uses getAssetForCaller with admin bypass (metadata-service.ts:1283). |
| #845 | fix(embedding): chunk embedBatch by configurable maxBatchSize | feat/server_team | MemoryCore-A | clean | med | `consider` | Needed only for providers with small batch caps (Dashscope=10); not wired into gateway top-level embedding config; touches the same store-pool block as 1344/777. |
| #844 | feat(cleanup): strip legacy recall injections from session history (#120) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #842 | feat(adapters): add Gemini CLI memory adapter for TencentDB Agent Memory | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #840 | fix(compact): call compressProtectedTail after emergency compression | feat/server_team | MemoryCore-B | clean | low | `wait` | Offload compaction (OpenClaw). |
| #836 | fix(proxy): keep /v1/ in the forwarded path for Anthropic endpoints | feat/server_team | MemoryProxy | clean | low | `skip` | Superseded: guard-adapter.ts:444-465 already adds /v1 for anthropic bases without a version suffix; this PR would produce /v1/v1/messages for bases that end in /v1. |
| #835 | fix(hermes): conversation_search must read the messages field (not items) | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes; dup of #1417. |
| #829 | fix(gateway): add security headers, replace MD5 with SHA-256 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #828 | fix(deploy): make host IP detection OS-aware and IPv4-safe | feat/server_team | other | clean | low | `wait` | Hub panel proxy URL auto-detection in global-images; our compose sets `PROXY_PUBLIC_URL` explicitly. |
| #827 | Fix/checkpoint recalibrate | feat/server_team | MemoryCore-A | conflict-upstream | low | `wait` | Recounts monotonic counters on startup; affects only cosmetic/threshold counters. |
| #821 | fix(memory-core): sqlite queryL1Records ignores recordIds filter | feat/server_team | MemoryCore-A | clean | high | `skip` | Duplicate of 1173 and targets the old path `core/store/sqlite.ts`, which moved to `sqlite/memory-store.ts`. |
| #815 | fix(deploy): gate init-admin on HTTP readiness; fix macOS bash unbound variable | feat/server_team | other | conflict-upstream | low | `wait` | Real race in the global-images script, but our compose uses healthchecks; stale, and it overlaps the curl cluster. |
| #814 | fix(memory-core): recover SerialQueue after synchronous task throw | feat/server_team | MemoryCore-A | clean | med | `pending-approval` | A synchronous throw in a task leaves `running=true` forever and stalls the queue (HEAD serial-queue.ts:109 still calls `entry.task()` bare). |
| #812 | feat(memory-core): reproducible memory evaluation harness (eval-memory) | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Eval tooling. |
| #810 | fix(hermes): bound Gateway stdout/stderr logs with a runtime rotation guard | feat/server_team | MemoryCore-B | clean | low | `skip` | Hermes only. |
| #809 | fix(recall): degrade hybrid strategy to keyword when EmbeddingService is absent | feat/server_team | MemoryCore-A | conflict-upstream | low | `skip` | The error string it targets is no longer in HEAD auto-recall.ts, so it is likely superseded (OpenClaw-originated). |
| #808 | security: fix auth bypass, unauthenticated admin endpoints, SSRF, git injection (#672) | feat/server_team | MemoryProxy | conflict-upstream | high (security) | `consider` | Owner approved 2026-10-22: port only the auth wrapper for /v3/admin/rate-limits and set TDAI_PROXY_ADMIN_API_KEY. Do not take the rest. |
| #805 | fix: add root pnpm-workspace.yaml to resolve missing packages field e… | feat/server_team | other | clean | low | `skip` | A root workspace file changes pnpm resolution and lockfile ownership for every subproject (local builds, Dockerfiles that copy the root). |
| #798 | feat(knowledge): export llm-wiki / code-graph assets (#779) | feat/server_team | MemoryKnowledge | clean | low | `wait` | Adds an export-knowledge CLI (wiki + code-graph ZIP); useful for backup but a new feature, not a fix. |
| #797 | feat(export): support the skill asset in export bundles (#779) | feat/server_team | MemoryCore-B | clean | med | `consider` | Backup/export of chat-memory + skills is useful ops tooling; stacked branch containing #793/#795/#796 - take this one alone if wanted. |
| #796 | feat(import): apply bundles with conflict handling (#779 step 3) | feat/server_team | MemoryCore-B | clean | med | `skip` | Contained in #797. |
| #795 | feat(import): import dry-run for export bundles (#779 step 2) | feat/server_team | MemoryCore-B | clean | med | `skip` | Contained in #796/#797. |
| #793 | feat(export): chat-memory export bundle with manifest schema (#779 step 1) | feat/server_team | MemoryCore-B | clean | med | `skip` | Contained in #795-#797. |
| #792 | fix(knowledge): align package entrypoints with mjs build | feat/server_team | MemoryKnowledge | clean | low | `wait` | bin/*.mjs and package main point to dist/*.js but tsdown fixedExtension emits .mjs, so `knowledge-server`/`knowledge-mcp` bins are broken; our Docker images call dist/server.mjs directly. Conflicts with #1643 on bin/mcp.mjs. |
| #787 | feat(adapters): add cross-platform adapter system for 7 AI platforms (#235) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #781 | feat(examples): Claude Code hooks for subscription-auth users | feat/server_team | other | clean | low | `skip` | Hook-based alternative to the proxy; we use the proxy for Claude Code. |
| #778 | feat(l1): keep user-grounded correction conclusions in episodic extraction | feat/server_team | MemoryCore-A | clean | med | `consider` | Prompt-only change that keeps AI conclusions the user confirmed; same prompt file as 1405/1500. |
| #777 | fix(embedding): enable provider=local and warm up the local model | feat/server_team | MemoryCore-A | clean | low | `skip` | Enables node-llama-cpp local embeddings, which our deployment does not use. |
| #776 | feat(llm): support Anthropic wire protocol (MEMORY_LLM_PROTOCOL=anthropic) | feat/server_team | MemoryCore-A | clean | med | `consider` | Our deploy already exposes MEMORY_LLM_PROTOCOL (_lib.sh:359, .env.example:39), but MemoryCore ignores it; this adds @ai-sdk/anthropic and wires it in. |
| #775 | fix(build): Dockerfile missing files, dead seed-v2 build, version alignment | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | Mostly superseded: MemoryKnowledge/docker/entrypoint.sh and smoke-test.sh already exist; seed-v2 part covered by #998. |
| #774 | feat(plugin): local scene-memory reader (tdai_read_local) + guarded read_cos | feat/server_team | MemoryCore-B | conflict-upstream | low | `skip` | OpenClaw plugin feature. |
| #773 | fix(mcp): send x-tdai-service-id header + log to stderr | feat/server_team | MemoryKnowledge | conflict-upstream | low | `skip` | Same MCP service-id header fix as #1643; prefer #1643 (clean, tests). |
| #771 | fix(memory-core): fail closed on corrupt checkpoints | feat/server_team | MemoryCore-A | clean | med | `consider` | A corrupt checkpoint now throws instead of silently resetting all cursors (which re-extracts everything), but this blocks the pipeline until a manual fix; edits the same lines as 1153. |
| #713 | fix(deploy): restrict generated gateway config to 0600 (contains the LLM API key) | feat/server_team | other | clean | low | `wait` | Sensible hardening, but global-images only (our `core.yaml` holds no key; the key comes through env). Conflicts in meaning with 1669 (tmp+mv), so add the chmod after the mv if both are taken. |
| #712 | fix(deploy): warn when MEMORY_LLM_PROTOCOL=anthropic reaches memory-core; document the limitation | feat/server_team | other | clean | low | `wait` | Useful warning and docs; our compose already hardcodes the OpenAI protocol for core. |
| #685 | security: fix auth bypass and SSRF in MemoryProxy & MemoryKnowledge | feat/server_team | MemoryKnowledge | conflict-upstream | high (proxy) | `consider` | Owner approved 2026-10-22: port only the auth wrapper for /v3/admin/rate-limits and set TDAI_PROXY_ADMIN_API_KEY. Do not take the rest. |
| #677 | fix(checkpoint): 规范化共享锁的文件路径 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #676 | fix(store): 恢复局部缺失或旧版 FTS 索引 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #673 | fix(security): enforce authentication on rate limits, deny unconfigured admin access, and sanitize git fetcher args | feat/server_team | MemoryProxy | clean | med | `consider` | Owner approved 2026-10-22: port only the auth wrapper for /v3/admin/rate-limits and set TDAI_PROXY_ADMIN_API_KEY. Do not take the rest. |
| #669 | fix(deploy): resolve curl from PATH in Git Bash | feat/server_team | other | clean | low | `wait` | Overlaps 1611/815 on curl handling; Windows motivation. |
| #661 | perf(hooks): stabilize recall context to restore prefix cache hits | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #608 | fix(search): sanitize FTS5 operators in buildFtsQuery | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #599 | fix(storage): prevent path traversal in writeRefMd/readRefMd (CWE-22) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #592 | build: add typecheck to the main source tree, and fix the 19 pre-existing errors it surfaces | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #586 | fix(hermes): bound Gateway sidecar logs | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #559 | feat(knowledge): add MCP streamable-HTTP endpoint for remote agent access | feat/server_team | MemoryKnowledge | conflict-upstream | low | `skip` | MCP streamable-HTTP endpoint for remote agents; new feature conflicting with upstream. |
| #551 | docs: add Community ContextEngine Integrations section (EN/CN) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #545 | feat(adapter-sdk): add unified HTTP Gateway adapter SDK with Claude C… | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #539 | fix(gateway): add opt-in recall context dedup | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #537 | docs: use canonical TencentCloud repo URLs | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #531 | feat(hooks): implement turn-level call limit for search tools | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #507 | fix(seed): flush pending L1 batches | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #501 | feat(l1): carry provenance fields through recall | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #482 | feat(report): 增加按 provider/model 分组的 Prompt 缓存实测指标 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #480 | Feat/mastra memory adapter | main | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #478 | Fix/gateway session end timeout | main | - | - | - | `skip-draft` | Draft PR; not reviewed. |
| #469 | fix(recall): 固定场景导航顺序以稳定提示前缀 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #464 | fix: resolve traceability, safety, compatibility, benchmark, and auto-recall bugs | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #463 | fix(offload): tracing/token hardening — astral token fix, L1.5 null fallback, createRequire | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #462 | fix(runtime): race/timeout hardening — recall abort, profile backup-swap, sandbox, SQLITE_BUSY | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #461 | fix(core): storage hardening — Buffer safety, embedding abort, atomic instanceId | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #443 | fix(config): support XDG config path fallbacks | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #436 | feat(store): support Bun runtime via bun:sqlite (vec0 + FTS5) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #430 | fix(l1): treat content-filtered extraction as failed | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #428 | security: harden supervisor and export script against injection/traversal | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #421 | Add memory safety controls for untrusted and deleted data | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #411 | fix(offload): invalidate token cache after stripping deleted tool_use blocks (#234) | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #386 | Add Docker Compose deployment for Hermes memory | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #369 | fix(scene): normalize indexed filenames on read | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #368 | fix(profile): sanitize pulled scene filenames | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #363 | feat(gateway): add live batch capture import | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #331 | fix(record): retry invalid l1 extraction output and trim pipeline debug logs | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #327 | fix(sqlite): add FTS5 injection sanitization with real integration tests | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #326 | feat(adapters): add Claude Code Gateway hook adapter | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #324 | fix(checkpoint): repair stale session cursors after cleanup | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #323 | feat:add Codex, Claude Code, and OpenCode memory adapters | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #319 | fix(openclaw): map stable recall context before cache boundary | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #318 | fix(gateway): normalize capture request timestamps | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #289 | fix(offload): sanitize ref and skill paths | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #288 | fix(offload): keep MMD files inside storage dir | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #287 | fix(offload): sanitize session storage paths | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #286 | fix(cleaner): schedule cleanup in configured timezone | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #285 | fix(cleaner): preserve local day in negative timezones | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #284 | fix(cleaner): allow one-day retention cutoff | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #281 | fix(recall): report effective fallback strategy | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #280 | fix(core): honor layer model config for runners | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #279 | fix(pipeline): honor L2/L3 runner timeout config | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #278 | fix(config): expose offload manifest fields | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #277 | fix(l1): honor runner timeout config | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #275 | fix(config): align offload timeout default | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #273 | Custom multitenant | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #272 | fix(search): honor recall embedding timeout | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #271 | fix(embedding): forward proxy and timeout config | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #270 | fix: reindex embeddings after config drift | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #269 | feat(l1): pre-extract direct memory rules | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #268 | docs: add TakoAPI directory badge | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #266 | fix(l1): drop ungrounded extracted memories | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #251 | fix(record): harden L1 dedup JSON parsing | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #245 | fix(hermes): install durable user plugin link | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #244 | fix(conversation): scope L0 search candidates by session | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #243 | fix(package): exclude python test artifacts | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #242 | fix(offload): keep backend TLS verification enabled | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #241 | fix(runner): avoid duplicate system prompt | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #238 | fix(embedding): cap remote batch size at 10 | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #237 | fix(gateway): reject invalid and oversized JSON bodies | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #232 | fix(tcvdb): escape session filter literals | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #224 | feat: add PostgreSQL memory store backend with pgvector + pg_textsearch | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #209 | fix(core): restore LocalStorageBackend auto-wire in TdaiCore constructor (CR-2) | feat/server | - | - | - | `out-of-scope` | Targets `feat/server`, not our base `feat/server_team`. |
| #206 | fix(hermes): inject L3 persona into system_prompt_block | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #153 | docs: add code audit report detailing found bugs | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #143 | fix(offload): prevent infinite emergency compression cycle | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #142 | fix(docker): add --start-period to HEALTHCHECK to prevent startup kill | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #112 | fix(core): reliable L3 persona writes for weak tool-calling models + warn on silent embedding misconfig | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #99 | fix(pipeline): L2 runner 零记录时返回现有 cursor 而非 void | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #97 | feat: add lane config option for embedded agent isolation | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #83 | feat: L1 extraction quality improvements — reduce LLM dependency | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #39 | fix(gateway): harden CORS / Host header / startup host binding | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #36 | fix: include prepend context in gateway recall response | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #29 | fix(core): scope L1 memory search in stores | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
| #27 | feat(package): expose host-neutral library entrypoints | main | - | - | - | `out-of-scope` | Targets `main`, not our base `feat/server_team`. |
