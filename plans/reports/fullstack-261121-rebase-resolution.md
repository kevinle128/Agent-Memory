# Rebase resolution: feat/team-scoped-subscription-pool onto origin/master

Result: rebase finished (commit 15019c84, message kept). Nothing pushed. Stash `antigravity-quota-summary-wip` untouched.

## Per file

| File | Merge |
|---|---|
| MemoryProxy/src/subscription-pool/types.ts | Kept master side only: `windowAppliesToModel` with the gemini/3p rule for unlisted models. Our side held the old shorter version of the same function, so it was dropped. |
| MemoryProxy/src/subscription-pool/__tests__/selector.test.ts | Kept both: master test "stops a model the group does not list by the group rule" and our "threshold of each account" block. |
| MemoryPanel/web/src/lib/subscription-pool-display.ts | Kept both: master `PoolWindow` fields (`group_label`, `shared_models`) plus our `POOL_SOURCE_NAMES`, `POOL_FORMAT`, threshold limits, `poolPermissions`, `describeThresholds`. |
| MemoryPanel/tests/subscription-pool-display.test.ts | Kept both: master quota-group tests and our permission/threshold tests. |
| MemoryPanel/web/src/pages/SubscriptionPoolPage/components/AccountTable.tsx | Took our side in all 5 hunks: the group cell reads `account.threshold_pct`, so the `thresholdPct` prop that master added to `QuotaGroupCell` is not needed; `minWidth` keeps our extra threshold column (140). Master's group columns and `windowLabel` stay. |

Auto-merged files checked: selector.ts (master uses `windowAppliesToModel` in `applicableWindows`, ours adds `accountThreshold`; both present), pool-request.ts (master `windowAppliesToModel` in the full-window check), MemoryCore antigravity provider files (master only; our Core code does not touch them).

## Real breakage found and fixed

- MemoryProxy/src/pipeline/runners/__tests__/langfuse-full-payload.test.ts (new on master) built a pool row with no `team_id`. Our rule is that a team pool row without a team is never used, so the test saw no pool. Added `team_id: POOL_TEST_TEAM` to the row, same as the other adapted tests. No assertion changed. Amended into the rebased commit.

## Verification

- MemoryProxy: `npx vitest run` 95 files, 1455 tests pass; `npm run typecheck` clean.
- MemoryPanel: `npx vitest run` 49 files, 699 tests pass; `tsc --noEmit` root clean; web `tsc --noEmit` clean. Master added `@modelcontextprotocol/sdk` to package.json but node_modules lacked it (122 tests and 5 tsc errors from the missing module). I ran `npm install --no-save --no-package-lock @modelcontextprotocol/sdk@^1.32.2`; this changes only node_modules, no tracked file.
- MemoryCore: `MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run src/metadata src/subscription-pool` 36 files, 935 tests pass. Core has no tsconfig. Ad-hoc `tsc --strict` over non-test src/metadata and src/subscription-pool: 1 error on HEAD and 1 on origin/master (a temporary worktree, now removed); no new error.

## Remaining

- None known. The branch has one commit on top of origin/master; push is up to you.

Status: DONE
Summary: Five conflicts merged (master quota-group logic kept, team scope and per-account thresholds kept); one master test fixed for team-scoped pool rows.
All three packages pass their tests and typechecks; nothing pushed.
