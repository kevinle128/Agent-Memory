import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_IDENTITY, withClaudeCodeIdentity } from "../claude-identity.js";

const id = { type: "text", text: CLAUDE_CODE_IDENTITY };

describe("withClaudeCodeIdentity", () => {
  it("adds the identity when there is no system prompt", () => {
    expect(withClaudeCodeIdentity({ model: "m" }).system).toEqual([id]);
    expect(withClaudeCodeIdentity({ system: "" }).system).toEqual([id]);
  });

  it("puts the identity before a string system prompt", () => {
    expect(withClaudeCodeIdentity({ system: "Be brief." }).system).toEqual([id, { type: "text", text: "Be brief." }]);
  });

  it("puts the identity before a block list and keeps the blocks", () => {
    const blocks = [{ type: "text", text: "Hermes rules", cache_control: { type: "ephemeral" } }];
    expect(withClaudeCodeIdentity({ system: blocks }).system).toEqual([id, ...blocks]);
  });

  it("keeps a request that already starts with the identity unchanged", () => {
    const asString = { system: `${CLAUDE_CODE_IDENTITY}\nmore` };
    expect(withClaudeCodeIdentity(asString)).toBe(asString);
    const asBlocks = { system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: "x" }] };
    expect(withClaudeCodeIdentity(asBlocks)).toBe(asBlocks);
  });

  it("does not change the other fields", () => {
    const out = withClaudeCodeIdentity({ model: "m", messages: [{ role: "user", content: "hi" }], system: "s" });
    expect(out.model).toBe("m");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
