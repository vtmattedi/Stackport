import fs from "fs";
import path from "path";
import { config } from "../config/env";
import { getDatabase } from "../config/database";
import { decryptSecret } from "../utils/crypto";

/**
 * Action output on disk: one file per action under <LOG_DIR>/actions, readable only by
 * the app user. Build output often prints environment values, so everything written
 * here is masked first (buildMasker), kept for a limited time (pruneActionLogs), and
 * deleted with its project. Documented in Stackport.md §7 and §10.
 */

/** Log files kept per action key (e.g. a project's build/deploy slot). */
export const LOG_KEEP_PER_KEY = 20;
/** Log files older than this are deleted regardless. */
export const LOG_MAX_AGE_DAYS = 30;
/** Action rows (no output, just what ran and how it ended) are kept this long for Insights. */
export const ROW_MAX_AGE_DAYS = 180;
/** Values shorter than this aren't masked: too likely to match ordinary output. */
const MIN_SECRET_LENGTH = 6;
const MASK = "***";

export function actionLogDir(): string {
  return path.join(config.logDir, "actions");
}

export function actionLogPath(id: string): string {
  return path.join(actionLogDir(), `${id.replace(/[^A-Za-z0-9-]/g, "")}.log`);
}

export function openActionLog(id: string): fs.WriteStream {
  // Paths here are built from LOG_DIR and a sanitized action id (actionLogPath).
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.mkdirSync(actionLogDir(), { recursive: true, mode: 0o700 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return fs.createWriteStream(actionLogPath(id), { flags: "a", mode: 0o600 });
}

export function readActionLog(id: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return fs.readFileSync(actionLogPath(id), "utf8");
  } catch {
    return null;
  }
}

function removeFile(file: string): void {
  // Only ever a path this module recorded in actions.log_path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Secrets Stackport knows about: every stored credential, plus the project's managed
 *  env values when the action belongs to a project. Doesn't catch secrets an app prints
 *  that Stackport doesn't manage. */
export function collectSecrets(projectId?: number): string[] {
  const db = getDatabase();
  const secrets = new Set<string>();
  for (const row of db.prepare("SELECT secret_enc FROM credentials").all() as { secret_enc: string }[]) {
    try { secrets.add(decryptSecret(row.secret_enc)); } catch { /* unreadable: nothing to mask */ }
  }
  if (projectId !== undefined) {
    const rows = db.prepare("SELECT variables_json FROM project_env_files WHERE project_id = ?").all(projectId) as { variables_json: string }[];
    for (const row of rows) {
      try {
        for (const variable of JSON.parse(row.variables_json) as { value?: unknown }[]) {
          if (typeof variable.value === "string") secrets.add(variable.value);
        }
      } catch { /* malformed row */ }
    }
  }
  return [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

export interface Masker {
  mask: (text: string) => string;
  /** The longest secret's length: callers holding back text across chunks need this much. */
  longest: number;
}

export function buildMasker(secrets: string[]): Masker {
  return {
    mask: (text): string => {
      let out = text;
      for (const secret of secrets) {
        if (out.includes(secret)) out = out.split(secret).join(MASK);
      }
      return out;
    },
    longest: secrets.reduce((max, s) => Math.max(max, s.length), 0),
  };
}

/** Deletes log files beyond the per-key count or the age limit, and action rows past
 *  their own age limit. Safe to call often; runs on every action finish and at boot. */
export function pruneActionLogs(now = Date.now()): void {
  const db = getDatabase();
  const logCutoff = new Date(now - LOG_MAX_AGE_DAYS * 86_400_000).toISOString();
  const rowCutoff = new Date(now - ROW_MAX_AGE_DAYS * 86_400_000).toISOString();

  const expired = db.prepare(`
    SELECT id, log_path FROM actions
    WHERE log_path IS NOT NULL AND status <> 'running' AND (
      started_at < ?
      OR id NOT IN (
        SELECT a2.id FROM actions a2
        WHERE a2.key = actions.key AND a2.log_path IS NOT NULL
        ORDER BY a2.started_at DESC LIMIT ?
      )
    )
  `).all(logCutoff, LOG_KEEP_PER_KEY) as { id: string; log_path: string }[];
  const clear = db.prepare("UPDATE actions SET log_path = NULL WHERE id = ?");
  for (const row of expired) {
    removeFile(row.log_path);
    clear.run(row.id);
  }

  db.prepare("DELETE FROM actions WHERE started_at < ? AND status <> 'running'").run(rowCutoff);
}

/** Deletes every log file for a project (Clear logs, Stop & Delete Data, project
 *  deletion). The action rows stay unless the project itself is deleted. */
export function deleteProjectActionLogs(projectId: number): number {
  const db = getDatabase();
  const rows = db.prepare("SELECT id, log_path FROM actions WHERE project_id = ? AND log_path IS NOT NULL AND status <> 'running'")
    .all(projectId) as { id: string; log_path: string }[];
  const clear = db.prepare("UPDATE actions SET log_path = NULL WHERE id = ?");
  for (const row of rows) {
    removeFile(row.log_path);
    clear.run(row.id);
  }
  return rows.length;
}
