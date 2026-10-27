/**
 * The variables a Compose file interpolates (`${VAR}`, `$VAR` and the default/required
 * forms). Compose fills these from the project directory's `.env` and from the
 * environment `docker compose` runs with, never from `env_file:` entries, which only
 * go into the containers. Walks the parsed document's strings, so comments are ignored.
 */

export interface ComposeVariableRef {
  name: string;
  /** `${VAR:-x}` / `${VAR-x}`: Compose has a fallback when it's unset. */
  hasDefault: boolean;
  /** `${VAR:?msg}` / `${VAR?msg}`: Compose refuses to run when it's unset. */
  required: boolean;
}

// `$$` is an escaped dollar; the alternation consumes it so it never starts a reference.
// The braced form captures its whole body; parseBraced splits the name from the operator.
const REF_RE = /\$\$|\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g;
const NAME_RE = /^[A-Za-z_]\w*/;

function parseBraced(body: string): { name: string; op: string } | null {
  const name = NAME_RE.exec(body)?.[0];
  if (!name) return null;
  const rest = body.slice(name.length);
  const op = rest.startsWith(":") ? rest.slice(0, 2) : rest.slice(0, 1);
  return { name, op };
}

function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStrings(value, out);
    }
  }
}

export function extractComposeVariables(doc: unknown): ComposeVariableRef[] {
  const strings: string[] = [];
  collectStrings(doc, strings);
  const refs = new Map<string, ComposeVariableRef>();
  for (const text of strings) {
    for (const match of text.matchAll(REF_RE)) {
      const braced = match[1] !== undefined ? parseBraced(match[1]) : null;
      const name = braced?.name ?? match[2];
      if (!name) continue; // "$$", or "${...}" that isn't a variable name
      const op = braced?.op ?? "";
      const existing = refs.get(name) ?? { name, hasDefault: false, required: false };
      // A reference with a default somewhere still counts as unset elsewhere; only
      // mark it as defaulted when every use has one.
      refs.set(name, {
        name,
        hasDefault: (refs.has(name) ? existing.hasDefault : true) && (op === "-" || op === ":-"),
        required: existing.required || op === "?" || op === ":?",
      });
    }
  }
  return [...refs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Keys defined in a dotenv-style text (KEY=value, `export KEY=value`, comments ignored). */
export function dotenvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (NAME_RE.exec(key)?.[0] === key) keys.add(key);
  }
  return keys;
}
