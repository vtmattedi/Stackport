import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { actionRegistry, projectRepoKey } from "../../modules/actions/registry";
import { resolveRollbackTarget } from "../../modules/deployments/history";
import { deployProject, getProjectById, isValidBranchName, recreateProject, rollbackProject, stopProject } from "../../modules/deployments/operations";
import { auditLog } from "../../shared/logger";
import { listNetworkGroups } from "../../modules/projects/networkGroups";
import { assignNetworkGroup, NetworkGroupError, validateNetworkGroupAssignment } from "../../modules/deployments/networkGroupAssignment";
import { groupAlias } from "../../shared/networkGroups";

/**
 * Write tools for the HTTP MCP endpoint (S5): deploy, roll back, restart and stop. A token
 * needs the `write` scope, may only act on projects in its project group, and every
 * tool is two steps. The first call changes nothing: it describes what would happen and
 * returns a one-time confirmation id. Only a second call that presents that id runs it.
 * The server enforces this, so a client that skips its own approval prompt still cannot
 * act on a first call. Every call is audited, with the token as the actor.
 */

export type WriteKind = "deploy" | "rollback" | "restart" | "stop" | "network_group";

export interface ProjectLike { id: number; name: string; groupName: string | null; lastStatus: string; autoDeployBranch: string | null }

export interface WriteDeps {
  getProject(id: number): ProjectLike | null;
  rollbackTarget(projectId: number, deploymentId?: number): { ok: true; id: number; commitSha: string | null } | { ok: false; error: string };
  /** Starts the action in the project's action slot; null when another action holds it. */
  start(kind: WriteKind, project: ProjectLike, params: WriteParams, actor: string): { id: string } | null;
  now(): number;
}

export interface WriteParams { branch?: string; deploymentId?: number; networkGroup?: string | null; networkServices?: string[] }

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
  return JSON.stringify({
    branch: params.branch ?? null, deploymentId: params.deploymentId ?? null,
    networkGroup: params.networkGroup ?? null, networkServices: params.networkServices ? [...params.networkServices].sort() : null,
  });
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

/** What the network-group tool needs from the rest of Stackport (replaceable in tests). */
export interface NetworkDeps {
  /** The request as it would be stored, plus the other projects already in that group. Throws NetworkGroupError. */
  preview(projectId: number, group: unknown, services: unknown): Promise<{ group: string | null; services: string[]; currentGroup: string | null; peers: { name: string; visualGroup: string | null }[] }>;
  apply(projectId: number, group: string | null, services: string[]): Promise<{ applied: boolean; warning?: string }>;
}

export function defaultNetworkDeps(): NetworkDeps {
  return {
    preview: async (projectId, group, services) => {
      const valid = await validateNetworkGroupAssignment(projectId, group, services);
      const all = listNetworkGroups();
      const current = all.find((g) => g.projects.some((p) => p.projectId === projectId))?.group ?? null;
      const peers = valid.group ? (all.find((g) => g.group === valid.group)?.projects ?? []).filter((p) => p.projectId !== projectId).map((p) => ({ name: p.name, visualGroup: p.visualGroup })) : [];
      return { ...valid, currentGroup: current, peers };
    },
    apply: async (projectId, group, services) => {
      const { applied, warning } = await assignNetworkGroup(projectId, group, services);
      return { applied, ...(warning ? { warning } : {}) };
    },
  };
}

/** A token limited to a project group may not join a network group that has projects outside its group:
 *  that would give its projects a path to services it could not otherwise touch. */
export function networkGroupScopeProblem(token: Pick<ApiToken, "projectGroup">, group: string | null, peers: { name: string; visualGroup: string | null }[]): string | null {
  if (token.projectGroup === null || group === null) return null;
  const outside = peers.filter((p) => p.visualGroup !== token.projectGroup).map((p) => p.name);
  return outside.length
    ? `This token is limited to the project group "${token.projectGroup}", and the network group "${group}" has projects outside it (${outside.join(", ")}).`
    : null;
}

