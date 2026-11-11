import { execFile } from "child_process";
import { INGRESS_NETWORK, ingressAlias, NGINX_CONTAINER } from "../../shared/ingressNames";
import { listProjectDomains } from "./domains";

/**
 * Whether nginx can reach a project's routed services (P2).
 *
 * The question is the one that failed in the 1.3.0 incident: from nginx's own network namespace,
 * does the service's alias resolve, and does its port accept a connection? What the application
 * answers (a 500, a login page) does not matter here, so a project's own errors never count as
 * "unreachable". The probe is a short shell script run inside the nginx container, so it sees
 * exactly what nginx sees.
 */

export interface ExecResult { code: number; stdout: string; stderr: string }
export type DockerExec = (args: string[]) => Promise<ExecResult>;

export const dockerExec: DockerExec = (args) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: 15_000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

export type RouteFailure = "name-does-not-resolve" | "connection-refused" | "timed-out" | "probe-failed";

export interface RouteHealth {
  domain: string;
  service: string;
  port: number;
  /** The name nginx uses for the service on the shared network. */
  alias: string;
  reachable: boolean;
  failure: RouteFailure | null;
  /** What the probe printed, trimmed; empty when it reached the service. */
  detail: string;
}

export type IngressStatus = "ok" | "degraded" | "down" | "no-routes" | "nginx-unavailable";

export interface IngressHealth {
  projectId: number;
  /** nginx's container is running and attached to the shared network. */
  nginx: { running: boolean; onSharedNetwork: boolean };
  routes: RouteHealth[];
  status: IngressStatus;
  /** One line saying what to look at, when something is wrong. */
  summary: string;
}

/** Exit codes the script uses itself. busybox `nc` prints nothing and exits 1 for both a refused connection
 *  and a timeout, so the script tells them apart by how long it took: a refusal is immediate. */
const NOT_RESOLVED = 10;
const REFUSED = 11;
const TIMED_OUT = 12;

/** Resolve through Docker's embedded DNS, then connect. Arguments are passed as positional
 *  parameters, never spliced into the script text. */
const PROBE_SCRIPT = [
  'nslookup "$1" 127.0.0.11 >/dev/null 2>&1 || exit ' + NOT_RESOLVED,
  "start=$(date +%s)",
  'nc -w 3 "$1" "$2" </dev/null >/dev/null 2>&1 && exit 0',
  "end=$(date +%s)",
  `if [ $((end - start)) -ge 3 ]; then exit ${TIMED_OUT}; fi`,
  `exit ${REFUSED}`,
].join("; ");

export function classifyProbe(result: ExecResult): { failure: RouteFailure | null; detail: string } {
  const detail = `${result.stdout} ${result.stderr}`.replace(/\s+/g, " ").trim().slice(0, 300);
  switch (result.code) {
    case 0: return { failure: null, detail: "" };
    case NOT_RESOLVED: return { failure: "name-does-not-resolve", detail: "the name did not resolve on the shared network" };
    case REFUSED: return { failure: "connection-refused", detail: "the port refused the connection" };
    case TIMED_OUT: return { failure: "timed-out", detail: "no answer within 3 seconds" };
    default: return { failure: "probe-failed", detail: detail || `the probe exited with code ${result.code}` };
  }
}

export async function probeRoute(alias: string, port: number, exec: DockerExec = dockerExec): Promise<{ failure: RouteFailure | null; detail: string }> {
  const result = await exec(["exec", NGINX_CONTAINER, "sh", "-c", PROBE_SCRIPT, "sh", alias, String(port)]);
  return classifyProbe(result);
}

async function nginxState(exec: DockerExec): Promise<{ running: boolean; onSharedNetwork: boolean }> {
  const result = await exec(["inspect", NGINX_CONTAINER, "--format", "{{.State.Running}} {{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}"]);
  if (result.code !== 0) return { running: false, onSharedNetwork: false };
  const [running, ...networks] = result.stdout.trim().split(/\s+/);
  return { running: running === "true", onSharedNetwork: networks.includes(INGRESS_NETWORK) };
}

export function summarize(nginx: IngressHealth["nginx"], routes: RouteHealth[]): { status: IngressStatus; summary: string } {
  if (!nginx.running) return { status: "nginx-unavailable", summary: "The nginx container is not running, so no route can be reached." };
  if (!nginx.onSharedNetwork) return { status: "nginx-unavailable", summary: `nginx is not on the ${INGRESS_NETWORK} network, so none of its upstreams can resolve. Restart Stackport to reconcile the network.` };
  if (!routes.length) return { status: "no-routes", summary: "This project has no routed domain." };
  const failed = routes.filter((r) => !r.reachable);
  if (!failed.length) return { status: "ok", summary: "Every route reaches its service." };
  const unresolved = failed.filter((r) => r.failure === "name-does-not-resolve");
  const lead = unresolved.length
    ? `${unresolved.map((r) => r.service).join(", ")} is not on the ${INGRESS_NETWORK} network under its alias: the service is not running, or was started before it was attached. Redeploy the project or restart Stackport.`
    : `${failed.map((r) => `${r.domain} (${r.failure})`).join(", ")}: the name resolves but the port does not answer. Check the service's logs and its container port.`;
  return { status: failed.length === routes.length ? "down" : "degraded", summary: lead };
}

export async function checkProjectIngress(projectId: number, exec: DockerExec = dockerExec): Promise<IngressHealth> {
  const nginx = await nginxState(exec);
  const targets = listProjectDomains(projectId).filter((d) => d.service && d.containerPort);
  const routes: RouteHealth[] = [];
  if (nginx.running && nginx.onSharedNetwork) {
    for (const domain of targets) {
      const alias = ingressAlias(projectId, domain.service);
      const outcome = await probeRoute(alias, domain.containerPort as number, exec);
      routes.push({ domain: domain.domain, service: domain.service, port: domain.containerPort as number, alias, reachable: outcome.failure === null, failure: outcome.failure, detail: outcome.detail });
    }
  }
  return { projectId, nginx, routes, ...summarize(nginx, routes) };
}
