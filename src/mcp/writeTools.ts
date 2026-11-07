import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiToken } from "../services/apiTokens";
import { actionRegistry, projectRepoKey } from "../services/actionRegistry";
import { resolveRollbackTarget } from "../services/projectDeployments";
import { deployProject, getProjectById, isValidBranchName, recreateProject, rollbackProject, stopProject } from "../services/projectDeploy";
import { auditLog } from "../utils/logger";

/**
 * Write tools for the HTTP MCP endpoint (S5): deploy, roll back, restart and stop. A token
 * needs the `write` scope, may only act on projects in its project group, and every
 * tool is two steps. The first call changes nothing: it describes what would happen and
 * returns a one-time confirmation id. Only a second call that presents that id runs it.
 * The server enforces this, so a client that skips its own approval prompt still cannot
 * act on a first call. Every call is audited, with the token as the actor.
 */

export type WriteKind = "deploy" | "rollback" | "restart" | "stop";

export interface ProjectLike { id: number; name: string; groupName: string | null; lastStatus: string; autoDeployBranch: string | null }

export interface WriteDeps {
  getProject(id: number): ProjectLike | null;
  rollbackTarget(projectId: number, deploymentId?: number): { ok: true; id: number; commitSha: string | null } | { ok: false; error: string };
  /** Starts the action in the project's action slot; null when another action holds it. */
  start(kind: WriteKind, project: ProjectLike, params: WriteParams, actor: string): { id: string } | null;
  now(): number;
}

export interface WriteParams { branch?: string; deploymentId?: number }

export const CONFIRMATION_TTL_MS = 5 * 60_000;

interface Pending { tokenId: number; kind: WriteKind; projectId: number; params: string; expiresAt: number; resolvedDeploymentId?: number }

/** One-time confirmations. Held in memory: a restart drops them, which only means asking again. */
export class ConfirmationStore {
  private pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `resolvedDeploymentId`: the revision a rollback preview named, so the one that runs is the one that was shown. */
  issue(tokenId: number, kind: WriteKind, projectId: number, params: WriteParams, resolvedDeploymentId?: number): { id: string; expiresAt: number } {
    const at = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(id);
    const id = randomUUID();
    const expiresAt = at + CONFIRMATION_TTL_MS;
    this.pending.set(id, { tokenId, kind, projectId, params: canonical(params), expiresAt, ...(resolvedDeploymentId !== undefined ? { resolvedDeploymentId } : {}) });
    return { id, expiresAt };
  }

  /** The confirmation, once, for the token, tool, project and parameters it was issued for; otherwise null. */
  consume(id: string, tokenId: number, kind: WriteKind, projectId: number, params: WriteParams): Pending | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    const valid = entry.expiresAt > this.now() && entry.tokenId === tokenId && entry.kind === kind
      && entry.projectId === projectId && entry.params === canonical(params);
    return valid ? entry : null;
  }
}

function canonical(params: WriteParams): string {
  return JSON.stringify({ branch: params.branch ?? null, deploymentId: params.deploymentId ?? null });
}

const confirmations = new ConfirmationStore();

const MCP_TRIGGER = "mcp";

export function defaultWriteDeps(): WriteDeps {
  return {
    getProject: (id) => {
      const project = getProjectById(id);
      return project ? { id: project.id, name: project.name, groupName: project.groupName, lastStatus: project.lastStatus, autoDeployBranch: project.autoDeployBranch } : null;
    },
    rollbackTarget: (projectId, deploymentId) => {
      const result = resolveRollbackTarget(projectId, deploymentId);
      return result.ok ? { ok: true, id: result.target.id, commitSha: result.target.commitSha ?? null } : { ok: false, error: result.error };
    },
    start: (kind, project, params, actor) => {
      const run = async (): Promise<{ ok: boolean; output: string }> => {
        const result = kind === "deploy" ? await deployProject(project.id, "manual", params.branch ?? null)
          : kind === "rollback" ? await rollbackProject(project.id, params.deploymentId)
          : kind === "restart" ? await recreateProject(project.id)
          : await stopProject(project.id);
        auditLog(actor, `mcp.write.${kind}.finished`, String(project.id), result.ok ? "ok" : "fail", { triggeredBy: MCP_TRIGGER });
        return { ok: result.ok, output: result.output };
      };
      // "restart" is the recreate action; the other kinds keep their own names.
      const actionKind = kind === "restart" ? "recreate" : kind;
      return actionRegistry.tryStart(projectRepoKey(project.id), actionKind, { projectId: project.id, triggeredBy: MCP_TRIGGER, ...params }, run);
    },
    now: Date.now,
  };
}

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

