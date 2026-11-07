import * as path from "path";
import { getDatabase } from "../../../config/database";
import { currentVolumeRoots, managedVolumesRoot, type VolumeRoots } from "../../deployments/compose/managedVolumes";
import { expectedComposeProjectName } from "../../deployments/operations";
import { dockerRunner, probeDirectory, type DockerRunner } from "./docker";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S2 cleanup: delete the original mount directories that the
 *  volume migration copied, once the project runs from its managed copy. Each deletion
 *  is guarded: the managed copy must hold files and cover everything in the original (nothing
 *  missing, nothing newer there), no container, running or stopped, may mount the original, and the
 *  path must be a real directory below the filesystem root. */

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

/** Run with the original as $1 and the managed copy as $2 (both mounted read-only) just before the original
 *  is deleted. After the migration the project writes to the managed copy, so the copy may legitimately differ:
 *  what must not happen is the original holding something the copy lacks or something newer than the copy's
 *  version (a project that was reverted to its old release and wrote there). Any such file fails the check, and
 *  a name it cannot parse fails it too, so it errs toward keeping the original. */
export const ORIGINAL_NOT_NEWER_SCRIPT = `cd "$1" || exit 2
find . \\( -type f -o -type l \\) | while IFS= read -r f; do
  if [ -L "$f" ]; then
    [ "$(readlink "$f")" = "$(readlink "$2/$f")" ] || { echo "link differs in the managed copy: $f"; exit 1; }
  elif [ ! -f "$2/$f" ]; then
    echo "missing from the managed copy: $f"; exit 1
  elif ! cmp -s "$f" "$2/$f" && [ ! "$2/$f" -nt "$f" ]; then
    echo "newer in the original than in the managed copy: $f"; exit 1
  fi
done`;

/** Whether any mount source in `lines` is the path or something inside it. A mount of a parent (Stackport's own
 *  data directory) does not count: it does not use the directory as a mount of its own. */
export function mountsPathOrInside(lines: string[], sourcePath: string): boolean {
  return lines.map((line) => line.trim()).some((line) => line === sourcePath || line.startsWith(`${sourcePath}/`));
}

const mount = (source: string, target: string, readOnly: boolean): string[] =>
  ["--mount", `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`];

export async function runCleanup(mode: MigrationMode, deps: CleanupDeps): Promise<MigrationReport> {
  const items: ReportItem[] = [];
  const sources = deps.listSources();
  if (!sources.length) return { summary: "Nothing to clean up: no migrated mount directories are waiting to be removed.", items };

  const image = await deps.helperImage();
  let removed = 0;
  let skipped = 0;
  for (const source of sources) {
    const label = `${source.projectName} (#${source.projectId}): ${source.name}`;
    const skip = (detail: string): void => { skipped += 1; items.push({ status: "error", label, detail }); };

    if (!isSafeToRemove(source.sourcePath)) { skip(`Refusing to remove "${source.sourcePath}": not a plain absolute path.`); continue; }

    const original = await probeDirectory(deps.docker, image, source.sourcePath);
    if (original.state === "error") { skip(`Could not look at ${source.sourcePath}: ${original.detail}. Not removed.`); continue; }
    if (original.state === "missing") {
      if (mode === "execute") deps.markRemoved(source.id);
      items.push({ status: "info", label, detail: `${source.sourcePath} is already gone.` });
      continue;
    }

    const managedHost = path.posix.join(managedVolumesRoot(deps.roots, source.projectId).host, source.name);
    const managed = await probeDirectory(deps.docker, image, managedHost);
    if (managed.state === "error") { skip(`Could not look at the managed copy at ${managedHost}: ${managed.detail}. Not removed.`); continue; }
    if (managed.state === "missing" || managed.entries === 0) { skip(`The managed copy at ${managedHost} is empty or missing, so the original is the only data. Not removed.`); continue; }

    // Every container on the host, stopped ones included: anything that could be started again with the original
    // mounted, whichever project it belongs to. A failed listing is not an empty one.
    const containers = await deps.docker(["ps", "-aq"]);
    if (containers.code !== 0) { skip(`Could not list the containers: ${containers.stderr.trim().split("\n")[0] || `exit code ${containers.code}`}. Not removed.`); continue; }
    const ids = containers.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      const inspected = await deps.docker(["inspect", "--format", "{{range .Mounts}}{{println .Source}}{{end}}", ...ids]);
      if (inspected.code !== 0 || mountsPathOrInside(inspected.stdout.split("\n"), source.sourcePath)) {
        skip(`A container (running or stopped) still mounts ${source.sourcePath} or something inside it, or its mounts could not be read. Redeploy the project so it uses the managed copy, remove stopped containers that use it, then run this again.`);
        continue;
      }
    }

    // The data may have changed since it was copied: do not delete an original that has something the copy lacks.
    const coverage = await deps.docker(["run", "--rm", ...mount(source.sourcePath, "/from", true), ...mount(managedHost, "/to", true), "--entrypoint", "sh", image, "-c", ORIGINAL_NOT_NEWER_SCRIPT, "sh", "/from", "/to"]);
    if (coverage.code !== 0) {
      const first = (coverage.stdout.trim() || coverage.stderr.trim()).split("\n")[0]?.slice(0, 300);
      skip(`The original is not covered by the managed copy (${first || `exit code ${coverage.code}`}). Not removed. If that file is no longer needed, delete it from the original yourself and run this again.`);
      continue;
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
    "Deletes the directories the mount migration copied from. It only touches a directory when the managed copy holds files and covers " +
    "everything in the original (a file missing from the copy, or newer in the original, stops it) and no container, running or stopped, still mounts " +
    "the original, so redeploy each migrated project first. Run the dry run to see the list.",
  executeWarning:
    "Permanently deletes the original directories listed in the dry run. The managed copies are the only data left afterwards. " +
    "This cannot be undone.",
  destructive: true,
  run: (mode) => runCleanup(mode, defaultDeps()),
};
