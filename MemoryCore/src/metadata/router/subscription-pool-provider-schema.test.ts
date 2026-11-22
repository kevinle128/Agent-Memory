import { describe, expect, it } from "vitest";
import {
  subscriptionPoolDisableSchema,
  subscriptionPoolEnableSchema,
  subscriptionPoolProviderSchema,
  subscriptionPoolStatusSchema,
} from "./v3-meta-schemas.js";

describe("subscription pool provider schema", () => {
  it.each(["claude", "codex", "antigravity"])("accepts %s", (provider) => {
    expect(subscriptionPoolProviderSchema.safeParse(provider).success).toBe(true);
    expect(subscriptionPoolEnableSchema.safeParse({ team_id: "team-1", provider }).success).toBe(true);
    expect(subscriptionPoolDisableSchema.safeParse({ team_id: "team-1", provider }).success).toBe(true);
    expect(subscriptionPoolStatusSchema.safeParse({ team_id: "team-1", provider }).success).toBe(true);
  });

  it("needs a team on every pool call", () => {
    expect(subscriptionPoolEnableSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(subscriptionPoolDisableSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(subscriptionPoolStatusSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(subscriptionPoolStatusSchema.safeParse({ team_id: "", provider: "claude" }).success).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(subscriptionPoolProviderSchema.safeParse("gemini").success).toBe(false);
  });
});
