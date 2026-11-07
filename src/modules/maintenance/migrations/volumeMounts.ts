import { statSync } from "fs";
import * as fs from "fs/promises";
import { getDatabase } from "../../../config/database";
import { currentVolumeRoots, planManagedVolumes, type MountPlanEntry, type VolumeRoots } from "../../deployments/compose/managedVolumes";
import { expectedComposeProjectName, projectRepoDir, resolveComposeConfig } from "../../deployments/operations";
import { rowToProject, type ProjectRow } from "../../projects/types";
import { dockerRunner, probeDirectory, type DockerRunner } from "./docker";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S2: copy each existing project's writable bind-mount data
 *  into the Stackport-owned directory it will use from now on, then switch the project
 *  over. The originals are never touched, so going back is a redeploy of the old
 *  release. */

export type { DockerResult, DockerRunner } from "./docker";

export interface UnmigratedProject { id: number; name: string; composeFile: string; repoPath: string; composeProject: string }

export interface VolumeMigrationDeps {
  docker: DockerRunner;
  roots: VolumeRoots;
  listProjects(): UnmigratedProject[];
  resolve(project: UnmigratedProject): Promise<unknown | null>;
  isFile(source: string): boolean;
  /** An image that has `sh`, `cp` and `du`; the one Stackport itself runs from. */
  helperImage(): Promise<string>;
  mkdir(path: string): Promise<void>;
  markManaged(projectId: number): void;
  /** Remembers where a mount's data was copied from, for the cleanup migration. */
  recordCopied(projectId: number, sourcePath: string, name: string): void;
}

interface Probe { exists: boolean; kb: number; entries: number }

const bindMount = (source: string, target: string, readOnly: boolean): string[] =>
  ["--mount", `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`];

