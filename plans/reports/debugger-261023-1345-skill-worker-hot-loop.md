# Skill worker hot loop on production Core (2026-10-23)

## Symptom
- `agent-memory-memory-core-1` logs `[skill-worker-pool] … consumeAgent error: standalone SkillExtractor unavailable (instance=default)` about 34,000 times per minute (60 workers × ~8/s). CPU 79–108%.
- Docker keeps 3 × 10 MB of logs, so the flood rotates out every other log line (startup lines included) within minutes.

## Feature
Skill extraction from conversations ("conversation-add"):
1. The proxy posts each conversation round to Core `POST /v3/skill/conversation/add` (`extraction.extractors: ["skill", ...]` in the proxy config).
2. Core buffers the messages per (user, team, agent, session). At 10 tool calls the buffer is archived (`skill_buffer/…/data-<ts>.jsonl`) and the agent tuple is pushed to the skill agent queue (in-memory queue in standalone mode).
3. `SkillWorkerPool` (60 loops by default) takes agent tuples and runs an LLM `SkillExtractor` on the archived conversation to write reusable skills.

## Root cause (reproduced locally with the production `deploy/compose/core.yaml`)
1. Config: production `core.yaml` (added 2026-10-21 by server commit `1d7d2589`) has `skill.enabled: true` and no `skill.extraction`. `resolveSkillConfig` turns extraction on only for an explicit `extraction.enabled: true` (`MemoryCore/src/core/skill/skill-config.ts:145`). Startup log: `Skill module wired (v2): … extraction=off`.
2. With extraction off, `TdaiCore` builds no singleton `SkillExtractor` (`MemoryCore/src/core/tdai-core.ts:946`).
3. Code gap 1: `ensureSkillWorkerPool` starts the pool when `skill.enabled` is true and does not check `extraction.enabled` (`MemoryCore/src/gateway/server.ts:2467-2478`).
4. Code gap 2: the conversation-add handler still archives and enqueues with extraction off (`ensureConversationAddForStandalone`).
5. Code gap 3: on a resolver error, each loop suppresses the agent for only 200 ms (`suppressAgentTtlMs`), and the queue keeps the agent at the head (peek semantics). The agent is never removed, so 60 loops retry it ~5 times per second each, forever. The in-memory queue is cleared only by a restart, and new traffic refills it.

Local reproduction: one conversation-add with 12 tool calls → 300 errors after 1 s, 1,740 after 6 s.

## Not caused by the project-scoped memory work
The 2026-10-22 diffs in MemoryCore do not touch skill wiring (`tdai-core.ts` change: 7 lines in the L3 runner wiring). The loop starts after every Core restart as soon as one agent reaches 10 tool calls.

## Fix options (verified locally)
- Config `skill.extraction.enabled: true`: the extractor exists, the "unavailable" loop stops. Remaining behavior: while one worker extracts, the other loops log `extract-lock contended` about 24 times per second (2 s sleep + jitter each, INFO level, bounded). Cost: one LLM extraction per 10 tool calls per agent.
- Code: do not start the worker pool and do not archive/enqueue when extraction is off; this removes the loop for any deployment that keeps extraction off.
