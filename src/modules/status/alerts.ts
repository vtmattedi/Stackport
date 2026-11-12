import { MIN_REQUESTS } from "./requestStats";
import type { Alert, ProjectStatus } from "./types";
import { finite } from "./types";

/**
 * "Something is wrong with X", as the Insights page's Needs attention shows it: conditions that hold now, not events. Each rule is a pure
 * function of the current state; the stream sends the list of conditions that are true, and an adapter that wants events (appeared,
 * cleared) diffs two lists by `id`. The browser push alerts are a different thing (something expected did not happen) and are not repeated here.
 *
 * Thresholds are the same everywhere and fixed in code for now: 1% / 5% server errors and 2 s / 5 s p95, only with at least MIN_REQUESTS
 * requests in the window, so a project with three requests and one error is not "33% errors".
 */

export const ERROR_RATE_WARNING_PCT = 1;
export const ERROR_RATE_CRITICAL_PCT = 5;
export const P95_WARNING_MS = 2_000;
export const P95_CRITICAL_MS = 5_000;
/** A project whose latest deploy failed is flagged for this long after it. */
export const DEPLOY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AlertInput {
  now: number;
  projects: (ProjectStatus & { latestDeployFailedAt: string | null })[];
  host: {
    dockerAvailable: boolean;
    /** null when Nginx's state is not known (Docker is down). */
    nginxRunning: boolean | null;
    disk: { state: "normal" | "warning" | "critical" | "unknown"; freePct: number | null };
  };
}

type Condition = Omit<Alert, "since">;

export function evaluateAlerts(input: AlertInput): Condition[] {
  const out: Condition[] = [];

  if (!input.host.dockerAvailable) {
    out.push(hostAlert("host_docker_down", "critical", "Docker", "Docker is not reachable, so no project's state can be confirmed."));
  } else if (input.host.nginxRunning === false) {
    out.push(hostAlert("host_nginx_down", "critical", "Nginx", "The Nginx container is not running, so no hostname is being served."));
  }
  if (input.host.disk.state === "warning" || input.host.disk.state === "critical") {
    const free = finite(input.host.disk.freePct);
    out.push({
      ...hostAlert("host_disk_low", input.host.disk.state === "critical" ? "critical" : "warning", "Disk", free === null ? "Docker's disk is nearly full." : `Docker's disk has ${free}% free.`),
      value: free, unit: free === null ? null : "%",
    });
  }

  for (const project of input.projects) {
    if (project.state === "paused" || project.state === "not-deployed") continue;
    const name = project.name;
    if (project.state === "down") {
      out.push(projectAlert(project, "project_down", "critical", `${name} is down: ${project.containers.running} of ${project.containers.total} containers are running.`));
    } else if (project.state === "problem" && project.health === "failing") {
      out.push(projectAlert(project, "project_unhealthy", "critical", `${name} is running but its health check is failing.`));
    }

    if (project.latestDeployFailedAt && input.now - Date.parse(project.latestDeployFailedAt) < DEPLOY_FAILURE_WINDOW_MS) {
      out.push(projectAlert(project, "project_deploy_failed", "warning", `${name}'s latest deploy failed.`));
    }

    const traffic = project.traffic;
    if (traffic && traffic.requests >= MIN_REQUESTS) {
      if (traffic.errorRatePct !== null && traffic.errorRatePct >= ERROR_RATE_WARNING_PCT) {
        out.push({
          ...projectAlert(project, "project_error_rate", traffic.errorRatePct >= ERROR_RATE_CRITICAL_PCT ? "critical" : "warning", `${name} is returning ${traffic.errorRatePct}% server errors.`),
          value: traffic.errorRatePct, unit: "%",
        });
      }
      if (traffic.p95Ms !== null && traffic.p95Ms >= P95_WARNING_MS) {
        out.push({
          ...projectAlert(project, "project_latency", traffic.p95Ms >= P95_CRITICAL_MS ? "critical" : "warning", `${name}'s p95 response time is ${Math.round(traffic.p95Ms)} ms.`),
          value: Math.round(traffic.p95Ms), unit: "ms",
        });
      }
    }
  }
  return out;
}

function hostAlert(code: Alert["code"], severity: Alert["severity"], subject: string, message: string): Condition {
  return { id: `${code}:host`, severity, code, scope: "host", projectId: null, subject, message, value: null, unit: null };
}

function projectAlert(project: ProjectStatus, code: Alert["code"], severity: Alert["severity"], message: string): Condition {
  return { id: `${code}:${project.id}`, severity, code, scope: "project", projectId: project.id, subject: project.name, message, value: null, unit: null };
}