function formatKb(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** Runs the migration for every project that has not been switched over yet. */
export async function runVolumeMigration(mode: MigrationMode, deps: VolumeMigrationDeps): Promise<MigrationReport> {
  const items: ReportItem[] = [];
  const projects = deps.listProjects();
  if (!projects.length) return { summary: "Nothing to migrate: every project already uses Stackport-owned mounts.", items };

  const image = await deps.helperImage();
  let switched = 0;
  let blocked = 0;

  for (const project of projects) {
    const label = `${project.name} (#${project.id})`;
    const resolved = await deps.resolve(project);
    if (resolved === null) {
      items.push({ status: "error", label, detail: "The Compose file could not be resolved (a missing env file or a syntax error). Fix it or deploy once, then run this again." });
      blocked += 1;
      continue;
    }
    const plan = planManagedVolumes(resolved, { projectId: project.id, projectDir: project.repoPath, roots: deps.roots, isFile: deps.isFile });
    const projectItems: ReportItem[] = [];
    let problem = false;

    const running = await deps.docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${project.composeProject}`]);
    // A copy of live data loses what the app writes during and after it, and a failed listing says nothing
    // about whether the project is running, so both stop the project here (the dry run shows the same).
    if (running.code !== 0) {
      items.push({ status: "error", label, detail: `Could not tell whether the project is running (${running.stderr.trim().split("\n")[0] || `exit code ${running.code}`}). Not switched over.` });
      blocked += 1;
      continue;
    }
    if (running.stdout.trim()) {
      items.push({ status: "error", label, detail: "Its containers are running. Stop the project and run this again: data written during and after the copy would not be carried over. Not switched over." });
      blocked += 1;
      continue;
    }

    const managed = plan.filter((entry): entry is MountPlanEntry & { managedContainerPath: string; managedHostPath: string; name: string } => entry.action === "managed");
    const copied = new Set<string>();
    for (const entry of managed) {
      if (copied.has(entry.name)) continue;
      copied.add(entry.name);
      const places = [...new Set([entry.source, entry.hostSource])];
      const found: { path: string; probe: Probe }[] = [];
      let unreadable: string | null = null;
      for (const place of places) {
        const result = await probeDirectory(deps.docker, image, place);
        if (result.state === "error") { unreadable = `${place}: ${result.detail}`; break; }
        if (result.state === "present" && result.entries > 0) found.push({ path: place, probe: { exists: true, kb: result.kb, entries: result.entries } });
      }
      if (unreadable) {
        // Could not tell whether there is data: never treat that as "starts empty", or the project would switch to an empty directory.
        projectItems.push({ status: "error", label: `${entry.name}: could not look for existing data`, detail: `${unreadable}. Nothing was changed; run this again once Docker is healthy.` });
        problem = true;
        continue;
      }
      if (found.length > 1) {
        projectItems.push({ status: "error", label: `${entry.name}: data in two places`, detail: `${found.map((f) => f.path).join(" and ")} both hold files. Decide which one to keep, empty the other, and run this again.` });
        problem = true;
        continue;
      }
      if (!found.length) {
        projectItems.push({ status: "info", label: `${entry.name}: no existing data`, detail: `Starts empty at ${entry.managedHostPath}.` });
        if (mode === "execute") await deps.mkdir(entry.managedContainerPath);
        continue;
      }
      const [{ path: from, probe: size }] = found;
      if (mode === "dry-run") {
        projectItems.push({ status: "ok", label: `${entry.name}: would copy ${formatKb(size.kb)}`, detail: `${from} to ${entry.managedHostPath} (mounted at ${entry.target})` });
        continue;
      }
      await deps.mkdir(entry.managedContainerPath);
      const copy = await deps.docker([
        "run", "--rm", ...bindMount(from, "/from", true), ...bindMount(entry.managedHostPath, "/to", false),
        "--entrypoint", "sh", image, "-c", "cp -a /from/. /to/",
      ]);
      if (copy.code !== 0) {
        projectItems.push({ status: "error", label: `${entry.name}: copy failed`, detail: copy.stderr.trim().slice(0, 500) || `exit code ${copy.code}` });
        problem = true;
      } else {
        deps.recordCopied(project.id, from, entry.name);
        projectItems.push({ status: "ok", label: `${entry.name}: copied ${formatKb(size.kb)}`, detail: `${from} to ${entry.managedHostPath}. The original was left in place.` });
      }
    }

    for (const entry of plan.filter((e) => e.action === "keep")) {
      projectItems.push({ status: "warn", label: `${entry.target}: kept in the checkout`, detail: `${entry.service} ${entry.reason ?? ""}; its path is translated to the host but not moved.` });
    }
    for (const entry of plan.filter((e) => e.action === "repository")) {
      projectItems.push({ status: "info", label: `${entry.target}: read-only repository mount`, detail: `Stays at ${entry.hostSource}.` });
    }

    if (problem) {
      blocked += 1;
      items.push({ status: "error", label, detail: "Not switched over." }, ...projectItems);
      continue;
    }
    if (mode === "execute") {
      deps.markManaged(project.id);
      items.push({ status: "ok", label, detail: "Switched to Stackport-owned mounts. Redeploy it to start using them." }, ...projectItems);
    } else {
      items.push({ status: "ok", label, detail: "Ready: would be switched to Stackport-owned mounts." }, ...projectItems);
    }
    switched += 1;
  }

  const verb = mode === "dry-run" ? "would be switched" : "switched";
  return { summary: `${switched} project${switched === 1 ? "" : "s"} ${verb}, ${blocked} blocked.`, items };
}

function defaultDeps(): VolumeMigrationDeps {
  const docker = dockerRunner();
  return {
    docker,
    roots: currentVolumeRoots(),
    listProjects: () => (getDatabase().prepare("SELECT * FROM projects WHERE volumes_managed = 0 AND compose_file IS NOT NULL ORDER BY id").all() as ProjectRow[])
      .map(rowToProject)
      .filter((project) => project.composeFile)
      .map((project) => ({
        id: project.id, name: project.name, composeFile: project.composeFile as string,
        repoPath: projectRepoDir(project), composeProject: expectedComposeProjectName(project),
      })),
    resolve: (project) => resolveComposeConfig(project.repoPath, project.composeFile),
    isFile: (source) => statSync(source, { throwIfNoEntry: false })?.isFile() ?? false,
    helperImage: async () => {
      const result = await docker(["inspect", "--format", "{{.Config.Image}}", "stackport"]);
      return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "alpine:3";
    },
    mkdir: async (target) => { await fs.mkdir(target, { recursive: true }); },
    markManaged: (projectId) => { getDatabase().prepare("UPDATE projects SET volumes_managed = 1 WHERE id = ?").run(projectId); },
    recordCopied: (projectId, sourcePath, name) => {
      getDatabase().prepare("INSERT OR REPLACE INTO legacy_mount_sources (project_id, source_path, managed_name, removed_at) VALUES (?, ?, ?, NULL)").run(projectId, sourcePath, name);
    },
  };
}

export const volumeMountsMigration: LegacyMigration = {
  id: "volume-mounts",
  title: "Stackport-owned mount directories (S2)",
  description:
    "Copies each existing project's writable bind-mount data into a directory Stackport owns, then switches the project to it. " +
    "Originals are never touched. Stop the projects you are migrating first (a project whose containers are running is skipped), run the dry run, then execute, then redeploy.",
  executeWarning:
    "Copies each project's data into its Stackport-owned directory and switches the project over. The originals are not touched. " +
    "Projects whose containers are running are skipped, so stop them first; redeploy each one afterwards. Run the dry run first if you have not.",
  run: (mode) => runVolumeMigration(mode, defaultDeps()),
};
