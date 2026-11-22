---
status: accepted
---

# A Subscription Pool belongs to one team; the request team comes from the session, with an ordered fallback over the teams of the user

[ADR 0001](0001-proxy-side-subscription-pool.md) made one pool per client type for the whole Memory
instance. All teams shared the same Subscription Accounts, so one team could use up the quota that
another team had paid for, and every admin saw every account. A pool now belongs to one team. A team
sees and manages only its own pools, and a request can use only the pool of its own team. The
Subscription Account, token, usage and timer rules of ADR 0001 do not change.

## Decisions

- **Ownership.** The upstream group row of a pool has a `team_id`. The accounts have no `team_id`:
  an account belongs to the team of its group, and an account cannot move to another group. A pool
  row with an empty `team_id` is used by no team. There is one pool for each team and provider. The
  group name and the fixed source name (`sub-claude`, `sub-openai`, `sub-antigravity`) repeat in
  every team, so the model ids that clients already use do not change. These names are reserved for
  pool rows.
- **A layer over the instance groups.** Pool rows are a per-team layer over the instance groups.
  The instance groups keep the rule that each agent is in exactly one group. Each team has its own
  rule for its pool rows: an agent is in at most one pool row of the team. An agent that a team
  pool serves stays in its instance group too, so a team without a pool still has a home and runs
  on the normal upstream of the client type.
- **Rights.** A member of the team and a System Admin can see the pool. The admin of the team and a
  System Admin can change it. A request that names an account or a group of another team gets the
  same answer as a request for an id that does not exist, so an id does not show that it exists.
- **Threshold per account.** The Threshold is a column of the account. A new account gets the value
  of the login request, else the global start value, which only a System Admin changes. Every
  reader uses the Threshold of the account: the usage check, the timers, the account selector and
  Account Switch. A change of the start value changes no existing account.
- **Team of a request.** One helper of the Proxy gives the team before any stage can pick a pool.
  The first of these wins: the team of the registered session, the team that a bypassed session
  chose, the team of an open session form. Only a request that can still run session init (it has a
  session id, it is not `x-memory-mode: off`, and its session has no final state) also tries the
  default team of the user and then the team of the header preset, in the order that session init
  uses. A request that runs no session init, such as one with `x-memory-mode: off` and `x-team-id`,
  ignores both and goes to the ordered fallback. A team counts only while the user is an active
  member of it. The membership list comes from
  Core. It is fresh for 60 seconds, and the last good list is kept for 10 minutes when Core cannot
  be reached.
- **Known team.** A known team without a pool for the client runs on the shared normal upstream of
  the client, also when that upstream is a paid key. It never uses an account of another team.
- **Ordered fallback.** When the session gives no team (for example `x-memory-mode: off`, a request
  with no session id, a session that skipped the team question), the request takes the first team of
  its user, in the order of Core (newest team first), that has an enabled pool for the client and
  one account that can take a new session. The result is an error when no team qualifies:
  `403 no_team_pool` when no team of the user has a pool, `429` with the earliest reset time of the
  pools when every account of every pool is at its Threshold or exhausted, `403 no_active_team` when
  the user has no active team, and `503 team_list_unavailable` with `retry-after: 5` when Core cannot
  give the team list. The helper runs only when an enabled pool row serves the client. A client that
  no team pool serves behaves as before. An error that session init may still resolve (a first turn
  that can register the session) waits until init has run, and then answers before any upstream call.
- **Fail closed.** The Proxy uses a pool row only when its `team_id` is not empty and is equal to the
  verified team of the request. A row without the field (a Core of the old build) is not used.
- **Session Binding and round robin.** The Session Binding key does not change, so no live binding
  is lost and the prompt cache of a session stays. The account list of a request is the accounts of
  its group, and a binding to an account outside that list is replaced by the selector. The round
  robin cursor has the group id in its key, so teams do not move each other's cursor.
