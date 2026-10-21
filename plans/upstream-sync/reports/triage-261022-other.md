# Upstream PR triage: other (deploy, agents, adapters, docs, root files)

The key context for this group: **our deployment does not use `deploy/global-images/*.sh`**. Our fork runs `compose.yaml`. That file uses `deploy/compose/core.yaml` (mounted read-only from the repo, with no secrets in it), a compose `configs:` block for the proxy, `restart: unless-stopped`, `extra_hosts: host-gateway`, named volumes for core, knowledge and proxy, healthchecks, and `injection.externalGatewayUrl: ${PROXY_PUBLIC_URL}`. Fixes that touch only the global-images shell scripts therefore have low relevance to us. Our only edits in global-images are the subscription-pool env passthrough in `start-memory-core.sh` and `.env.example` (commit 9175848a).

"Net change" below was checked with `git merge-tree HEAD refs/upr/N`.

| # | title | +/- | status | relevance | quality | verdict | reason (one sentence) |
|---|---|---|---|---|---|---|---|
| 1742 | fix(deploy): skip host-gateway flag on Podman | +43/-2 | clean | low | ok (detect via `docker version` string, self-check in verify.sh) | skip | Podman only, and global-images scripts only; we run Docker compose. |
| 1669 | fix(deploy): preserve memory-core gateway config across restarts | +697/-12 | conflict-ours | low | good (558-line shell test, careful path pinning), but changes behavior | wait | Fixes the global-images script overwriting a hand-edited `tdai-gateway.yaml`; our compose mounts a static repo file, so the bug does not affect us. Not related to our SQLite restart fix (see Top picks). |
| 1611 | fix(deploy): global-images scripts under Windows Git Bash (#1609) | +65/-20 | clean | low | good (no-op on Linux/macOS) | wait | Windows Git Bash only; best PR of the Windows cluster. |
| 1610 | feat(openhands): OpenHands SDK adapter + v2 proxy registration | +1329/-5 | clean | low | mixed (commits stray `ISSUE_DRAFT.md`/`PR_BODY.md` at repo root) | skip | OpenHands is not used; its MemoryProxy edits (bridge L1 prefixes, HEADER_ONLY_AGENTS) only add values, but they touch session code. |
| 1535 | docs: skills framework README (DE), MemoryPanel pnpm align, orchestration wiring | +782/-1 | conflict-ours | low | poor for upstream (one person's Windows runbooks, `L:\` paths) | skip | Its AGENTS.md/CLAUDE.md would replace ours (GitNexus rules), and its `.gitignore` adds `docs/*.md`, which would hide our docs. |
| 1369 | feat(memory-core): source-feedback evaluation and budgeted retrieval example | +59088/-0 | clean | low | n/a (research example dump) | skip | 59k-line `examples/memory-ac` research artifact, no runtime value. |
| 1368 | feat(integrations): pluggable subscription memory hooks | +961/-0 | clean | low | ok | skip | Hook-based client integration (Codex/zcode) as an alternative to the proxy; we route through MemoryProxy. |
| 1330 | fix(deploy): global-images scripts under Git Bash on Windows | +12/-5 | conflict-upstream | low | small | skip | Duplicate of 1611 (Windows), and stale. |
| 1324 | docs: refresh contribution workflow and L1 backlog comment | +11/-10 | conflict-upstream | low | trivial | wait | Docs plus a comment only; stale. |
| 1276 | feat(memory-core): opt-in feedback-driven memory policy self-optimization | +22895/-11 | clean | low | large, research-grade | skip | Huge feature: it edits `l1-extractor.ts` and `.github/workflows/pr-ci.yml` and adds 12k-line lockfiles; too risky for no need. |
| 1258 | fix(deploy): honor PROXY_UPSTREAM_PROTOCOL in LLM connectivity checks | +16/-6 | clean | low | good, small | wait | Correct fix for the verify.sh/interactive setup on Anthropic proxy upstreams, but global-images only. |
| 1241 | fix(proxy): align dsh config and runtime compatibility | +1139/-110 | conflict-upstream | low | n/a | skip | dsh is not used, it is stale, and it touches `pipeline/runners/openai-chat.ts`/`server.ts` (needs-owner-read if it ever comes back). |
| 1188 | docs: OrcaRouter as a first-class upstream LLM | +123/-7 | clean | low | promotional | skip | Vendor promotion plus a `live-test-orcarouter.sh` at repo root. |
| 1163 | fix(deploy): add upstream.agents, restart policy, proxy data volume | +29/-0 | clean | low | hacky (`${URL//anthropic/openai}` rewrite for unused agents) | skip | Our compose already has the restart policy and the proxy volume, and the agents block targets clients we do not use. |
| 1091 | fix(deploy): Windows Git Bash one-click deploy fixes | +7302/-8 | clean | low | bundles an unrelated 7k-line `integrations/cross-agent-memory` | skip | Windows deploy part duplicates 1611; the bundled integration is out of scope. |
| 1081 | feat(deploy): proxy config supports externalGatewayUrl and a redis switch | +28/-4 | clean | low | ok | wait | Our compose already sets `injection.externalGatewayUrl`; global-images only. |
| 1053 | docs: fix stale branch names in CONTRIBUTING, maxScenes default comment | +33/-7 | conflict-upstream | low | trivial | wait | Docs/comment only; stale. |
| 979 | docs: add Russian README translation | +264/-4 | clean | low | fine | wait | Translation only, no value to our deployment. |
| 953 | feat(codex): TencentDB Agent Memory integration plugin | +26225/-23 | clean | low | large (vendors a 20k-line MCP bundle) | skip | Codex plugin via hooks/MCP instead of the proxy; also edits gateway `server.ts` (capture `startedAt`) and route constants. Too large for an approach we do not use. |
| 948 | fix(deploy): brace admin key path expansion | +64/-1 | clean | low | fine | wait | The fix is already in our tree (`start-memory-core.sh:303`); merging adds only a shell test. |
| 828 | fix(deploy): OS-aware, IPv4-safe host IP detection | +115/-7 | clean | low | good (adds test) | wait | Hub panel proxy URL auto-detection in global-images; our compose sets `PROXY_PUBLIC_URL` explicitly. |
| 815 | fix(deploy): gate init-admin on HTTP readiness; macOS bash unbound var | +55/-7 | conflict-upstream | low | good idea | wait | Real race in the global-images script, but our compose uses healthchecks; stale, and it overlaps the curl cluster. |
| 805 | fix: add root pnpm-workspace.yaml | +6/-0 | clean | low | risky | skip | A root workspace file changes pnpm resolution and lockfile ownership for every subproject (local builds, Dockerfiles that copy the root). |
| 781 | feat(examples): Claude Code hooks for subscription-auth users | +248/-0 | clean | low | example only | skip | Hook-based alternative to the proxy; we use the proxy for Claude Code. |
| 713 | fix(deploy): generated gateway config to 0600 (contains LLM API key) | +2/-0 | clean | low | good, tiny | wait | Sensible hardening, but global-images only (our `core.yaml` holds no key; the key comes through env). Conflicts in meaning with 1669 (tmp+mv), so add the chmod after the mv if both are taken. |
| 712 | fix(deploy): warn when MEMORY_LLM_PROTOCOL=anthropic reaches memory-core | +9/-2 | clean | low | good, tiny | wait | Useful warning and docs; our compose already hardcodes the OpenAI protocol for core. |
| 669 | fix(deploy): resolve curl from PATH in Git Bash | +47/-10 | clean | low | ok (more logging, temp error files) | wait | Overlaps 1611/815 on curl handling; Windows motivation. |

## Top picks

**No merge-now items in this group.** Every PR is either global-images only (we deploy with compose), for a client or OS we do not use, a docs or translation change, or a large feature. Nothing qualifies as "consider" either. The items below are notes for the owner.

**#1669 (wait). Compared with our change and with `upstream-sqlite-restart-fix.patch`.**
- **These are different bugs.** #1669 fixes `deploy/global-images/start-memory-core.sh` regenerating `tdai-gateway.yaml` on every start, which wipes manual edits to embedding, recall and persona settings. After #1669, the script generates the file once, reuses it afterwards, and offers `--force-regenerate-config` / `MEMORY_CORE_REGENERATE_CONFIG=1` and an external `MEMORY_CORE_CONFIG_FILE`. Our patch fixes a **data-loss bug in MemoryCore**: `sqlite-adapter.ts` ran `DROP TABLE IF EXISTS meta_instance_upstream_config` on every start, so a restart deleted all custom upstream groups. We already apply that fix (`MemoryCore/src/metadata/store/sqlite-adapter.ts:426-444`, `dropLegacyInstanceUpstreamTable`, plus the rebuild migration). Upstream still has the bug (`upstream/feat/server_team:MemoryCore/src/metadata/store/sqlite-adapter.ts:346`). Neither change replaces the other.
- **Which is better:** ours, by impact. It prevents real data loss in a component we run. #1669 fixes a config-overwrite annoyance in a script we do not run, because our compose mounts the static `deploy/compose/core.yaml` read-only and so already "preserves config". #1669 is well made (path pinning, atomic tmp+mv, 558-line test), but it adds a footgun: after the first run, changes to `MEMORY_LLM_*` and `MEMORY_PROMPT_MODE` in `.env` silently stop taking effect until the operator regenerates. The script prints only a warn line about this.
- **Should we adopt it:** not now (wait). Take it on the next upstream sync. Our SQLite fix should be offered upstream as its own PR, because #1669 does not cover it.
- **Conflict resolution if taken:** trivial. Keep our `POOL_ENV_ARGS` block (HEAD side, before the config section). Keep their `pin_core_config_dir()` function. Drop the HEAD-side `pull_image` / `rm_container_if_exists` lines, because #1669 moves them after the config block. `${POOL_ENV_ARGS[@]...}` in `docker run` merges without conflict.

**#1535 (skip). The conflict-ours files are AGENTS.md and CLAUDE.md.** These are docs only, but taking them would overwrite our GitNexus AGENTS.md/CLAUDE.md with one contributor's Windows/Podman machine runbooks (local `L:\...` paths, `stack-start.cmd`). It also adds `docs/*.md` and `docs/*.txt` to `.gitignore`, which would hide new files in our `docs/`. Do not take it. If we want anything from it, cherry-pick only `agents/skills/README.md`.

**Side observation (not a PR of this group), found while reading #1610.** `loadSessionIdsL1` in `MemoryProxy/src/memory/memory-bridge.ts:153-155` and `MemoryProxy/src/skill/skill-bridge.ts:303-305` probes only the bare id, `codebuddy:` and `claude-code:`. It does not probe `codex:`. Codex sessions therefore miss the L1 lookup and depend on the L2 fallback, which needs `x-tdai-service-id`; our injected curl templates send it. Worth a quick owner check that Codex bridge calls never hit 40101. #1610 does not add `codex` either.

## Duplicates

1. **Windows Git Bash / curl path:** 1611, 1330, 1091 (deploy part), 669, 815 (curl part). **Prefer 1611**: newest, clean, covers path conversion, bind-mount paths and `$CURL`. 815's `wait_http_ready` is a separate, valid idea (init-admin readiness race) and can be cherry-picked on its own if global-images is ever used.
2. **start-proxy.sh restart, volume and injection settings:** 1163 (restart policy, proxy volume, agents hack), 1081 (externalGatewayUrl, redis), 1610 (start-proxy OpenHands bits). Our compose already covers the restart, volume and externalGatewayUrl parts. If upstream sync takes one, **prefer 1081** and drop 1163's `upstream.agents` rewrite.
3. **Admin key path brace fix:** 948 and 1081 contain the same one-line change, which is already in our tree. **948** adds the regression test; take it for the test only.
4. **Config file hardening:** 713 (chmod 600) overlaps 1669 (rewrites the same generation block). Take 1669 first, then reapply 713's chmod after the `mv`.
5. **Client-side hook integrations, all alternatives to MemoryProxy:** 953 (Codex plugin), 1368 (pluggable hooks), 1091 (`integrations/cross-agent-memory`), 781 (Claude Code hook examples). Same idea, none needed by us; **skip all**.

## Unresolved questions
- Should our SQLite upstream-group restart fix be submitted upstream as its own PR? Upstream still drops the table on every start.
- Codex bridge L1 prefix gap (see side observation): owner should confirm Codex sessions never hit 40101.

Status: DONE
Summary: No merge-now PRs in this group.
