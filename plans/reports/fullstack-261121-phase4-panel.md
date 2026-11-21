# Panel report: team pool page (team-scoped Subscription Pools)

Branch `feat/team-scoped-subscription-pool`. Nothing committed, pushed or switched. Only `MemoryPanel/**` changed. No production access.

## Outcome

The pool page follows the active team and sends `team_id` on every team call. A team admin or a System Admin manages the pool, a member only views it. Each account has its own threshold. The global threshold is now the "Start threshold for new accounts", shown only to the System Admin. Pool sources are gone from the API Key page and from the Model Provider taken-names logic.

## Files (all under `Agent-Memory/MemoryPanel`)

- `src/panel/api/meta-actions.ts`: allowlist gets `subscription-pool/clients/update`; comment states the new role rule.
- `web/src/lib/api/subscription-pool.ts`: `teamId` on status, enable, disable, oauthStart, oauthComplete, checkAll; new `updateClients`; `threshold_pct` on account, update and login; `clients` on the provider status; `default_threshold_pct` and `team_id` on the status.
- `web/src/lib/subscription-pool-display.ts`: `POOL_SOURCE_NAMES`, `POOL_FORMAT`, threshold range and `isValidThreshold`, `poolPermissions`, `describeThresholds` (pure, no imports).
- `web/src/lib/client-sources.ts`: `poolClientCandidates` (clients whose wire format fits the pool format; the rule Core applies).
- `web/src/pages/SubscriptionPoolPage/index.tsx`: reads `activeTeam`; empty state without a team; content is keyed by team id, so a team change remounts it and drops all state. `canManage` follows Core (`roleInTeam === 'admin'` or System Admin). Per-account threshold save. Disable check uses `status.clients`, not the client-source catalog.
- `use-pool-status.ts`: takes `teamId`; refetches on a team change; clears data and error first; the existing request-sequence guard drops late answers of the old team.
- `components/PoolClients.tsx` (new): checkboxes of the clients that can use the provider pool, save calls `updateClients`, off while the pool is off or for a viewer.
- `components/AccountTable.tsx`: new "Stop at" column with an editable 50-100 number for a manager, plain text for a viewer. Meters, marks and state use the account threshold.
- `components/AddAccountDialog.tsx`: team id on oauthStart and oauthComplete; optional threshold field (empty uses the start value).
- `components/PoolSettings.tsx`: "Start threshold for new accounts" with a note; shown and editable for the System Admin only. `PoolSummary.tsx`: threshold card shows the range of the accounts. `PoolHeader.tsx`: team name tag.
- `web/src/components/model-source/SourceInUseModal.tsx`: for the pool action it points to the Clients box and has no link to the API Key page.
- `web/src/pages/ModelProviderPage/use-provider-groups.ts`: no pool status call; the three fixed pool names are always taken.
- `web/src/pages/ApiKeysPage/components/ClientEndpoints.tsx`: one line "Subscription pools are set per team on the Subscription Pool page."
- `web/src/i18n/en-US.ts`, `zh-CN.ts`: same keys in both (zh-CN in Chinese, en-US in English). `settings.stopAt` removed (no longer used); texts of subtitle, offNotice and thresholdSaved changed.
- `panel-api-doc.md` (Chinese, as the file): `team_id` rules, the new action, the start threshold meaning.
- Tests: `tests/subscription-pool-actions.test.ts` (new action in the list; "sends the active team with every pool call"; account calls and the start threshold carry no team; "allows the new clients action"), `tests/subscription-pool-display.test.ts` ("a team admin can edit, a member only views, a global admin can edit any team"; "shows the threshold of each account"; "a team admin edits an account threshold; the start threshold control is for a global admin only"; own-threshold state; range check), `tests/client-sources.test.ts` ("the client source catalog has no pool sources"; `poolClientCandidates`; fixture no longer has pool rows).

## Commands and counts

- `npx vitest run` on the three changed test files: 93 passed.
- `npm test` (MemoryPanel): 36 files, 500 tests passed.
- `npm run typecheck`, `npm run build` (root): clean.
- `web`: `npx tsc --noEmit -p .` clean; `npm run build` OK (only the existing chunk size notice); `npm run lint:check`: 0 errors, 35 warnings (the files I touched keep only two old ref-cleanup warnings in `use-provider-groups.ts` and `use-pool-status.ts`).
- i18n sync: key lists of both files match (`comm -3` empty), no duplicate key.

## Deviations and notes

1. `poolPermissions` and the candidate rule are pure functions in `lib`, because the Panel Vitest runs in node without a DOM; the React pieces are checked by typecheck and build, not by a render test.
2. The Clients control is a new component `PoolClients` (spec allowed this) rendered below the header, not inside `PoolHeader`.
3. The pool status now reports the format `gemini` for the AntiGravity pool in `POOL_FORMAT`; the Panel `SourceFormat` type has no `gemini`, so the candidate rule compares strings. A Core catalog that sends `gemini` in `formats` works at run time.
4. `updateAccount` input type gets `status?: 'active'` (the page already sent it through an untyped spread).
5. GitNexus `impact` was not run before the edits (no graph tool in this session); changes are additive or signature changes whose callers I fixed and confirmed with `tsc` (`usePoolStatus`, the api functions, `AccountTable`, `PoolSettings`, `PoolSummary`, `AddAccountDialog`, `useProviderGroups` lost `pools`).
6. Stale `panel-api-doc.md` sentence "only codex is open" (about `PROVIDER_NOT_SUPPORTED`) was there before and is left as is.

## Concerns

- No browser check with two teams; that is the e2e step. Not verified by a real session: the no-old-team-request rule rests on the keyed remount plus the request-sequence guard.
- `SOURCE_IN_USE` in the disable flow is now checked from `status.clients`; if Core status lags the stored row, Core still answers 409 and the same dialog shows from `detail.clients`.
- Proxy still needs its own phase; the Panel does not depend on it.

Status: DONE_WITH_CONCERNS
Summary: The pool page is team scoped with per-account thresholds, a Clients control, a System Admin-only start threshold and matching locale keys; Panel tests (500), typecheck, web build and lint (0 errors) pass.
Open: no two-team browser check yet and no GitNexus impact run; both are listed above.
