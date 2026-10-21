/**
 * One client request against a subscription pool: pick an account, run the upstream call,
 * and move to another account when the first one is out of quota.
 *
 *   - The caller supplies `doFetch(auth)` that performs the real upstream call with the headers
 *     of `auth`. All status handling happens before any byte goes to the client, so a retry is safe.
 *   - 429: retry the same account after 1/2/4/8 seconds, then Check now. Only confirmed full
 *     applicable quota permits switching; otherwise keep retrying within 30 seconds total.
 *   - 401: the token is refreshed through Core (`held_expires_at` makes concurrent 401s one
 *     provider refresh) and the request is retried once. If the refresh fails, the account is
 *     skipped and the request moves to another account.
 *   - When no account is left: the client's own login if it sent `x-tdai-user-key`, else a 429
 *     with the earliest reset time.
 *
 * Access tokens are only put into request headers. Logs carry the account id.
 */

import type { ProxyConfig } from "../types.js";
import type { InstanceUpstreamRow } from "../instance-upstream-cache.js";
import { getProxyStorage } from "../storage/factory.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import {
  getPoolSnapshot, markAccountExhausted, observeAccountWindows, replaceAccountToken,
} from "./account-cache.js";
import {
  bindSession, countSessionsByAccount, getBinding, getCursor, rebindSession, sessionBindingKey, setCursor,
  type SessionBinding,
} from "./binding-store.js";
import { callPoolCore, PoolCoreError, type PoolCoreConfig } from "./core-client.js";
import { buildPoolExhaustedResponse, buildPoolUnavailableResponse } from "./exhausted-response.js";
import { parseClaudeQuotaHeaders, parseCodexQuotaHeaders } from "./quota-signals.js";
import { reportAccount } from "./reporter.js";
import { recordPoolUpstreamError, sanitizeErrorText } from "./upstream-error.js";
import { POOL_RETRY_BUDGET_MS, POOL_RETRY_MAX_WAIT_MS, PoolRetryDeadline, withinRetryDeadline, waitForPoolRetry, notePoolRetryAfter, originalRateLimitResponse, sharedPoolUsageCheck, readPoolErrorBody } from "./retry.js";
import { earliestReset, selectAccount, type Selection } from "./selector.js";
import type { PoolAccount, PoolSnapshot } from "./types.js";

const TAG = "[subscription-pool]";

export const CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

export type PoolProviderId = "claude" | "codex";
/** After a failed token refresh the account is skipped for this long. */
const REFRESH_FAILURE_COOLDOWN_MS = 60 * 1000;
/** A binding is rewritten at most this often while its session keeps sending requests. */
const BINDING_TOUCH_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export type PoolAuth =
  | { kind: "account"; accountId: string; accessToken: string; providerAccountId: string }
  | { kind: "client" };

