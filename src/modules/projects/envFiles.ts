import { createHmac } from "crypto";
import { getDatabase } from "../../config/database";
import { config } from "../../config/env";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { normalizeRelativePath } from "../../shared/safePath";

export interface EnvVariable {
  key: string;
  value: string;
}

export function renderEnvFile(variables: EnvVariable[]): string {
  return variables.map(({ key, value }) => `${key}=${value}`).join("\n") + "\n";
}

/** Match legacy files without retaining deleted credentials or claiming unrelated files. */
export function envFileFingerprint(content: string): string {
  const digest = createHmac("sha256", config.encryptionKey || config.jwtSecret).update(content).digest("hex");
  return `${Buffer.byteLength(content)}:${digest}`;
}

export interface ProjectEnvFile {
  id: number;
  projectId: number;
  relativePath: string;
  variables: EnvVariable[];
  /** The stored values could not be read (their key is not configured, or the data is damaged).
   *  `variables` is empty then, which must not be mistaken for an empty file. */
  unreadable: boolean;
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
 *  predates the encryption (S13). Null when the row cannot be read. */
export function tryReadEnvVariables(row: Pick<ProjectEnvFileRow, "variables_json" | "variables_enc">): EnvVariable[] | null {
  try {
    const parsed = JSON.parse(row.variables_enc ? decryptSecret(row.variables_enc) : row.variables_json) as unknown;
    return parseEnvVariables(parsed);
  } catch {
    return null;
  }
}

/** Like tryReadEnvVariables, for callers that only need what can be read (masking secrets in logs). */
export function readEnvVariables(row: Pick<ProjectEnvFileRow, "variables_json" | "variables_enc">): EnvVariable[] {
  return tryReadEnvVariables(row) ?? [];
}

/** Thrown when a file whose stored values cannot be read is about to be overwritten. */
export class EnvFileUnreadableError extends Error {
  constructor(relativePath: string) {
    super(`The stored values of ${relativePath} cannot be decrypted with the configured keys. Restore the key (ENCRYPTION_KEY, or the old one as ENCRYPTION_KEY_PREVIOUS), or delete the file and create it again.`);
  }
}

/** What to store for a set of variables: only the ciphertext holds the values. */
export function sealEnvVariables(variables: EnvVariable[]): { json: string; enc: string } {
  return { json: "[]", enc: encryptSecret(JSON.stringify(variables)) };
}

function rowToEnvFile(row: ProjectEnvFileRow): ProjectEnvFile {
  const read = tryReadEnvVariables(row);
  const variables = read ?? [];

  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    variables,
    unreadable: read === null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shared deployments read the primary project's current values at deploy time. */
export function projectEnvOwner(projectId: number): number {
  const row = getDatabase().prepare("SELECT branch_parent_id FROM projects WHERE id = ? AND branch_share_env = 1")
    .get(projectId) as { branch_parent_id: number | null } | undefined;
  return row?.branch_parent_id ?? projectId;
}

export class SharedProjectEnvError extends Error {
  constructor() { super("This deployment shares env files. Edit them on the primary project."); }
}

function requireOwnEnvFiles(projectId: number): void {
  if (projectEnvOwner(projectId) !== projectId) throw new SharedProjectEnvError();
}

export function listProjectEnvFiles(projectId: number): ProjectEnvFile[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM project_env_files WHERE project_id = ? ORDER BY relative_path ASC")
    .all(projectEnvOwner(projectId)) as ProjectEnvFileRow[];
  return rows.map(rowToEnvFile);
}

export function createProjectEnvFile(projectId: number, relativePath: string, variables: EnvVariable[]): ProjectEnvFile {
  requireOwnEnvFiles(projectId);
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
  requireOwnEnvFiles(projectId);
  const existing = getDatabase().prepare("SELECT * FROM project_env_files WHERE id = ? AND project_id = ?").get(id, projectId) as ProjectEnvFileRow | undefined;
  // Saving over values we cannot read would destroy them for good.
  if (existing && tryReadEnvVariables(existing) === null) throw new EnvFileUnreadableError(existing.relative_path);
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

/** Applies edits without returning plaintext to the caller or replacing unrelated keys. */
export function patchProjectEnvFile(projectId: number, relativePath: string, changes: EnvVariable[], removeKeys: string[] = []): void {
  const db = getDatabase();
  db.transaction(() => {
    requireOwnEnvFiles(projectId);
    const existing = db.prepare("SELECT * FROM project_env_files WHERE project_id = ? AND relative_path = ?")
      .get(projectId, relativePath) as ProjectEnvFileRow | undefined;
    if (!existing) {
      if (changes.length > 0) createProjectEnvFile(projectId, relativePath, changes);
      return;
    }
    const current = tryReadEnvVariables(existing);
    if (!current) throw new EnvFileUnreadableError(relativePath);
    const values = new Map(current.map(({ key, value }) => [key, value]));
    for (const key of removeKeys) values.delete(key);
    for (const { key, value } of changes) values.set(key, value);
    updateProjectEnvFile(existing.id, projectId, relativePath, [...values].map(([key, value]) => ({ key, value })));
  }).immediate();
}

export function deleteProjectEnvFile(id: number, projectId: number): boolean {
  const db = getDatabase();
  return db.transaction(() => {
    requireOwnEnvFiles(projectId);
    const file = db.prepare("DELETE FROM project_env_files WHERE id = ? AND project_id = ? RETURNING *")
      .get(id, projectId) as ProjectEnvFileRow | undefined;
    if (!file) return false;
    const variables = tryReadEnvVariables(file);
    db.prepare("INSERT OR REPLACE INTO project_env_removals (project_id, relative_path, fingerprint) VALUES (?, ?, ?)")
      .run(projectId, file.relative_path, variables ? envFileFingerprint(renderEnvFile(variables)) : null);
    return true;
  }).immediate();
}

export function pendingEnvRemovals(projectId: number): { id: number; relativePath: string; fingerprint: string | null }[] {
  return getDatabase().prepare("SELECT id, relative_path AS relativePath, fingerprint FROM project_env_removals WHERE project_id = ?")
    .all(projectId) as { id: number; relativePath: string; fingerprint: string | null }[];
}

export function clearEnvRemovals(ids: number[]): void {
  const db = getDatabase();
  const remove = db.prepare("DELETE FROM project_env_removals WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) remove.run(id);
  })();
}
