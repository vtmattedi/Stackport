import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiToken } from "../../modules/identity/apiTokens";
import { buildMcpServer } from "./http";

/**
 * The tools the MCP endpoint offers, for the Settings > MCP page. They are read back from a real server over an in-memory
 * connection, not written out by hand, so the list can never differ from what a client sees: a tool added to the server
 * appears here, and a tool a read token cannot see is marked as needing a write token.
 */

export interface McpToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  /** The least a token needs: `write` for a tool a read-only token does not get, `logs` for one that needs log access. */
  scope: "read" | "write" | "logs";
  /** Marked destructive: it changes or interrupts something. Every write tool is. */
  destructive: boolean;
  /** Takes two calls: the first only says what would happen, the second (with the id it returned) does it. */
  twoStep: boolean;
  parameters: McpToolParameter[];
}

function token(scopes: ApiToken["scopes"]): ApiToken {
  return { id: 0, name: "catalog", prefix: "", scopes, projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null };
}

interface JsonSchemaProperty { type?: string | string[]; description?: string; enum?: unknown[]; anyOf?: { type?: string }[]; items?: { type?: string } }

function describeType(property: JsonSchemaProperty): string {
  if (property.enum) return property.enum.map((value) => JSON.stringify(value)).join(" | ");
  const type = Array.isArray(property.type) ? property.type.join(" | ") : property.type ?? property.anyOf?.map((option) => option.type).filter(Boolean).join(" | ") ?? "any";
  return type === "array" && property.items?.type ? `${property.items.type}[]` : type;
}

async function listFor(scopes: ApiToken["scopes"]) {
  const server = buildMcpServer(token(scopes));
  const client = new Client({ name: "stackport-catalog", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { return (await client.listTools()).tools; }
  finally { await client.close(); await server.close(); }
}

const order = { read: 0, logs: 1, write: 2 } as const;

export async function listMcpTools(): Promise<McpToolInfo[]> {
  const readNames = new Set((await listFor(["read"])).map((tool) => tool.name));
  const logNames = new Set((await listFor(["read", "logs"])).map((tool) => tool.name).filter((name) => !readNames.has(name)));
  const all = await listFor(["read", "write", "logs"]);
  return all.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, JsonSchemaProperty>; required?: string[] };
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const twoStep = "confirmationId" in properties;
    return {
      name: tool.name,
      title: tool.title ?? tool.annotations?.title ?? tool.name,
      description: tool.description ?? "",
      scope: readNames.has(tool.name) ? "read" as const : logNames.has(tool.name) ? "logs" as const : "write" as const,
      destructive: tool.annotations?.destructiveHint === true,
      twoStep,
      // The confirmation id is the same on every two-step tool and is explained by `twoStep`, so it is not listed as a parameter.
      parameters: Object.entries(properties).filter(([name]) => name !== "confirmationId").map(([name, property]) => ({ name, type: describeType(property), required: required.has(name), description: property.description ?? "" })),
    };
  }).sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : order[a.scope] - order[b.scope]));
}
