import type { Migration } from "./index";

/** Columns the move target gained after migration 23 had shipped. A database that already ran 23 lacks them; one created fresh has them from 23. */
const migration: Migration = {
  id: 24,
  name: "transfer_columns",
  up(db) {
    const have = new Set((db.prepare("PRAGMA table_info(project_transfers_in)").all() as { name: string }[]).map((c) => c.name));
    for (const column of ["health_endpoint", "auth_json"]) {
      if (!have.has(column)) db.exec(`ALTER TABLE project_transfers_in ADD COLUMN ${column} TEXT`);
    }
  },
};

export default migration;
