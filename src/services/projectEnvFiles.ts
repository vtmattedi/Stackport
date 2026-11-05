import { getDatabase } from "../config/database";
import { normalizeRelativePath } from "../utils/safePath";

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
  variables_json: string;
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

function rowToEnvFile(row: ProjectEnvFileRow): ProjectEnvFile {
  let variables: EnvVariable[] = [];
  try {
    const parsed = JSON.parse(row.variables_json) as unknown;
    variables = parseEnvVariables(parsed) ?? [];
  } catch {
    variables = [];
  }

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
  const result = getDatabase()
    .prepare(
      "INSERT INTO project_env_files (project_id, relative_path, variables_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(projectId, relativePath, JSON.stringify(variables), now, now);
  const row = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE id = ?")
    .get(result.lastInsertRowid) as ProjectEnvFileRow;
  return rowToEnvFile(row);
}

export function updateProjectEnvFile(id: number, projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile | null {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare("UPDATE project_env_files SET relative_path = ?, variables_json = ?, updated_at = ? WHERE id = ? AND project_id = ?")
    .run(relativePath, JSON.stringify(variables), now, id, projectId);
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
