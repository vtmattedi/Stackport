import type { ProjectState, ProjectStatus } from "./types";

/**
 * A project's state, from Docker and its health check. This is the same decision the web UI makes (client/src/lib/projectStatus.ts), so the
 * stream and the Projects page never disagree; tests/statusLogic.test.ts pins the cases the two share.
 *
 *  paused        the project is stopped on purpose: health checks and auto-deploy are off
 *  not-deployed  no stack, or no container that counts
 *  down          a container that counts is not running
 *  problem       everything runs but the health check fails
 *  ready         everything runs and the health check passes (or none is set)
 *
 * A container labelled `com.stackport.health.ignore=true` (a one-shot or helper) does not count.
 */

export interface ContainerFacts {
  state: string;
  healthCheckIgnored: boolean;
}

export interface ProjectFacts {
  paused: boolean;
  lastStatus: "up" | "down" | "unknown";
  healthCheckIntervalS: number;
}

export function deriveProjectState(project: ProjectFacts, containers: ContainerFacts[] | null, dockerAvailable: boolean): ProjectState {
  if (project.paused) return "paused";

  if (!dockerAvailable) {
    if (project.lastStatus === "up") return "ready";
    if (project.lastStatus === "down") return "down";
    return "not-deployed";
  }

  const monitored = (containers ?? []).filter((container) => !container.healthCheckIgnored);
  if (monitored.length === 0) return "not-deployed";
  if (!monitored.every((container) => container.state === "running")) return "down";

  if (project.healthCheckIntervalS === 0) return "ready";
  return project.lastStatus === "up" ? "ready" : "problem";
}

export function healthOf(project: ProjectFacts): ProjectStatus["health"] {
  if (project.healthCheckIntervalS === 0) return "none";
  return project.lastStatus === "up" ? "ok" : project.lastStatus === "down" ? "failing" : "unknown";
}

/** How many of a project's counted containers run. */
export function containerCounts(containers: ContainerFacts[] | null): { running: number; total: number } {
  const monitored = (containers ?? []).filter((container) => !container.healthCheckIgnored);
  return { running: monitored.filter((container) => container.state === "running").length, total: monitored.length };
}
