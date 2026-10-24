/**
 * Line diff of two texts, by longest common subsequence.
 *
 * No diff library is in the dependencies and a SKILL.md is small, so a plain
 * LCS table is enough. Common head and tail lines are cut first, which keeps
 * the table small for the usual case of a few edited lines.
 */

export type DiffLineType = "added" | "removed" | "unchanged";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the old text. Absent for an added line. */
  old_line?: number;
  /** 1-based line number in the new text. Absent for a removed line. */
  new_line?: number;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
  /**
   * True when the changed middle was too large for an exact table and was
   * reported as one removed block followed by one added block.
   */
  approximate: boolean;
}

/** Largest LCS table (old lines x new lines, after trimming) that is built. */
const MAX_TABLE_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  // A final newline does not start a new line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const lines: DiffLine[] = [];
  for (let i = 0; i < head; i++) {
    lines.push({ type: "unchanged", text: a[i]!, old_line: i + 1, new_line: i + 1 });
  }

  let approximate = false;
  const oldBase = head;
  const newBase = head;

  if (midA.length * midB.length > MAX_TABLE_CELLS) {
    approximate = true;
    midA.forEach((t, i) => lines.push({ type: "removed", text: t, old_line: oldBase + i + 1 }));
    midB.forEach((t, j) => lines.push({ type: "added", text: t, new_line: newBase + j + 1 }));
  } else {
    // table[i][j] = LCS length of midA[i..] and midB[j..]
    const w = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * w + j] = midA[i] === midB[j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        lines.push({ type: "unchanged", text: midA[i]!, old_line: oldBase + i + 1, new_line: newBase + j + 1 });
        i++; j++;
      } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
        lines.push({ type: "removed", text: midA[i]!, old_line: oldBase + i + 1 });
        i++;
      } else {
        lines.push({ type: "added", text: midB[j]!, new_line: newBase + j + 1 });
        j++;
      }
    }
    for (; i < midA.length; i++) lines.push({ type: "removed", text: midA[i]!, old_line: oldBase + i + 1 });
    for (; j < midB.length; j++) lines.push({ type: "added", text: midB[j]!, new_line: newBase + j + 1 });
  }

  for (let k = 0; k < tail; k++) {
    const oi = a.length - tail + k;
    const ni = b.length - tail + k;
    lines.push({ type: "unchanged", text: a[oi]!, old_line: oi + 1, new_line: ni + 1 });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.type === "added") added++;
    else if (l.type === "removed") removed++;
    else unchanged++;
  }
  return { lines, added, removed, unchanged, approximate };
}
