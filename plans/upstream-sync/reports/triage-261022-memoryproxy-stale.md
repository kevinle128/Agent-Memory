# MemoryProxy stale PRs (conflict-upstream) — triage

Group: 54 PRs, all `conflict-upstream` (the PR conflicts with upstream itself). Many were superseded by the upstream handler-to-`pipeline/runners/*` refactor.
Method: title/files/body for all; diff read for Claude Code / Codex / auth / security / data-loss items, and HEAD checked for whether the fix already landed.
No PR here is `merge-now`: every one needs a manual port onto `pipeline/runners/*`.

| # | title | +/- | status | relevance | quality | verdict | reason (one sentence) |
|---|---|---|---|---|---|---|---|
| 1630 | feat(pi): durable outbox into proxy capture | +2659/-9 | conflict-upstream | low | tests, large | skip | Pi only; we do not run Pi, and it is a large new subsystem. |
| 1575 | honor external gateway URL env override | +92/-5 | conflict-upstream | low | small, docs | wait | Our compose sets `injection.externalGatewayUrl` in YAML (compose.yaml:155), so the env override is optional. |
| 1482 | read SessionInfo fields directly (no Record casts) | +126/-30 | conflict-upstream | low | type-only refactor | skip | Typing cleanup on the old handlers; the runners were since rewritten. |
| 1481 | declare traceId on RequestLogEntry | +105/-0 | conflict-upstream | low | type-only | skip | Superseded: `traceId?` is already declared at HEAD (MemoryProxy/src/types.ts:1175). |
| 1480 | keep CreditReportOutcome optional members | +88/-2 | conflict-upstream | low | type-only | wait | A type-inference fix for credit reporting with no runtime effect we depend on. |
| 1478 | declare sessionInit.skipAssetConfirm in RawYamlConfig | +93/-0 | conflict-upstream | low | type-only | skip | Superseded: already declared at HEAD (types.ts:1083); duplicates #1357. |
| 1476 | auto-select solo agent in split-stage session init | +442/-2 | conflict-upstream | med (Codex uses this state machine) | tests | skip | Superseded: HEAD already auto-selects a solo agent (session/codebuddy/init.ts:1490); duplicates #1180. |
| 1427 | resolve Pi sessions from bridge L1 | +174/-23 | conflict-upstream | low | tests, good design | wait | Pi-focused, but its shared L1 candidate helper built from the AgentKind registry would also fix the missing `codex:` bridge lookup (see #1416). |
| 1418 | restore memory identity when auth is disabled | +460/-89 | conflict-upstream | low | tests, broad | skip | Only affects `auth.enabled=false`; ours is `true` (MemoryProxy/config.yaml:19), and it rewrites all four old handlers. |
| 1416 | support ChatGPT auth and Codex memory round-trips | +152/-18 | conflict-upstream | **high** | tests, live-verified on Codex 0.154 | consider | HEAD Codex injection still only uses `input[0]`, so memory injection is silently skipped when Codex puts `additional_tools` first, and the memory-bridge cannot find `codex:` sessions. |
| 1400 | capture final DSH headless turns | +348/-35 | conflict-upstream | low | tests | skip | DSH only. |
| 1367 | ZCode Agent Memory integration | +712/-173 | conflict-upstream | low | feature | skip | Adds a new client (ZCode) that we do not use. |
| 1359 | honor read-only mode in skill listing instructions | +146/-8 | conflict-upstream | med | tests, small | consider | HEAD still tells the model to call `skill_patch` / update skills (skill-injector.ts:85-88) while `allowLlmWrite=false`, so CC/Codex call a tool that gets a 403. |
| 1357 | declare skipAssetConfirm in RawYamlConfig | +6/-0 | conflict-upstream | low | trivial | skip | Superseded (types.ts:1083). |
| 1339 | unblock dsh session-init for headerless channels | +360/-3 | conflict-upstream | low | tests | skip | DSH / pi-ai only. |
| 1334 | Hermes interactive tools | +1369/-73 | conflict-upstream | low | feature | skip | Hermes only. |
| 1332 | preserve WorkBuddy memory routing | +110/-39 | conflict-upstream | low | tests | skip | WorkBuddy answer-line parsing; we do not run WorkBuddy. |
| 1328 | Opik memory-access audit read paths | +4768/-518 | conflict-upstream | low | huge | skip | Opik observability stack; we use Langfuse. |
| 1326 | baseline tsc fixes + CI gate | +77/-29 | conflict-upstream | low | chore | skip | Fixes a baseline that has since moved; stale. |
| 1319 | populate agent_source in SessionIdFields | +8/-0 | conflict-upstream | low | trivial | skip | Superseded: `agent_source` exists at HEAD (memory-bridge.ts:81, :350). |
| 1315 | headless web-link session-init fallback dsh/hermes | +1818/-58 | conflict-upstream | low | feature | skip | Only for headless clients we do not run; one of three competing versions (#1255, #1315). |
| 1314 | Hermes minimal session-init via clarify | +972/-52 | conflict-upstream | low | feature | skip | Hermes only; competes with #1215 and #1334. |
| 1291 | register opencode in AGENT_PREFIX_RE | +486/-16 | conflict-upstream | low | tests | skip | We do not use opencode; duplicates #1247, which is better (derives the regex from the registry). |
| 1290 | native /v1/models endpoint | +430/-30 | conflict-upstream | low | feature | skip | `modelsHandler.ts` already exists upstream (that is the conflict); duplicates #1114. |
| 1281 | dynamic skill queue strategies | +1606/-38 | conflict-upstream | low-med | large feature | skip | A large change to skill injection strategy on hot injection paths; not a bug fix. |
| 1277 | Chat/Responses <-> Anthropic protocol conversion | +1895/-92 | conflict-upstream | low | large | skip | Cross-protocol conversion we do not need (the pool serves Codex natively); competes with #1226/#1253. |
| 1270 | Opik observability + memory audit | +3243/-495 | conflict-upstream | low | huge | skip | Opik, not Langfuse. |
| 1266 | OpenClaw native session bridge + web init | +4598/-501 | conflict-upstream | low | huge | skip | OpenClaw only; also touches MemoryCore. |
| 1256 | OpenClaw/Hermes no-Task access + session continuation | +1997/-298 | conflict-upstream | low | large | skip | OpenClaw/Hermes only, and it changes claude-code/init.ts, which is risky for us. |
| 1255 | web-link session-init fallback (proxy+panel) | +4999/-320 | conflict-upstream | low | huge | skip | Headless clients only; #1315 is its smaller replacement. |
| 1253 | protocol wiring + upstream capability probe | +9782/-187 | conflict-upstream | low | huge | skip | Second layer of the #1226 protocol stack; too large, not needed. |
| 1251 | session isolation redesign | +5498/-2416 | conflict-upstream | med (design) | huge | skip | Rewrites session identity and storage keys; it would collide with our pool and session fixes, and is too risky. |
| 1247 | derive agent URL prefixes from AgentKind registry | +49/-2 | conflict-upstream | low | small, correct | wait | A good structural fix, but the regex already covers claude-code and codex (whitelist.ts:187). |
| 1226 | OpenAI Chat/Responses <-> Anthropic conversion layer | +7046/-25 | conflict-upstream | low | huge | skip | Protocol-conversion feature we do not use. |
| 1215 | Feat/hermes clarify session init | +2356/-181 | conflict-upstream | low | large | skip | Hermes; #1314 is its smaller replacement. |
| 1205 | session-init autoDefault + timeout | +592/-0 | conflict-upstream | low | feature | skip | DSH-driven UX feature for the codebuddy init path. |
| 1197 | CC main-dialog misclassified as fork, L0 skipped | +1057/-10 | conflict-upstream | **high (if the claim holds)** | tests, bundled | consider | HEAD still classifies any request with the marker at n-2 as fork (cc-request-classifier.ts:44), which skips L0 + skill buffer for CC; the PR bundles unrelated changes. |
| 1180 | single-agent Team for OpenCode | +381/-2 | conflict-upstream | low | tests | skip | Superseded by the solo-agent cascade at HEAD; duplicates #1476. |
| 1177 | per-user corporate API key passthrough | +794/-34 | conflict-upstream | low | feature | skip | Our subscription pool covers upstream credentials. |
| 1167 | compress tool-injection prompts + LLM eval harness | +11723/-283 | conflict-upstream | med | huge (eval harness) | skip | Rewrites the injected prompts that every CC/Codex turn sees; would need its own evaluation, so we should not take it as is. |
| 1114 | OpenAI-compatible model discovery | +77/-1 | conflict-upstream | low | small | skip | Upstream already has `modelsHandler.ts` (that is the conflict). |
| 1108 | ask_followup_question questions as array | +18/-15 | conflict-upstream | low | small | skip | CodeBuddy form only. |
| 1057 | x-tdai-user-key + codex credential passthrough | +12/-1 | conflict-upstream | low for us | small | skip | Duplicate of part of #1416; HEAD stageAuth already reads x-tdai-user-key (pipeline/stages/auth.ts:65), and the pool sets Codex credentials. |
| 1051 | strip session-init form artifacts (extended thinking) | +124/-2 | conflict-upstream | low-med | tests | wait | Only hits Anthropic-compatible thinking upstreams such as DeepSeek; dropping whole assistant turns can break role alternation. |
| 1013 | skill_search stop excluding "already injected" | +141/-21 | conflict-upstream | low | small | skip | Superseded: the subtraction was already removed at HEAD (skill-bridge.ts:779). |
| 989 | preserve space id during hook prewarm | +337/-0 | conflict-upstream | low | tests | skip | Superseded: HEAD prewarm already passes spaceId (pipeline/runners/anthropic.ts:819, codex.ts:662). |
| 988 | finalize OpenAI streams on [DONE] | +238/-8 | conflict-upstream | low | tests | wait | Chat Completions path only (pi/dsh/opencode); CC uses Anthropic and Codex uses Responses. |
| 967 | emit knowledge: config so knowledge injector registers | +82/-6 | conflict-upstream | low | small | skip | Fixes `start-proxy.sh` config generation; we deploy with compose.yaml. |
| 963 | strip session-init artifacts (extended thinking) | +209/-5 | conflict-upstream | low-med | adds FIX-NOTES.md | skip | Duplicate of #1051, which is smaller. |
| 960 | Hermes bridge session lookup + knowledge config | +164/-2 | conflict-upstream | low | small | skip | Hermes + start-proxy.sh. |
| 930 | let members select team-visible agents | +68/-4 | conflict-upstream | med | test, small | wait | HEAD still lists only owner-scoped agents (codebuddy/init.ts:313); a product choice, and the PR leaves claude-code/init.ts:124 unchanged, so CC and Codex would differ. |
| 908 | patch missing reasoning_content (DeepSeek) | +58/-2 | conflict-upstream | low | small | skip | DeepSeek on the Chat Completions path only. |
| 869 | parse tdai.anonymous config block | +67/-18 | conflict-upstream | low | small | skip | Anonymous fallback; we run with auth enabled. |
| 808 | security: admin auth bypass, rate-limits, SSRF, git injection | +169/-9 | conflict-upstream | **high (security)** | tests | consider | HEAD `/v3/admin/rate-limits` has no auth (server.ts:159-161, rate-limits.ts has no checkAdminAuth), and an empty admin.apiKey means "open" (admin-auth.ts:8). |

## Top picks

### #1416 — Codex memory injection with new Codex input layout (consider, high)
HEAD `injectCodexAssets` (MemoryProxy/src/pipeline/runners/codex.ts:244-265) returns the body unchanged unless `input[0]` is a `type:"message"` with array content. The PR reports that Codex 0.154+ can put `additional_tools` before the developer message. In that case memory/skill injection is silently skipped for every Codex turn. We run Codex 0.163 locally, so this is likely live for us; confirm with one captured `/v1/responses` body. The second part adds the `codex:` prefix to `loadSessionIdsL1` candidates (memory-bridge.ts:153-155). Codex sessions are stored under `codex:<id>` (codex.ts:1652), so bare-id memory-bridge calls from Codex miss the L1 lookup. Port only these two pieces by hand into `pipeline/runners/codex.ts` and `memory-bridge.ts`. Drop the auth / passthrough part: HEAD stageAuth already handles `x-tdai-user-key` (auth.ts:65), and our pool path sets the Codex credentials (codex.ts:1066-1070). Mark needs-owner-read: this touches injection next to our subscription pool and "keep images/non-text parts" fixes.

### #1197 — CC main dialog classified as fork, so no L0 writes (consider, high if the claim holds)
HEAD still has `if (markerIdx === n - 2) return "fork"` (common/cc-request-classifier.ts:44). For fork requests the anthropic runner skips the L0 write and the skill buffer (pipeline/runners/anthropic.ts:1639, :1955). If current Claude Code puts the cache marker on the n-2 assistant turn during tool loops, every agentic CC session loses its conversation record. Before we port, verify with proxy logs: count `[cc-routing] ... kind=fork` and `skip L0 write for kind=fork` against `kind=main` for normal CC sessions. If confirmed, cherry-pick only the classifier change (role check at n-2, about 14 lines) plus its test. Do not take the rest: the strict L0-write error part is already upstream as `throwOnError` (tdai/client.ts:171, :344). It also bundles a search `task_id` scope change in memory-bridge.ts, which is a behavior change, and Spanish deploy docs.

### #808 — admin endpoint auth (consider, security)
`GET/PUT/DELETE /v3/admin/rate-limits` has no auth at HEAD. `checkAdminAuth` returns "ok" when `admin.apiKey` is empty, and our config.yaml does not set one. Our proxy is reachable over the tailnet (`vtc.taildae6a9.ts.net:8096`), so any tailnet caller can read or modify tenant rate limits and call `/v3/instance/proxy-destroy`. Port the rate-limits wrapper and set `TDAI_PROXY_ADMIN_API_KEY`. Deny-by-default (empty key returns "missing") closes the hole even without a key, but it disables proxy-destroy and model-aliases until a key is set; confirm that nothing of ours calls them. Most of the MemoryKnowledge SSRF/protocol checks are already at HEAD (git-fetcher.ts:169-183). Check whether the whitespace/argument-injection check is still missing before porting that half.

### #1359 — skill listing honours read-only mode (consider, med)
With `skillRuntime.allowLlmWrite=false` (the default, config.ts:189), `<skill_tools>` correctly hides write tools. But the `<available_skills>` header still tells the model to "fix it with `skill_patch`" and "update it before finishing" (skill-injector.ts:85-88). CC/Codex then try write calls that the bridge rejects with 403, which wastes turns. The fix is small (pass `allowLlmWrite` into SkillInjector, with a read-only wording branch) and has good tests. A trivial manual port. Risk: it changes the injected text, so the hook-cache hash changes once.

## Duplicates
- Solo-agent auto-select after team pick: #1476, #1180. Both superseded by HEAD (codebuddy/init.ts:1490). Take neither.
- skipAssetConfirm on RawYamlConfig: #1478, #1357. Both superseded. Take neither.
- AGENT_PREFIX_RE missing agents: #1247 (registry-derived, preferred), #1291 (adds opencode only). Low value for us.
- Model discovery `/v1/models`: #1114, #1290. Upstream already has modelsHandler.ts. Take neither.
- Session-init artifacts vs. thinking-mode upstreams: #1051 (preferred, smaller), #963, and a related Chat-path variant #908. All low for us.
- Codex credential passthrough: #1057 is contained in #1416. Prefer #1416, minus its auth part.
- Headless web-link session-init: #1255 (big) -> #1315 (smaller replacement). Hermes clarify: #1215 -> #1314 -> #1334. OpenClaw: #1256, #1266. All skip.
- Protocol conversion: #1277 vs. the stack #1226 + #1253. All skip.
- Opik observability: #1270 + #1328 (stacked). Skip.
- L1 bridge candidate keys: #1416 adds `codex:` inline; #1427 adds a shared helper derived from the AgentKind registry. For the port, a registry-derived candidate list (the #1427 approach) is cleaner than adding one more prefix.

## Unresolved questions
- #1416: does Codex 0.163 actually send `additional_tools` before the developer message? Capture one request body to confirm.
- #1197: does current Claude Code put the cache marker on the n-2 assistant turn in main tool loops? Check `[cc-routing] kind=` log counts.
- #808: is any client (panel, scripts) calling `/v3/instance/proxy-destroy` or `/v3/admin/model-aliases` without a key? Deny-by-default would break it.
