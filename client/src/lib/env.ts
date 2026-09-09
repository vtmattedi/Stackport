import type { EnvVariable } from "../api/types";

export const EMPTY_VARIABLE: EnvVariable = { key: "", value: "" };
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeEnvRelativePath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.length > 240) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (!trimmed.endsWith(".env")) return null;
  return trimmed;
}

export function parseEnvText(text: string): EnvVariable[] {
  const values = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = cleaned.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = cleaned.slice(0, equalsIndex).trim();
    if (!ENV_KEY_RE.test(key)) continue;

    let value = cleaned.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return Array.from(values, ([key, value]) => ({ key, value }));
}
