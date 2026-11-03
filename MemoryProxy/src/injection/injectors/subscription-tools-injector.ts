/**
 * SubscriptionToolsInjector — inject a static `<subscription_tools>` text block that teaches the
 * LLM to curl `<proxy>/subscription-bridge/v1/*` to show or change the Subscription Account that
 * serves the current conversation.
 *
 * Who gets the block: only a System Admin whose client (Claude Code or Codex) is served by a
 * Subscription Pool. Other users cannot use the bridge, and a client without a pool has no
 * account to show or change, so the block would only cost prompt tokens and invite failed calls.
 *
 * The permission comes from `canUseAccountSwitch` and the pool from `resolveSwitchPool`. The
 * bridge calls the same two functions on every request, so hiding the block is not the security
 * boundary: a direct curl from a user without the block is refused with the same answer.
 *
 * The text is static for a session (it depends only on the proxy base URL, the session, the
 * instance and the client), so execute and prewarm render the same bytes and the prompt cache
 * stays stable. The proxy adds the identity from the session; no key or token is in the text.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { canUseAccountSwitch, resolveSwitchPool } from "../../subscription-pool/account-switch-access.js";

export interface SubscriptionToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every curl recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /** Proxy config parts that the access checks read; a full `ProxyConfig` fits. */
  config: Parameters<typeof canUseAccountSwitch>[0];
}

/**
 * Render the entire `<subscription_tools>` block as a single text string. Pure function for ease
 * of testing.
 */
export function renderSubscriptionToolsBlock(
  proxyBaseUrl: string,
  sessionId: string,
  spaceId: string,
  agentSource: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/subscription-bridge/v1`;
  const headers = `-H 'content-type: application/json' -H 'x-tdai-service-id: ${spaceId}' -H 'x-conversation-id: ${sessionId}'`;

  const lines: string[] = [
    "<subscription_tools>",
    "These are the Account Switch tools for System Admins. They show or change the Subscription Account that serves this conversation.",
    "Call them with Bash + curl to the proxy. The proxy adds your identity. Never ask for, use or print any key or token.",
    "Call them only when the user asks which account serves this conversation, or explicitly asks to switch the account (also through the shortcuts `/sub` and `/sub <email>` in Claude Code, or `$sub` and `$sub <email>` in Codex).",
    "NEVER switch the account on your own.",
  ];
  if (agentSource === "codex") {
    lines.push("The Codex sandbox has no network by default: ask the user for approval to run the curl command outside the sandbox.");
  }
  lines.push(
    "",
    "  <tool name=\"subscription_current\">",
    `    curl: ${bridge}/current`,
    "    body: {}",
    "    use:  Show the account that serves this conversation. data.state is bound, unbound (no account yet) or own_login (the client uses its own login, not the pool). data.provider and data.account (email, display_name) identify the account.",
    "  </tool>",
    "",
    "  <tool name=\"subscription_switch\">",
    `    curl: ${bridge}/switch`,
    "    body: {\"email\": \"<email>\"}",
    "    use:  Switch this conversation to the pool account with this email. Only this conversation changes. data.previous and data.current show the change.",
    "  </tool>",
    "",
    "## Commands",
    "```bash",
    `curl -sSk -X POST ${bridge}/current ${headers} -d '{}'`,
    `curl -sSk -X POST ${bridge}/switch ${headers} -d '{"email": "<email>"}'`,
    "```",
    "",
    "## Result",
    "- The reply is JSON. `code == 0` is success.",
    "- Otherwise tell the user the `message` (the `reason` field gives the cause, for example account_exhausted with data.resets_at). Do not retry on HTTP 4xx.",
    "- Answer in the user's language. Show the user the email and the provider of the account.",
    "</subscription_tools>",
  );
  return lines.join("\n");
}

export class SubscriptionToolsInjector implements InjectionHook {
  id = "subscription-tools-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "before" };
  /** Right after TdaiMemoryToolsInjector (MEMORY + 5). */
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 6;
  description = "Inject <subscription_tools> curl recipes block for System Admins on pool-served sessions";
  /**
   * Static tool instructions are session-stable; render once at session_init. An empty result is
   * not cached by the pipeline, so a failed role lookup is asked again on the next turn.
   */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private cfg: SubscriptionToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const identity = getTdaiIdentity(custom);
    const session = custom?.session as Record<string, unknown> | undefined;
    const userId = identity?.userId ?? ctx.metadata.userId;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : ctx.metadata.spaceId;
    return this.renderBlocks(identity?.sessionId, spaceId, userId, ctx.metadata.agentSource);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    return this.renderBlocks(
      input.sessionInfo.session_id,
      input.spaceId ?? input.sessionInfo.space_id,
      input.userId,
      input.agentSource,
    );
  }

  private async renderBlocks(
    sessionId: string | undefined,
    spaceId: string | undefined,
    userId: string | undefined,
    agentSource: string,
  ): Promise<ContextBlock[]> {
    if (!sessionId || !spaceId || !userId) return [];
    if (!(await this.shouldOffer(spaceId, userId, agentSource))) return [];
    return [{
      type: "text",
      content: renderSubscriptionToolsBlock(this.cfg.proxyBaseUrl, sessionId, spaceId, agentSource),
      metadata: {
        source: this.id,
        sessionId,
        cacheKey: "subscription-tools-injector:tools",
      },
    }];
  }

  private async shouldOffer(spaceId: string, userId: string, agentSource: string): Promise<boolean> {
    if (!(await canUseAccountSwitch(this.cfg.config, { spaceId, userId }))) return false;
    return (await resolveSwitchPool(this.cfg.config, spaceId, agentSource)) !== null;
  }
}
