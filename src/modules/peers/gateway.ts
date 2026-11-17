import crypto from "crypto";
import type Database from "better-sqlite3";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { auditLog } from "../../shared/logger";
import type { Grant } from "./grants";
import { hasGrant } from "./grants";
import { setPeerPrincipal } from "./principal";
import { actionRegistry } from "../actions/registry";
import { tryReadEnvVariables, type ProjectEnvFileRow } from "../projects/envFiles";
import { getDatabase } from "../../config/database";
import { OPERATION_ID_PATTERN, safeEqual } from "./signing";

/**
 * The managed side's project API for a controller: the application's own routes, called in this process, for the requests an allow-list names.
 *
 * Nothing is reimplemented here. A deploy, a domain change or a project update run the same handlers, the same services and the same action
 * runner as the same click in this instance's own UI, so this instance stays authoritative and the two cannot drift. What the gateway adds is
 * the boundary: a default-deny list of (method, path, grant), idempotency for writes, and an audit line for each write naming the caller.
 *
 * The list is the contract. A route that is not on it does not exist to a peer, whatever the application router has: host administration,
 * credentials, other peers, backups and updates are not here and cannot be granted.
 */

interface Rule {
  method: string;
  path: RegExp;
  grant: Grant;
  /** Body fields this route refuses from a peer, because they reach past the project (see below). */
  denyFields?: readonly string[];
}

const ID = "\\d+";
const PROJECT = `^/projects/${ID}`;
const read = (path: RegExp): Rule => ({ method: "GET", path, grant: "projects:read" });
const write = (method: string, path: RegExp, denyFields?: readonly string[]): Rule => ({ method, path, grant: "projects:write", ...(denyFields ? { denyFields } : {}) });

/** Raw nginx directives go into the shared proxy's configuration: they can affect every project on the host, not only this one. A peer does not get them. */
const NGINX_FIELDS = ["nginxExtraConfig", "nginxExtraBlocks"] as const;

export const GATEWAY_RULES: readonly Rule[] = [
  // read
  read(/^\/projects\/(resources-summary|resources-timeseries)$/),
  read(new RegExp(`${PROJECT}/(resources|deployments|deploy-preview|rollback-preview|ingress-targets|compose-env-files|compose-variables|compose-policy|ingress-health|network-group|domains|tcp-exposures|compose-file/content|actions|branches)$`)),
  read(/^\/actions\/running$/),
  read(/^\/actions\/[A-Za-z0-9-]+(\/log)?$/),
  read(/^\/domains(\/hostnames)?$/),
  // write: create, configure, deploy and operate
  write("POST", /^\/projects$/, NGINX_FIELDS),
  write("PATCH", new RegExp(`${PROJECT}$`), NGINX_FIELDS),
  write("POST", new RegExp(`${PROJECT}/(build|pull|compose|recreate|force-rebuild|deploy|rollback|stop|pause|resume|check|favorite|unfavorite|actions/cancel)$`)),
  write("POST", new RegExp(`${PROJECT}/containers/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/redeploy$`)),
  // Not here, on purpose: compose-policy-enforcement, hardening and ingress-isolation. They are the controls that keep a Compose file from reaching the host,
  // and switching them off is an escalation of its own, not project configuration.
  write("PUT", new RegExp(`${PROJECT}/(github-deploy-on|github-auth|network-group|deploy-trigger)$`)),
  write("PATCH", new RegExp(`${PROJECT}/compose-file$`)),
  // write: domains, routing, certificates, TCP exposure
  write("POST", new RegExp(`${PROJECT}/domains$`)),
  write("POST", new RegExp(`${PROJECT}/domains/${ID}/(rename|ssl/issue)$`)),
  write("PATCH", new RegExp(`${PROJECT}/domains/${ID}(/route)?$`)),
  write("DELETE", new RegExp(`${PROJECT}/domains/${ID}$`)),
  write("POST", new RegExp(`${PROJECT}/tcp-exposures$`)),
  write("DELETE", new RegExp(`${PROJECT}/tcp-exposures/${ID}$`)),
  // env files: `projects:env` reads and writes them with values masked; `projects:secrets` sees the values (see maskEnv)
  { method: "GET", path: new RegExp(`${PROJECT}/env-files$`), grant: "projects:env" },
  { method: "POST", path: new RegExp(`${PROJECT}/env-files$`), grant: "projects:env" },
  { method: "PUT", path: new RegExp(`${PROJECT}/env-files/${ID}$`), grant: "projects:env" },
  { method: "DELETE", path: new RegExp(`${PROJECT}/env-files/${ID}$`), grant: "projects:env" },
  // destroy: the project and its data. Each needs `projects:destroy`, which is never implied by another grant.
  { method: "DELETE", path: new RegExp(`${PROJECT}$`), grant: "projects:destroy" },
  { method: "POST", path: new RegExp(`${PROJECT}/stop-purge$`), grant: "projects:destroy" },
  { method: "POST", path: new RegExp(`${PROJECT}/containers/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/drop-volumes$`), grant: "projects:destroy" },
  // write: the repository credentials a new project may name (aliases and types only; a secret is never part of the answer)
  { method: "GET", path: /^\/credentials$/, grant: "projects:write" },
];

