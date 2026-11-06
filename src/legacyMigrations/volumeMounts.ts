import { execFile } from "child_process";
import { statSync } from "fs";
import * as fs from "fs/promises";
import { getDatabase } from "../config/database";
import { currentVolumeRoots, planManagedVolumes, type MountPlanEntry, type VolumeRoots } from "../services/managedVolumes";
import { expectedComposeProjectName, projectRepoDir, resolveComposeConfig } from "../services/projectDeploy";
import { rowToProject, type ProjectRow } from "../entities/Project";
import type { LegacyMigration, MigrationMode, MigrationReport, ReportItem } from "./types";

/** TEMPORARY (see types.ts). S2: copy each existing project's writable bind-mount data
 *  into the Stackport-owned directory it will use from now on, then switch the project
 *  over. The originals are never touched, so going back is a redeploy of the old
 *  release. */

export interface DockerResult { code: number; stdout: string; stderr: string }
export type DockerRunner = (args: string[]) => Promise<DockerResult>;

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
}

interface Probe { exists: boolean; kb: number; entries: number }

function parseProbe(result: DockerResult): Probe {
  if (result.code !== 0) return { exists: false, kb: 0, entries: 0 };
  const [kb, entries] = result.stdout.trim().split(/\s+/).map(Number);
  return { exists: true, kb: kb || 0, entries: entries || 0 };
}

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
  const probe = async (hostPath: string): Promise<Probe> => parseProbe(await deps.docker([
    "run", "--rm", ...bindMount(hostPath, "/from", true), "--entrypoint", "sh", image, "-c", "du -sk /from | cut -f1; ls -A /from | wc -l",
  ]));
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
    if (running.code === 0 && running.stdout.trim()) {
      projectItems.push({ status: "warn", label: "Containers are running", detail: "Writes made after the copy are not carried over. Stop the project first for a consistent copy." });
    }

    const managed = plan.filter((entry): entry is MountPlanEntry & { managedContainerPath: string; managedHostPath: string; name: string } => entry.action === "managed");
    const copied = new Set<string>();
    for (const entry of managed) {
      if (copied.has(entry.name)) continue;
      copied.add(entry.name);
      const places = [...new Set([entry.source, entry.hostSource])];
      const found: { path: string; probe: Probe }[] = [];
      for (const place of places) {
        const result = await probe(place);
        if (result.exists && result.entries > 0) found.push({ path: place, probe: result });
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

function dockerRunner(): DockerRunner {
  return (args) => new Promise((resolve) => {
    execFile("docker", args, { timeout: 3_600_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
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
  };
}

export const volumeMountsMigration: LegacyMigration = {
  id: "volume-mounts",
  title: "Stackport-owned mount directories (S2)",
  description:
    "Copies each existing project's writable bind-mount data into a directory Stackport owns, then switches the project to it. " +
    "Originals are never touched. Run the dry run first, stop the projects you are migrating, then execute, then redeploy.",
  run: (mode) => runVolumeMigration(mode, defaultDeps()),
};
