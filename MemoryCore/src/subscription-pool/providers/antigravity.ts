import { arch, platform } from "node:os";
import type { SubscriptionQuotaWindow } from "../../metadata/types.js";
import {
  parseResetTime,
  readProviderError,
  SubscriptionProviderError,
  type ExchangedSubscriptionTokens,
  type FetchModelsOptions,
  type FetchUsageOptions,
  type SourceModelReading,
  type SubscriptionCodeExchangeInput,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./types.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
/**
 * Host of the Cloud Code API. The `daily` host is the one the AntiGravity app and the CLI use, and
 * its model list is newer than the production host's (it carries the newest Gemini models), so the
 * model catalog and the usage check read from it. `ANTIGRAVITY_CLOUD_CODE_URL` overrides the host.
 */
export const DEFAULT_CLOUD_CODE_HOST = "https://daily-cloudcode-pa.googleapis.com";

/** `https://host/v1internal:<method>`, with the host read from the environment on every call. */
export function cloudCodeUrl(method: string, env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.ANTIGRAVITY_CLOUD_CODE_URL?.trim() || DEFAULT_CLOUD_CODE_HOST).replace(/\/+$/, "");
  return `${host}/v1internal:${method}`;
}
/** Fixed port: the admin pastes the URL of the failed redirect, so nothing listens on it. */
const CALLBACK_PORT = 51121;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

/** Version the AntiGravity CLI reports. Google reads it to decide whether the client is supported. */
const CLI_VERSION = "1.5.13";
const CLI_BUILD = "1025641825";
const DEFAULT_TIER_ID = "legacy-tier";

function osType(): string {
  const os = platform();
  return os === "win32" ? "windows" : os;
}

function cpuArch(): string {
  const architecture = arch();
  return architecture === "x64" ? "amd64" : architecture;
}

/**
 * Google answers `loadCodeAssist` without a project (reason UNSUPPORTED_CLIENT) to the older
 * desktop-app metadata and user agent. The CLI's string name and user agent get the project.
 */
const CLOUD_CODE_USER_AGENT =
  `antigravity/cli/${CLI_VERSION} (aidev_client; os_type=${osType()}; arch=${cpuArch()}; cl=${CLI_BUILD}; auth_method=consumer)`;
const CLIENT_METADATA = { ideType: "ANTIGRAVITY" };

export const ANTIGRAVITY_OAUTH_NOT_CONFIGURED =
  "AntiGravity OAuth is not configured: set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET";

/** Raised when the OAuth client of the AntiGravity login is not set in the environment. */
export class AntigravityOAuthNotConfiguredError extends SubscriptionProviderError {
  constructor() {
    super(ANTIGRAVITY_OAUTH_NOT_CONFIGURED, false, 0);
    this.name = "AntigravityOAuthNotConfiguredError";
  }
}

/**
 * OAuth client of the AntiGravity login, read from the process environment on every call, so a
 * missing value breaks only AntiGravity and a change needs no code edit. The values are kept
 * out of the source on purpose.
 */
export function antigravityOAuthCredentials(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
  const clientId = env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new AntigravityOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function cloudCodeHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": CLOUD_CODE_USER_AGENT,
  };
}

/** Project id of a `loadCodeAssist` or `onboardUser` payload: a string, or an object with `id`. */
function projectIdOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const id = asRecord(value).id;
  return typeof id === "string" ? id.trim() || null : null;
}

/**
 * Ids in the list that are not chat models: editor helpers (`chat_*`, `tab_*`), retired or
 * tier-gated entries and image or search backends. The agent must not offer them to a client.
 */
const NON_CHAT_MODEL_ID = /^(chat_|tab_)|-(disabled|tiered|sonar)$|image/i;

/** Models that carry a real quota or can be offered to a client: not internal, not a helper id. */
function isUsableModel(id: string, model: Record<string, unknown>): boolean {
  return Boolean(id) && model.isInternal !== true && !NON_CHAT_MODEL_ID.test(id);
}

/**
 * Quota of every listed model, as one window per model.
 *
 * Why per model: Google reports a quota fraction for each model id and the groups behind them
 * change between releases, so a fixed grouping would go stale. Every window carries its model id
 * as `model_scope`: a shared window that reaches 100 % would stop the whole account, but a
 * drained model must only stop that model. All windows share the name `quota`, so
 * `name` + `model_scope` stays unique.
 *
 * A model with `quotaInfo` but no `remainingFraction` is read as nothing left, because Google
 * omits the field when a model is exhausted; skipping it would hide the limit. Internal and
 * helper models (see `isUsableModel`) and models without `quotaInfo` have no quota to show.
 */
