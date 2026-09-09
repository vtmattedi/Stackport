// js-yaml ships no bundled type declarations and @types/js-yaml isn't
// installed, so `import` would fail to typecheck — require() + a manual
// shape below is the workaround. Must stay a direct `dependencies` entry in
// package.json (not just transitively pulled in by eslint tooling): the
// deploy script prunes devDependencies after build, which previously deleted
// this exact module and crash-looped the service at boot.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require("js-yaml") as {
  load: (input: string) => unknown;
  dump: (input: unknown) => string;
};

export function loadYamlDoc(raw: string): unknown {
  return yaml.load(raw);
}

export function dumpYamlDoc(doc: unknown): string {
  return yaml.dump(doc);
}

// Splits a compose port spec on ":", except inside a "${...}" interpolation
// — compose's own "${VAR:-default}" / "${VAR:?err}" syntax embeds a ":" that
// isn't a host:container separator, so a plain `.split(":")` misparses
// something like "${HOST_PORT:-3010}:8282" into three bogus segments instead
// of two.
export function splitPortSpec(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

