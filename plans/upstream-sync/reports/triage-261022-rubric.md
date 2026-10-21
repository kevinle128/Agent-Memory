# Upstream PR triage rubric

Repo: /Users/dale/Desktop/workspace/vtc/operator-master/Agent-Memory (branch feat/server_team, our fork).
Upstream: TencentCloud/TencentDB-Agent-Memory. Every PR head is fetched locally as refs/upr/<N>.
Do NOT use the GitHub API (it times out). Do NOT modify the repo (no checkout, no merge, no commits). Read-only.

Get a PR's diff:  git diff $(git merge-base upstream/feat/server_team refs/upr/N) refs/upr/N
Commit messages:  git log --oneline $(git merge-base upstream/feat/server_team refs/upr/N)..refs/upr/N

## Our deployment (relevance context)
- Docker compose runs: MemoryCore gateway (:8420), Hub = MemoryPanel (:8125) + MemoryKnowledge (:8424), MemoryProxy (:8096). Linux containers.
- Agent clients used: Claude Code and Codex (through MemoryProxy). NOT used: Hermes, OpenClaw, dsh, WorkBuddy, CodeBuddy, OpenHands, PI, TAPD, iWiki, Windows hosts, Podman.
- SDKs (sdk/) are not used by our deployment -> low relevance unless the fix is in shared code.
- Our fork added: subscription account pool (MemoryCore/src/subscription-pool, MemoryProxy/src/subscription-pool, Panel UI),
  and proxy fixes: preserve Anthropic server tool definitions (commit 4cfb845), keep images/non-text parts in injected request bodies (8a350b6),
  preserve Langfuse trace input without cost-guard (f69a1d1), preserve sessions during transient upstream rate limits (043d3a1).
  Any PR touching MemoryProxy/src/pipeline, injection, session, subscription-pool: a clean merge is NOT proof of safety — flag "needs-owner-read".

## Merge status values (precomputed in the input file)
- clean: merges cleanly onto our HEAD.
- conflict-ours: conflicts only because of our fork changes.
- conflict-upstream: stale; conflicts with upstream itself. Triage by title/files; read diff only if high relevance.

## Per-PR judgment
- Do not trust titles. Read the diff for clean / conflict-ours PRs (skim large ones).
- Detect duplicates/near-duplicates inside your group (same bug fixed twice) and pick the better one.
- Quality: has tests? minimal? correct? any obvious bug in the fix?
- Relevance: high = real bug/data loss/security/crash in a component+client we run; med = correctness in our components, edge case; low = unused component/client, docs, cosmetic, SDK.

## Verdict values
- merge-now: high or solid-med relevance, correct, small/contained, clean (or trivial conflict).
- consider: useful but larger/riskier, needs owner review, or needs-owner-read.
- wait: fine but low value — pick up on next upstream sync.
- skip: irrelevant to us, duplicate, wrong, or too risky/large feature.

## Output
Write your report to the path given in your prompt (markdown). Format:
1. A table, one row per PR in your input file:
   | # | title | +/- | status | relevance | quality | verdict | reason (one sentence) |
2. Then a section "Top picks" with merge-now and consider items, 2-4 sentences each: what bug, why it matters to us, risks.
3. Then "Duplicates" listing duplicate clusters and which one to prefer.
End your final reply with:
Status: DONE | DONE_WITH_CONCERNS | BLOCKED
Summary: the merge-now PR numbers with a 6-word reason each.
