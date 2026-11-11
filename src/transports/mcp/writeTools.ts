import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { actionRegistry, projectRepoKey } from "../../modules/actions/registry";
import { resolveRollbackTarget } from "../../modules/deployments/history";
import { deployProject, getProjectById, isValidBranchName, restartBlocker, restartProject, rollbackProject, stopProject } from "../../modules/deployments/operations";
import { auditLog } from "../../shared/logger";
import { listNetworkGroups } from "../../modules/projects/networkGroups";
import { assignNetworkGroup, NetworkGroupError, validateNetworkGroupAssignment } from "../../modules/deployments/networkGroupAssignment";
import { groupAlias } from "../../shared/networkGroups";
import { ensureDomainAvailable, listProjectDomains, ProjectDomainError } from "../../modules/ingress/domains";
import { realRenameDeps } from "../../modules/ingress/hostnameOps";
import { addManagedProjectDomain, hostnameFor, listManagedDomains, renameProjectHostname, validateLabel, type Canonical } from "../../modules/ingress/managedDomains";
import { GithubAppError } from "../../modules/github/app";
import type { AppRepository } from "../../modules/github/binding";
import { createAppProject, IMPORT_WARNING, projectForRepository, uniqueProjectName } from "../../modules/github/importer";
import { getInstallation, listRepositories } from "../../modules/github/store";
import { parseProjectGroupName } from "../../modules/projects/operations";

/**
 * Write tools for the HTTP MCP endpoint (S5): deploy, roll back, restart and stop. A token
 * needs the `write` scope, may only act on projects in its project group, and every
 * tool is two steps. The first call changes nothing: it describes what would happen and
 * returns a one-time confirmation id. Only a second call that presents that id runs it.
 * The server enforces this, so a client that skips its own approval prompt still cannot
 * act on a first call. Every call is audited, with the token as the actor.
 */

export type WriteKind = "deploy" | "rollback" | "restart" | "stop" | "network_group" | "hostname" | "repository";

export interface ProjectLike { id: number; name: string; groupName: string | null; lastStatus: string; autoDeployBranch: string | null }

export interface WriteDeps {
  getProject(id: number): ProjectLike | null;
  rollbackTarget(projectId: number, deploymentId?: number): { ok: true; id: number; commitSha: string | null } | { ok: false; error: string };
  /** Why the running revision cannot be restarted as it is (the checkout has moved on), or null. */
  restartBlocker?(projectId: number): Promise<string | null>;
  /** Starts the action in the project's action slot; null when another action holds it. */
  start(kind: WriteKind, project: ProjectLike, params: WriteParams, actor: string): { id: string } | null;
  now(): number;
}

