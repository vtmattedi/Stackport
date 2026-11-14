import crypto from "crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../../config/database";

/**
 * This installation's identity (1.4). Exactly two attributes:
 *  - `instance_id`: immutable, globally unique. The only thing authorization, peer pairing and
 *    persisted references may use. Recovering an installation keeps it; cloning mints a new one.
 *  - `instance_name`: a friendly name the operator may change. Never an identity.
 */
export const INSTANCE_ID_KEY = "instance_id";
export const INSTANCE_NAME_KEY = "instance_name";
const DEFAULT_NAME = "Stackport";

export interface InstanceIdentity {
  id: string;
  name: string;
}

export function newInstanceId(): string {
  return crypto.randomUUID();
}

function read(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

/** Creates the identity on first use and returns it; later calls only read. Safe to call at every boot. */
export function ensureInstanceIdentity(db: Database.Database = getDatabase()): InstanceIdentity {
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)").run(INSTANCE_ID_KEY, newInstanceId());
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)").run(INSTANCE_NAME_KEY, DEFAULT_NAME);
  return { id: read(db, INSTANCE_ID_KEY) as string, name: read(db, INSTANCE_NAME_KEY) as string };
}

export function getInstanceIdentity(db: Database.Database = getDatabase()): InstanceIdentity {
  return ensureInstanceIdentity(db);
}

export function setInstanceName(name: string, db: Database.Database = getDatabase()): InstanceIdentity {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error("An instance name is 1 to 80 characters.");
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(INSTANCE_NAME_KEY, trimmed);
  return ensureInstanceIdentity(db);
}
