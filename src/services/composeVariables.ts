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
const REF_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

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
      const name = match[1] ?? match[3];
      if (!name) continue; // "$$"
      const op = match[2] ?? "";
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
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}
