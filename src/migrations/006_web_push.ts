import type { Migration } from "./index";

const migration: Migration = {
  id: 6,
  name: "web_push",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        subject TEXT NOT NULL DEFAULT '',
        events_json TEXT NOT NULL DEFAULT '{}',
        vapid_public_key TEXT NOT NULL,
        vapid_private_key_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        label TEXT NOT NULL DEFAULT 'Browser',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_success_at TEXT,
        last_failure_at TEXT
      );
    `);
    const columns = db.prepare("PRAGMA table_info(notification_logs)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "channel")) {
      db.exec("ALTER TABLE notification_logs ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");
    }
  },
};

export default migration;
