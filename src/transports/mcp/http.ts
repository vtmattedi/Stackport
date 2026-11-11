import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requireApiToken } from "../../modules/identity/middleware/apiToken";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { auditLog } from "../../shared/logger";
import { getProjectIngressHealthView, getProjectNetworkView, getProjectView, getStatusView, listManagedDomainsView, listNetworkGroupsView, listProjectsView } from "./readModel";
import { registerWriteTools } from "./writeTools";
import { packageVersion } from "../../modules/maintenance/version";

/**
 * The MCP endpoint at /mcp: Streamable HTTP, stateless (a fresh server per request),
 * JSON responses, API-token auth with the `read` scope. It runs inside the app, so it
 * reads the same state the UI does. A token that also has the `write` scope gets the
 * deploy, rollback, restart and stop tools (writeTools.ts); a read token never sees
 * them. The stdio server (server.ts) is separate and unchanged.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function result(data: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function notFound(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function buildMcpServer(token: ApiToken): McpServer {
  const server = new McpServer({ name: "stackport", version: packageVersion() }, {
    instructions: "Tools whose description starts with DESTRUCTIVE: change, interrupt or remove something that is running or overwrite stored data. Do not call one unless the user has asked for that change. Each takes two calls: the first only describes what would happen; show that to the user and call again with the confirmationId only after they agree.",
  });
  const actor = `token:${token.name}#${token.id}`;
  const audit = (tool: string, meta: Record<string, unknown> = {}): void =>
    auditLog(actor, "mcp.tool", tool, "ok", { tokenId: token.id, ...meta });

  server.registerTool(
    "stackport_status",
    {
      title: "Stackport status",
      description: "Stackport version and how many projects are up, down, unknown or paused.",
      annotations: READ_ONLY,
    },
    async () => {
      audit("stackport_status");
      return result(await getStatusView());
    }
  );

  server.registerTool(
    "stackport_list_projects",
    {
      title: "List projects",
      description: "Every project with its repository, branch, deploy trigger, health, last commit and domains.",
      annotations: READ_ONLY,
    },
    () => {
      audit("stackport_list_projects");
      return result({ projects: listProjectsView() });
    }
  );

  server.registerTool(
    "stackport_get_project",
    {
      title: "Get project",
      description: "One project's details: the list fields plus its Compose file, last 10 deployments, containers and the action running now, if any.",
      inputSchema: { projectId: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      audit("stackport_get_project", { projectId });
      const view = await getProjectView(projectId);
      return view ? result(view) : notFound(`No project with id ${projectId}.`);
    }
  );

  server.registerTool(
    "stackport_list_network_groups",
    {
      title: "List network groups",
      description: "Every network group (projects that can reach each other's shared services without a public domain), with its projects and the hostname each shared service answers to, such as db.p7.",
      annotations: READ_ONLY,
    },
    () => {
      audit("stackport_list_network_groups");
      return result(listNetworkGroupsView());
    }
  );

  server.registerTool(
    "stackport_get_project_network_group",
    {
      title: "Get project network group",
      description: "One project's network group: the group it is in, which of its services it shares, which services its Compose file has, and the other projects in the group.",
      inputSchema: { projectId: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      audit("stackport_get_project_network_group", { projectId });
      const view = await getProjectNetworkView(projectId);
      return view ? result(view) : notFound(`No project with id ${projectId}.`);
    }
  );

  server.registerTool(
    "stackport_list_managed_domains",
    {
      title: "List managed domains",
      description: "The base domains Stackport manages (a project's hostname is a label on one, or the bare domain itself), which is the default, how many hostnames use each, and the result of the last DNS check. Use it to choose a managedDomain for stackport_set_project_hostname.",
      annotations: READ_ONLY,
    },
    () => {
      audit("stackport_list_managed_domains");
      return result(listManagedDomainsView());
    }
  );

  server.registerTool(
    "stackport_get_project_ingress_health",
    {
      title: "Get project ingress health",
      description: "Whether nginx can reach each of one project's routed services right now: for every domain, whether the service's name resolves on the shared network and its port accepts a connection, with what to check when it does not. It says nothing about what the application answers.",
      inputSchema: { projectId: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      audit("stackport_get_project_ingress_health", { projectId });
      const view = await getProjectIngressHealthView(projectId);
      return view ? result(view) : notFound(`No project with id ${projectId}.`);
    }
  );

  if (token.scopes.includes("write")) registerWriteTools(server, token);

  return server;
}

const router = Router();

// Per token, on top of the app's per-IP limit.
const perTokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `token:${req.apiToken?.id ?? "none"}`,
  message: { error: "Too many MCP requests for this token, try again shortly" },
});

router.post("/", requireApiToken("read"), perTokenLimiter, async (req: Request, res: Response): Promise<void> => {
  const server = buildMcpServer(req.apiToken!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless: no server-initiated stream (GET) and no session to end (DELETE).
router.all("/", (_req: Request, res: Response): void => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
});

export default router;
