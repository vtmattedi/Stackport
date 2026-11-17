import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import m024 from "../src/migrations/024_transfer_columns";

test("migration 24 adds the columns a database that already ran 23 lacks, and does nothing when they exist", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE project_transfers_in (id TEXT PRIMARY KEY, name TEXT)");
  m024.up(db);
  m024.up(db);
  const columns = (db.prepare("PRAGMA table_info(project_transfers_in)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("health_endpoint") && columns.includes("auth_json"));
  db.close();
});
