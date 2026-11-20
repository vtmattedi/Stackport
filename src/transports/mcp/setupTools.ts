import { createHmac, randomBytes } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDatabase } from "../../config/database";
import { actionRegistry, projectRepoKey, projectSslKey } from "../../modules/actions/registry";
import { getProjectBranches } from "../../modules/automation/githubPolling";
import { validateDomainRoute } from "../../modules/deployments/domainRoute";
import { getProjectById, getProjectComposeEnvFiles, getProjectComposeVariables, getProjectIngressTargets, scanComposeFiles, validateComposeFileChoice } from "../../modules/deployments/operations";
import { inspectRepository, resolveAppRepository } from "../../modules/github/binding";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { addProjectDomain, ensureDomainAvailable, getProjectDomain, listProjectDomains, parseDomainName, ProjectDomainError, setProjectDomainRoute, setProjectDomainSsl, type ProjectDomain } from "../../modules/ingress/domains";
import { startProjectDomainRoute } from "../../modules/ingress/hostnameOps";
import { BranchDeploymentError, createBranchDeployment, listBranchDeployments, type BranchDeployment } from "../../modules/projects/branchDeployments";
import { isValidBranchName } from "../../modules/projects/branchName";
import { deleteProjectEnvFile, EnvFileUnreadableError, listProjectEnvFiles, normalizeEnvRelativePath, parseEnvVariables, patchProjectEnvFile, projectEnvOwner, SharedProjectEnvError } from "../../modules/projects/envFiles";
import { ProjectAdminError, updateProject } from "../../modules/projects/operations";
import type { Project } from "../../modules/projects/types";
import { projectRepoDir } from "../../modules/projects/workspace";
import { base32Encode } from "../../shared/base32";
import { auditLog } from "../../shared/logger";
import { confirmationOwner, confirmations, mayActOn } from "./writeTools";

const projectInput = { projectId: z.number().int().positive() };
const writeInput = { ...projectInput, confirmationId: z.string().uuid().optional() };
const branch = z.string().max(200).refine(isValidBranchName, "Choose a valid Git branch.");
const envPath = z.string().max(512).describe("Path relative to the checkout, ending in .env.");
const envKey = z.string().max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const routeInput = { service: z.string().min(1).max(255), containerPort: z.number().int().min(1).max(65535) };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const bindingKey = randomBytes(32);

class SetupError extends Error {}