/** What the allow-list says about a request, or null when it is not on the list. `target` is the path without its query string. */
export function matchRule(method: string, target: string): Rule | null {
  return GATEWAY_RULES.find((rule) => rule.method === method && rule.path.test(target)) ?? null;
}

const ENV_FILES = new RegExp(`${PROJECT}/env-files(/${ID})?$`);

interface EnvVariableLike { key?: unknown; value?: unknown; masked?: unknown }

/** Env values never leave in clear text for a caller without `projects:secrets`: the keys stay, the values do not. The answer is rebuilt from a short list of
 *  fields, not patched, so a field added to an env file later is not shown to a masked caller until it is added here on purpose. */
export function maskEnv(body: unknown): unknown {
  const maskFile = (file: unknown): unknown => {
    if (file === null || typeof file !== "object") return file;
    const f = file as Record<string, unknown>;
    if (!Array.isArray(f["variables"])) {
      // Not an env file (an error answer): only its message.
      return { ...(typeof f["error"] === "string" ? { error: f["error"] } : {}), ...(typeof f["code"] === "string" ? { code: f["code"] } : {}) };
    }
    return {
      id: f["id"], projectId: f["projectId"], relativePath: f["relativePath"], unreadable: f["unreadable"], createdAt: f["createdAt"], updatedAt: f["updatedAt"],
      variables: (f["variables"] as EnvVariableLike[]).map((variable) => ({ key: variable.key, value: "", masked: true })),
    };
  };
  return Array.isArray(body) ? body.map(maskFile) : maskFile(body);
}

/** Whether an env answer actually carries a value in clear: the only thing worth recording as a secret having left. */
function revealsValues(body: unknown): boolean {
  const files = Array.isArray(body) ? body : [body];
  return files.some((file) => Array.isArray((file as { variables?: unknown })?.variables) && ((file as { variables: EnvVariableLike[] }).variables).some((variable) => typeof variable.value === "string" && variable.value !== ""));
}

const ENV_FILE_ONE = /^\/projects\/(\d+)\/env-files\/(\d+)$/;

/** A masked caller edits a file without knowing its values: an entry `{ key, keep: true }` stands for the value the file already has. Resolved here, on the peer, so the value never travels. */
function resolveKeptValues(req: Request, target: string, db: Database.Database): string | null {
  const match = ENV_FILE_ONE.exec(target);
  const variables = (req.body as { variables?: unknown } | undefined)?.variables;
  if (!match || !Array.isArray(variables) || !variables.some((entry) => (entry as { keep?: unknown })?.keep === true)) return null;
  const row = db.prepare("SELECT * FROM project_env_files WHERE id = ? AND project_id = ?").get(Number(match[2]), Number(match[1])) as ProjectEnvFileRow | undefined;
  const existing = row ? tryReadEnvVariables(row) : null;
  if (!existing) return "The values to keep cannot be read.";
  const byKey = new Map(existing.map((variable) => [variable.key, variable.value]));
  const resolved: unknown[] = [];
  for (const entry of variables as { key?: unknown; value?: unknown; keep?: unknown }[]) {
    if (entry?.keep === true) {
      if (typeof entry.key !== "string" || !byKey.has(entry.key)) return `There is no existing value for ${String(entry?.key)} to keep.`;
      resolved.push({ key: entry.key, value: byKey.get(entry.key) });
    } else resolved.push(entry);
  }
  (req.body as { variables: unknown[] }).variables = resolved;
  return null;
}