function data(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Whether this token may act on the project: every project, or its group's. */
export function mayActOn(token: Pick<ApiToken, "projectGroup">, project: Pick<ProjectLike, "groupName">): boolean {
  return token.projectGroup === null || project.groupName === token.projectGroup;
}

interface ToolSpec {
  kind: WriteKind;
  title: string;
  description: string;
  extra: z.ZodRawShape;
  /** What would happen, or an error that stops before any confirmation is issued. */
  preview(project: ProjectLike, params: WriteParams, deps: WriteDeps): { summary: string; resolvedDeploymentId?: number } | { error: string };
}

const SPECS: ToolSpec[] = [
  {
    kind: "deploy",
    title: "Deploy project",
    description: "Pull the latest commit of the project's branch, build and start it. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: { branch: z.string().min(1).max(200).optional() },
    preview: (project, params) => {
      if (params.branch !== undefined && !isValidBranchName(params.branch)) return { error: "Invalid branch name." };
      const branch = params.branch ?? project.autoDeployBranch ?? "the project's configured branch";
      return { summary: `Deploy "${project.name}" from ${branch}: pull, build and recreate changed containers. The project is currently ${project.lastStatus}.` };
    },
  },
  {
    kind: "rollback",
    title: "Roll back project",
    description: "Restore an earlier deployment (the previous one unless deploymentId is given). Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: { deploymentId: z.number().int().positive().optional() },
    preview: (project, params, deps) => {
      const target = deps.rollbackTarget(project.id, params.deploymentId);
      if (!target.ok) return { error: target.error };
      return { summary: `Roll "${project.name}" back to ${target.commitSha ? `commit ${target.commitSha.slice(0, 7)}` : "the previous revision"}. The running revision is replaced.`, resolvedDeploymentId: target.id };
    },
  },
  {
    kind: "restart",
    title: "Restart project",
    description: "Recreate the project's containers from the revision that is running now, without pulling or building. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: {},
    preview: (project) => ({ summary: `Recreate every container of "${project.name}" from its current revision. There is a short outage. It is currently ${project.lastStatus}.` }),
  },
  {
    kind: "stop",
    title: "Stop project",
    description: "Stop the project's containers. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: {},
    preview: (project) => ({ summary: `Stop "${project.name}". It stays down until it is deployed or restarted. It is currently ${project.lastStatus}.` }),
  },
];

export function registerWriteTools(
  server: McpServer,
  token: ApiToken,
  deps: WriteDeps = defaultWriteDeps(),
  store: ConfirmationStore = confirmations,
): void {
  const actor = `token:${token.name}#${token.id}`;

  for (const spec of SPECS) {
    server.registerTool(
      `stackport_${spec.kind}_project`,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: { projectId: z.number().int().positive(), confirmationId: z.string().uuid().optional(), ...spec.extra },
        annotations: DESTRUCTIVE,
      },
      async (input: { projectId: number; confirmationId?: string; branch?: string; deploymentId?: number }) => {
        const { projectId, confirmationId } = input;
        const params: WriteParams = {
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
          ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
        };
        const tool = `stackport_${spec.kind}_project`;
        const refuse = (reason: string, message: string): CallToolResult => {
          auditLog(actor, "mcp.write", tool, "fail", { tokenId: token.id, projectId, reason });
          return text(message, true);
        };

        const project = deps.getProject(projectId);
        if (!project) return refuse("not-found", `No project with id ${projectId}.`);
        if (!mayActOn(token, project)) {
          return refuse("outside-group", `This token may only act on projects in the group "${token.projectGroup}". Project ${projectId} is not in it.`);
        }

        if (!confirmationId) {
          const preview = spec.preview(project, params, deps);
          if ("error" in preview) return refuse("preview-failed", preview.error);
          const { id, expiresAt } = store.issue(token.id, spec.kind, projectId, params, preview.resolvedDeploymentId);
          auditLog(actor, "mcp.write.preview", tool, "ok", { tokenId: token.id, projectId, ...params });
          return data({
            requiresConfirmation: true,
            summary: preview.summary,
            confirmationId: id,
            expiresAt: new Date(expiresAt).toISOString(),
            next: `Nothing has run. To proceed, call ${tool} again with the same arguments and this confirmationId.`,
          });
        }

        const confirmed = store.consume(confirmationId, token.id, spec.kind, projectId, params);
        if (!confirmed) {
          return refuse("bad-confirmation", "That confirmationId is unknown, expired, already used, or was issued for different arguments. Call the tool without it to get a new one.");
        }
        // A rollback runs the revision the preview named, not whatever is newest by now.
        const runParams: WriteParams = confirmed.resolvedDeploymentId !== undefined ? { ...params, deploymentId: confirmed.resolvedDeploymentId } : params;
        const started = deps.start(spec.kind, project, runParams, actor);
        if (!started) return refuse("busy", `Another action is already running for project ${projectId}. Try again when it has finished.`);
        auditLog(actor, "mcp.write", tool, "ok", { tokenId: token.id, projectId, actionId: started.id, ...params });
        return data({ started: true, actionId: started.id, kind: spec.kind, projectId, note: "The action runs in the background; check stackport_get_project for its state." });
      },
    );
  }
}
