import { createHash } from "crypto";
import * as path from "path";
import { dumpYamlDoc } from "./yaml";
import { config } from "../../../config/env";
import { relativeInside, rebasePath } from "../../../shared/hostPath";
import { plainRecord } from "../../../shared/plainRecord";

/**
 * Stackport-owned mount directories (S2).
 *
 * Stackport runs `docker compose` inside its own container, so a relative bind such as
 * `./data` resolves to a path in that container, which the host's Docker daemon then
 * reads as a host path. Instead, every bind mount that points into the project's
 * checkout is planned here from the resolved Compose config and re-written, through a
 * generated override file, to a host path Stackport knows:
 *
 *  - a writable directory becomes a managed directory, `<data>/volumes/<project>/<name>`,
 *    that Stackport creates and owns;
 *  - a read-only mount (config files from the repository) keeps pointing into the
 *    checkout, with its path translated to the host's;
 *  - what cannot move (a file, or the whole checkout mounted writable) also keeps its
 *    place, translated, and is reported so an admin can look at it.
 */

export interface VolumeRoots {
  /** Stackport's data directory as this process sees it (`/app/data` in the container). */
  containerDataRoot: string;
  /** The same directory on the host, which is what the Docker daemon needs. */
  hostDataRoot: string;
}

export type MountAction = "managed" | "repository" | "keep";

export interface MountPlanEntry {
  service: string;
  target: string;
  /** The bind source exactly as `docker compose config` resolved it. */
  source: string;
  readOnly: boolean;
  action: MountAction;
  /** The source on the host, which is what the override will use for a non-managed mount. */
  hostSource: string;
  /** Managed mounts: the directory's name and where it lives (as Stackport and as the host see it). */
  name?: string;
  managedContainerPath?: string;
  managedHostPath?: string;
  /** Why a mount could not be moved. */
  reason?: string;
}

export interface PlanOptions {
  projectId: number;
  /** The project's checkout as this process sees it. */
  projectDir: string;
  roots: VolumeRoots;
  /** Whether `source` is a file; a file cannot be replaced by a directory. */
  isFile: (source: string) => boolean;
}

/** The data directory is the parent of the deploy root (`/app/data` in the container).
 *  Outside the container, with no host data directory configured, both are the same. */
export function currentVolumeRoots(): VolumeRoots {
  const containerDataRoot = path.dirname(path.resolve(config.deployRoot));
  return { containerDataRoot, hostDataRoot: config.hostDataDir ? path.resolve(config.hostDataDir) : containerDataRoot };
}

/** Where managed directories live, as Stackport sees it. */
export function managedVolumesRoot(roots: VolumeRoots, projectId: number): { container: string; host: string } {
  return {
    container: path.posix.join(toPosix(roots.containerDataRoot), "volumes", String(projectId)),
    host: path.posix.join(toPosix(roots.hostDataRoot), "volumes", String(projectId)),
  };
}

function toPosix(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g, "/") : value;
}

function segments(relative: string): string[] {
  return relative.split(/[\\/]/).filter(Boolean);
}

/** The managed directory's name for a mount source, from its path inside the checkout alone:
 *  a readable form of the path plus a hash of the exact path. Nothing else goes into it (not
 *  the other mounts, not the order they are met in), so a path keeps its directory however the
 *  Compose file changes around it; the hash keeps paths that read alike (`my db`, `my_db`)
 *  apart without ever renaming either of them later. */
export function managedDirectoryName(relative: string): string {
  const readable = segments(relative).join("__").replace(/[^A-Za-z0-9._-]/g, "_") || "data";
  const hash = createHash("sha256").update(segments(relative).join("/")).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

/** Reads the bind mounts of a resolved config that point into the project checkout and
 *  decides what to do with each. Mounts outside the checkout are the compose policy's
 *  business and are not planned here. */
export function planManagedVolumes(resolved: unknown, options: PlanOptions): MountPlanEntry[] {
  const services = (resolved as { services?: Record<string, { volumes?: unknown }> } | null)?.services ?? {};
  const roots = managedVolumesRoot(options.roots, options.projectId);
  const relativeBySource = new Map<string, string>();
  const plan: MountPlanEntry[] = [];

  for (const [service, definition] of Object.entries(services)) {
    if (!Array.isArray(definition?.volumes)) continue;
    for (const entry of definition.volumes) {
      const mount = entry as { type?: string; source?: string; target?: string; read_only?: boolean };
      if (mount?.type !== "bind" || typeof mount.source !== "string" || typeof mount.target !== "string") continue;
      const relative = relativeInside(mount.source, options.projectDir);
      if (relative === null) continue;

      const base = {
        service, target: mount.target, source: mount.source, readOnly: mount.read_only === true,
        hostSource: rebasePath(mount.source, options.roots.containerDataRoot, options.roots.hostDataRoot),
      };
      if (base.readOnly) { plan.push({ ...base, action: "repository" }); continue; }
      if (relative === "") {
        plan.push({ ...base, action: "keep", reason: "mounts the whole checkout writable" });
        continue;
      }
      if (options.isFile(mount.source)) {
        plan.push({ ...base, action: "keep", reason: "is a file, which cannot be replaced by a directory" });
        continue;
      }

      relativeBySource.set(mount.source, relative);
      plan.push({ ...base, action: "managed" });
    }
  }

  for (const entry of plan) {
    if (entry.action !== "managed") continue;
    const name = managedDirectoryName(relativeBySource.get(entry.source)!);
    entry.name = name;
    entry.managedContainerPath = path.posix.join(roots.container, name);
    entry.managedHostPath = path.posix.join(roots.host, name);
  }
  return plan;
}

/** The Compose override that points each planned mount at its host path. Compose merges
 *  an override's `volumes` with the base file by container path, so only the sources
 *  change. Returns null when there is nothing to override. */
export function buildVolumesOverride(plan: MountPlanEntry[]): string | null {
  const services = plainRecord<{ volumes: unknown[] }>();
  for (const entry of plan) {
    (services[entry.service] ??= { volumes: [] }).volumes.push({
      type: "bind",
      source: entry.action === "managed" ? entry.managedHostPath : entry.hostSource,
      target: entry.target,
      ...(entry.readOnly ? { read_only: true } : {}),
    });
  }
  return plan.length ? dumpYamlDoc({ services }) : null;
}
