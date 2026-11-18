import { describe, expect, it } from "vitest";
import { isMemoryModeOff, resolveMemoryGates } from "../memory-mode.js";

describe("isMemoryModeOff", () => {
  it("accepts off in any case and with spaces", () => {
    expect(isMemoryModeOff("off")).toBe(true);
    expect(isMemoryModeOff(" OFF ")).toBe(true);
  });

  it("keeps memory on for a missing or other value", () => {
    expect(isMemoryModeOff(undefined)).toBe(false);
    expect(isMemoryModeOff(null)).toBe(false);
    expect(isMemoryModeOff("")).toBe(false);
    expect(isMemoryModeOff("on")).toBe(false);
    expect(isMemoryModeOff("false")).toBe(false);
  });
});

describe("resolveMemoryGates", () => {
  it("opens every gate for a main turn without the header", () => {
    expect(resolveMemoryGates({ requestKind: "main", legacyProxy: false, memoryModeHeader: undefined }))
      .toEqual({ memoryTurn: true, skipSessionInit: false, skipInjection: false });
  });

  it("closes every gate for a main turn with x-memory-mode: off", () => {
    expect(resolveMemoryGates({ requestKind: "main", legacyProxy: false, memoryModeHeader: "off" }))
      .toEqual({ memoryTurn: false, skipSessionInit: true, skipInjection: true });
  });

  it("closes the same gates on the legacy route as with the header", () => {
    expect(resolveMemoryGates({ requestKind: "main", legacyProxy: true, memoryModeHeader: undefined }))
      .toEqual(resolveMemoryGates({ requestKind: "main", legacyProxy: false, memoryModeHeader: "off" }));
  });

  it("keeps the sidequery and fork rules without the header", () => {
    expect(resolveMemoryGates({ requestKind: "sidequery", legacyProxy: false, memoryModeHeader: undefined }))
      .toEqual({ memoryTurn: false, skipSessionInit: true, skipInjection: true });
    expect(resolveMemoryGates({ requestKind: "fork", legacyProxy: false, memoryModeHeader: undefined }))
      .toEqual({ memoryTurn: false, skipSessionInit: false, skipInjection: false });
  });

  it("closes the fork gates with the header", () => {
    expect(resolveMemoryGates({ requestKind: "fork", legacyProxy: false, memoryModeHeader: "off" }))
      .toEqual({ memoryTurn: false, skipSessionInit: true, skipInjection: true });
  });
});
