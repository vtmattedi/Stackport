import crypto from "crypto";
import { getDatabase } from "../../config/database";

/** The stream is off until an admin turns it on (Settings > Live status): an endpoint that is not needed should not exist. */
const ENABLED_KEY = "status_stream_enabled";

export function isStatusStreamEnabled(): boolean {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(ENABLED_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export function setStatusStreamEnabled(enabled: boolean): void {
  getDatabase().prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ENABLED_KEY, enabled ? "1" : "0");
}

const INSTANCE_KEY = "status_stream_instance";

/** A name for this Stackport that an adapter can use in its topics. Random and made once: it says nothing about the machine or its address. */
export function statusStreamInstanceId(): string {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(INSTANCE_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = `sp-${crypto.randomBytes(5).toString("hex")}`;
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)").run(INSTANCE_KEY, id);
  return (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(INSTANCE_KEY) as { value: string }).value;
}
