/**
 * Architecture rule: skill content changes only through `SkillChangeService`.
 *
 * `appendVersion` is the store write. It may be called only by
 * `SkillVersioning` (which adds the file storage steps) and by the store
 * backends themselves. `createNewSkill` / `appendNextVersion` of
 * `SkillVersioning` may be called only by the service. So every write path
 * (extractor tools, gateway handlers, session import, rollback, approval)
 * has to pass the service, where the scope rule and the approval policy live.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Source files that are production code: not tests, not the shared test harness and contract suites. */
function productionFiles(): string[] {
  return walk(SRC).filter((f) => !/\.test\.ts$/.test(f) && !f.includes(`${join("skill", "__contract__")}`) && !f.includes(`${join("store", "__contract__")}`));
}

/** Lines that call `<receiver>.name(`, with comments cut off. */
function callSites(file: string, method: string): string[] {
  const re = new RegExp(`\\.${method}\\s*\\(`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .filter((line) => re.test(line));
}

function filesCalling(method: string): string[] {
  return productionFiles()
    .filter((f) => callSites(f, method).length > 0)
    .map((f) => relative(SRC, f).split("\\").join("/"))
    .sort();
}

describe("skill write paths", () => {
  it("calls store.appendVersion only from SkillVersioning", () => {
    expect(filesCalling("appendVersion")).toEqual(["core/skill/skill-versioning.ts"]);
  });

  it("calls SkillVersioning.createNewSkill / appendNextVersion only from SkillChangeService", () => {
    expect(filesCalling("createNewSkill")).toEqual(["core/skill/skill-change-service.ts"]);
    expect(filesCalling("appendNextVersion")).toEqual(["core/skill/skill-change-service.ts"]);
  });

  it("the scan sees the call sites it is meant to guard", () => {
    // Guards the test itself: a wrong path or regex would make the checks above pass on an empty scan.
    expect(productionFiles().length).toBeGreaterThan(100);
    expect(callSites(join(SRC, "core/skill/skill-versioning.ts"), "appendVersion").length).toBe(2);
  });
});
