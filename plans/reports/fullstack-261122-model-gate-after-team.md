# Model gate and model source after the team settles

Branch `feat/team-scoped-subscription-pool` at `513a77fd`. Nothing committed, nothing pushed. Only MemoryProxy files changed.

## Files

| File | Change |
|---|---|
| `MemoryProxy/src/pipeline/stages/model-after-team.ts` (new) | Shared helper: `teamMayChangeInInit`, `reselectModelSource`, `settledUpstreamKind`, `gateModelAfterTeam`. |
| `MemoryProxy/src/pipeline/runners/codex.ts` | Early gate deferred; `modelId`, `clientModel`, `requestedModel` are `let`; late block after `settleRequestTeam`. |
| `MemoryProxy/src/pipeline/runners/anthropic.ts` | Same; `_isCustomUpstream`, `requestedModel`, `mainModelFrom` are `let`. |
| `MemoryProxy/src/pipeline/runners/workbuddy.ts` | Same, with the WorkBuddy rule (see deviations). |
| `MemoryProxy/src/pipeline/runners/__tests__/model-gate-after-team.test.ts` (new) | 23 runner tests. |

## Behavior

- The early gate is skipped when `teamMayChangeInInit` is true: session init may run, and the first answer is a deferrable error or a team whose source is not `session`.
- While the gate is deferred, the model gets the alias only (no 400), as when the gate is off.
- After `settleRequestTeam`, when the team changed OR the gate was deferred, the runner:
  1. (team changed) re-selects the source from the client's original `body.model` whenever it has a source prefix, and applies a new match. On a lost match it restores `body.model`, clears `clientFacingModel`, and uses the restored name;
  2. runs the gate against the settled upstream and sets `modelId` and `body.model`.
- Anthropic: the custom flag is taken after the override-to-official downgrade. `_isCustomUpstream` is updated, so rate limit and credit use the settled value. `mainModelFrom` is cleared on a late match so `stageResolveTargetFull` does not get a stale `requestedModel`.
- Anthropic system-user short-circuit leaves the pipeline before session init, so the gate is not deferred for a system user.
- Other exits before settle (aux passthrough, legacy path) are not deferred: `sessionInitMayRun` is false for aux, and a legacy path has no team.

## Impact (GitNexus, `impact --direction upstream`)

| Symbol | Result |
|---|---|
| `runCodexPipeline` | LOW, 2 impacted (`createApp`) |
| `runAnthropicPipeline`, `runWorkbuddyPipeline` | LOW, 0 callers in the graph. Not trusted: `rg` shows the only callers are `server.ts` (wrapped by `withClientFacingModel`) and tests. |
| `stageModelGate`, `stageModelSource`, `applyModelSource` | HIGH (6 impacted each). Not edited, only called by the new helper. |

`detect-changes --scope all`: 3 files, 11 symbols, 0 affected processes, low.

## Tests

New file, 23 tests (Codex 9, Anthropic 8, WorkBuddy 6) after one wrong test was removed. Run before any implementation, against the original runners:
24 tests ran: 20 failed, 4 passed (the removed wrong test is one of the 20). The 4 that passed already (characterization of existing behavior, they stay as guards):
- Codex: settled team without a pool sends the pricing alias.
- Anthropic claude-code: settled team without a pool gates an unregistered model, and sends the alias (2 tests).
- WorkBuddy: a pool source of a registered session team is gated by the pricing table.

Failing first, by case:
- (a) deferred error or predicted team, non-empty pricing: Codex 3, Anthropic 3 (predicted team, error, form), WorkBuddy 3 (match before pricing, error, form). All returned 400.
- (b) fallback pool team then settled team without a pool: Codex unregistered model reached the upstream (200 instead of 400). Anthropic and WorkBuddy cannot reach this state in the same way, see deviations.
- (c) prefix matched no pool before init: Codex (hermes) 2, Anthropic 2, WorkBuddy 1.
- (d) lost match: Codex 2, Anthropic 2, WorkBuddy 2 (restored name, alias applied, response model not masked, gate on the restored name).

Of the 20 failures, 19 remain as tests; after the change 23 of 23 pass.

Commands (in `MemoryProxy`):
- `npx vitest run src/pipeline/runners/__tests__/model-gate-after-team.test.ts`: 23 passed.
- `npx vitest run`: 96 files, 1484 tests passed.
- `npm run typecheck`: clean.

## Deviations and open questions

1. One test I wrote first was wrong and I removed it: for Anthropic claude-code, a team pool is not a custom upstream (`shouldOverride(pool)` is false), so a pool request is gated by the pricing table and aliased. I had assumed the client name stays. The shipped tests follow the real rule.
2. WorkBuddy keeps its existing rule: only an override group skips the pricing table, a pool source does not. The late path uses the same rule and a characterization test pins it (a registered session team with a pool source and a model outside the pricing table gets 400). If this is a gap, not intent, it is a separate change. Open question for you.
3. Case (b) for WorkBuddy and Anthropic is covered by other cases, not a separate test: both runners already gate a pool request early, so "pool first, no pool later" cannot skip the gate there. WorkBuddy's stale `modelId` is covered by the lost-match test.
4. `modelId` after a settled change has no observable seam. `createPipeline` is built with the early `modelId`, and `forwardToUpstream` is not exported. The tests check the effects: upstream body model, response model mask, 400 on the gate. `modelId` itself is assigned and passed to `forwardToUpstream`, not asserted.
5. A lost match does not re-apply the main-model pin or the pool-service rewrite (same as the old code: "the client's model name stays").
6. In the Codex runner, a `<source>/<model>` request needs a multi-source agent. Codex itself is not one, so source cases use the `hermes` Responses route (`/hermes/:spaceId/v1/responses`, same runner). `makeApp` in the shared harness was not changed; the test builds its own app.
7. Stale-ordering note: in Codex/WorkBuddy the late block always sets `body.model = modelId`; for an unchanged, non-deferred request the block does not run.

Status: DONE_WITH_CONCERNS (see deviations 2 and 4).
Summary: The three runners now defer the model gate while session init can change the team, then re-select the source and gate against the settled team; the shared logic is in `stages/model-after-team.ts`.
Tests: 23 new tests (20 failed before the change), full MemoryProxy suite 1484 passed, typecheck clean.
