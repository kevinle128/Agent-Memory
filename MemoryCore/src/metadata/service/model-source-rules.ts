import type {
  GroupType,
  InstanceUpstreamConfigEntity,
  InstanceUpstreamSourceFields,
  SupportedAgent,
  UpstreamMode,
} from "../types.js";

/** Error raised by the source rules. The service maps it onto its own error type. */
export class SourceRuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SourceRuleError";
  }
}

export const SOURCE_FORMATS = ["anthropic-messages", "openai-chat", "openai-responses"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** Source fields a caller may send on create and update. Fetch results are written by Core only. */
export const SOURCE_INPUT_KEYS = [
  "source_name",
  "source_provider",
  "source_formats",
  "source_agents",
  "source_enabled",
  "source_models",
] as const;

export type SourceInput = Partial<Pick<InstanceUpstreamSourceFields, (typeof SOURCE_INPUT_KEYS)[number]>>;

export const SOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SOURCE_PROVIDER_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DEFAULT_API_FORMATS: SourceFormat[] = ["openai-chat"];

export type PoolProvider = "claude" | "codex";

/** What a subscription pool fixes for its source, by provider. */
const POOL_SOURCE: Record<PoolProvider, { name: string; provider: string; format: SourceFormat }> = {
  claude: { name: "sub-claude", provider: "claude", format: "anthropic-messages" },
  codex: { name: "sub-openai", provider: "openai", format: "openai-responses" },
};

/** Source fields a subscription pool group gets: a fixed name, provider and format. */
export function poolSourceFields(provider: PoolProvider): Pick<InstanceUpstreamSourceFields, "source_name" | "source_provider" | "source_formats"> {
  const fixed = POOL_SOURCE[provider];
  return { source_name: fixed.name, source_provider: fixed.provider, source_formats: [fixed.format] };
}

export function poolProviderOfName(name: string): PoolProvider | null {
  for (const provider of ["claude", "codex"] as const) {
    if (name === `${provider} subscription pool`) return provider;
  }
  return null;
}

export function sentSourceKeys(input: SourceInput): string[] {
  return SOURCE_INPUT_KEYS.filter((key) => input[key] !== undefined);
}

export interface SourceWriteContext {
  groupType: GroupType;
  /** Mode after the write. */
  mode: UpstreamMode;
  /** The stored group on update, undefined on create. */
  existing?: InstanceUpstreamConfigEntity;
  /** Group name after the write. */
  name: string;
  /** Agents after the write. */
  agents: string[];
  /** model_id after the write. */
  modelId: string;
  input: SourceInput;
  supportedAgents: SupportedAgent[];
  /** source_name values held by the other groups. */
  takenNames: ReadonlySet<string>;
}

export interface SourceWriteResult {
  /** Fields to store. Empty when the write leaves the group's source state alone. */
  patch: SourceInput;
  /** True when the group is a model source after the write. A source may have no agent yet. */
  isSource: boolean;
}

/**
 * Check the source part of a group write and compute the source fields to store.
 * Pure: the caller supplies everything it knows about the group and its neighbours.
 */
export function resolveSourceWrite(ctx: SourceWriteContext): SourceWriteResult {
  const { input, existing } = ctx;
  const sent = sentSourceKeys(input);
  const wasSource = Boolean(existing?.source_name);

  if (ctx.groupType !== "custom" || ctx.mode === "custom_passthrough") {
    if (sent.length > 0 || wasSource) {
      throw new SourceRuleError(
        "SOURCE_MODE_NOT_ALLOWED",
        ctx.mode === "custom_passthrough"
          ? "a custom_passthrough group forwards the client credential and cannot be a model source"
          : `a ${ctx.groupType} group cannot be a model source`,
        { rejected_fields: sent },
      );
    }
    return { patch: {}, isSource: false };
  }

  if (wasSource && existing && existing.mode !== ctx.mode) {
    throw new SourceRuleError("SOURCE_MODE_NOT_ALLOWED", "the mode of a model source cannot be changed");
  }

  const isPool = ctx.mode === "subscription_pool";
  if (isPool && input.source_enabled !== undefined) {
    throw new SourceRuleError(
      "SOURCE_ENABLED_NOT_ALLOWED",
      "a subscription pool source follows the pool switch and has no source_enabled",
    );
  }

  const storedName = existing?.source_name ?? "";
  const sentName = input.source_name;
  if (sentName !== undefined && storedName && sentName !== storedName) {
    throw new SourceRuleError("SOURCE_NAME_IMMUTABLE", "source name cannot be changed after it is saved");
  }
  const name = storedName || sentName || "";
  if (!name) {
    if (sent.some((key) => key !== "source_name")) {
      throw new SourceRuleError("INVALID_SOURCE_NAME", "source_name is required before other source fields");
    }
    return { patch: {}, isSource: false };
  }

  const patch: SourceInput = {};
  if (!storedName) {
    if (!SOURCE_NAME_RE.test(name)) {
      throw new SourceRuleError(
        "INVALID_SOURCE_NAME",
        "source_name must be 1-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit",
      );
    }
    if (ctx.takenNames.has(name)) {
      throw new SourceRuleError("SOURCE_NAME_TAKEN", `source name is already used by another group: ${name}`);
    }
    patch.source_name = name;
  }

  const sourceAgents = resolveSourceAgents(ctx);
  if (sourceAgents) patch.source_agents = sourceAgents;

  if (isPool) {
    const provider = poolProviderOfName(ctx.name);
    if (!provider) {
      throw new SourceRuleError("SOURCE_MODE_NOT_ALLOWED", "only the claude and codex subscription pools can be model sources");
    }
    patch.source_provider = POOL_SOURCE[provider].provider;
    patch.source_formats = [POOL_SOURCE[provider].format];
  } else {
    if (input.source_provider !== undefined) {
      if (input.source_provider !== "" && !SOURCE_PROVIDER_RE.test(input.source_provider)) {
        throw new SourceRuleError("INVALID_SOURCE_PROVIDER", "source_provider must be a lowercase slug");
      }
      patch.source_provider = input.source_provider;
    }
    const formats = input.source_formats ?? (storedName ? undefined : DEFAULT_API_FORMATS);
    if (formats) {
      patch.source_formats = resolveApiFormats(formats);
    }
  }

  if (input.source_enabled !== undefined) patch.source_enabled = input.source_enabled;
  if (input.source_models !== undefined) patch.source_models = input.source_models;

  if (ctx.agents.length === 0 && ctx.modelId.trim()) {
    throw new SourceRuleError("MODEL_ID_UNUSED", "model_id is not used by a group that only serves as a model source");
  }

  return { patch, isSource: true };
}

function resolveSourceAgents(ctx: SourceWriteContext): string[] | undefined {
  const sent = ctx.input.source_agents;
  if (sent === undefined) return undefined;
  const unique = Array.from(new Set(sent));
  if (ctx.supportedAgents.length > 0) {
    const multi = new Set(ctx.supportedAgents.filter((a) => a.multi_source === true).map((a) => a.agent_source));
    const rejected = unique.filter((agent) => !multi.has(agent));
    if (rejected.length > 0) {
      throw new SourceRuleError(
        "INVALID_SOURCE_AGENTS",
        `source_agents may only name multi-source agents; rejected: ${rejected.join(",")}`,
        { rejected_agents: rejected },
      );
    }
  }
  return unique;
}

function resolveApiFormats(formats: string[]): string[] {
  const unique = Array.from(new Set(formats));
  const allowed = new Set<string>(SOURCE_FORMATS);
  const rejected = unique.filter((f) => !allowed.has(f));
  if (unique.length === 0 || rejected.length > 0) {
    throw new SourceRuleError(
      "INVALID_SOURCE_FORMATS",
      `source_formats must be a non-empty subset of ${SOURCE_FORMATS.join(", ")}`,
      { rejected_formats: rejected },
    );
  }
  return unique;
}

const SUGGESTED_NAME_MAX = 40;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Propose a source name: `sub-claude`, `sub-openai` or `api-<provider>`, with `-2`, `-3`, ...
 * appended while the name is taken.
 */
export function suggestSourceName(kind: "subscription" | "api", provider: string, taken: ReadonlySet<string>): string {
  let base: string;
  if (kind === "subscription") {
    const slug = slugify(provider);
    if (slug === "claude") base = "sub-claude";
    else if (slug === "openai" || slug === "codex") base = "sub-openai";
    else throw new SourceRuleError("INVALID_SOURCE_PROVIDER", "a subscription source provider is claude or openai");
  } else {
    const slug = slugify(provider);
    base = slug ? `api-${slug}` : "api";
  }
  const fit = (name: string, suffix: string): string =>
    `${name.slice(0, SUGGESTED_NAME_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
  let candidate = fit(base, "");
  for (let n = 2; taken.has(candidate); n++) candidate = fit(base, `-${n}`);
  return candidate;
}
