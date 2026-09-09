import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ListResourcesResult } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { config } from "../config/env";
import { closeDatabase, initializeDatabase } from "../config/database";
import type { ProjectEnvFile } from "../services/projectDeploy";
import {
  buildProject,
  composeProject,
  createProjectEnvFile,
  deleteProjectEnvFile,
  deployProject,
  listProjectEnvFiles,
  normalizeEnvRelativePath,
  parseEnvVariables,
  pullProject,
  scanProjectRepoFolders,
  stopProject,
  updateProjectEnvFile,
} from "../services/projectDeploy";
import {
  createProject,
  getProjectOrThrow,
  listCredentials,
  listProjects,
  setProjectPaused,
  updateProject,
} from "../services/projectAdmin";
import {
  addProjectDomain,
  listProjectDomains,
  removeProjectDomain,
  setProjectDomainSsl,
} from "../services/projectDomains";
import { writeNginxConfig } from "../services/nginx/configWriter";

const projectIdSchema = z.coerce.number().int().positive();
const credentialTypeSchema = z.enum(["github", "webhook", "api_key"]).optional();
const nullableStringSchema = z.union([z.string(), z.null()]);
const optionalNullableStringSchema = nullableStringSchema.optional();
const optionalNullablePortSchema = z.union([z.coerce.number().int().min(1).max(65535), z.null()]).optional();
const envVariableSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

