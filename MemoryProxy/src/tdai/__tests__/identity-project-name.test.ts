import { describe, expect, it } from "vitest";

import { getProjectName } from "../identity.js";

describe("getProjectName", () => {
  it("returns a trimmed name", () => {
    expect(getProjectName({ projectName: "  vtc/3q-chess/3q-game-api " })).toBe("vtc/3q-chess/3q-game-api");
  });

  it("accepts a name of exactly 200 characters and rejects one of 201", () => {
    expect(getProjectName({ projectName: "a".repeat(200) })).toHaveLength(200);
    expect(getProjectName({ projectName: "a".repeat(201) })).toBeUndefined();
  });

  it.each([undefined, null, 42, "", "   ", "a\nb", "a\u0000b", "a\tb", "a\u007fb", "<script>", "a>b"])(
    "rejects %j",
    (value) => {
      expect(getProjectName({ projectName: value })).toBeUndefined();
    },
  );

  it("returns undefined without custom data", () => {
    expect(getProjectName(undefined)).toBeUndefined();
  });
});
