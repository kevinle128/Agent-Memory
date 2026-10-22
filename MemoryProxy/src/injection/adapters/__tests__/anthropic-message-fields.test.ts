import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";

describe("AnthropicAdapter message-level fields", () => {
  it("keeps output_config on a directive-only system message", () => {
    const adapter = new AnthropicAdapter();
    const body = {
      model: "claude-opus-5-5",
      system: "top-level system",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "assistant", content: "ok" },
      ],
    };

    const out = adapter.serialize(adapter.parse(body, {} as never));

    expect(out.system).toBe("top-level system");
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });
});
