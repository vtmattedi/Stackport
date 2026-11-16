import type Database from "better-sqlite3";
import { logger } from "../shared/logger";
import m001 from "./001_deployment_rolled_back_at";
import m002 from "./002_deploy_health_gate";
import m003 from "./003_api_tokens";
import m004 from "./004_actions";
import m005 from "./005_host_metrics";
import m006 from "./006_web_push";
import m007 from "./007_push_outbox";
import m008 from "./008_compose_policy_enforced";
import m009 from "./009_volumes_managed";
import m010 from "./010_legacy_mount_sources";
import m011 from "./011_hardened_defaults";
import m012 from "./012_api_token_project_group";
import m013 from "./013_env_values_encrypted";
import m014 from "./014_network_groups";
import m015 from "./015_ingress_isolated";
import m016 from "./016_github_app";
import m017 from "./017_github_app_state_meta";
import m018 from "./018_managed_domains";
import m019 from "./019_hostname_dns";
import m020 from "./020_github_deploy_on";
import m021 from "./021_peers";

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
export const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021];

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
