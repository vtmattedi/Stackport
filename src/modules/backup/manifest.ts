import { MIGRATIONS } from "../../migrations";
import type { BackupLevel } from "./classification";

export const MANIFEST_FORMAT = 1;
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.id), 0);

export interface ManifestEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface ManifestComponent {
  id: string;
  included: boolean;
  description: string;
  /** Why an excluded component is not here. Omissions are always stated, never silent. */
  reason?: string;
}

export interface BackupManifest {
  format: number;
  createdAt: string;
  stackportVersion: string;
  /** The database's `user_version` when it was exported. */
  schemaVersion: number;
  level: BackupLevel;
  /** The installation this archive came from. */
  instance: { id: string; name: string };
  /** The source host's values, shown at restore but never applied. */
  host: Record<string, string>;
  components: ManifestComponent[];
  entries: ManifestEntry[];
  /** Rows kept per table. */
  tables: Record<string, number>;
  unclassifiedTables: string[];
  droppedMetaKeys: string[];
  skippedSpecialFiles: number;
}

export function parseManifest(raw: Buffer): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("The archive's manifest is not valid JSON.");
  }
  const m = value as Partial<BackupManifest> | null;
  if (!m || typeof m !== "object" || m.format !== MANIFEST_FORMAT) {
    throw new Error(`Unsupported manifest format ${String((m as { format?: unknown } | null)?.format)}; this Stackport reads format ${MANIFEST_FORMAT}.`);
  }
  if (m.level !== 1 && m.level !== 2) throw new Error(`The archive declares an unknown level (${String(m.level)}).`);
  if (!Number.isInteger(m.schemaVersion) || !Array.isArray(m.entries) || !m.instance?.id || !Array.isArray(m.components)) {
    throw new Error("The archive's manifest is incomplete.");
  }
  for (const entry of m.entries) {
    if (typeof entry?.name !== "string" || !Number.isInteger(entry.size) || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
      throw new Error("The archive's manifest has a malformed entry.");
    }
  }
  return m as BackupManifest;
}
