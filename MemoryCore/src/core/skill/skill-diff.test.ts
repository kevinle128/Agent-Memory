import { describe, expect, it } from "vitest";

import { diffLines } from "./skill-diff.js";

describe("diffLines", () => {
  it("marks added, removed and unchanged lines with counts and line numbers", () => {
    const d = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    expect(d.lines.map((l) => `${l.type[0]}:${l.text}`)).toEqual(["u:a", "r:b", "a:B", "u:c", "u:d", "a:e"]);
    expect({ added: d.added, removed: d.removed, unchanged: d.unchanged }).toEqual({ added: 2, removed: 1, unchanged: 3 });
    expect(d.approximate).toBe(false);
    const removed = d.lines.find((l) => l.type === "removed")!;
    expect(removed.old_line).toBe(2);
    expect(removed.new_line).toBeUndefined();
    const last = d.lines[d.lines.length - 1]!;
    expect(last.new_line).toBe(5);
  });

  it("reports no change for equal text, also with different line endings", () => {
    const d = diffLines("a\r\nb\r\n", "a\nb\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.unchanged).toBe(2);
  });

  it("handles an empty side", () => {
    expect(diffLines("", "x\ny").added).toBe(2);
    expect(diffLines("x\ny", "").removed).toBe(2);
    expect(diffLines("", "").lines).toEqual([]);
  });

  it("finds the common lines between two edited blocks", () => {
    const d = diffLines("1\nA\n2\nB\n3", "1\nX\n2\nY\n3");
    expect(d.unchanged).toBe(3);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  it("falls back to one removed and one added block when the table would be too large", () => {
    const n = 2100;
    const a = Array.from({ length: n }, (_, i) => `old-${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `new-${i}`).join("\n");
    const d = diffLines(a, b);
    expect(d.approximate).toBe(true);
    expect(d.removed).toBe(n);
    expect(d.added).toBe(n);
  });
});
