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
    expect(subscriptionPoolEnableSchema.safeParse({ provider }).success).toBe(true);
    expect(subscriptionPoolDisableSchema.safeParse({ provider }).success).toBe(true);
    expect(subscriptionPoolStatusSchema.safeParse({ provider }).success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    expect(subscriptionPoolProviderSchema.safeParse("gemini").success).toBe(false);
  });
});