/** An action belongs to a project when it was started for one. Updates, backups and other host-level actions are not a peer's to see. */
function isProjectAction(id: string): boolean {
  const live = actionRegistry.getById(id);
  if (live) return live.projectId !== undefined;
  const row = getDatabase().prepare("SELECT project_id FROM actions WHERE id = ?").get(id) as { project_id: number | null } | undefined;
  return row?.project_id !== null && row?.project_id !== undefined;
}

/** A status that says "try again", or that a server error cut the work short, is not an outcome to remember: a retry with the same operation id must be able to run once the cause has passed.
 *  (The handlers behind a write are guarded by their own conflicts: a name that exists, a project action already running.) */
export const notRecorded = (status: number): boolean => status === 409 || status === 429 || status >= 500;

/** An operation that has been running longer than this without recording a result is treated as lost (a crash), not as still running. */
const IN_PROGRESS_LOST_MS = 10 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
let lastPrune = 0;

interface OperationRow { request_hash: string; status: number | null; body: string | null; content_type: string | null; created_at: number }

function refuse(res: Response, status: number, error: string, code: string): void {
  res.status(status).json({ error, code });
}

export function createGateway(api: Router, getDb: () => Database.Database): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = req.peer?.controller;
    if (!controller) { refuse(res, 401, "Authentication failed.", "unauthenticated"); return; }
    const target = req.path;
    const rule = matchRule(req.method, target);
    // Unknown to the allow-list is the same answer as unknown to the router: a peer cannot probe for what exists.
    if (!rule) { refuse(res, 404, "Unknown control endpoint.", "not-found"); return; }
    if (!hasGrant(req.peer?.grants ?? [], rule.grant)) {
      auditLog(`peer:${controller.instanceId}`, "peer.denied", `${req.method} ${target}`, "fail", { needed: rule.grant, operationId: req.peer?.operationId });
      res.status(403).json({ error: `This instance has not been granted ${rule.grant}.`, code: "forbidden", needed: rule.grant });
      return;
    }

    // Host-level actions are not part of a project's story.
    const actionId = /^\/actions\/([A-Za-z0-9-]+)(\/log)?$/.exec(target)?.[1];
    if (actionId && actionId !== "running" && !isProjectAction(actionId)) { refuse(res, 404, "Unknown control endpoint.", "not-found"); return; }
    if (rule.denyFields && req.body && typeof req.body === "object") {
      const denied = rule.denyFields.find((field) => Object.prototype.hasOwnProperty.call(req.body, field));
      if (denied) { refuse(res, 403, `${denied} cannot be set by a peer.`, "forbidden-field"); return; }
    }
    const db = getDb();
    const envRoute = ENV_FILES.test(target);
    const secrets = hasGrant(req.peer?.grants ?? [], "projects:secrets");
    if (envRoute) {
      // Masked unless the caller may see secrets; and a clear value being shown is audited as such.
      const json = res.json.bind(res) as (body: unknown) => Response;
      res.json = ((body: unknown) => {
        if (secrets && res.statusCode < 400 && revealsValues(body)) auditLog(`peer:${controller.instanceId}`, "peer.secrets-read", `${req.method} ${target}`, "ok", { operationId: req.peer?.operationId, status: res.statusCode });
        return json(secrets ? body : maskEnv(body));
      }) as typeof res.json;
    }
    if (target === "/actions/running") {
      // Only the actions started for a project.
      const json = res.json.bind(res) as (body: unknown) => Response;
      res.json = ((body: unknown) => json(Array.isArray(body) ? body.filter((entry) => (entry as { projectId?: unknown })?.projectId !== undefined && (entry as { projectId?: unknown })?.projectId !== null) : body)) as typeof res.json;
    }

    const mutating = req.method !== "GET";
    const operationId = req.peer?.operationId ?? null;
    let recorded = false;

    if (mutating) {
      if (!operationId || !OPERATION_ID_PATTERN.test(operationId)) { refuse(res, 400, "A write needs an operation id (X-SP-Operation, 8 to 128 characters), so a retry cannot act twice.", "operation-required"); return; }
      const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const hash = crypto.createHash("sha256").update(`${req.method}\n${req.originalUrl}\n`).update(raw).digest("hex");
      const now = Date.now();
      if (now - lastPrune > 60_000) { lastPrune = now; db.prepare("DELETE FROM peer_operations WHERE created_at < ?").run(now - RETENTION_MS); }
      const inserted = db.prepare("INSERT OR IGNORE INTO peer_operations (controller_id, operation_id, request_hash, created_at) VALUES (?, ?, ?, ?)").run(controller.id, operationId, hash, now).changes > 0;
      if (!inserted) {
        const row = db.prepare("SELECT request_hash, status, body, content_type, created_at FROM peer_operations WHERE controller_id = ? AND operation_id = ?").get(controller.id, operationId) as OperationRow | undefined;
        if (!row) { refuse(res, 409, "Try again.", "operation-in-progress"); return; }
        if (!safeEqual(row.request_hash, hash)) { refuse(res, 409, "This operation id was already used for a different request.", "operation-conflict"); return; }
        if (row.status === null) {
          if (now - row.created_at > IN_PROGRESS_LOST_MS) { refuse(res, 409, "The outcome of this operation is unknown (it did not finish recording). Check the project's state, then use a new operation id.", "operation-outcome-unknown"); return; }
          res.setHeader("Retry-After", "1");
          refuse(res, 409, "This operation is still running.", "operation-in-progress");
          return;
        }
        // The first result, as it was: the same status and body, marked so the caller knows nothing ran again.
        res.setHeader("X-SP-Replayed", "true");
        if (row.content_type) res.setHeader("content-type", row.content_type);
        res.status(row.status).send(row.body ?? "");
        return;
      }
      recorded = true;
    }

    // Record what the handler answers, then let it go out. Wrapped inside the channel's own signing, which sees the final bytes.
    if (recorded && operationId) {
      const end = res.end.bind(res) as (...args: unknown[]) => Response;
      res.end = ((chunk?: unknown, ...rest: unknown[]) => {
        let body = chunk === undefined || typeof chunk === "function" ? "" : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        // A value is never stored in the operations table, whoever was allowed to see it: a replay of an env write is the masked answer.
        if (envRoute && body) { try { body = JSON.stringify(maskEnv(JSON.parse(body))); } catch { /* not JSON: an error page, which holds no value */ } }
        try {
          if (notRecorded(res.statusCode)) db.prepare("DELETE FROM peer_operations WHERE controller_id = ? AND operation_id = ?").run(controller.id, operationId);
          else {
            db.prepare("UPDATE peer_operations SET status = ?, body = ?, content_type = ? WHERE controller_id = ? AND operation_id = ?")
              .run(res.statusCode, body, String(res.getHeader("content-type") ?? "") || null, controller.id, operationId);
          }
        } catch { /* the answer still goes out; a retry then sees an operation with no result and reports it unknown */ }
        auditLog(`peer:${controller.instanceId}`, "peer.request", `${req.method} ${target}`, res.statusCode < 400 ? "ok" : "fail", { operationId, status: res.statusCode, grant: rule.grant });
        return end(chunk, ...rest);
      }) as typeof res.end;
    }

    // Kept values are read from the file as it is now, so only for a request that runs: a replay (above) never re-reads state the first attempt changed.
    if (envRoute && req.method === "PUT") {
      const problem = resolveKeptValues(req, target, db);
      if (problem) { refuse(res, 400, problem, "bad-request"); return; }
    }

    // The route sees an authenticated principal and none of the caller's own credentials.
    setPeerPrincipal(req, `peer:${controller.instanceId}`);
    delete req.headers["authorization"];
    delete req.headers["cookie"];
    api(req, res, (error?: unknown) => {
      if (error) { next(error); return; }
      refuse(res, 404, "Unknown control endpoint.", "not-found");
    });
  };
}