export function parseAntigravityUsage(raw: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const windows: SubscriptionQuotaWindow[] = [];
  for (const [modelId, info] of Object.entries(asRecord(asRecord(raw).models))) {
    const model = asRecord(info);
    const quota = model.quotaInfo;
    if (!isUsableModel(modelId, model) || !quota || typeof quota !== "object") continue;
    const info2 = quota as { remainingFraction?: unknown; resetTime?: unknown };
    const fraction = typeof info2.remainingFraction === "number" && Number.isFinite(info2.remainingFraction)
      ? Math.min(1, Math.max(0, info2.remainingFraction))
      : 0;
    windows.push({
      name: "quota",
      model_scope: modelId,
      used_pct: Math.round((1 - fraction) * 10_000) / 100,
      resets_at: parseResetTime(info2.resetTime, now),
      observed_at: now,
      source: "usage_api",
    });
  }
  return windows;
}

/** Name of a bucket window: the app sends `window` as `weekly` or `5h`; the bucket id suffix is the fallback. */
function bucketWindowName(bucket: Record<string, unknown>): string {
  if (typeof bucket.window === "string" && bucket.window.trim()) return bucket.window.trim();
  const id = typeof bucket.bucketId === "string" ? bucket.bucketId : "";
  return /-(weekly|5h)$/.exec(id)?.[1] ?? id;
}

/**
 * Group key of a bucket: its id without the window suffix (`gemini-weekly` gives `gemini`,
 * `3p-5h` gives `3p`). A group has no id of its own in the payload.
 */
function bucketGroupKey(bucket: Record<string, unknown>): string {
  const id = typeof bucket.bucketId === "string" ? bucket.bucketId : "";
  return id.replace(/-(weekly|5h)$/, "");
}

/**
 * Quota of every group of a `retrieveUserQuotaSummary` payload: one window per bucket (weekly and
 * 5h), the same limits the AntiGravity app shows.
 *
 * Why per group: every model of a group shares both limits, so a drained bucket must stop all of
 * those models and no other. `model_scope` is the group key and `shared_models` lists the model
 * ids (from `fetchAvailableModels`) that the bucket stops. The payload names a group's models
 * only by display name, so the app's own rule decides membership: a model whose id contains
 * `gemini` belongs to the Gemini group and every other model to the third-party group.
 *
 * A bucket without `remainingFraction` is read as nothing left, like a model in
 * `parseAntigravityUsage`.
 */
export function parseAntigravityQuotaSummary(summary: unknown, models: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const modelIds = Object.entries(asRecord(asRecord(models).models))
    .filter(([id, info]) => isUsableModel(id, asRecord(info)))
    .map(([id]) => id);
  const groups = asRecord(summary).groups;
  const windows: SubscriptionQuotaWindow[] = [];
  for (const rawGroup of Array.isArray(groups) ? groups : []) {
    const group = asRecord(rawGroup);
    const groupLabel = typeof group.displayName === "string" ? group.displayName.trim() : "";
    for (const rawBucket of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = asRecord(rawBucket);
      const key = bucketGroupKey(bucket);
      const name = bucketWindowName(bucket);
      if (!key || !name) continue;
      const fraction = typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)
        ? Math.min(1, Math.max(0, bucket.remainingFraction))
        : 0;
      const geminiGroup = key.toLowerCase().includes("gemini");
      windows.push({
        name,
        model_scope: key,
        used_pct: Math.round((1 - fraction) * 10_000) / 100,
        resets_at: parseResetTime(bucket.resetTime, now),
        observed_at: now,
        source: "usage_api",
        ...(groupLabel ? { group_label: groupLabel } : {}),
        shared_models: modelIds.filter((id) => id.toLowerCase().includes("gemini") === geminiGroup),
      });
    }
  }
  return windows;
}

/** Models of a `fetchAvailableModels` payload. `models` is an object keyed by model id. */
export function parseAntigravityModels(raw: unknown): SourceModelReading[] {
  const models: SourceModelReading[] = [];
  for (const [id, info] of Object.entries(asRecord(asRecord(raw).models))) {
    const model = asRecord(info);
    if (!isUsableModel(id, model)) continue;
    const name = typeof model.displayName === "string" ? model.displayName.trim() : "";
    models.push({ id, display_name: name || id });
  }
  return models;
}

export interface AntigravityAdapterOptions {
  /** `onboardUser` calls made before giving up when Google has no project yet. */
  onboardAttempts?: number;
  onboardDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createAntigravityAdapter(
  fetchImpl: SubscriptionFetch = fetch,
  options: AntigravityAdapterOptions = {},
): SubscriptionProviderAdapter {
  const onboardAttempts = options.onboardAttempts ?? 5;
  const onboardDelayMs = options.onboardDelayMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
    const { clientId, clientSecret } = antigravityOAuthCredentials();
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    return await response.json() as Record<string, unknown>;
  }

  async function emailOf(accessToken: string): Promise<string> {
    const response = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    const email = asRecord(await response.json()).email;
    // The e-mail is the account identity in the pool; without it two logins could not be told apart.
    if (typeof email !== "string" || !email.trim()) throw new Error("antigravity userinfo has no email");
    return email.trim();
  }

