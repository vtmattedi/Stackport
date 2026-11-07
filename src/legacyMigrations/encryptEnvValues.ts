import { getDatabase } from "../config/database";
import { readEnvVariables } from "../services/projectEnvValues";
import { encryptSecret } from "../utils/crypto";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S13: encrypt the env values stored as plain JSON before they
 *  were encrypted on write. Once this has run, nothing writes plain values any more. */

export interface PlainEnvRow { id: number; projectName: string; relativePath: string; variablesJson: string }

export interface EncryptEnvDeps {
  rows(): PlainEnvRow[];
  save(id: number, encrypted: string): void;
  atomic<T>(work: () => T): T;
  encrypt(plain: string): string;
}

export function runEnvEncryption(mode: MigrationMode, deps: EncryptEnvDeps): MigrationReport {
  const rows = deps.rows();
  if (!rows.length) return { summary: "Nothing to encrypt: every env file is already stored encrypted.", items: [] };

  const items: ReportItem[] = [];
  const ready: { id: number; encrypted: string }[] = [];
  let failed = 0;
  for (const row of rows) {
    const label = `${row.projectName}: ${row.relativePath}`;
    const variables = readEnvVariables({ variables_json: row.variablesJson });
    // readEnvVariables yields nothing for JSON it cannot use, and a file may genuinely be empty.
    let usable = variables.length > 0;
    if (!usable) { try { usable = (JSON.parse(row.variablesJson) as unknown[]).length === 0; } catch { usable = false; } }
    if (!usable) { failed += 1; items.push({ status: "error", label, detail: "The stored values are not valid. Left as they are." }); continue; }
    ready.push({ id: row.id, encrypted: deps.encrypt(row.variablesJson) });
    items.push({ status: "ok", label, detail: `${variables.length} variable${variables.length === 1 ? "" : "s"} ${mode === "dry-run" ? "would be" : "were"} encrypted.` });
  }
  if (mode === "execute") deps.atomic(() => { for (const row of ready) deps.save(row.id, row.encrypted); });

  const verb = mode === "dry-run" ? "would be encrypted" : "encrypted";
  return { summary: `${ready.length} env file${ready.length === 1 ? "" : "s"} ${verb}, ${failed} skipped.`, items };
}

function defaultDeps(): EncryptEnvDeps {
  const db = getDatabase();
  return {
    rows: () => db.prepare(
      `SELECT e.id, p.name AS projectName, e.relative_path AS relativePath, e.variables_json AS variablesJson
         FROM project_env_files e JOIN projects p ON p.id = e.project_id
        WHERE e.variables_enc IS NULL AND e.variables_json <> '[]' ORDER BY e.id`,
    ).all() as PlainEnvRow[],
    save: (id, encrypted) => { db.prepare("UPDATE project_env_files SET variables_enc = ?, variables_json = '[]' WHERE id = ?").run(encrypted, id); },
    atomic: (work) => db.transaction(work).immediate(),
    encrypt: encryptSecret,
  };
}

export const encryptEnvValuesMigration: LegacyMigration = {
  id: "encrypt-env-values",
  title: "Encrypt managed env values (S13)",
  description:
    "Env values that were saved before 1.3 are still stored as plain text in the database. This encrypts them with the current key. " +
    "New and edited env files are already encrypted when they are saved.",
  executeWarning:
    "Replaces the plain env values in the database with ciphertext. Back up the database and secrets.env first. " +
    "Afterwards, rolling back to a release older than 1.3 deploys these projects with empty env files.",
  run: async (mode) => runEnvEncryption(mode, defaultDeps()),
};
