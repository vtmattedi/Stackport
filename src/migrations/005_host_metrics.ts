import type { Migration } from "./index";

function hasColumn(db: Parameters<Migration["up"]>[0], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Host network throughput and disk use per hardware sample (hardwareSampler.ts).
 *  Nullable: older samples, and hosts whose mounts are missing, have none. */
const migration: Migration = {
  id: 5,
  name: "host_metrics",
  up(db) {
    for (const column of ["net_rx_bps", "net_tx_bps", "disk_used_pct"]) {
      if (!hasColumn(db, "hardware_samples", column)) {
        db.exec(`ALTER TABLE hardware_samples ADD COLUMN ${column} REAL`);
      }
    }
  },
};

export default migration;
