import { afterEach, describe, expect, it } from "vitest";
import { expandEnvVars } from "../config.js";

describe("expandEnvVars", () => {
  afterEach(() => { delete process.env.AM_TEST_VAR; });

  it("replaces ${VAR}", () => {
    process.env.AM_TEST_VAR = "x";
    expect(expandEnvVars({ a: "${AM_TEST_VAR}" })).toEqual({ a: "x" });
  });

  it("replaces ${VAR:-default} with the variable when it is set", () => {
    process.env.AM_TEST_VAR = "https://lf.example";
    expect(expandEnvVars({ host: "${AM_TEST_VAR:-}" })).toEqual({ host: "https://lf.example" });
  });

  it("uses the default when the variable is missing or empty", () => {
    expect(expandEnvVars(["${AM_TEST_VAR:-fallback}", "${AM_TEST_VAR:-}", "${AM_TEST_VAR}"])).toEqual(["fallback", "", ""]);
    process.env.AM_TEST_VAR = "";
    expect(expandEnvVars("${AM_TEST_VAR:-fallback}")).toBe("fallback");
  });

  it("keeps other strings and types unchanged", () => {
    expect(expandEnvVars({ a: "pre-${AM_TEST_VAR}", b: 3, c: true, d: null })).toEqual({ a: "pre-${AM_TEST_VAR}", b: 3, c: true, d: null });
  });
});
