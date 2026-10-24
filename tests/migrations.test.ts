import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";

function schema(): string[] {
  return (getDatabase()
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as { type: string; name: string; sql: string }[])
    .map((row) => `${row.type} ${row.name}: ${row.sql}`);
}

test("initializing an already-migrated database changes nothing", () => {
  initializeDatabase();
  const first = schema();
  closeDatabase();
  initializeDatabase();
  assert.deepEqual(schema(), first);
  closeDatabase();
});

function projectColumns(): string[] {
  return (getDatabase().prepare("PRAGMA table_info(projects)").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[])
    .map((c) => `${c.name} ${c.type} ${c.notnull} ${String(c.dflt_value)}`)
    .sort();
}

test("a database missing later columns is brought up to date", () => {
  const db = initializeDatabase();
  const fresh = projectColumns();
  // Columns added by recent releases: an install from before them must gain them on boot.
  db.exec("DROP INDEX IF EXISTS idx_projects_hook_public_id");
  for (const column of ["group_name", "deploy_trigger", "pending_deploy_sha", "hook_public_id"]) {
    db.exec(`ALTER TABLE projects DROP COLUMN ${column}`);
  }
  closeDatabase();
  initializeDatabase();
  assert.deepEqual(projectColumns(), fresh);
  closeDatabase();
});

// Rollback puts the previous release's code back on the migrated database, so a
// migration that removes or renames something old code reads would strand the
// server. New migrations may only add. The two drops below predate this rule and
// only removed columns that no released code reads any more.
const GRANDFATHERED = [
  "ALTER TABLE vps_providers DROP COLUMN api_key_enc",
  "ALTER TABLE notification_config DROP COLUMN api_key_enc",
];

test("migrations only add to the schema", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/config/database.ts"), "utf8");
  const offending = source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /\b(DROP\s+(TABLE|COLUMN)|RENAME\s+(TO|COLUMN))\b/i.test(line))
    .filter(({ line }) => !GRANDFATHERED.some((allowed) => line.includes(allowed)));
  assert.deepEqual(offending, [], "A migration drops or renames schema. Old code must still run on the new database for rollback to work.");

  const notNullWithoutDefault = source
    .split("\n")
    .filter((line) => /ADD COLUMN/i.test(line) && /NOT NULL/i.test(line) && !/DEFAULT/i.test(line));
  assert.deepEqual(notNullWithoutDefault, [], "ADD COLUMN ... NOT NULL needs a DEFAULT, or old code inserting rows will fail.");
});
