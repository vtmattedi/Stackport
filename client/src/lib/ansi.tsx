import type { ReactNode, CSSProperties } from "react";

// Standard 16-color palette tuned for dark terminals
const PALETTE: string[] = [
  "#1e1e1e", "#f85149", "#3fb950", "#d29922",
  "#4d9ef5", "#bc8cff", "#39c5cf", "#e6edf3",
  "#484f58", "#ff7b72", "#56d364", "#e3b341",
  "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];

function color256(n: number): string {
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const i = n - 16;
    const toChannel = (v: number) => (v ? Math.round(v * 40 + 55) : 0);
    return `rgb(${toChannel(Math.floor(i / 36))},${toChannel(Math.floor(i / 6) % 6)},${toChannel(i % 6)})`;
  }
  const v = Math.round((n - 232) * 10.2 + 8);
  return `rgb(${v},${v},${v})`;
}

interface State {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: string | null;
  bg: string | null;
}

function fresh(): State {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
}

function toStyle(s: State): CSSProperties {
  const style: CSSProperties = {};
  if (s.bold) style.fontWeight = "bold";
  if (s.dim) style.opacity = 0.6;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  return style;
}

function apply(state: State, codes: number[], i: number): { next: State; skip: number } {
  const c = codes[i];
  if (c === 0) return { next: fresh(), skip: 0 };
  if (c === 1) return { next: { ...state, bold: true }, skip: 0 };
  if (c === 2) return { next: { ...state, dim: true }, skip: 0 };
  if (c === 3) return { next: { ...state, italic: true }, skip: 0 };
  if (c === 4) return { next: { ...state, underline: true }, skip: 0 };
  if (c === 22) return { next: { ...state, bold: false, dim: false }, skip: 0 };
  if (c === 23) return { next: { ...state, italic: false }, skip: 0 };
  if (c === 24) return { next: { ...state, underline: false }, skip: 0 };
  if (c === 39) return { next: { ...state, fg: null }, skip: 0 };
  if (c === 49) return { next: { ...state, bg: null }, skip: 0 };
  if (c >= 30 && c <= 37) return { next: { ...state, fg: PALETTE[c - 30] }, skip: 0 };
  if (c >= 40 && c <= 47) return { next: { ...state, bg: PALETTE[c - 40] }, skip: 0 };
  if (c >= 90 && c <= 97) return { next: { ...state, fg: PALETTE[c - 90 + 8] }, skip: 0 };
  if (c >= 100 && c <= 107) return { next: { ...state, bg: PALETTE[c - 100 + 8] }, skip: 0 };
  // 256-color
  if ((c === 38 || c === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
    const color = color256(codes[i + 2]);
    return { next: c === 38 ? { ...state, fg: color } : { ...state, bg: color }, skip: 2 };
  }
  // True color
  if ((c === 38 || c === 48) && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
    const color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
    return { next: c === 38 ? { ...state, fg: color } : { ...state, bg: color }, skip: 4 };
  }
  return { next: state, skip: 0 };
}

/** Convert a string containing ANSI SGR escape sequences to React nodes. */
export function parseAnsi(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let state = fresh();
  let last = 0;
  let key = 0;

  const push = (segment: string) => {
    if (!segment) return;
    const style = toStyle(state);
    nodes.push(
      Object.keys(style).length > 0
        ? <span key={key++} style={style}>{segment}</span>
        : segment
    );
  };

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;

    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    let i = 0;
    while (i < codes.length) {
      const { next, skip } = apply(state, codes, i);
      state = next;
      i += 1 + skip;
    }
  }

  push(text.slice(last));
  return nodes;
}
