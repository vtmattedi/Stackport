import { getDatabase } from "../../config/database";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { normalizeRelativePath } from "../../shared/safePath";

export interface EnvVariable {
  key: string;
  value: string;
}

export interface ProjectEnvFile {
  id: number;
  projectId: number;
  relativePath: string;
  variables: EnvVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEnvFileRow {
  id: number;
  project_id: number;
  relative_path: string;
  /** Plain values, from before they were encrypted. New rows hold '[]' here. */
  variables_json: string;
  /** The values as an encrypted JSON array (S13). */
  variables_enc?: string | null;
  created_at: string;
  updated_at: string;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeEnvRelativePath(input: string): string | null {
  const normalized = normalizeRelativePath(input);
  if (!normalized || !normalized.endsWith(".env")) return null;
  return normalized;
}

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
 *  predates the encryption (S13). A row that can't be read yields none. */
export function readEnvVariables(row: Pick<ProjectEnvFileRow, "variables_json" | "variables_enc">): EnvVariable[] {
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

function rowToEnvFile(row: ProjectEnvFileRow): ProjectEnvFile {
  const variables = readEnvVariables(row);

  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    variables,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjectEnvFiles(projectId: number): ProjectEnvFile[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE project_id = ? ORDER BY relative_path ASC")
    .all(projectId) as ProjectEnvFileRow[];
  return rows.map(rowToEnvFile);
}

export function createProjectEnvFile(projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile {
  const now = new Date().toISOString();
  const sealed = sealEnvVariables(variables);
  const result = getDatabase()
    .prepare(
      "INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(projectId, relativePath, sealed.json, sealed.enc, now, now);
  const row = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE id = ?")
    .get(result.lastInsertRowid) as ProjectEnvFileRow;
  return rowToEnvFile(row);
}

export function updateProjectEnvFile(id: number, projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile | null {
  const now = new Date().toISOString();
  const sealed = sealEnvVariables(variables);
  const result = getDatabase()
    .prepare("UPDATE project_env_files SET relative_path = ?, variables_json = ?, variables_enc = ?, updated_at = ? WHERE id = ? AND project_id = ?")
    .run(relativePath, sealed.json, sealed.enc, now, id, projectId);
  if (result.changes === 0) return null;
  const row = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE id = ? AND project_id = ?")
    .get(id, projectId) as ProjectEnvFileRow;
  return rowToEnvFile(row);
}

export function deleteProjectEnvFile(id: number, projectId: number): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM project_env_files WHERE id = ? AND project_id = ?")
    .run(id, projectId);
  return result.changes > 0;
}
