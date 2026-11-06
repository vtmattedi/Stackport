import * as path from "path";
import { getDatabase } from "../config/database";
import { currentVolumeRoots, managedVolumesRoot, type VolumeRoots } from "../services/managedVolumes";
import { expectedComposeProjectName } from "../services/projectDeploy";
import { dockerRunner, type DockerRunner } from "./docker";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S2 cleanup: delete the original mount directories that the
 *  volume migration copied, once the project runs from its managed copy. Each deletion
 *  is guarded: the managed copy must hold files, no running container may still mount
 *  the original, and the path must be a real directory below the filesystem root. */

export interface RecordedSource {
  id: number;
  projectId: number;
  projectName: string;
  composeProject: string;
  sourcePath: string;
  name: string;
}

export interface CleanupDeps {
  docker: DockerRunner;
  roots: VolumeRoots;
  listSources(): RecordedSource[];
  helperImage(): Promise<string>;
  markRemoved(id: number): void;
}

/** A path that is safe to hand to `rm -rf`: absolute, normalised, not near the root. */
export function isSafeToRemove(sourcePath: string): boolean {
  if (!path.posix.isAbsolute(sourcePath) || path.posix.normalize(sourcePath) !== sourcePath) return false;
  const parts = sourcePath.split("/").filter(Boolean);
  return parts.length >= 3 && !parts.includes("..") && !parts.includes(".");
}

const mount = (source: string, target: string, readOnly: boolean): string[] =>
  ["--mount", `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`];

const PROBE = "du -sk /from | cut -f1; ls -A /from | wc -l";

export async function runCleanup(mode: MigrationMode, deps: CleanupDeps): Promise<MigrationReport> {
  const items: ReportItem[] = [];
  const sources = deps.listSources();
  if (!sources.length) return { summary: "Nothing to clean up: no migrated mount directories are waiting to be removed.", items };

  const image = await deps.helperImage();
  const probe = async (hostPath: string): Promise<{ exists: boolean; kb: number; entries: number }> => {
    const result = await deps.docker(["run", "--rm", ...mount(hostPath, "/from", true), "--entrypoint", "sh", image, "-c", PROBE]);
    if (result.code !== 0) return { exists: false, kb: 0, entries: 0 };
    const [kb, entries] = result.stdout.trim().split(/\s+/).map(Number);
    return { exists: true, kb: kb || 0, entries: entries || 0 };
  };

  let removed = 0;
  let skipped = 0;
  for (const source of sources) {
    const label = `${source.projectName} (#${source.projectId}): ${source.name}`;
    const skip = (detail: string): void => { skipped += 1; items.push({ status: "error", label, detail }); };

    if (!isSafeToRemove(source.sourcePath)) { skip(`Refusing to remove "${source.sourcePath}": not a plain absolute path.`); continue; }

    const original = await probe(source.sourcePath);
    if (!original.exists) {
      if (mode === "execute") deps.markRemoved(source.id);
      items.push({ status: "info", label, detail: `${source.sourcePath} is already gone.` });
      continue;
    }

    const managedHost = path.posix.join(managedVolumesRoot(deps.roots, source.projectId).host, source.name);
    const managed = await probe(managedHost);
    if (!managed.exists || managed.entries === 0) { skip(`The managed copy at ${managedHost} is empty or missing, so the original is the only data. Not removed.`); continue; }

    const containers = await deps.docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${source.composeProject}`]);
    const ids = containers.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      const inspected = await deps.docker(["inspect", "--format", "{{range .Mounts}}{{println .Source}}{{end}}", ...ids]);
      if (inspected.code !== 0 || inspected.stdout.split("\n").some((line) => line.trim() === source.sourcePath)) {
        skip(`A running container still mounts ${source.sourcePath} (or its mounts could not be read). Redeploy the project so it uses the managed copy, then run this again.`);
        continue;
      }
    }

    if (mode === "dry-run") {
      items.push({ status: "ok", label, detail: `Would remove ${source.sourcePath} (${original.kb} KB). The managed copy has ${managed.entries} top-level entries.` });
      removed += 1;
      continue;
    }
    const parent = path.posix.dirname(source.sourcePath);
    const result = await deps.docker([
      "run", "--rm", ...mount(parent, "/p", false), "-e", `TARGET=${path.posix.basename(source.sourcePath)}`,
      "--entrypoint", "sh", image, "-c", 'rm -rf "/p/$TARGET"',
    ]);
    if (result.code !== 0) { skip(`Removal failed: ${result.stderr.trim().slice(0, 500) || `exit code ${result.code}`}`); continue; }
    deps.markRemoved(source.id);
    items.push({ status: "ok", label, detail: `Removed ${source.sourcePath}.` });
    removed += 1;
  }

  const verb = mode === "dry-run" ? "would be removed" : "removed";
  return { summary: `${removed} director${removed === 1 ? "y" : "ies"} ${verb}, ${skipped} skipped.`, items };
}

function defaultDeps(): CleanupDeps {
  const docker = dockerRunner();
  return {
    docker,
    roots: currentVolumeRoots(),
    listSources: () => (getDatabase().prepare(
      `SELECT s.id, s.project_id AS projectId, p.name AS projectName, s.source_path AS sourcePath, s.managed_name AS name
         FROM legacy_mount_sources s JOIN projects p ON p.id = s.project_id
        WHERE s.removed_at IS NULL ORDER BY s.id`,
    ).all() as Omit<RecordedSource, "composeProject">[])
      .map((row) => ({ ...row, composeProject: expectedComposeProjectName({ id: row.projectId, name: row.projectName }) })),
    helperImage: async () => {
      const result = await docker(["inspect", "--format", "{{.Config.Image}}", "stackport"]);
      return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "alpine:3";
    },
    markRemoved: (id) => { getDatabase().prepare("UPDATE legacy_mount_sources SET removed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id); },
  };
}

export const cleanupMountsMigration: LegacyMigration = {
  id: "cleanup-old-mounts",
  title: "Remove the original mount directories (S2 cleanup)",
  description:
    "Deletes the directories the mount migration copied from. It only touches a directory when the managed copy holds files " +
    "and no running container still mounts the original, so redeploy each migrated project first. Run the dry run to see the list.",
  executeWarning:
    "Permanently deletes the original directories listed in the dry run. The managed copies are the only data left afterwards. " +
    "This cannot be undone.",
  destructive: true,
  run: (mode) => runCleanup(mode, defaultDeps()),
};
