import { decryptSecret, encryptSecret } from "../utils/crypto";

/**
 * A project's managed env values and how they are stored (S13). The values are encrypted
 * as one JSON array in `project_env_files.variables_enc`; `variables_json` is '[]' for
 * rows written since, and still holds the plain values on older rows until the migration
 * on Settings > Migrations has encrypted them. Kept apart from projectDeploy so the
 * action-log masker can read them without importing the deploy engine.
 */

export interface EnvVariable {
  key: string;
  value: string;
}

export interface EnvVariablesRow {
  variables_json: string;
  variables_enc?: string | null;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvVariables(input: unknown): EnvVariable[] | null {
  if (!Array.isArray(input)) return null;
  const variables: EnvVariable[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const data = item as Record<string, unknown>;
    if (typeof data["key"] !== "string" || typeof data["value"] !== "string") return null;
    const key = data["key"].trim();
    if (data["value"].includes("\n") || data["value"].includes("\r")) return null;
    if (!ENV_KEY_RE.test(key)) return null;
    variables.push({ key, value: data["value"] });
  }

  const keys = new Set<string>();
  for (const variable of variables) {
    if (keys.has(variable.key)) return null;
    keys.add(variable.key);
  }

  return variables;
}

/** The variables of a stored env file: decrypted, or read as plain JSON for a row that
 *  predates the encryption. A row that can't be read yields none. */
export function readEnvVariables(row: EnvVariablesRow): EnvVariable[] {
  try {
    const parsed = JSON.parse(row.variables_enc ? decryptSecret(row.variables_enc) : row.variables_json) as unknown;
    return parseEnvVariables(parsed) ?? [];
  } catch {
    return [];
  }
}

/** What to store for a set of variables: only the ciphertext holds the values. */
export function sealEnvVariables(variables: EnvVariable[]): { json: string; enc: string } {
  return { json: "[]", enc: encryptSecret(JSON.stringify(variables)) };
}
