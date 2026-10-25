export interface SubscriptionPoolConfig {
  enabled: boolean;
  checkIntervalMin: number;
  /** `client_version` sent when the ChatGPT model list is read. */
  codexClientVersion: string;
}

export const DEFAULT_CODEX_CLIENT_VERSION = "0.164.0";

export function readSubscriptionPoolConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionPoolConfig {
  const enabled = env.SUBSCRIPTION_POOL_ENABLED !== "false";
  const parsed = Number(env.SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN ?? 30);
  const checkIntervalMin = Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
  const codexClientVersion = env.SUBSCRIPTION_POOL_CODEX_CLIENT_VERSION?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
  return { enabled, checkIntervalMin, codexClientVersion };
}