  /** Project of the account: `loadCodeAssist` first, then `onboardUser` for a new user. */
  async function projectOf(accessToken: string): Promise<string> {
    const headers = cloudCodeHeaders(accessToken);
    const loadResponse = await fetchImpl(cloudCodeUrl("loadCodeAssist"), {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: CLIENT_METADATA }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!loadResponse.ok) throw await readProviderError(loadResponse);
    const loaded = asRecord(await loadResponse.json());
    const known = projectIdOf(loaded.cloudaicompanionProject);
    if (known) return known;

    let tierId = DEFAULT_TIER_ID;
    if (Array.isArray(loaded.allowedTiers)) {
      for (const tier of loaded.allowedTiers) {
        const row = asRecord(tier);
        if (row.isDefault === true && typeof row.id === "string" && row.id.trim()) {
          tierId = row.id.trim();
          break;
        }
      }
    }
    for (let attempt = 1; attempt <= onboardAttempts; attempt++) {
      const response = await fetchImpl(cloudCodeUrl("onboardUser"), {
        method: "POST",
        headers,
        body: JSON.stringify({ tierId, metadata: CLIENT_METADATA }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw await readProviderError(response);
      const onboarded = asRecord(await response.json());
      if (onboarded.done === true) {
        const project = projectIdOf(asRecord(onboarded.response).cloudaicompanionProject);
        if (project) return project;
        break;
      }
      if (attempt < onboardAttempts) await sleep(onboardDelayMs);
    }
    // The proxy cannot send a request for an account without a project, so the login fails here.
    throw new Error("antigravity account has no cloud project");
  }

  async function availableModels(accessToken: string, projectId: string | null | undefined): Promise<unknown> {
    const response = await fetchImpl(cloudCodeUrl("fetchAvailableModels"), {
      method: "POST",
      headers: cloudCodeHeaders(accessToken),
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    return await response.json();
  }

  async function quotaSummary(accessToken: string, projectId: string | null | undefined): Promise<unknown> {
    const response = await fetchImpl(cloudCodeUrl("retrieveUserQuotaSummary"), {
      method: "POST",
      headers: cloudCodeHeaders(accessToken),
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    return await response.json();
  }

  function expiresAtOf(body: Record<string, unknown>, now: number): number | null {
    const expiresIn = Number(body.expires_in);
    return Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
  }

  return {
    provider: "antigravity",
    async exchangeCode(input: SubscriptionCodeExchangeInput): Promise<ExchangedSubscriptionTokens> {
      const body = await postToken({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri || REDIRECT_URI,
      });
      const accessToken = String(body.access_token ?? "");
      if (!accessToken) throw new Error("antigravity token response has no access token");
      const email = await emailOf(accessToken);
      const projectId = await projectOf(accessToken);
      return {
        accessToken,
        refreshToken: String(body.refresh_token ?? ""),
        expiresAt: expiresAtOf(body, Date.now()),
        providerAccountId: email,
        accountLabel: email,
        projectId,
      };
    },
    async refresh(refreshToken: string): Promise<ExchangedSubscriptionTokens> {
      const body = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
      return {
        accessToken: String(body.access_token ?? ""),
        // Google keeps the refresh token on refresh. An empty value tells the caller to keep the stored one.
        refreshToken: String(body.refresh_token ?? ""),
        expiresAt: expiresAtOf(body, Date.now()),
        providerAccountId: "",
        accountLabel: "",
      };
    },
    async fetchUsage(accessToken: string, _providerAccountId: string, usageOptions: FetchUsageOptions = {}) {
      const models = await availableModels(accessToken, usageOptions.projectId);
      // The quota summary has the groups with weekly and 5h limits. When it fails or has no group,
      // the per-model fractions of `fetchAvailableModels` still give a usable reading.
      const summary = await quotaSummary(accessToken, usageOptions.projectId).catch(() => null);
      const grouped = summary ? parseAntigravityQuotaSummary(summary, models) : [];
      return { windows: grouped.length > 0 ? grouped : parseAntigravityUsage(models), resetCredits: null };
    },
    async fetchModels(accessToken: string, _providerAccountId: string, modelOptions: FetchModelsOptions = {}) {
      return parseAntigravityModels(await availableModels(accessToken, modelOptions.projectId));
    },
    async redeemResetCredit() {
      // AntiGravity has no reset credits; the pool never lists one, so this is only a guard.
      throw new Error("antigravity has no reset credits");
    },
  };
}

export const ANTIGRAVITY_OAUTH = {
  /** Read at access time; throws `AntigravityOAuthNotConfiguredError` when the variable is missing. */
  get CLIENT_ID(): string {
    return antigravityOAuthCredentials().clientId;
  },
  REDIRECT_URI,
  SCOPE,
  AUTHORIZE_URL,
  /** Google's installed-app login here sends a client secret instead of a code verifier. */
  PKCE: false,
  extraParams: { access_type: "offline", prompt: "consent" } as Record<string, string>,
};