function registerNetworkGroupTool(server: McpServer, token: ApiToken, deps: WriteDeps, net: NetworkDeps, store: ConfirmationStore): void {
  const actor = `token:${token.name}#${token.id}`;
  const tool = "stackport_set_network_group";
  server.registerTool(
    tool,
    {
      title: "Set project network group",
      description: "Put a project in a network group, or take it out (empty group), and choose which of its services the group's other projects can reach (as <service>.p<projectId>). Nothing is shared unless listed in services. The services it shares can also reach what the others share. Two steps: the first call returns what would happen and a confirmationId; call again with the same arguments and that id to apply it.",
      inputSchema: {
        projectId: z.number().int().positive(),
        group: z.string().max(40).describe("Lower-case letters, digits, - and _. Empty to leave the group."),
        services: z.array(z.string().min(1).max(63)).max(50).optional().describe("Compose services to share. Default: none."),
        confirmationId: z.string().uuid().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (input: { projectId: number; group: string; services?: string[]; confirmationId?: string }) => {
      const { projectId, confirmationId } = input;
      const refuse = (reason: string, message: string): CallToolResult => {
        auditLog(actor, "mcp.write", tool, "fail", { tokenId: token.id, projectId, reason });
        return text(message, true);
      };
      const project = deps.getProject(projectId);
      if (!project) return refuse("not-found", `No project with id ${projectId}.`);
      if (!mayActOn(token, project)) {
        return refuse("outside-group", `This token may only act on projects in the group "${token.projectGroup}". Project ${projectId} is not in it.`);
      }
      let preview: Awaited<ReturnType<NetworkDeps["preview"]>>;
      try { preview = await net.preview(projectId, input.group, input.services ?? []); }
      catch (err) {
        if (err instanceof NetworkGroupError) return refuse("invalid", err.message);
        throw err;
      }
      // Checked on both calls: the group's members can change between the preview and the confirmation.
      const scope = networkGroupScopeProblem(token, preview.group, preview.peers);
      if (scope) return refuse("outside-group-peers", scope);

      const params: WriteParams = { networkGroup: preview.group, networkServices: preview.services };
      if (!confirmationId) {
        const peerNames = preview.peers.length ? preview.peers.map((p) => p.name).join(", ") : "none yet";
        const summary = preview.group === null
          ? `Take "${project.name}" out of its network group${preview.currentGroup ? ` "${preview.currentGroup}"` : ""}. Its services stop being reachable from, and stop reaching, the other projects in it.`
          : `Put "${project.name}" in network group "${preview.group}" and share ${preview.services.length ? preview.services.map((s) => `${s} (as ${groupAlias(projectId, s)})`).join(", ") : "no services"}. Other projects in the group: ${peerNames}. They can reach what is shared, and the shared services can reach what they share, on any port.`;
        const { id, expiresAt } = store.issue(token.id, "network_group", projectId, params);
        auditLog(actor, "mcp.write.preview", tool, "ok", { tokenId: token.id, projectId, group: preview.group, services: preview.services });
        return data({
          requiresConfirmation: true,
          summary,
          confirmationId: id,
          expiresAt: new Date(expiresAt).toISOString(),
          next: `Nothing has changed. To proceed, call ${tool} again with the same arguments and this confirmationId.`,
        });
      }
      if (!store.consume(confirmationId, token.id, "network_group", projectId, params)) {
        return refuse("bad-confirmation", "That confirmationId is unknown, expired, already used, or was issued for different arguments. Call the tool without it to get a new one.");
      }
      const result = await net.apply(projectId, preview.group, preview.services);
      auditLog(actor, "mcp.write", tool, "ok", { tokenId: token.id, projectId, group: preview.group, services: preview.services, applied: result.applied });
      return data({
        done: true,
        projectId,
        group: preview.group,
        services: preview.services.map((service) => ({ service, hostname: groupAlias(projectId, service) })),
        applied: result.applied,
        ...(result.warning ? { warning: `Saved, but not applied to the running containers (${result.warning}). It applies on the next deploy.` } : {}),
      });
    },
  );
}

export function registerWriteTools(
  server: McpServer,
  token: ApiToken,
  deps: WriteDeps = defaultWriteDeps(),
  store: ConfirmationStore = confirmations,
  net: NetworkDeps = defaultNetworkDeps(),
): void {
  const actor = `token:${token.name}#${token.id}`;
  registerNetworkGroupTool(server, token, deps, net, store);

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