function data(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function scopedProject(token: ApiToken, projectId: number): Project | null {
  const project = getProjectById(projectId);
  return project && mayActOn(token, project) ? project : null;
}

function branchView(project: BranchDeployment) {
  const domain = project.domains[0];
  const url = domain ? new URL(`${domain.useSsl ? "https" : "http"}://${domain.domain}`).href : null;
  return { projectId: project.id, branch: project.autoDeployBranch, env: project.branchShareEnv ? "shared" : "separate", commentOnPullRequest: project.branchComment, url };
}

function envMetadata(projectId: number) {
  return listProjectEnvFiles(projectId).map(({ relativePath, unreadable, variables }) => ({
    relativePath, unreadable, keys: variables.map(({ key }) => key),
  }));
}

function checkedEnvPath(project: Project, requested: string): string {
  const path = normalizeEnvRelativePath(requested);
  if (!path) throw new SetupError("Provide a valid relative path ending in .env.");
  if (projectEnvOwner(project.id) !== project.id) throw new SharedProjectEnvError();
  return path;
}

export function registerSetupReadTools(server: McpServer, token: ApiToken): void {
  server.registerTool("stackport_get_project_setup", {
    title: "Get project setup",
    description: "Project branch, separate deployments and their URLs, managed env file paths and key names, Compose inputs and declared ingress targets, and domain IDs and routes. Pull the repository to inspect its Compose file.",
    inputSchema: projectInput,
    annotations: readOnly,
  }, async ({ projectId }) => {
    const project = scopedProject(token, projectId);
    if (!project) return error("Project not found.");
    const ownerId = projectEnvOwner(projectId);
    const canReadEnv = ownerId === projectId || scopedProject(token, ownerId) !== null;
    let compose: object | null = null;
    if (project.composeFile) {
      const [targets, files, variables] = await Promise.allSettled([
        getProjectIngressTargets(projectId),
        getProjectComposeEnvFiles(projectId),
        canReadEnv ? getProjectComposeVariables(projectId) : Promise.resolve([]),
      ]);
      compose = {
        targets: targets.status === "fulfilled" ? targets.value : null,
        envFileReferences: files.status === "fulfilled" ? files.value : null,
        variables: variables.status === "fulfilled" ? variables.value : null,
        ...(targets.status === "rejected" ? { routingHint: "Compose targets could not be resolved. Check the selected file and required env variables." } : {}),
      };
    }
    return data({
      projectId,
      branch: project.autoDeployBranch,
      composeFile: project.composeFile,
      composeFiles: project.availableComposeFiles,
      compose,
      env: { shared: ownerId !== projectId, ownerProjectId: canReadEnv ? ownerId : null, files: canReadEnv ? envMetadata(projectId) : null },
      domains: listProjectDomains(projectId),
      branchDeployments: listBranchDeployments(projectId).filter((child) => mayActOn(token, child)).map(branchView),
    });
  });

  server.registerTool("stackport_list_project_branches", {
    title: "List project branches",
    description: "List branches and their latest commit IDs for a project's GitHub repository.",
    inputSchema: { ...projectInput, refresh: z.boolean().optional() },
    annotations: readOnly,
  }, async ({ projectId, refresh }) => {
    const project = scopedProject(token, projectId);
    if (!project) return error("Project not found.");
    try {
      const branches = await getProjectBranches(project, { refresh });
      return data({ branches: branches.map(({ name, sha }) => ({ name, sha })) });
    } catch {
      return error("Could not fetch branches. Check the project's GitHub connection.");
    }
  });

  server.registerTool("stackport_inspect_project_repository", {
    title: "Inspect project repository",
    description: "Inspect a GitHub App project's branch before pulling it. Returns Compose filenames and variable names from an example env file.",
    inputSchema: { ...projectInput, branch: branch.optional() },
    annotations: readOnly,
  }, async ({ projectId, branch: requested }) => {
    const project = scopedProject(token, projectId);
    if (!project) return error("Project not found.");
    if (project.githubAuthMode !== "app") return error("This project needs a GitHub App connection.");
    try {
      const repository = resolveAppRepository(project.githubInstallationId, project.githubRepositoryId);
      const selected = requested ?? project.autoDeployBranch ?? repository.defaultBranch;
      if (!selected) return error("Choose a branch to inspect.");
      return data({ branch: selected, ...await inspectRepository(repository, selected) });
    } catch {
      return error("Could not inspect the repository. Check the GitHub connection and branch.");
    }
  });
}

interface Change {
  summary: string;
  subject?: string | number;
  apply(): Record<string, unknown>;
}

function requireIdleCheckout(projectId: number): void {
  if (actionRegistry.get(projectRepoKey(projectId))?.status === "running") {
    throw new SetupError("An action is already running for this project. Try again once it finishes.");
  }
}

function applyDomain(domain: ProjectDomain, actor: string) {
  const action = startProjectDomainRoute(domain, actor);
  if (!action) throw new SetupError("A domain action is already running.");
  return { domain, actionId: action.id };
}

export function registerSetupWriteTools(server: McpServer, token: ApiToken): void {
  const actor = `token:${token.name}#${token.id}`;
  async function change<I extends { projectId: number; confirmationId?: string }>(
    tool: string, input: I, plan: (project: Project) => Change | Promise<Change>,
  ): Promise<CallToolResult> {
    const { projectId, confirmationId, ...args } = input;
    const project = scopedProject(token, projectId);
    if (!project) return error("Project not found.");
    const owner = confirmationOwner(token);
    const target = { tokenId: token.id, projectId };
    try {
      const prepared = await plan(project);
      // Bind the arguments and resolved target without retaining submitted env values.
      const configuration = createHmac("sha256", bindingKey)
        .update(JSON.stringify([tool, project.groupName, args, prepared.subject])).digest("hex");
      if (!confirmationId) {
        const { id, expiresAt } = confirmations.issue(owner, "setup", projectId, { configuration });
        auditLog(actor, "mcp.write.preview", tool, "ok", target);
        return data({ requiresConfirmation: true, summary: prepared.summary, confirmationId: id, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (!confirmations.consume(confirmationId, owner, "setup", projectId, { configuration })) {
        return error("Confirmation is invalid or expired. Preview the change again.");
      }
      // Recheck scope after plans that inspect the checkout asynchronously.
      if (!scopedProject(token, projectId)) return error("Project not found.");
      const result = await prepared.apply();
      auditLog(actor, "mcp.write", tool, "ok", target);
      return data(result);
    } catch (err) {
      auditLog(actor, "mcp.write", tool, "fail", target);
      if (err instanceof SetupError || err instanceof ProjectAdminError || err instanceof BranchDeploymentError ||
        err instanceof ProjectDomainError || err instanceof EnvFileUnreadableError || err instanceof SharedProjectEnvError) return error(err.message);
      return error("Stackport could not complete the change.");
    }
  }

  const setEnv = "stackport_set_project_env_file";
  server.registerTool(setEnv, {
    title: "Edit managed env file (destructive)",
    description: "DESTRUCTIVE: creates a managed env file or sets and removes individual keys. Other keys are preserved. Responses omit all values. Preview the change first, then confirm it with the same arguments.",
    inputSchema: {
      ...writeInput, relativePath: envPath,
      variables: z.array(z.object({ key: envKey, value: z.string().max(131072) })).max(200).optional(),
      removeKeys: z.array(envKey).max(200).optional(),
    },
    annotations: destructive,
  }, (input) => change(setEnv, input, (project) => {
    const relativePath = checkedEnvPath(project, input.relativePath);
    const variables = parseEnvVariables(input.variables ?? []);
    const removeKeys = input.removeKeys ?? [];
    if (!variables || variables.some(({ key }) => removeKeys.includes(key))) throw new SetupError("Use distinct keys, single-line values, and a separate list of keys to remove.");
    if (!variables.length && !removeKeys.length) throw new SetupError("Provide keys to set or remove.");
    return {
      summary: `Edit ${relativePath} for "${project.name}". Set: ${variables.map(({ key }) => key).join(", ") || "none"}. Remove: ${removeKeys.join(", ") || "none"}.`,
      apply: () => {
        patchProjectEnvFile(project.id, relativePath, variables, removeKeys);
        return { ok: true };
      },
    };
  }));

  const deleteEnv = "stackport_delete_project_env_file";
  server.registerTool(deleteEnv, {
    title: "Delete managed env file (destructive)",
    description: "DESTRUCTIVE: delete a managed env file and all its stored keys. The next deploy reconciles the copy on disk. Preview first, then confirm.",
    inputSchema: { ...writeInput, relativePath: envPath },
    annotations: destructive,
  }, (input) => change(deleteEnv, input, (project) => {
    const relativePath = checkedEnvPath(project, input.relativePath);
    const file = listProjectEnvFiles(project.id).find((candidate) => candidate.relativePath === relativePath);
    if (!file) throw new SetupError("Managed env file not found.");
    return {
      summary: `Delete ${relativePath} and all its keys from "${project.name}".`,
      subject: file.id,
      apply: () => {
        if (!deleteProjectEnvFile(file.id, project.id)) throw new SetupError("Managed env file not found.");
        return { ok: true };
      },
    };
  }));

  const generateEnv = "stackport_generate_project_env_value";
  server.registerTool(generateEnv, {
    title: "Generate and save an env value (destructive)",
    description: "DESTRUCTIVE: generate a cryptographically random value and write it directly to a managed env file key. Size is bytes before encoding. A confirmed write returns only success. Preview first, then confirm with the same arguments.",
    inputSchema: {
      ...writeInput, relativePath: envPath, key: envKey,
      // Four bytes produce at least six characters in every format, the minimum the log masker covers.
      size: z.number().int().min(4).max(65536).describe("Number of random bytes to encode (4–65536)."),
      format: z.enum(["hex", "b32", "b64", "b64url"]).describe("Encoding. Base32 and Base64url omit padding."),
    },
    annotations: destructive,
  }, (input) => change(generateEnv, input, (project) => {
    const relativePath = checkedEnvPath(project, input.relativePath);
    return {
      summary: `Generate ${input.size} random bytes in ${input.format} and save them to ${input.key} in ${relativePath} for "${project.name}". Any existing value for this key will be replaced.`,
      apply: () => {
        const bytes = randomBytes(input.size);
        const encoding = input.format === "b64" ? "base64" : input.format === "b64url" ? "base64url" : "hex";
        const value = input.format === "b32" ? base32Encode(bytes) : bytes.toString(encoding);
        patchProjectEnvFile(project.id, relativePath, [{ key: input.key, value }]);
        return { ok: true };
      },
    };
  }));

  const setBranch = "stackport_set_project_branch";
  server.registerTool(setBranch, {
    title: "Set project branch (destructive)",
    description: "DESTRUCTIVE: saves the project branch for future pulls and deploys. An existing branch deployment is pinned to its own branch. Preview first, then confirm.",
    inputSchema: { ...writeInput, branch },
    annotations: destructive,
  }, (input) => change(setBranch, input, (project) => {
    if (project.sourceType !== "github") throw new SetupError("Only GitHub projects have a branch.");
    return {
      summary: `Set the branch for "${project.name}" to ${input.branch}.`,
      apply: () => {
        requireIdleCheckout(project.id);
        const updated = updateProject(project.id, { autoDeployBranch: input.branch }).project;
        return { projectId: updated.id, branch: updated.autoDeployBranch };
      },
    };
  }));

  const createBranch = "stackport_create_branch_deployment";
  server.registerTool(createBranch, {
    title: "Create branch deployment (destructive)",
    description: "DESTRUCTIVE: creates a separate deployment and reserves a URL for another branch of a GitHub project. Choose shared or separate env files. Optionally post the URL to its pull request once live. Preview first, then confirm and deploy the returned projectId.",
    inputSchema: { ...writeInput, branch, env: z.enum(["shared", "separate"]), commentOnPullRequest: z.boolean().optional() },
    annotations: destructive,
  }, (input) => change(createBranch, input, (project) => ({
    summary: `Create a deployment of ${input.branch} for "${project.name}" with ${input.env} env files.${input.commentOnPullRequest ? " Post the URL to its GitHub pull request once it is live." : ""}`,
    apply: () => branchView(createBranchDeployment(project.id, input)),
  })));

  const selectCompose = "stackport_set_project_compose_file";
  server.registerTool(selectCompose, {
    title: "Set project Compose file (destructive)",
    description: "DESTRUCTIVE: select a Compose file from the root of the current checkout for future deployments. Pull the branch first. Preview first, then confirm.",
    inputSchema: { ...writeInput, composeFile: z.string().min(1).max(256) },
    annotations: destructive,
  }, (input) => change(selectCompose, input, async (project) => {
    requireIdleCheckout(project.id);
    const candidates = await scanComposeFiles(projectRepoDir(project));
    const composeFile = validateComposeFileChoice(input.composeFile, candidates);
    if (!composeFile) throw new SetupError("Choose a Compose file from the current checkout. Use stackport_get_project_setup to list the files.");
    return {
      summary: `Use ${composeFile} for "${project.name}" on its next deployment.`,
      apply: () => {
        requireIdleCheckout(project.id);
        getDatabase().prepare("UPDATE projects SET compose_file = ?, updated_at = ? WHERE id = ?").run(composeFile, new Date().toISOString(), project.id);
        return { projectId: project.id, composeFile };
      },
    };
  }));

  const addDomain = "stackport_add_project_domain";
  server.registerTool(addDomain, {
    title: "Add project domain (destructive)",
    description: "DESTRUCTIVE: add a full hostname and route it to a declared Compose service and port. Enables HTTPS and redirects HTTP by default. Point DNS at this Stackport instance for certificate issuance. Preview first, then confirm.",
    inputSchema: { ...writeInput, ...routeInput, domain: z.string().min(1).max(253), allowHttp: z.boolean().optional() },
    annotations: destructive,
  }, (input) => change(addDomain, input, async (project) => {
    const domain = parseDomainName(input.domain);
    if (!domain) throw new SetupError("Choose a valid hostname.");
    ensureDomainAvailable(domain);
    const route = await validateDomainRoute(project, input.service, input.containerPort);
    if (!route.ok) throw new SetupError(route.error);
    const useSsl = input.allowHttp !== true;
    return {
      summary: `Add ${domain} to "${project.name}" and route it to ${route.service}:${route.containerPort} over ${useSsl ? "HTTPS" : "HTTP"}.`,
      apply: () => {
        requireIdleCheckout(project.id);
        return applyDomain(addProjectDomain(project.id, domain, useSsl, route.service, route.containerPort), actor);
      },
    };
  }));

  const setRoute = "stackport_set_project_domain_route";
  server.registerTool(setRoute, {
    title: "Set project domain route (destructive)",
    description: "DESTRUCTIVE: route an existing domain ID to a declared Compose service and port. Set allowHttp to change the protocol, or omit it to keep the existing setting. On an HTTPS route without a usable certificate, this requests one. Preview first, then confirm.",
    inputSchema: { ...writeInput, ...routeInput, domainId: z.number().int().positive(), allowHttp: z.boolean().optional() },
    annotations: destructive,
  }, (input) => change(setRoute, input, async (project) => {
    const domain = getProjectDomain(project.id, input.domainId);
    if (!domain) throw new SetupError("Domain not found for this project.");
    if (actionRegistry.get(projectSslKey(project.id, domain.id))?.status === "running") throw new SetupError("A domain action is already running.");
    const route = await validateDomainRoute(project, input.service, input.containerPort);
    if (!route.ok) throw new SetupError(route.error);
    const useSsl = input.allowHttp === undefined ? domain.useSsl : !input.allowHttp;
    return {
      summary: `Route ${domain.domain} to ${route.service}:${route.containerPort} over ${useSsl ? "HTTPS" : "HTTP"}.`,
      subject: `${domain.domain}|${useSsl}`,
      apply: () => {
        requireIdleCheckout(project.id);
        if (actionRegistry.get(projectSslKey(project.id, domain.id))?.status === "running") throw new SetupError("A domain action is already running.");
        const updated = getDatabase().transaction(() => {
          if (input.allowHttp !== undefined) setProjectDomainSsl(project.id, domain.id, useSsl);
          return setProjectDomainRoute(project.id, domain.id, route.service, route.containerPort);
        }).immediate();
        if (!updated) throw new SetupError("Domain not found for this project.");
        return applyDomain(updated, actor);
      },
    };
  }));
}