function toolResult(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function redactEnvFile(envFile: ProjectEnvFile): Record<string, unknown> {
  return {
    ...envFile,
    variables: envFile.variables.map((variable) => ({
      key: variable.key,
      value: "[redacted]",
    })),
  };
}

async function readSkillsMarkdown(): Promise<string> {
  const skillsPath = path.resolve(process.cwd(), "Skills.md");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return fs.readFile(skillsPath, "utf8");
}

async function applyNginx(apply: boolean): Promise<unknown | null> {
  if (!apply) return null;
  return writeNginxConfig();
}

async function runProjectAction(projectId: number, action: "pull" | "build" | "deploy" | "compose" | "stop"): Promise<unknown> {
  switch (action) {
    case "pull":
      return pullProject(projectId);
    case "build":
      return buildProject(projectId);
    case "deploy":
      return deployProject(projectId);
    case "compose":
      return composeProject(projectId);
    case "stop":
      return stopProject(projectId);
  }
}

function registerResources(server: McpServer): void {
  server.registerResource(
    "stackport-project-prep-skill",
    "stackport://skills/project-prep",
    {
      title: "Stackport Project Preparation Skill",
      description: "Agent-facing instructions for preparing a repository to deploy on Stackport.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: await readSkillsMarkdown(),
      }],
    })
  );

  server.registerResource(
    "stackport-projects",
    "stackport://projects",
    {
      title: "Stackport Projects",
      description: "Current Stackport project records as JSON.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ projects: listProjects() }, null, 2),
      }],
    })
  );

  server.registerResource(
    "stackport-project",
    new ResourceTemplate("stackport://projects/{projectId}", {
      list: (): ListResourcesResult => ({
        resources: listProjects().map((project) => ({
          uri: `stackport://projects/${project.id}`,
          name: `Project ${project.id}: ${project.name}`,
          title: project.name,
          description: project.githubRepo ?? "Stackport project",
          mimeType: "application/json",
        })),
      }),
      complete: {
        projectId: (): string[] => listProjects().map((project) => String(project.id)),
      },
    }),
    {
      title: "Stackport Project",
      description: "A single Stackport project record with redacted env-file metadata.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const rawProjectId = Array.isArray(variables["projectId"]) ? variables["projectId"][0] : variables["projectId"];
      const projectId = Number(rawProjectId);
      const project = getProjectOrThrow(projectId);
      const envFiles = listProjectEnvFiles(projectId).map(redactEnvFile);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ project, envFiles }, null, 2),
        }],
      };
    }
  );
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "stackport_status",
    {
      title: "Stackport Status",
      description: "Show Stackport MCP runtime paths and summary counts.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => toolResult({
      deployRoot: config.deployRoot,
      nginxPath: config.nginxPath,
      sqlitePath: config.sqlitePath,
      projectCount: listProjects().length,
      credentialCount: listCredentials().length,
      projectPrepResource: "stackport://skills/project-prep",
    })
  );

  server.registerTool(
    "stackport_list_projects",
    {
      title: "List Projects",
      description: "List Stackport project records.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => toolResult({ projects: listProjects() })
  );

  server.registerTool(
    "stackport_get_project",
    {
      title: "Get Project",
      description: "Get one Stackport project plus redacted env-file metadata.",
      inputSchema: { projectId: projectIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => {
      const project = getProjectOrThrow(input.projectId);
      const envFiles = listProjectEnvFiles(input.projectId).map(redactEnvFile);
      return toolResult({ project, envFiles });
    }
  );

  server.registerTool(
    "stackport_list_credentials",
    {
      title: "List Credentials",
      description: "List credential IDs and aliases without secret values. Filter by type when needed.",
      inputSchema: { type: credentialTypeSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => toolResult({ credentials: listCredentials(input.type) })
  );

  server.registerTool(
    "stackport_create_project",
    {
      title: "Create Project",
      description: "Create a Stackport project record for a GitHub repository. domain, if given, becomes the project's first domain (use the project-domain tools to add more later). Optionally apply nginx after creation.",
      inputSchema: {
        name: z.string().min(1),
        githubRepo: z.string().min(1),
        internalPort: z.coerce.number().int().min(1).max(65535).optional(),
        domain: z.string().optional(),
        healthCheckEndpoint: z.string().optional(),
        healthCheckIntervalS: z.coerce.number().int().min(0).optional(),
        credentialId: z.coerce.number().int().positive().optional(),
        githubCredentialId: z.coerce.number().int().positive().optional(),
        autoDeployBranch: z.string().optional(),
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const project = createProject(input);
      const nginx = await applyNginx(input.applyNginx);
      return toolResult({ project, nginx });
    }
  );

  server.registerTool(
    "stackport_update_project",
    {
      title: "Update Project",
      description: "Update Stackport project metadata. Use null to clear nullable fields. Domains are managed separately — see the project-domain tools. Optionally apply nginx when routing fields change.",
      inputSchema: {
        projectId: projectIdSchema,
        name: z.string().min(1).optional(),
        githubRepo: optionalNullableStringSchema,
        internalPort: optionalNullablePortSchema,
        healthCheckEndpoint: optionalNullableStringSchema,
        healthCheckIntervalS: z.coerce.number().int().min(0).optional(),
        credentialId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
        githubCredentialId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
        autoDeployBranch: optionalNullableStringSchema,
        nginxExtraConfig: optionalNullableStringSchema,
        nginxExtraBlocks: optionalNullableStringSchema,
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const { project, nginxFieldsChanged } = updateProject(input.projectId, input);
      const nginx = nginxFieldsChanged ? await applyNginx(input.applyNginx) : null;
      return toolResult({ project, nginx, nginxFieldsChanged });
    }
  );

  server.registerTool(
    "stackport_set_project_paused",
    {
      title: "Set Project Paused",
      description: "Pause or resume a Stackport project. Paused projects are excluded from generated nginx routes.",
      inputSchema: {
        projectId: projectIdSchema,
        paused: z.boolean(),
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const project = setProjectPaused(input.projectId, input.paused);
      const nginx = await applyNginx(input.applyNginx);
      return toolResult({ project, nginx });
    }
  );

  server.registerTool(
    "stackport_list_project_domains",
    {
      title: "List Project Domains",
      description: "List every domain routed to a project. Each gets its own full nginx block set (server_name/cert/www-redirect), all sharing the project's internalPort.",
      inputSchema: { projectId: projectIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => {
      getProjectOrThrow(input.projectId);
      return toolResult({ domains: listProjectDomains(input.projectId) });
    }
  );

  server.registerTool(
    "stackport_add_project_domain",
    {
      title: "Add Project Domain",
      description: "Route another domain to a project's existing internalPort (e.g. a.com and b.com both proxying to the same backend). Optionally apply nginx after adding.",
      inputSchema: {
        projectId: projectIdSchema,
        domain: z.string().min(1),
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const domain = addProjectDomain(input.projectId, input.domain);
      const nginx = await applyNginx(input.applyNginx);
      return toolResult({ domain, nginx });
    }
  );

  server.registerTool(
    "stackport_delete_project_domain",
    {
      title: "Delete Project Domain",
      description: "Stop routing a domain to a project. Does not touch any issued certificate files on disk. Optionally apply nginx after removing.",
      inputSchema: {
        projectId: projectIdSchema,
        domainId: z.coerce.number().int().positive(),
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const deleted = removeProjectDomain(input.projectId, input.domainId);
      const nginx = deleted ? await applyNginx(input.applyNginx) : null;
      return toolResult({ deleted, nginx });
    }
  );

  server.registerTool(
    "stackport_set_project_domain_ssl",
    {
      title: "Set Project Domain SSL",
      description: "Toggle whether a project's domain is served over HTTPS. Does not issue a certificate — the domain must already have one (see certbot tools) for this to actually take effect. Optionally apply nginx after toggling.",
      inputSchema: {
        projectId: projectIdSchema,
        domainId: z.coerce.number().int().positive(),
        useSsl: z.boolean(),
        applyNginx: z.boolean().optional().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const domain = setProjectDomainSsl(input.projectId, input.domainId, input.useSsl);
      const nginx = domain ? await applyNginx(input.applyNginx) : null;
      return toolResult({ domain, nginx });
    }
  );

  server.registerTool(
    "stackport_list_project_env_files",
    {
      title: "List Project Env Files",
      description: "List Stackport-managed project env files with values redacted.",
      inputSchema: { projectId: projectIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => {
      getProjectOrThrow(input.projectId);
      return toolResult({ envFiles: listProjectEnvFiles(input.projectId).map(redactEnvFile) });
    }
  );

  server.registerTool(
    "stackport_set_project_env_file",
    {
      title: "Set Project Env File",
      description: "Create or replace one Stackport-managed .env file. Values are accepted but redacted from the response.",
      inputSchema: {
        projectId: projectIdSchema,
        relativePath: z.string().min(1),
        variables: z.array(envVariableSchema),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => {
      getProjectOrThrow(input.projectId);
      const relativePath = normalizeEnvRelativePath(input.relativePath);
      const variables = parseEnvVariables(input.variables);
      if (!relativePath || !variables) {
        throw new Error("Env file needs a safe .env relative path and unique KEY=value pairs");
      }

      const existing = listProjectEnvFiles(input.projectId).find((envFile) => envFile.relativePath === relativePath);
      const envFile = existing
        ? updateProjectEnvFile(existing.id, input.projectId, relativePath, variables)
        : createProjectEnvFile(input.projectId, relativePath, variables);
      if (!envFile) throw new Error("Env file could not be saved");
      return toolResult({ envFile: redactEnvFile(envFile) });
    }
  );

  server.registerTool(
    "stackport_delete_project_env_file",
    {
      title: "Delete Project Env File",
      description: "Delete a Stackport-managed env file by id or relative path.",
      inputSchema: {
        projectId: projectIdSchema,
        envFileId: z.coerce.number().int().positive().optional(),
        relativePath: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => {
      getProjectOrThrow(input.projectId);
      const envFileId = input.envFileId ?? listProjectEnvFiles(input.projectId)
        .find((envFile) => envFile.relativePath === normalizeEnvRelativePath(input.relativePath ?? ""))?.id;
      if (!envFileId) throw new Error("envFileId or a matching relativePath is required");
      const deleted = deleteProjectEnvFile(envFileId, input.projectId);
      return toolResult({ deleted, envFileId });
    }
  );

  server.registerTool(
    "stackport_run_project_action",
    {
      title: "Run Project Action",
      description: "Run a project action: pull, build, deploy, compose, or stop.",
      inputSchema: {
        projectId: projectIdSchema,
        action: z.enum(["pull", "build", "deploy", "compose", "stop"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toolResult({ result: await runProjectAction(input.projectId, input.action) })
  );

  server.registerTool(
    "stackport_scan_repo_folders",
    {
      title: "Scan Repo Folders",
      description: "Scan DEPLOY_ROOT for matched, missing, mismatched, and orphaned project folders.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult({ scan: await scanProjectRepoFolders() })
  );

  server.registerTool(
    "stackport_apply_nginx_config",
    {
      title: "Apply Nginx Config",
      description: "Regenerate and reload Stackport nginx config from current project records.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toolResult({ nginx: await writeNginxConfig() })
  );
}

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "stackport",
      title: "Stackport",
      version: "1.0.0",
    },
    {
      instructions: [
        "Use this server to inspect and operate Stackport projects on the local Stackport host.",
        "Read stackport://skills/project-prep before preparing an application repository for Stackport deployment.",
        "Env-file tool responses redact values; do not request stored secret values unless the user provides them in the current task.",
      ].join(" "),
    }
  );
  registerResources(server);
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  initializeDatabase();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDatabase();
  process.exit(0);
});

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  closeDatabase();
  process.exit(1);
});
