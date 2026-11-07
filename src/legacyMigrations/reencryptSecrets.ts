import { getDatabase } from "../config/database";
import { currentKeyId, decryptSecret, encryptSecret, LEGACY_KEY_ID, secretKeyId } from "../utils/crypto";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S7: re-encrypt every stored secret under the current
 *  ENCRYPTION_KEY, so JWT_SECRET (or an old encryption key) can be rotated or retired.
 *  It is also how a later key rotation is finished, so this one may be worth keeping when
 *  the others are removed. */

export interface SecretColumn { table: string; column: string; idColumn: string; label: string }

/** Every column that holds a ciphertext. A column added elsewhere must be listed here, or
 *  it keeps its old key after a rotation. */
export const SECRET_COLUMNS: SecretColumn[] = [
  { table: "credentials", column: "secret_enc", idColumn: "id", label: "Credentials (GitHub tokens, API keys, webhook secrets)" },
  { table: "projects", column: "hook_secret_enc", idColumn: "id", label: "GitHub webhook secrets" },
];

export interface SecretRow { id: number | string; value: string }

export interface ReencryptDeps {
  columns: SecretColumn[];
  rows(column: SecretColumn): SecretRow[];
  save(column: SecretColumn, id: number | string, value: string): void;
  /** Runs `work` so that a failure part-way leaves nothing half-done. */
  atomic<T>(work: () => T): T;
  currentKeyId: string;
  keyIdOf(stored: string): string;
  decrypt(stored: string): string;
  encrypt(plain: string): string;
}

const keyLabel = (id: string): string => (id === LEGACY_KEY_ID ? "the old key derived from JWT_SECRET" : `key ${id}`);

export function runReencryption(mode: MigrationMode, deps: ReencryptDeps): MigrationReport {
  if (deps.currentKeyId === LEGACY_KEY_ID) {
    return {
      summary: "No ENCRYPTION_KEY is configured, so there is nothing to move to.",
      items: [{ status: "warn", label: "Generate the key first", detail: "Run `sudo stackport repair`: it creates ENCRYPTION_KEY in secrets.env and restarts Stackport. Then run this again." }],
    };
  }

  const items: ReportItem[] = [];
  let moved = 0;
  let failed = 0;
  let current = 0;

  for (const column of deps.columns) {
    const rows = deps.rows(column).filter((row) => row.value);
    const stale: SecretRow[] = [];
    const byKey = new Map<string, number>();
    for (const row of rows) {
      let id: string;
      try { id = deps.keyIdOf(row.value); } catch { items.push({ status: "error", label: `${column.table}.${column.column} #${row.id}`, detail: "Not a recognised ciphertext. Left as it is." }); failed += 1; continue; }
      if (id === deps.currentKeyId) { current += 1; continue; }
      byKey.set(id, (byKey.get(id) ?? 0) + 1);
      stale.push(row);
    }
    if (!stale.length) { items.push({ status: "info", label: column.label, detail: `${rows.length} stored, all under the current key.` }); continue; }

    // Decrypt and re-encrypt everything first, and write only if every row worked.
    const converted: { id: number | string; value: string }[] = [];
    let columnFailed = 0;
    for (const row of stale) {
      try {
        const next = deps.encrypt(deps.decrypt(row.value));
        if (deps.decrypt(next) !== deps.decrypt(row.value)) throw new Error("round trip differs");
        converted.push({ id: row.id, value: next });
      } catch (err) {
        columnFailed += 1;
        items.push({ status: "error", label: `${column.table}.${column.column} #${row.id}`, detail: `Cannot be decrypted with a configured key (${err instanceof Error ? err.message : String(err)}). Add the key it needs as ENCRYPTION_KEY_PREVIOUS.` });
      }
    }
    failed += columnFailed;

    const from = [...byKey].map(([id, count]) => `${count} under ${keyLabel(id)}`).join(", ");
    if (columnFailed) { items.push({ status: "error", label: column.label, detail: `Not changed: ${from}, and ${columnFailed} could not be read.` }); continue; }
    if (mode === "execute") deps.atomic(() => { for (const row of converted) deps.save(column, row.id, row.value); });
    moved += converted.length;
    items.push({ status: "ok", label: column.label, detail: `${mode === "dry-run" ? "Would re-encrypt" : "Re-encrypted"} ${from}.` });
  }

  const verb = mode === "dry-run" ? "would be re-encrypted" : "re-encrypted";
  return { summary: `${moved} secret${moved === 1 ? "" : "s"} ${verb}, ${current} already current, ${failed} could not be changed.`, items };
}

function defaultDeps(): ReencryptDeps {
  const db = getDatabase();
  return {
    columns: SECRET_COLUMNS,
    rows: (column) => db.prepare(`SELECT ${column.idColumn} AS id, ${column.column} AS value FROM ${column.table} WHERE ${column.column} IS NOT NULL`).all() as SecretRow[],
    save: (column, id, value) => { db.prepare(`UPDATE ${column.table} SET ${column.column} = ? WHERE ${column.idColumn} = ?`).run(value, id); },
    atomic: (work) => db.transaction(work).immediate(),
    currentKeyId,
    keyIdOf: secretKeyId,
    decrypt: decryptSecret,
    encrypt: encryptSecret,
  };
}

export const reencryptSecretsMigration: LegacyMigration = {
  id: "reencrypt-secrets",
  title: "Re-encrypt stored secrets with the current key (S7)",
  description:
    "Moves every stored credential and webhook secret to the current ENCRYPTION_KEY, so JWT_SECRET (or an old encryption key) can be rotated or retired. " +
    "The dry run counts what is under which key and changes nothing. A secret that cannot be read stops its column from being changed.",
  executeWarning:
    "Rewrites every stored secret under the current ENCRYPTION_KEY. Back up secrets.env and the database first. " +
    "Afterwards, rolling back to a release older than 1.3 cannot read these secrets.",
  run: async (mode) => runReencryption(mode, defaultDeps()),
};
