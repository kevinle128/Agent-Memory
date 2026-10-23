# Subscription pool: reset credits (show and redeem)

Status: in progress
Branch: `feat/reset-credits` (worktree `../Agent-Memory-reset-credits`, base `feat/server_team` HEAD)

## Outcome

On the Subscription Pool page of the Panel, each Claude and Codex account shows how many
usage-limit reset credits it has and when each credit expires. A System Admin can redeem one
credit from the Panel, after a confirmation.

## Verified provider facts (live read on local accounts, 2026-10-22)

| | Claude | Codex |
|---|---|---|
| Read | `GET api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`, block `cedar_ember` | `GET chatgpt.com/backend-api/wham/rate-limit-reset-credits` |
| Extra header | `User-Agent: claude-cli/<ver> (external, cli)` is required. Without it: `eligible:false, ineligible_reason:"surface"`, no grants | none |
| Items | `grants[]`: `id, label, resets_left, resets_total, ends_at, usable_now, unavailable_reason` | `credits[]`: `id, title, status, expires_at, is_supported_by_plan`; top level `available_count`, and `/wham/usage` has `applicable_available_count` |
| Redeem (from client source, not run live yet) | `POST /api/organizations/{organization.uuid}/reset_rate_limits` `{program:"cedar_ember", grant_id, request_id}` | `POST /wham/rate-limit-reset-credits/consume` `{redeem_request_id, credit_id}` |
| Redeem result | `reset, already_used, not_limited, cooldown, ineligible, unavailable` | `reset, nothing_to_reset, no_credit, already_redeemed` |

Raw probe output (no tokens): `/tmp/rb-probe/`.

## Design

- Glossary: new term **Reset Credit**, verb **redeem**. The glossary forbids "reset" as a verb on
  the account, so routes and code say `redeem` / `reset_credits`.
- New entity field `reset_credits: SubscriptionResetCredits | null`, separate from `usage`, so
  proxy quota reports that rewrite `usage` never drop it. Mongo: plain field. SQLite: column
  `reset_credits_json TEXT` added by `ALTER TABLE` when missing.
- Normalized shape (provider neutral):
  `{ available, usable_now, note, observed_at, credits: [{ id, label, remaining, total, expires_at, usable_now, unavailable_reason }] }`.
- Adapter: `fetchUsage` returns `{ windows, resetCredits }`. Claude reads both from one call
  (usage URL with `cedar_ember=1`, CLI User-Agent). Codex makes a second call to the credits
  endpoint; a failure there gives `resetCredits: null` and never fails the usage check.
- Adapter: new `redeemResetCredit(accessToken, providerAccountId, { creditId, requestId })`
  returns `{ outcome, resetApplied }`. Claude reads `organization.uuid` from the profile at
  redeem time (no new stored field).
- Core service `redeemSubscriptionResetCredit(accountId, creditId, requestId)`: call
  `runSubscriptionTokenRefresh` with `ifExpiresWithinMs: 60_000` (it locks internally), call the
  adapter with no lock (the lock is not reentrant and redeem writes no account state), then
  `runSubscriptionUsageCheck` (locks internally). The Panel generates `request_id` once per click, so a
  retry of the same click cannot spend twice.
- Route `POST /v3/meta/subscription-pool/account/redeem-reset-credit`
  `{ account_id, credit_id, request_id }`, System Admin only.
- Panel: a "Reset credits" cell per account (count, nearest expiry, list of credits with expiry),
  a redeem button per credit with a confirm dialog stating the action cannot be undone, and a
  toast with the outcome.

- Redeem outcomes: `reset` = success; `nothing_to_reset` / `not_limited` = information, credit
  not spent; `already_redeemed` / `already_used` = already done, not an error; any other = error
  with the provider text.
- The Claude CLI User-Agent lives in one constant with a comment: the server gates
  `cedar_ember` on the client surface. Codex per-credit `usable_now` is derived
  (`status === "available" && is_supported_by_plan && applicable_available_count > 0`).

## Bug fix in the same branch: Codex window name by window length

User report: a Codex `prolite` account shows its weekly usage (14 %, resets in 4 days) in the
"Primary window (5h)" column. Live payload: `rate_limit.primary_window.limit_window_seconds =
604800` and `secondary_window = null`. Core and Proxy name windows by position. The official
Codex TUI picks the 5h / weekly label from `window_minutes`.
Fix: name a Codex window by its length when the length is known (about 5 h gives
`primary_window`, about 7 days gives `secondary_window`); fall back to position when the length
is missing or both windows map to the same name. Core reads `limit_window_seconds`; Proxy reads
`x-codex-primary-window-minutes` / `x-codex-secondary-window-minutes`, so header readings and
usage readings keep the same names and still merge.

## Phases

- [x] 0. Codex window naming by length (Core parser, Proxy header parser, tests)
- [x] 1. Types, store (Mongo, SQLite, contract test), glossary entry
- [x] 2. Adapters: parse credits, redeem call, unit tests with recorded payload shapes
- [x] 3. usage-check stores credits; service method, schema, route; tests
- [ ] 4. Panel: API client, display helper, table cell, redeem dialog; tests
- [x] 5. Verify: compare Claude `usage.windows` before and after the URL change; unit tests of Core and Panel, typecheck; live run on local (read for all
      accounts, redeem on the Codex account, which the user approved)

## Acceptance

- Status of the pool returns `reset_credits` for each account; Panel shows count and expiries.
- Redeem from the Panel calls the provider once per click and shows the outcome; the account
  row updates after the call.
- Existing usage check, proxy report and tests keep working.

## Risks

- Provider endpoints are undocumented and can change. Parsers accept missing fields and
  return `null` instead of failing the usage check.
- A redeem cannot be undone. Only an explicit admin action redeems; nothing redeems automatically.

## Review (2026-10-22)

- Tests: MemoryCore subscription-pool + metadata 271 passed; MemoryProxy subscription-pool 153
  passed; MemoryPanel subscription-pool 62 passed; Panel web typecheck and build clean.
- Claude usage URL change: windows identical before and after on 3 live accounts (only
  sub-second jitter in `resets_at`).
- Live read on local Mongo: 3 Claude accounts (0 credits left, one `no_grant`), 1 Codex account
  (3 credits, expiry dates match the provider).
- Extra fix found in live run: an older usage API window absent from a new reading stayed until
  its old reset time, so the renamed Codex weekly window showed twice. usage-check now drops
  older `usage_api` rows that the new reading does not return.
- Live redeem on Codex: `nothing_to_reset`, credit not spent (account at 15 %). The `reset`
  branch is not yet verified live; it needs an account that is at its limit.
- Not done: MemoryCore has no tsconfig, so a full typecheck was not run; MongoDB contract test
  needs a `mongod` binary (Mongo path verified live instead). GitNexus index is stale for the
  subscription-pool files.
