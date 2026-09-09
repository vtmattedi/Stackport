import type { ComposeStack, Project } from "../api/types";
import { formatTimeAgo } from "./format";

export type ProjectStatusKind = "not-deployed" | "down" | "problem" | "ready" | "paused";

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function expectedComposeProjectName(project: Pick<Project, "id" | "name">): string {
  return `${project.id}-${slugify(project.name)}`;
}

export function findProjectStack(
  project: Pick<Project, "id" | "name">,
  stacks: ComposeStack[],
): ComposeStack | null {
  const expectedName = expectedComposeProjectName(project);
  return stacks.find((stack) => (
    stack.name === expectedName ||
    stack.configFiles.some((file) => file.split(/[\\/]+/).includes(expectedName)) ||
    stack.containers.some((c) => (
      c.name.startsWith(`${expectedName}-`) || c.name.startsWith(`${expectedName}_`)
    ))
  )) ?? null;
}

/**
 * Derives a unified 4-state project status from docker state + health check.
 *
 * States (in priority order):
 *  paused       — project is explicitly paused by the user
 *  not-deployed — no docker stack found or no containers
 *  down         — stack exists but not all containers are running
 *  problem      — all containers running but health check fails (only when HC configured)
 *  ready        — all containers running + health check passes (or no HC configured)
 */
export function deriveProjectStatus(
  project: Pick<Project, "paused" | "lastStatus" | "healthCheckIntervalS">,
  dockerStack: ComposeStack | null,
  dockerAvailable: boolean,
): ProjectStatusKind {
  if (project.paused) return "paused";

  if (!dockerAvailable) {
    if (project.lastStatus === "up") return "ready";
    if (project.lastStatus === "down") return "down";
    return "not-deployed";
  }

  if (!dockerStack || dockerStack.containers.length === 0) return "not-deployed";

  const allRunning = dockerStack.containers.every((c) => c.state === "running");
  if (!allRunning) return "down";

  if (project.healthCheckIntervalS === 0) return "ready";
  return project.lastStatus === "up" ? "ready" : "problem";
}

/**
 * Explains *why* a status was derived — the docker + health check facts
 * `deriveProjectStatus` based its verdict on (no leading status word; pair
 * with `projectStatusLabel` for that).
 */
export function explainProjectStatus(
  project: Pick<Project, "healthCheckIntervalS" | "lastStatus" | "lastResponseMs" | "lastCheckedAt">,
  dockerStack: ComposeStack | null,
  dockerAvailable: boolean,
  status: ProjectStatusKind,
): string {
  if (status === "paused") return "Manually stopped — health checks and auto-deploy are off.";

  if (status === "not-deployed") {
    return dockerAvailable
      ? "No docker containers found for this project — it hasn't been deployed yet."
      : "Docker isn't available on this host, so deployment state can't be confirmed.";
  }

  const total = dockerStack?.containers.length ?? 0;
  const running = dockerStack?.containers.filter((c) => c.state === "running").length ?? 0;
  const dockerFact = dockerAvailable
    ? `docker: ${running}/${total} container${total === 1 ? "" : "s"} running`
    : "docker: unavailable, showing last known status";

  if (status === "down") {
    const stopped = (dockerStack?.containers ?? []).filter((c) => c.state !== "running").map((c) => c.service ?? c.name);
    return `${dockerFact}${stopped.length > 0 ? ` (stopped: ${stopped.join(", ")})` : ""}.`;
  }

  const healthFact = project.healthCheckIntervalS === 0
    ? "no health check configured"
    : project.lastStatus === "up"
      ? `health check ok${project.lastResponseMs != null ? ` (${project.lastResponseMs}ms)` : ""}`
      : `health check failing — last checked ${formatTimeAgo(project.lastCheckedAt, "never")}`;

  return `${dockerFact}, ${healthFact}.`;
}

export function projectStatusLabel(status: ProjectStatusKind): string {
  switch (status) {
    case "not-deployed": return "Not deployed";
    case "down": return "Down";
    case "problem": return "Problem";
    case "ready": return "Ready";
    case "paused": return "Paused";
  }
}
