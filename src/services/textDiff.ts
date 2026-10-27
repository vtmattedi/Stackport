/* eslint-disable security/detect-object-injection -- every index here is a loop counter into a local array */
/** Line diff for previews (deploy and rollback Compose files). Small files only: the
 *  part that differs, after trimming the common start and end, is diffed with a plain
 *  LCS table, and anything bigger than MAX_CELLS is reported as too large. */

export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface DiffHunk {
  /** 1-based first line of the hunk in the old and new text. */
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type LineDiff =
  | { identical: true; tooLarge: false; hunks: [] }
  | { identical: false; tooLarge: true; hunks: [] }
  | { identical: false; tooLarge: false; hunks: DiffHunk[] };

const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface Op { type: DiffLine["type"]; text: string; oldLine: number; newLine: number }

export function diffLines(oldText: string, newText: string, context = 3): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return { identical: true, tooLarge: false, hunks: [] };

  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_CELLS) return { identical: false, tooLarge: true, hunks: [] };

  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ type: "context", text: a[k], oldLine: k + 1, newLine: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ type: "context", text: a[start + i], oldLine: start + i + 1, newLine: start + j + 1 });
      i++; j++;
    } else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      // Removals first on a tie, as diff tools show them.
      ops.push({ type: "remove", text: a[start + i], oldLine: start + i + 1, newLine: start + j + 1 });
      i++;
    } else {
      ops.push({ type: "add", text: b[start + j], oldLine: start + i + 1, newLine: start + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ type: "context", text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 });
  }

  // Group changes into hunks with `context` unchanged lines around them.
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let lastChange = -Infinity;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === "context") continue;
    const from = Math.max(0, k - context);
    if (current && from <= lastChange + context + 1) {
      for (let c = lastChange + 1; c <= k; c++) current.lines.push({ type: ops[c].type, text: ops[c].text });
    } else {
      if (current) {
        for (let c = lastChange + 1; c <= Math.min(ops.length - 1, lastChange + context); c++) {
          current.lines.push({ type: "context", text: ops[c].text });
        }
      }
      current = { oldStart: ops[from].oldLine, newStart: ops[from].newLine, lines: [] };
      hunks.push(current);
      for (let c = from; c <= k; c++) current.lines.push({ type: ops[c].type, text: ops[c].text });
    }
    lastChange = k;
  }
  if (current) {
    for (let c = lastChange + 1; c <= Math.min(ops.length - 1, lastChange + context); c++) {
      current.lines.push({ type: "context", text: ops[c].text });
    }
  }
  return { identical: false, tooLarge: false, hunks };
}
