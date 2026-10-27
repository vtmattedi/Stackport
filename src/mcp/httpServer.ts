import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requireApiToken } from "../middleware/apiTokenAuth";
import type { ApiToken } from "../services/apiTokens";
import { auditLog } from "../utils/logger";
import { getProjectView, getStatusView, listProjectsView } from "./readModel";

/**
 * The MCP endpoint at /mcp: Streamable HTTP, stateless (a fresh server per request),
 * JSON responses, API-token auth with the `read` scope. It runs inside the app, so it
 * reads the same state the UI does and never writes. The stdio server (server.ts) is
 * separate and unchanged.
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

export function buildReadOnlyMcpServer(token: ApiToken): McpServer {
  const server = new McpServer({ name: "stackport", version: "1.0.0" });
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
  const server = buildReadOnlyMcpServer(req.apiToken!);
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
