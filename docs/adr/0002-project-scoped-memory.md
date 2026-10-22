---
status: accepted
---

# Memory is scoped by project; the proxy injects project memory only when a client hook proves the project

The proxy injected one agent's persona and scene index into every session, so a session in an
unrelated directory got facts about other projects. Profile rows have no project dimension
(`team|agent` scope), the chat persona prompt asks for "current state", and the injected block is
computed at session registration, before any request carries a working directory. Wrong memory is
worse than no memory, so injection is now deny-by-default: user-global memory is injected only
when it passes a project filter, and project memory is injected only when the session's project is
known. A mandatory client hook reports the project; the proxy cannot see the client's file system.

## Decisions

- **Project identity** comes from a client hook on session start and on each user prompt:
  normalized git remote (`git:<host>/<path>`), else `local:<device_id>:<git toplevel>`, else no
  project. The server computes the key, so there is one implementation.
- **Device identity** is our own UUID in `~/.agent-memory/device.json`, created by the installer
  and read by the hook. The id is not written into client settings files, because users sync them.
  The server keeps one setup record per `(user, device_id)`.
- **The hook is mandatory.** A Claude Code session without a hook report gets an install form;
  "Exit" blocks the session. Clients without a form UI get the install as a direct shell tool call.
- **Side requests get no memory**: session-title generation and the model probe (sent when the
  user selects a model, for example `/advisor <model>`) are classified as `sidequery`.
  Compaction stays `fork`: it keeps read-only memory so that it reuses the main prompt cache.
  Deny-by-default injection removes the risk that a summary copies wrong memory.
- **Storage keeps the `team|agent` scope key.** Project data uses key prefixes inside that scope
  (`scene_blocks/projects/<hash>/`, `project_personas/<hash>.md`) and an additive `project_key`
  column on L0/L1, following the `task_id` precedent.

## Evidence (Claude Code v2.1.289, captured 2026-10-22)

- Hooks: `SessionStart` and `UserPromptSubmit` run in interactive and `-p` mode, before the first
  model request. Hook `session_id` equals header `x-claude-code-session-id`. Resume keeps the id;
  fork makes a new id and runs `SessionStart` with source `fork`. Hooks inherit
  `ANTHROPIC_BASE_URL` and the auth token from settings `env`. Hook stdout goes into model context,
  so the hook prints nothing.
- Request shapes and the current classifier (`common/cc-request-classifier.ts`):

  | Request | Shape | Current kind |
  |---|---|---|
  | Session title | 0 tools, `thinking: disabled`, system has "You are naming a coding session" | `sidequery` |
  | Compaction | same as main; last user text has "REMINDER: Do NOT call any tools. Respond with plain text only" | `fork` (kept on purpose) |
  | Advisor model probe | `max_tokens: 1`, no tools, one user message "Hi" | was `main`; now `sidequery` |

- Client capabilities: see
  `plans/261022-1550-project-scoped-memory/research-client-capabilities.md`. Only Claude Code is a
  clean form-plus-hook client. For pi, hermes and openclaw the hook session id does not match the
  proxy session key, so a report cannot join the session.

## Considered Options

- **Parse the working directory from the system prompt**: rejected. Side requests do not carry
  it, prewarm runs before any request, and a path alone cannot identify a project across clones.
- **Use Claude Code's `metadata.user_id.device_id` as the device id**: rejected as authority. It is
  an undocumented format that changes between versions, and other clients do not send it.
- **One agent per project**: rejected. It splits one user's memory and strands existing scenes.
- **Fix the persona prompt only**: rejected. The scene index is project content and still leaks.

## Consequences

- Between the deny switch and the filtered user-global persona, agents get only the memory tools
  guide.
- Existing scenes have no project and are not injected; tools can still read them.
- Clients whose hook session id does not match the proxy key get user-global memory only until the
  join problem has a fix.
