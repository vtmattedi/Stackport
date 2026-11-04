import type { Migration } from "./index";

const migration: Migration = {
  id: 7,
  name: "push_outbox",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
        project_id INTEGER,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        cancelled_at_ms INTEGER,
        cancel_reason TEXT,
        CHECK (expires_at_ms > created_at_ms)
      );
      CREATE TABLE IF NOT EXISTS push_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
        subscription_id INTEGER REFERENCES push_subscriptions(id) ON DELETE SET NULL,
        browser_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending', 'leased', 'retry', 'accepted', 'expired', 'cancelled', 'permanent_failure')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_until_ms INTEGER,
        accepted_at_ms INTEGER,
        finished_at_ms INTEGER,
        last_http_status INTEGER,
        last_error_code TEXT,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(event_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS idx_push_deliveries_due ON push_deliveries(status, next_attempt_at_ms);
      CREATE INDEX IF NOT EXISTS idx_push_deliveries_lease ON push_deliveries(status, lease_until_ms);
      CREATE INDEX IF NOT EXISTS idx_push_events_created ON push_events(created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_push_events_expiry ON push_events(expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_push_deliveries_event ON push_deliveries(event_id);
      CREATE INDEX IF NOT EXISTS idx_push_deliveries_subscription ON push_deliveries(subscription_id);
    `);
    const columns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "health_incident_key")) db.exec("ALTER TABLE projects ADD COLUMN health_incident_key TEXT");
    if (!columns.some((c) => c.name === "health_probe_started_at_ms")) db.exec("ALTER TABLE projects ADD COLUMN health_probe_started_at_ms INTEGER NOT NULL DEFAULT 0");
  },
};
export default migration;
