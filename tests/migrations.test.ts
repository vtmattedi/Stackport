import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { MIGRATIONS, runMigrations, schemaVersion, type Migration } from "../src/migrations";

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
  const migrationsDir = path.join(__dirname, "../src/migrations");
  const source = [
    path.join(__dirname, "../src/config/database.ts"),
    ...fs.readdirSync(migrationsDir).map((file) => path.join(migrationsDir, file)),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
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

test("a fresh database ends at the latest migration", () => {
  const db = initializeDatabase();
  assert.equal(schemaVersion(db), Math.max(...MIGRATIONS.map((m) => m.id)));
  closeDatabase();
});

test("migration ids are unique and increasing", () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

function recording(log: string[]): Migration[] {
  return [1, 2, 3].map((id) => ({
    id,
    name: `m${id}`,
    up: (db: Database.Database) => {
      log.push(`m${id}`);
      db.exec(`CREATE TABLE t${id} (x INTEGER)`);
    },
  }));
}

test("migrations run once each, in order", () => {
  const db = new Database(":memory:");
  const log: string[] = [];
  runMigrations(db, recording(log));
  runMigrations(db, recording(log));
  assert.deepEqual(log, ["m1", "m2", "m3"]);
  assert.equal(schemaVersion(db), 3);
  db.close();
});

test("only migrations newer than the database run", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t1 (x INTEGER)");
  db.pragma("user_version = 1");
  const log: string[] = [];
  runMigrations(db, recording(log));
  assert.deepEqual(log, ["m2", "m3"]);
  db.close();
});

test("a failing migration rolls back its changes and its version, and stops", () => {
  const db = new Database(":memory:");
  const log: string[] = [];
  const migrations = recording(log);
  migrations[1] = {
    id: 2,
    name: "broken",
    up: (d) => {
      d.exec("CREATE TABLE half_done (x INTEGER)");
      throw new Error("boom");
    },
  };
  assert.throws(() => runMigrations(db, migrations), /boom/);
  assert.equal(schemaVersion(db), 1);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.equal(tables.includes("half_done"), false);
  assert.deepEqual(log, ["m1"], "nothing after the failure runs");
  db.close();
});

test("a database newer than the code is left alone (after stackport rollback)", () => {
  const db = new Database(":memory:");
  db.pragma("user_version = 99");
  const log: string[] = [];
  assert.doesNotThrow(() => runMigrations(db, recording(log)));
  assert.deepEqual(log, []);
  assert.equal(schemaVersion(db), 99);
  db.close();
});

test("a second process sees migrations the first applied and skips them", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stackport-mig-")), "db.sqlite");
  const first = new Database(file);
  const second = new Database(file);
  const log: string[] = [];
  runMigrations(first, recording(log));
  runMigrations(second, recording(log));
  assert.deepEqual(log, ["m1", "m2", "m3"]);
  first.close();
  second.close();
});

test("an install from before the migration runner is brought to the latest version", () => {
  const db = initializeDatabase();
  // What a released install looks like: baseline schema, no migrations recorded.
  db.exec("ALTER TABLE project_deployments DROP COLUMN rolled_back_at");
  db.pragma("user_version = 0");
  closeDatabase();

  const upgraded = initializeDatabase();
  const cols = (upgraded.prepare("PRAGMA table_info(project_deployments)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("rolled_back_at"));
  assert.equal(schemaVersion(upgraded), Math.max(...MIGRATIONS.map((m) => m.id)));
  closeDatabase();
});
