import type Database from "better-sqlite3";
import { logger } from "../utils/logger";
import m001 from "./001_deployment_rolled_back_at";
import m002 from "./002_deploy_health_gate";

/** A schema change that runs once, in order, recorded in `PRAGMA user_version`.
 *  `stackport rollback` runs the previous release's code on the migrated database,
 *  so a migration may only add: new tables, new nullable columns or columns with a
 *  DEFAULT, new indexes, backfills (tests/migrations.test.ts enforces this). */
export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** Ordered by id. Append only: never edit or reorder a migration that has shipped. */
export const MIGRATIONS: Migration[] = [m001, m002];

export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Runs every migration newer than the database's version. Each runs in its own
 *  IMMEDIATE transaction that re-reads the version first, so two processes starting
 *  at once (the app and the MCP or recovery CLI) can't both apply the same migration.
 *  A database newer than this code (after `stackport rollback`) is left alone: the
 *  additive-only rule means this code still runs on it. */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const latest = migrations.reduce((max, m) => Math.max(max, m.id), 0);
  const current = schemaVersion(db);
  if (current > latest) {
    logger.warn({ schemaVersion: current, codeVersion: latest }, "database.schema-newer-than-code");
    return;
  }

  for (const migration of migrations) {
    db.transaction(() => {
      if (schemaVersion(db) >= migration.id) return;
      migration.up(db);
      db.pragma(`user_version = ${migration.id}`);
      logger.info({ id: migration.id, name: migration.name }, "database.migration.applied");
    }).immediate();
  }
}