export interface PoolRequestInput {
  config: ProxyConfig;
  spaceId: string;
  /** The pool group row. A non-empty `base_url` replaces the provider backend URL. */
  row: InstanceUpstreamRow;
  /** Which pool this request belongs to. Defaults to Codex. */
  provider?: PoolProviderId;
  /** Headers of the client request, as received. */
  clientHeaders: Headers;
  body: Record<string, unknown> | null;
  /** Value of the user key (header `x-tdai-user-key`, else the bearer token). */
  userKey: string;
  /** True for a dialogue turn: it may create or move the Session Binding. False reads only. */
  bindSession: boolean;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PoolRequest {
  /** Base URL to join with the request path. */
  readonly upstreamBase: string;
  readonly provider: PoolProviderId;
  /** Account that served the request. Null before the call, or when the client's login was used. */
  readonly accountId: string | null;
  send(doFetch: (auth: PoolAuth, signal?: AbortSignal) => Promise<Response>): Promise<Response>;
}

/**
 * Session id of a Codex request. A subagent request carries its parent's id so it shares the
 * parent's account; otherwise `session-id`, `session_id`, then `client_metadata.session_id`.
 */
export function extractPoolSessionId(headers: Headers, body: Record<string, unknown> | null): string | null {
  const parent = headers.get("x-parent-conversation-id");
  if (parent) return parent;
  const fromHeader = headers.get("session-id") || headers.get("session_id") || headers.get("x-claude-code-session-id");
  if (fromHeader) return fromHeader;
  const meta = body?.client_metadata as { session_id?: unknown } | undefined;
  return typeof meta?.session_id === "string" && meta.session_id ? meta.session_id : null;
}

/** Headers for one attempt: the base headers with the credentials of `auth` applied. */
function withOAuthBeta(existing: string | undefined): string {
  const parts = (existing ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(",");
}

export function applyPoolAuth(
  base: Record<string, string>,
  clientHeaders: Headers,
  auth: PoolAuth,
  provider: PoolProviderId = "codex",
): Record<string, string> {
  const headers = { ...base };
  delete headers["authorization"];
  delete headers["x-api-key"];
  delete headers["chatgpt-account-id"];
  if (auth.kind === "account") {
    headers["authorization"] = `Bearer ${auth.accessToken}`;
    if (provider === "codex") headers["chatgpt-account-id"] = auth.providerAccountId;
    if (provider === "claude") headers["anthropic-beta"] = withOAuthBeta(headers["anthropic-beta"]);
    return headers;
  }
  const authorization = clientHeaders.get("authorization");
  const chatgptAccountId = clientHeaders.get("chatgpt-account-id");
  if (authorization) headers["authorization"] = authorization;
  if (provider === "codex" && chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId;
  if (provider === "claude") {
    const beta = clientHeaders.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  }
  return headers;
}

function coreConfig(config: ProxyConfig): PoolCoreConfig {
  return config.coreSkill;
}

class PoolRequestImpl implements PoolRequest {
  accountId: string | null = null;
  readonly upstreamBase: string;
  readonly provider: PoolProviderId;
  private readonly now: () => number;
  private readonly model: string;
  private readonly clientLoginAllowed: boolean;
  private readonly sessionKey: string | null;
  private storage: ProxyStorage | null = null;

  constructor(private readonly input: PoolRequestInput) {
    this.now = input.now ?? Date.now;
    this.provider = input.provider ?? "codex";
    this.upstreamBase = input.row.base_url || (this.provider === "claude" ? CLAUDE_API_BASE_URL : CODEX_CHATGPT_BASE_URL);
    this.model = typeof input.body?.model === "string" ? input.body.model : "";
    // The client's own login is used only when the user key came in its own header and the
    // bearer is something else; otherwise the bearer is the proxy user key and must not go upstream.
    const userKeyHeader = input.clientHeaders.get("x-tdai-user-key")?.trim() ?? "";
    const bearer = (input.clientHeaders.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    this.clientLoginAllowed = Boolean(userKeyHeader) && Boolean(bearer) && bearer !== userKeyHeader
      && bearer !== (input.userKey ?? "");
    const sessionId = extractPoolSessionId(input.clientHeaders, input.body);
    this.sessionKey = sessionId ? `session:${sessionId}` : input.userKey ? `user:${input.userKey}` : null;
    try {
      this.storage = getProxyStorage(input.config.storage);
    } catch (err) {
      console.warn(`${TAG} storage unavailable, bindings are off: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async send(doFetch: (auth: PoolAuth, signal?: AbortSignal) => Promise<Response>): Promise<Response> {
    const excluded = new Set<string>();
    let switches = 0;
    let refreshes = 0;
    let poolRechecked = false;
    let pinned: PoolAccount | null = null;
    let deadline: number | undefined;
    let last429: Response | null = null;
    const bounded = <T>(run: (signal?: AbortSignal) => Promise<T>): Promise<T> => deadline === undefined
      ? run(this.input.signal) : withinRetryDeadline(run, deadline, this.input.signal);

    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        this.input.signal?.throwIfAborted();
        if (deadline !== undefined && Date.now() >= deadline && last429) return last429;
        let account: PoolAccount | null = pinned;
        pinned = null;
        let snapshot: PoolSnapshot | null = null;
        if (!account) {
          snapshot = await bounded(() => this.snapshot());
          account = await bounded(() => this.pick(snapshot!, excluded));
          // A Panel Check now may have released the pool while this snapshot was cached.
          // Re-read Core once before rejecting the request, without waiting for the cache TTL.
          if (!account && !poolRechecked && !snapshot.unavailable) {
            poolRechecked = true;
            snapshot = await bounded(() => this.snapshot(true));
            account = await bounded(() => this.pick(snapshot!, excluded));
          }
        }
        if (!account) return await bounded(async (signal) => this.noAccountLeft(snapshot ?? await this.snapshot(), (auth) => doFetch(auth, signal)));

        const auth: PoolAuth = {
          kind: "account", accountId: account.account_id,
          accessToken: account.access_token, providerAccountId: account.provider_account_id,
        };
        this.accountId = account.account_id;
        let resp: Response;
        try {
          resp = deadline === undefined ? await doFetch(auth, this.input.signal)
            : await withinRetryDeadline((signal) => doFetch(auth, signal), deadline, this.input.signal);
        } catch (error) {
          if (error instanceof PoolRetryDeadline && last429) return last429;
          throw error;
        }

        if (resp.status === 429) {
          deadline ??= Date.now() + POOL_RETRY_BUDGET_MS;
          const result = await this.retryRateLimitedAccount(account, resp, doFetch, deadline);
          if (result.response.status === 429) last429 = result.response.clone();
          if (result.quotaConfirmed) {
            excluded.add(account.account_id);
            if (switches++ >= 1) break;
            continue;
          }
          resp = result.response;
          if (resp.status === 429) return resp;
        }

        if (resp.status === 401) {
          const text = await bounded(() => resp.text());
          if (refreshes++ === 0) {
            const refreshed: PoolAccount | null = await bounded(() => this.refreshToken(account!));
            if (refreshed) {
              pinned = refreshed;
              continue;
            }
            excluded.add(account.account_id);
            if (switches++ >= 1) break;
            continue;
          }
          return new Response(text, { status: resp.status, headers: resp.headers });
        }

        if (resp.status < 400) this.onSuccess(account, resp.headers);
        return resp;
      }

      // Out of attempts after a limit: the client's login, or the 429 with the earliest reset.
      return await bounded(async (signal) => this.noAccountLeft(await this.snapshot(), (auth) => doFetch(auth, signal)));
    } catch (error) {
      if (error instanceof PoolRetryDeadline && last429) return last429;
      throw error;
    }
  }

  // ── selection ────────────────────────────────────────────────────────────

  /** Preserve session/cache on unclassified 429s; only Check now can authorize switching. */
  private async retryRateLimitedAccount(
    account: PoolAccount, initial: Response,
    doFetch: (auth: PoolAuth, signal?: AbortSignal) => Promise<Response>, deadline: number,
  ): Promise<{ response: Response; quotaConfirmed: boolean }> {
    const key = `${this.input.spaceId}\0${account.account_id}`;
    let response = initial;
    let body = "";
    let lastHeaders = initial.headers;
    let retries = 0;
    let checked = false;
    const originalError = () => originalRateLimitResponse(sanitizeErrorText(body, [
      account.access_token, this.input.userKey, coreConfig(this.input.config).serviceToken,
      this.input.clientHeaders.get("authorization") ?? "", this.input.clientHeaders.get("x-api-key") ?? "",
    ]), lastHeaders, key);
    const auth: PoolAuth = { kind: "account", accountId: account.account_id, accessToken: account.access_token, providerAccountId: account.provider_account_id };
    try {
      body = await readPoolErrorBody(initial, deadline, this.input.signal);
      this.onLimitReached(account, body, response.headers);
      notePoolRetryAfter(key, response.headers);
      while (Date.now() < deadline) {
        const delay = Math.min(1000 * 2 ** retries, POOL_RETRY_MAX_WAIT_MS);
        await waitForPoolRetry(key, delay, deadline, this.input.signal);
        console.info(`${TAG} retry account_id=${account.account_id} attempt=${retries + 1} remaining_ms=${Math.max(0, deadline - Date.now())}`);
        response = await withinRetryDeadline((signal) => doFetch(auth, signal), deadline, this.input.signal);
        if (response.status !== 429) return { response, quotaConfirmed: false };
        body = await readPoolErrorBody(response, deadline, this.input.signal);
        lastHeaders = response.headers;
        this.onLimitReached(account, body, response.headers);
        notePoolRetryAfter(key, response.headers);
        retries++;
        if (retries >= 4 && !checked) {
          checked = true;
          console.info(`${TAG} Check now after retries account_id=${account.account_id}`);
          try {
            const result = await withinRetryDeadline(() => sharedPoolUsageCheck(key, () => callPoolCore<{
              failed: boolean; account: Pick<PoolAccount, "usage" | "status" | "exhausted_until"> & { usage_updated_at?: number | null };
            }>(coreConfig(this.input.config), this.input.spaceId, "check-usage", { account_id: account.account_id })), deadline, this.input.signal);
            if (result.failed === false && Array.isArray(result.account?.usage?.windows)) {
              observeAccountWindows(this.input.spaceId, account.account_id, result.account.usage.windows);
              const full = result.account.usage.windows.some((window) => (
                (!window.model_scope || window.model_scope === this.model)
                && window.source === "usage_api"
                && typeof result.account.usage_updated_at === "number"
                && window.observed_at >= result.account.usage_updated_at
                && window.used_pct >= 100 && (window.resets_at === null || window.resets_at > this.now())
              ));
              if (full) {
                console.info(`${TAG} Check now confirmed full quota account_id=${account.account_id}; switching allowed`);
                // Fetch the checked state before selecting another account; never fabricate 100%.
                await withinRetryDeadline(() => this.snapshot(true), deadline, this.input.signal);
                return { response: originalError(), quotaConfirmed: true };
              }
            }
          } catch (error) {
            if (error instanceof PoolRetryDeadline || this.input.signal?.aborted) throw error;
            console.warn(`${TAG} Check now unavailable account_id=${account.account_id}; retaining session account`);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof PoolRetryDeadline)) throw error;
    }
    return { response: originalError(), quotaConfirmed: false };
  }

  private async snapshot(forceRefresh = false): Promise<PoolSnapshot> {
    const snapshot = await getPoolSnapshot(coreConfig(this.input.config), this.input.spaceId, this.input.config.instanceUpstream, this.now(), forceRefresh);
    return {
      ...snapshot,
      // Core may return accounts for more than one pool group. This request is tied to one
      // group row, so never send another group's or provider's token to ChatGPT.
      accounts: snapshot.accounts.filter((account) => account.group_id === this.input.row.group_id && account.provider === this.provider),
    };
  }

  private bindingKey(): string | null {
    if (!this.storage || !this.sessionKey) return null;
    try {
      return sessionBindingKey(this.input.spaceId, this.provider, this.sessionKey);
    } catch (err) {
      console.warn(`${TAG} no binding for this request: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
  }

  private async pick(snapshot: PoolSnapshot, excluded: Set<string>): Promise<PoolAccount | null> {
    const now = this.now();
    const key = this.bindingKey();
    const storage = this.storage;
    let binding: SessionBinding | null = null;
    let cursor = 0;
    if (storage) {
      try {
        if (key) binding = await getBinding(storage, key, now);
        cursor = await getCursor(storage, this.input.spaceId, this.provider);
      } catch (err) {
        console.warn(`${TAG} binding read failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    const selection = selectAccount(snapshot.accounts, binding?.account_id ?? null, now, snapshot.thresholdPct, this.model, cursor, excluded);
    if (!selection) return null;
    if (this.input.bindSession && storage && key) {
      await this.persist(storage, key, selection, binding, snapshot, now);
    }
    return selection.account;
  }

  /** Write the binding and cursor a main-turn selection implies, then refresh session counts. */
  private async persist(
    storage: ProxyStorage,
    key: string,
    selection: Selection,
    binding: SessionBinding | null,
    snapshot: PoolSnapshot,
    now: number,
  ): Promise<void> {
    const accountId = selection.account.account_id;
    try {
      if (selection.kind === "bound") {
        if (binding && now - binding.last_used_at > BINDING_TOUCH_MS) await rebindSession(storage, key, accountId, now);
        return;
      }
      if (selection.kind === "round_robin") await setCursor(storage, this.input.spaceId, this.provider, selection.nextCursor);

      let changed = false;
      if (binding) {
        await rebindSession(storage, key, accountId, now);
        changed = true;
      } else {
        const bound = await bindSession(storage, key, accountId, now);
        changed = bound.created;
        if (!bound.created && bound.accountId !== accountId) {
          // A concurrent first request bound this session already; the bound account is the one in use.
          const winner = snapshot.accounts.find((a) => a.account_id === bound.accountId);
          if (winner) selection.account = winner;
        }
      }
      if (changed) {
        this.reportSessionCounts(storage, [accountId, binding?.account_id], now);
      }
    } catch (err) {
      console.warn(`${TAG} binding write failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /** Tell Core how many sessions the accounts have now. Runs in the background. */
  private reportSessionCounts(storage: ProxyStorage, accountIds: Array<string | undefined>, now: number): void {
    const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
    void countSessionsByAccount(storage, this.input.spaceId, this.provider, now)
      .then((counts) => {
        for (const id of ids) {
          reportAccount(coreConfig(this.input.config), this.input.spaceId, id, { active_sessions: counts.get(id) ?? 0 });
        }
      })
      .catch((err: unknown) => {
        console.warn(`${TAG} session count failed: ${err instanceof Error ? err.message : "unknown"}`);
      });
  }

  // ── outcomes ─────────────────────────────────────────────────────────────

  private onSuccess(account: PoolAccount, headers: Headers): void {
    const windows = this.provider === "claude"
      ? parseClaudeQuotaHeaders(headers, this.now())
      : parseCodexQuotaHeaders(headers, this.now());
    if (windows.length === 0) return;
    observeAccountWindows(this.input.spaceId, account.account_id, windows);
    reportAccount(coreConfig(this.input.config), this.input.spaceId, account.account_id, { windows });
  }

  private onLimitReached(account: PoolAccount, bodyText: string, headers: Headers): void {
    const now = this.now();
    void recordPoolUpstreamError({
      storage: this.storage, spaceId: this.input.spaceId, accountId: account.account_id,
      provider: this.provider, model: this.model, status: 429, body: bodyText, headers, now,
      requestId: this.input.clientHeaders.get("x-request-id") ?? this.input.clientHeaders.get("x-tdai-request-id"),
      secrets: [account.access_token, this.input.userKey, coreConfig(this.input.config).serviceToken,
        this.input.clientHeaders.get("authorization") ?? "", this.input.clientHeaders.get("x-api-key") ?? ""],
    }).catch(() => { /* Diagnostics must never interrupt forwarding. */ });
    console.warn(`${TAG} account_id=${account.account_id} received 429; quota not yet confirmed`);
  }

  /** Returns the account with a fresh token, or null when Core could not refresh it. */
  private async refreshToken(account: PoolAccount): Promise<PoolAccount | null> {
    reportAccount(coreConfig(this.input.config), this.input.spaceId, account.account_id, { status_code: 401 });
    try {
      const result = await callPoolCore<{ access_token: string; provider_account_id?: string; token_expires_at: number | null }>(
        coreConfig(this.input.config), this.input.spaceId, "refresh",
        { account_id: account.account_id, held_expires_at: account.token_expires_at },
      );
      replaceAccountToken(this.input.spaceId, account.account_id, result.access_token, result.token_expires_at);
      return {
        ...account,
        access_token: result.access_token,
        token_expires_at: result.token_expires_at,
        provider_account_id: result.provider_account_id || account.provider_account_id,
      };
    } catch (err) {
      const reason = err instanceof PoolCoreError ? `${err.httpStatus} ${err.errorCode ?? ""}`.trim() : "unreachable";
      console.warn(`${TAG} token refresh failed for account_id=${account.account_id} (${reason})`);
      markAccountExhausted(this.input.spaceId, account.account_id, this.now() + REFRESH_FAILURE_COOLDOWN_MS);
      return null;
    }
  }

  private async noAccountLeft(snapshot: PoolSnapshot, doFetch: (auth: PoolAuth) => Promise<Response>): Promise<Response> {
    if (this.clientLoginAllowed) {
      this.accountId = null;
      return doFetch({ kind: "client" });
    }
    if (snapshot.unavailable) return buildPoolUnavailableResponse();
    const now = this.now();
    return buildPoolExhaustedResponse(earliestReset(snapshot.accounts, now, snapshot.thresholdPct, this.model), now);
  }
}

export function openPoolRequest(input: PoolRequestInput): PoolRequest {
  return new PoolRequestImpl(input);
}