export interface WriteParams { branch?: string; deploymentId?: number; networkGroup?: string | null; networkServices?: string[]; hostname?: string }

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
    hostname: params.hostname ?? null,
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
    restartBlocker,
    rollbackTarget: (projectId, deploymentId) => {
      const result = resolveRollbackTarget(projectId, deploymentId);
      return result.ok ? { ok: true, id: result.target.id, commitSha: result.target.commitSha ?? null } : { ok: false, error: result.error };
    },
    start: (kind, project, params, actor) => {
      const run = async (): Promise<{ ok: boolean; output: string }> => {
        const result = kind === "deploy" ? await deployProject(project.id, "manual", params.branch ?? null)
          : kind === "rollback" ? await rollbackProject(project.id, params.deploymentId)
          : kind === "restart" ? await restartProject(project.id)
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
  preview(project: ProjectLike, params: WriteParams, deps: WriteDeps): { summary: string; resolvedDeploymentId?: number } | { error: string } | Promise<{ summary: string; resolvedDeploymentId?: number } | { error: string }>;
}

const SPECS: ToolSpec[] = [
  {
    kind: "deploy",
    title: "Deploy project (destructive)",
    description: "DESTRUCTIVE: replaces the running containers with a new build of the branch's latest commit, with a short outage; container data that is not in a volume is lost, and a failed health check can leave the project down. Pulls the latest commit of the project's branch, builds and starts it. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: { branch: z.string().min(1).max(200).optional() },
    preview: (project, params) => {
      if (params.branch !== undefined && !isValidBranchName(params.branch)) return { error: "Invalid branch name." };
      const branch = params.branch ?? project.autoDeployBranch ?? "the project's configured branch";
      return { summary: `Deploy "${project.name}" from ${branch}: pull, build and recreate changed containers. The project is currently ${project.lastStatus}.` };
    },
  },
  {
    kind: "rollback",
    title: "Roll back project (destructive)",
    description: "DESTRUCTIVE: replaces the running revision with an earlier one, with a short outage; changes made by the newer revision are not undone in volumes or databases. Restores an earlier deployment (the previous one unless deploymentId is given). Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: { deploymentId: z.number().int().positive().optional() },
    preview: (project, params, deps) => {
      const target = deps.rollbackTarget(project.id, params.deploymentId);
      if (!target.ok) return { error: target.error };
      return { summary: `Roll "${project.name}" back to ${target.commitSha ? `commit ${target.commitSha.slice(0, 7)}` : "the previous revision"}. The running revision is replaced.`, resolvedDeploymentId: target.id };
    },
  },
  {
    kind: "restart",
    title: "Restart project (destructive)",
    description: "DESTRUCTIVE: removes and recreates every container of the project, with a short outage; container data that is not in a volume is lost. It uses the images already built for the running revision (no pull, no build) and is refused when the checkout has moved on since the last deployment, because that would start different code. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
    extra: {},
    preview: async (project, _params, deps) => {
      const blocker = await deps.restartBlocker?.(project.id);
      if (blocker) return { error: blocker };
      return { summary: `Recreate every container of "${project.name}" from the images of the running revision (no pull, no build). There is a short outage. It is currently ${project.lastStatus}.` };
    },
  },
  {
    kind: "stop",
    title: "Stop project (destructive)",
    description: "DESTRUCTIVE: stops and removes the project's containers; the project is down, and its domains stop working, until someone deploys or restarts it. Volumes are kept. Two steps: the first call returns what would happen and a confirmationId; call again with that id to run it.",
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
      title: "Set project network group (destructive)",
      description: "DESTRUCTIVE (security-sensitive): changes which projects can reach this project's services, and what it can reach, on any port. Applied to the running containers immediately; taking a service out cuts live connections to it. Puts a project in a network group, or take it out (empty group), and choose which of its services the group's other projects can reach (as <service>.p<projectId>). Nothing is shared unless listed in services. The services it shares can also reach what the others share. Two steps: the first call returns what would happen and a confirmationId; call again with the same arguments and that id to apply it.",
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

// ---- hostname (domain manager)

export interface HostnamePlan {
  projectId: number;
  /** The hostname being changed, or null when a new one is added. */
  replaces: { id: number; domain: string; useSsl: boolean } | null;
  managedDomainId: number;
  label: string;
  canonical: Canonical;
  newHostname: string;
}

export interface HostnameInput { hostname?: string; managedDomain: string; label: string; canonical?: Canonical }

/** What the hostname tool needs from the rest of Stackport (replaceable in tests). */
export interface HostnameDeps {
  /** Validates the request and says what it would do. Throws ProjectDomainError with a reason. */
  preview(projectId: number, input: HostnameInput): HostnamePlan;
  /** Runs it in the project's action slot, in the background; null when another action holds the slot. */
  start(plan: HostnamePlan, actor: string): { id: string } | null;
}

export function defaultHostnameDeps(): HostnameDeps {
  return {
    preview: (projectId, input) => {
      const base = listManagedDomains().find((d) => d.name === input.managedDomain.trim().toLowerCase());
      if (!base) throw new ProjectDomainError(400, `"${input.managedDomain}" is not a managed domain. Managed domains: ${listManagedDomains().map((d) => d.name).join(", ") || "none"}.`);
      const label = validateLabel(input.label, base.name);
      const canonical: Canonical = input.canonical === "www" ? "www" : "apex";
      const newHostname = label === "@" && canonical === "www" ? `www.${base.name}` : hostnameFor(label, base.name);
      const existing = listProjectDomains(projectId);
      let replaces: HostnamePlan["replaces"] = null;
      if (input.hostname !== undefined) {
        const found = existing.find((d) => d.domain.toLowerCase() === input.hostname?.trim().toLowerCase());
        if (!found) throw new ProjectDomainError(404, `This project has no hostname "${input.hostname}". Its hostnames: ${existing.map((d) => d.domain).join(", ") || "none"}.`);
        replaces = { id: found.id, domain: found.domain, useSsl: found.useSsl };
      } else if (existing.length === 1) {
        replaces = { id: existing[0].id, domain: existing[0].domain, useSsl: existing[0].useSsl };
      } else if (existing.length > 1) {
        throw new ProjectDomainError(400, `This project has several hostnames (${existing.map((d) => d.domain).join(", ")}). Say which one to change with "hostname".`);
      }
      if (replaces && replaces.domain.toLowerCase() === newHostname.toLowerCase()) throw new ProjectDomainError(400, "That is already this hostname.");
      ensureDomainAvailable(newHostname);
      if (label === "@" && canonical === "www") ensureDomainAvailable(base.name);
      return { projectId, replaces, managedDomainId: base.id, label, canonical, newHostname };
    },
    start: (plan, actor) => {
      const kind = plan.replaces ? "domain-rename" : "domain-add";
      return actionRegistry.tryStart(projectRepoKey(plan.projectId), kind, { projectId: plan.projectId, triggeredBy: MCP_TRIGGER }, async () => {
        const deps = realRenameDeps(plan.projectId);
        if (plan.replaces) {
          const result = await renameProjectHostname(plan.projectId, plan.replaces.id, { managedDomainId: plan.managedDomainId, label: plan.label, canonical: plan.canonical }, deps);
          auditLog(actor, "mcp.write.hostname.finished", String(plan.projectId), result.ok ? "ok" : "fail", { hostname: plan.newHostname, reason: result.reason });
          return { ok: result.ok, output: [...result.steps, ...(result.reason ? [result.reason] : [])].join("\n") };
        }
        addManagedProjectDomain(plan.projectId, plan.managedDomainId, plan.label, "", null, plan.canonical);
        const applied = await deps.applyNginx();
        auditLog(actor, "mcp.write.hostname.finished", String(plan.projectId), applied.ok ? "ok" : "fail", { hostname: plan.newHostname });
        return { ok: applied.ok, output: `Added ${plan.newHostname} (not routed yet: pick a service).` };
      });
    },
  };
}

function registerHostnameTool(server: McpServer, token: ApiToken, deps: WriteDeps, hosts: HostnameDeps, store: ConfirmationStore): void {
  const actor = `token:${token.name}#${token.id}`;
  const tool = "stackport_set_project_hostname";
  server.registerTool(
    tool,
    {
      title: "Set project hostname (destructive)",
      description: "DESTRUCTIVE: changes where traffic for this project goes. Renames one of the project's hostnames (or adds one when it has none) to a label on a managed domain, or to the bare domain with label \"@\". The new hostname is added, routed and, if the old one had SSL, given a certificate first; then the old hostname stops answering at once, with no redirect, so anyone using it gets an error. For the bare domain, canonical chooses which name is served: \"apex\" (www redirects to it) or \"www\" (the bare domain redirects to www). Adding or removing a managed domain is not available here. Two steps: the first call returns what would happen and a confirmationId; call again with the same arguments and that id to run it.",
      inputSchema: {
        projectId: z.number().int().positive(),
        managedDomain: z.string().min(3).max(253).describe("One of the managed domains, as listed by stackport_list_managed_domains."),
        label: z.string().min(1).max(63).describe("The label in front of the managed domain, or @ for the bare domain."),
        hostname: z.string().min(3).max(253).optional().describe("The hostname to change. Optional when the project has exactly one."),
        canonical: z.enum(["apex", "www"]).optional().describe("With label @: which name is served, the other redirects to it. Default apex."),
        confirmationId: z.string().uuid().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (input: { projectId: number; managedDomain: string; label: string; hostname?: string; canonical?: Canonical; confirmationId?: string }) => {
      const { projectId, confirmationId } = input;
      const refuse = (reason: string, message: string): CallToolResult => {
        auditLog(actor, "mcp.write", tool, "fail", { tokenId: token.id, projectId, reason });
        return text(message, true);
      };
      const project = deps.getProject(projectId);
      if (!project) return refuse("not-found", `No project with id ${projectId}.`);
      if (!mayActOn(token, project)) return refuse("outside-group", `This token may only act on projects in the group "${token.projectGroup}". Project ${projectId} is not in it.`);

      let plan: HostnamePlan;
      try { plan = hosts.preview(projectId, { hostname: input.hostname, managedDomain: input.managedDomain, label: input.label, canonical: input.canonical }); }
      catch (err) {
        if (err instanceof ProjectDomainError) return refuse("invalid", err.message);
        throw err;
      }
      // The confirmation is for exactly this change: the hostname it replaces and the one it creates.
      const params: WriteParams = { hostname: `${plan.replaces?.domain ?? "-"}>${plan.newHostname}` };
      if (!confirmationId) {
        const redirect = plan.label === "@" ? ` ${plan.canonical === "www" ? `The bare domain redirects to ${plan.newHostname}.` : "www redirects to it."}` : "";
        const summary = plan.replaces
          ? `Rename the hostname ${plan.replaces.domain} of "${project.name}" to ${plan.newHostname}. The new hostname is added and routed first${plan.replaces.useSsl ? ", and a certificate is issued for it" : ""}; then ${plan.replaces.domain} stops answering at once, with no redirect.${redirect}`
          : `Add the hostname ${plan.newHostname} to "${project.name}". It is not routed to a service yet.${redirect}`;
        const { id, expiresAt } = store.issue(token.id, "hostname", projectId, params);
        auditLog(actor, "mcp.write.preview", tool, "ok", { tokenId: token.id, projectId, from: plan.replaces?.domain ?? null, to: plan.newHostname });
        return data({ requiresConfirmation: true, summary, confirmationId: id, expiresAt: new Date(expiresAt).toISOString(), next: `Nothing has changed. To proceed, call ${tool} again with the same arguments and this confirmationId.` });
      }
      if (!store.consume(confirmationId, token.id, "hostname", projectId, params)) {
        return refuse("bad-confirmation", "That confirmationId is unknown, expired, already used, or was issued for different arguments. Call the tool without it to get a new one.");
      }
      const started = hosts.start(plan, actor);
      if (!started) return refuse("busy", `Another action is already running for project ${projectId}. Try again when it has finished.`);
      auditLog(actor, "mcp.write", tool, "ok", { tokenId: token.id, projectId, actionId: started.id, to: plan.newHostname });
      return data({ started: true, actionId: started.id, projectId, newHostname: plan.newHostname, note: "The change runs in the background; check stackport_get_project for its state." });
    },
  );
}

// ---- create a project from a GitHub App repository

export interface RepositoryPlan { repository: AppRepository; name: string; groupName: string | null }

export interface RepositoryInput { repository: string; name?: string; group?: string }

/** What the repository tool needs from the rest of Stackport (replaceable in tests). */
export interface RepositoryDeps {
  /** Validates the request against what the App can use. Throws GithubAppError with a reason. */
  preview(input: RepositoryInput, token: Pick<ApiToken, "projectGroup">): RepositoryPlan;
  create(plan: RepositoryPlan): { projectId: number; name: string; hostname: string | null };
}

export function defaultRepositoryDeps(): RepositoryDeps {
  return {
    preview: (input, token) => {
      const wanted = input.repository.trim().toLowerCase();
      const match = listRepositories().find((r) => r.fullName.toLowerCase() === wanted && getInstallation(r.installationId)?.status === "linked");
      if (!match) {
        const some = listRepositories().slice(0, 15).map((r) => r.fullName).join(", ");
        throw new GithubAppError(`"${input.repository}" is not a repository the GitHub App can use.${some ? ` Some that it can: ${some}.` : " No account is connected."}`, 404);
      }
      const existing = projectForRepository(match.repositoryId);
      if (existing) throw new GithubAppError(`${match.fullName} already deploys as the project "${existing.name}" (id ${existing.id}).`, 409);
      let groupName: string | null = input.group?.trim() || null;
      if (token.projectGroup !== null) {
        // A token limited to a group creates projects inside it, so the project stays within what the token may act on.
        if (groupName !== null && groupName !== token.projectGroup) throw new GithubAppError(`This token may only create projects in the group "${token.projectGroup}".`, 403);
        groupName = token.projectGroup;
      }
      try { parseProjectGroupName(groupName); } catch (err) { throw new GithubAppError(err instanceof Error ? err.message : "Invalid group.", 400); }
      return { repository: { installationId: match.installationId, repositoryId: match.repositoryId, fullName: match.fullName, defaultBranch: match.defaultBranch }, name: uniqueProjectName(input.name?.trim() || match.fullName.split("/")[1] || match.fullName), groupName };
    },
    create: (plan) => {
      const project = createAppProject(plan.repository, { name: plan.name, groupName: plan.groupName });
      const host = listProjectDomains(project.id)[0];
      return { projectId: project.id, name: project.name, hostname: host?.domain ?? null };
    },
  };
}

function registerRepositoryTool(server: McpServer, token: ApiToken, repos: RepositoryDeps, store: ConfirmationStore): void {
  const actor = `token:${token.name}#${token.id}`;
  const tool = "stackport_create_project_from_repository";
  server.registerTool(
    tool,
    {
      title: "Create project from a GitHub repository (destructive)",
      description: "DESTRUCTIVE: creates a project that pulls code from a repository the GitHub App can use and, once someone deploys it, runs that code on this host. Anyone who can push to the repository controls what runs. The project is bound to the repository, on its default branch, and reserves a hostname when a default domain is set; nothing is cloned or deployed by this call. Use stackport_list_github_repositories to see what is available. A token limited to a project group creates the project inside that group. Two steps: the first call returns what would happen and a confirmationId; call again with the same arguments and that id to create it.",
      inputSchema: {
        repository: z.string().min(3).max(200).describe("owner/name, as listed by stackport_list_github_repositories."),
        name: z.string().min(1).max(100).optional().describe("The project's name. Default: the repository's name."),
        group: z.string().max(100).optional().describe("The project group. A token limited to a group always uses its own."),
        confirmationId: z.string().uuid().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (input: { repository: string; name?: string; group?: string; confirmationId?: string }) => {
      const refuse = (reason: string, message: string): CallToolResult => {
        auditLog(actor, "mcp.write", tool, "fail", { tokenId: token.id, repository: input.repository, reason });
        return text(message, true);
      };
      let plan: RepositoryPlan;
      try { plan = repos.preview({ repository: input.repository, name: input.name, group: input.group }, token); }
      catch (err) {
        if (err instanceof GithubAppError) return refuse("invalid", err.message);
        throw err;
      }
      // The confirmation is for exactly this repository, name and group.
      const params: WriteParams = { hostname: `${plan.repository.repositoryId}|${plan.name}|${plan.groupName ?? ""}` };
      if (!input.confirmationId) {
        const { id, expiresAt } = store.issue(token.id, "repository", plan.repository.repositoryId, params);
        auditLog(actor, "mcp.write.preview", tool, "ok", { tokenId: token.id, repository: plan.repository.fullName });
        return data({
          requiresConfirmation: true,
          summary: `Create the project "${plan.name}"${plan.groupName ? ` in the group "${plan.groupName}"` : ""} from ${plan.repository.fullName}${plan.repository.defaultBranch ? ` (branch ${plan.repository.defaultBranch})` : ""}. Nothing is cloned or deployed yet. ${IMPORT_WARNING}`,
          confirmationId: id,
          expiresAt: new Date(expiresAt).toISOString(),
          next: `Nothing has been created. To proceed, call ${tool} again with the same arguments and this confirmationId.`,
        });
      }
      if (!store.consume(input.confirmationId, token.id, "repository", plan.repository.repositoryId, params)) {
        return refuse("bad-confirmation", "That confirmationId is unknown, expired, already used, or was issued for different arguments. Call the tool without it to get a new one.");
      }
      const created = repos.create(plan);
      auditLog(actor, "mcp.write", tool, "ok", { tokenId: token.id, repository: plan.repository.fullName, projectId: created.projectId });
      return data({ created: true, projectId: created.projectId, name: created.name, hostname: created.hostname, note: "The project exists but has not been deployed. Deploy it with stackport_deploy_project." });
    },
  );
}

export function registerWriteTools(
  server: McpServer,
  token: ApiToken,
  deps: WriteDeps = defaultWriteDeps(),
  store: ConfirmationStore = confirmations,
  net: NetworkDeps = defaultNetworkDeps(),
  hosts: HostnameDeps = defaultHostnameDeps(),
  repos: RepositoryDeps = defaultRepositoryDeps(),
): void {
  const actor = `token:${token.name}#${token.id}`;
  registerNetworkGroupTool(server, token, deps, net, store);
  registerHostnameTool(server, token, deps, hosts, store);
  registerRepositoryTool(server, token, repos, store);

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
          const preview = await spec.preview(project, params, deps);
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
