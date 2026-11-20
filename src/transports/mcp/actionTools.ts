import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDatabase } from "../../config/database";
import { actionRegistry } from "../../modules/actions/registry";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { getProjectById } from "../../modules/deployments/operations";
import { mayActOn } from "./writeTools";

interface ActionRow {
  id: string;
  kind: string;
  projectId: number;
  status: string;
  branch: string | null;
  commitSha: string | null;
  startedAt: string;
  completedAt: string | null;
}

const columns = "id, kind, project_id AS projectId, status, branch, commit_sha AS commitSha, started_at AS startedAt, finished_at AS completedAt";
export const actionIdInput = z.string().max(64).regex(/^(?:[0-9a-f-]{36}|legacy-[0-9]+)$/);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function data(payload: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload as Record<string, unknown> };
}

export function getScopedAction(token: ApiToken, actionId: string): ActionRow | null {
  const row = getDatabase().prepare(`SELECT ${columns} FROM actions WHERE id = ? AND project_id IS NOT NULL`).get(actionId) as ActionRow | undefined;
  const project = row && getProjectById(row.projectId);
  return row && project && mayActOn(token, project) ? row : null;
}

export function registerActionStatusTools(server: McpServer, token: ApiToken): void {
  server.registerTool("stackport_get_project_action", {
    title: "Get project action",
    description: "Get the status of a project action by ID, including pull, deploy and certificate issuance. Use stackport_get_project_action_log for output with the logs scope.",
    inputSchema: { actionId: actionIdInput },
    annotations,
  }, ({ actionId }) => {
    const row = getScopedAction(token, actionId);
    if (!row) return { content: [{ type: "text", text: "Project action not found." }], isError: true };
    const live = actionRegistry.getById(actionId);
    return data({ ...row, phase: live?.phase ?? null, progress: live?.progress ?? null });
  });

  server.registerTool("stackport_list_project_actions", {
    title: "List project actions",
    description: "List a project's recent actions with IDs and status, including deploys, pulls and certificate issuance.",
    inputSchema: { projectId: z.number().int().positive(), limit: z.number().int().min(1).max(50).optional() },
    annotations,
  }, ({ projectId, limit }) => {
    const project = getProjectById(projectId);
    if (!project || !mayActOn(token, project)) return { content: [{ type: "text", text: "Project not found." }], isError: true };
    const actions = getDatabase().prepare(`SELECT ${columns} FROM actions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(projectId, limit ?? 10) as ActionRow[];
    return data({ actions });
  });
}
