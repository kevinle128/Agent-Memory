import { describe, expect, it } from "vitest";

import {
  buildInstallCommand,
  installNotDoneText,
  isGateEnabled,
  looksRejected,
  planGateStep,
  resolveOrigin,
  SESSION_ID_RE,
  type GateHistory,
} from "../hook-gate-core.js";

const history = (overrides: Partial<GateHistory> = {}): GateHistory => ({
  attempts: 0, resultIsLast: false, lastResult: null, lastAnswered: false, ...overrides,
});

describe("planGateStep", () => {
  it("asks for the first install call", () => {
    expect(planGateStep(history())).toBe("call");
  });

  it("checks a result that just came back, even after the second attempt", () => {
    expect(planGateStep(history({ attempts: 1, resultIsLast: true, lastResult: "ok" }))).toBe("check-result");
    expect(planGateStep(history({ attempts: 2, resultIsLast: true, lastResult: "ok" }))).toBe("check-result");
  });

  it("calls again after one answered failure", () => {
    expect(planGateStep(history({ attempts: 1, lastResult: "exit 1", lastAnswered: true }))).toBe("call");
  });

  it("stops after two failed attempts", () => {
    expect(planGateStep(history({ attempts: 2, lastResult: "exit 1", lastAnswered: true }))).toBe("retry-limit");
  });

  it("tells the user once about a refused call that no text answered", () => {
    expect(planGateStep(history({ attempts: 1, lastResult: "aborted by user" }))).toBe("rejected");
    expect(planGateStep(history({ attempts: 1, lastResult: "aborted by user", lastAnswered: true }))).toBe("call");
  });

  it("stops without a text answer when the second attempt was refused", () => {
    expect(planGateStep(history({ attempts: 2, lastResult: "aborted by user" }))).toBe("retry-limit");
  });
});

describe("looksRejected", () => {
  it("knows the refusal wordings of the clients", () => {
    expect(looksRejected("Wall time: 6.0 seconds\naborted by user")).toBe(true);
    expect(looksRejected("approval policy is Never; reject command")).toBe(true);
    expect(looksRejected("unsupported call: exec_command")).toBe(true);
    expect(looksRejected("Process exited with code 0\nOutput:\nAgent-Memory hooks installed")).toBe(false);
    expect(looksRejected("")).toBe(false);
  });
});

describe("install command", () => {
  const SID = "01a16eab-0b03-708d-8d4f-4bba152cad8e";

  it("names the client", () => {
    expect(buildInstallCommand("http://p", SID)).toBe(`curl -fsSL http://p/setup/hooks.sh | bash -s -- --client claude-code --session ${SID}`);
    expect(buildInstallCommand("http://p", SID, "codex")).toContain("--client codex --session");
    expect(buildInstallCommand("http://p", SID, "omp")).toContain("--client omp --session");
  });

  it("refuses an unsafe session id or a missing origin", () => {
    expect(buildInstallCommand("http://p", "id; rm -rf ~", "codex")).toBeNull();
    expect(buildInstallCommand(null, SID, "omp")).toBeNull();
  });

  it("accepts the UUIDv7 ids of Codex and omp", () => {
    expect(SESSION_ID_RE.test(SID)).toBe(true);
    expect(SESSION_ID_RE.test("01a16d8e-4b6a-7e21-9f3c-0123456789ab")).toBe(true);
  });
});

describe("gate switch and origin", () => {
  it("is on unless hookGate.enabled is false", () => {
    expect(isGateEnabled({})).toBe(true);
    expect(isGateEnabled({ hookGate: { enabled: true } })).toBe(true);
    expect(isGateEnabled({ hookGate: { enabled: false } })).toBe(false);
  });

  it("prefers a valid configured origin", () => {
    expect(resolveOrigin({ hookGate: { enabled: true, publicOrigin: "https://p.example.com/" } }, "http://x")).toBe("https://p.example.com");
    expect(resolveOrigin({ hookGate: { enabled: true, publicOrigin: "javascript:x" } }, "http://x")).toBe("http://x");
  });
});

describe("installNotDoneText", () => {
  it("holds the manual command in both wordings", () => {
    for (const rejected of [true, false]) {
      const text = installNotDoneText("curl X", rejected);
      expect(text).toContain("    curl X");
      expect(text).toContain("send your prompt again");
    }
  });
});