- **Migration.** Core gives each pool row without a team to the default team on every start. The
  default team is the one team with the name in `TDAI_METADATA_DEFAULT_TEAM_NAME`; when that
  variable is not set, the one team named `default`, and only when no team has that name, the one team named
  `default-team`. A name step that finds two teams stops the rule. When no single team is found,
  the pool rows stay unassigned, no team uses them, every client runs on its instance group, and
  Core logs an error with the candidate team ids. Before this, the migration always gives each
  pooled agent back to the default instance group, so no client gets `AGENT_NOT_CONFIGURED`. It
  copies the global Threshold into every existing account once.
- **Team delete.** Deleting a team deletes its pools and their accounts, and Core tells the
  scheduler about each removed account.

## Considered Options

- **A `team_id` on the accounts too**: rejected. The team of an account is the team of its group, and
  no route moves an account between groups, so a second field could only disagree with the first.
- **One Threshold for the instance or for each pool**: rejected. Two accounts of one pool can have
  different plans and different safe levels of use.
- **A separate routing row that holds team accounts, next to the instance pool row**: rejected. It
  needs a second table and a second set of rules for names, clients and the Panel, and the
  existing group rules already express the per-team layer.
- **A new Session Binding key with the team in it**: rejected. It drops every live binding on the
  day of the deploy and loses the prompt cache of every session. The account list is already
  filtered to the group of the request, so a binding to an account of another team cannot be used.
- **Send a request with no team to the normal upstream**: rejected by the product owner. Every
  request has a user and every user is in at least one team, so the ordered fallback or a clear
  error is the answer.

## Consequences

- The teams other than the default team lose the old shared pool on the day of the deploy. They run
  on the normal upstream of the client until their admin sets up a pool. Requests of a user in no
  team to a pooled client get `403 no_active_team`.
- A new Proxy that reads a Core of the old build sees pool rows without `team_id`, so it uses none
  of them. A pooled client gets `400 AGENT_NOT_CONFIGURED` for up to one cache time of the instance
  rows (30 seconds by default) until Core is the new build.
- The Proxy and Core must not be rolled back apart while a second team has a pool. The old Core
  creates a unique index on the source name that cannot be built when two teams hold the same
  source name. It also rejects a write while an agent is in both the default group and a pool row.
  The old Proxy takes the first pool row that holds the agent, so it can send the traffic of one
  team on the account of another team. A rollback therefore needs a data step before the old
  images start: `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs` (SQLite, Core
  stopped, `--dry-run` first). It refuses while more than one team holds pool groups, or while a
  source name is used twice, so the old index can always be built. Then it puts the old source name
  index back and takes the agents of the pool groups out of the default group. It keeps the
  `team_id` and `threshold_pct` columns, which the old code does not read. It copies the database
  files first and runs in one transaction. Use the live database for this step, not a restored
  backup, because providers rotate refresh tokens and a backup holds tokens that are already dead.
  There is no MongoDB version of the script; production uses SQLite.
- The first request of a session that no team claims gets its team error only after session init.
  A side request, a token count or a request with `x-memory-mode: off` has no init to wait for, so
  it can get a team error before the main turn has registered the session.
- The Claude Code runner writes the serving account id and the team id to the usage record, and
  one `[subscription-pool] served account_id=<id> team=<team_id>` line for each request that a pool
  account served. It never writes a token.
- Accepted low risk: a model request in the `openai-chat` format for a pool source name that the
  caller's team does not serve gets an error text that tells whether a pool with that name exists
  in some team, is switched off, or does not list the client. The caller learns only that on or
  off state, nothing about accounts or tokens.
- Accepted low risk: the Proxy keeps the team list of a user for 60 seconds. When Core is not
  reachable, it uses the last good list for up to 10 minutes. A user who was removed from a team
  just before a Core outage can therefore keep using the team pool for up to 10 minutes. The
  window ends when Core answers again.
- Team delete on SQLite is one transaction: the team, its members, agents, tasks, assets, pool
  groups and pool accounts all go or none go. On MongoDB the team document goes first and the
  related rows follow in separate steps; only the pool groups and their accounts share one
  transaction (and only when the deployment has transactions). A stop between the steps leaves
  pool rows of a team that no longer exists. No team can use them. Production uses SQLite, so
  this is accepted for MongoDB.
