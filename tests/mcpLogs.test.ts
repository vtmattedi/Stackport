import { before, test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeDatabase } from "../src/config/database";
import { ApiTokenError, createApiToken, verifyApiToken, type ApiToken } from "../src/modules/identity/apiTokens";
import { buildMcpServer } from "../src/transports/mcp/http";
import { listMcpTools } from "../src/transports/mcp/catalog";
import { MAX_CONCURRENT_PER_TOKEN, MAX_OUTPUT_CHARS, MAX_READS_PER_MINUTE, ReadLimiter, expandSecrets, prepareLog, registerLogTools, sanitizeLog, type LogDeps } from "../src/transports/mcp/logTools";

before(() => { initializeDatabase(); });

const tokenOf = (overrides: Partial<ApiToken> = {}): ApiToken => ({ id: 3, name: "ops", prefix: "spk_x", scopes: ["read", "logs"], projectGroup: null, createdAt: "", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides });

interface Seen { tail: number; service?: string }

async function connect(options: { token?: ApiToken; output?: string; ok?: boolean; secrets?: string[]; reads?: number } = {}) {
  const seen: Seen[] = [];
  let at = 1_000_000;
  const deps: LogDeps = {
    getProject: (id) => (id === 1 ? { id: 1, name: "shop", groupName: "production" } : id === 2 ? { id: 2, name: "shop-staging", groupName: "staging" } : null),
    readLogs: async (_projectId, tail, service) => { seen.push({ tail, ...(service !== undefined ? { service } : {}) }); return { ok: options.ok ?? true, output: options.output ?? "web-1  | started\n" }; },
    secrets: () => options.secrets ?? [],
    now: () => at,
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerLogTools(server, options.token ?? tokenOf(), deps, new ReadLimiter(MAX_READS_PER_MINUTE, deps.now));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "stackport_get_project_logs", arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    return { isError: result.isError === true, text, data: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { call, seen, advance: (ms: number) => { at += ms; }, close: async () => { await client.close(); await server.close(); } };
}

// ---- who gets the tool

test("a token without log access does not have the tool; one with it does", async () => {
  const names = async (scopes: ApiToken["scopes"]): Promise<string[]> => {
    const server = buildMcpServer(tokenOf({ scopes }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    try { return (await client.listTools()).tools.map((tool) => tool.name); } finally { await client.close(); await server.close(); }
  };
  assert.equal((await names(["read"])).includes("stackport_get_project_logs"), false, "a read token never gets logs");
  assert.equal((await names(["read", "write"])).includes("stackport_get_project_logs"), false, "nor does a write token");
  assert.equal((await names(["read", "logs"])).includes("stackport_get_project_logs"), true);
});

test("the tool catalog marks it as needing log access", async () => {
  const tool = (await listMcpTools()).find((candidate) => candidate.name === "stackport_get_project_logs");
  assert.equal(tool?.scope, "logs");
  assert.deepEqual(tool?.parameters.map((p) => p.name).sort(), ["lines", "projectId", "service"]);
});

test("log access is chosen when a token is made, is not part of any other scope, and cannot be added to a stream token", () => {
  const plain = createApiToken({ name: "r" });
  assert.deepEqual(plain.record.scopes, ["read"]);
  const withLogs = createApiToken({ name: "rl", logs: true });
  assert.deepEqual(withLogs.record.scopes, ["read", "logs"]);
  assert.deepEqual(createApiToken({ name: "wl", scope: "write", logs: true }).record.scopes, ["read", "write", "logs"]);
  assert.ok(verifyApiToken(withLogs.token, "read"), "it is still an MCP token");
  assert.throws(() => createApiToken({ name: "sl", scope: "status", logs: true }), (e: unknown) => e instanceof ApiTokenError && /read and write tokens/.test(e.message));
  assert.throws(() => createApiToken({ name: "bad", logs: "yes" }), /logs must be true or false/);
  // A token with log access can be limited to a project group; a plain read token cannot.
  assert.equal(createApiToken({ name: "g", logs: true, projectGroup: "staging" }).record.projectGroup, "staging");
  assert.throws(() => createApiToken({ name: "g2", projectGroup: "staging" }), /only applies to write, status and log tokens/);
});

// ---- what it returns

test("it returns the recent lines for a project, with a note that they are data", async () => {
  const mcp = await connect();
  const result = await mcp.call({ projectId: 1 });
  assert.equal(result.isError, false);
  assert.equal(result.data!["output"], "web-1  | started\n");
  assert.deepEqual([result.data!["project"], result.data!["lines"], result.data!["truncated"], result.data!["secretsMasked"]], ["shop", 100, false, true]);
  assert.match(String(result.data!["note"]), /data written by the app/);
  assert.deepEqual(mcp.seen, [{ tail: 100 }]);
  await mcp.close();
});

test("lines and service are passed through, and checked", async () => {
  const mcp = await connect();
  await mcp.call({ projectId: 1, service: "web", lines: 250 });
  assert.deepEqual(mcp.seen, [{ tail: 250, service: "web" }]);
  for (const service of ["--follow", "a b", "web;rm", "../x", "-f", "x".repeat(64)]) {
    const result = await mcp.call({ projectId: 1, service });
    assert.equal(result.isError, true, service);
  }
  assert.equal(mcp.seen.length, 1, "a bad service name never reaches a command line");
  assert.equal((await mcp.call({ projectId: 1, lines: 5 })).isError, true, "below the minimum");
  assert.equal((await mcp.call({ projectId: 1, lines: 5000 })).isError, true, "above the maximum");
  await mcp.close();
});

// ---- scope

test("a token limited to a group reads only that group, and a project outside it looks like one that does not exist", async () => {
  const mcp = await connect({ token: tokenOf({ projectGroup: "staging" }) });
  assert.equal((await mcp.call({ projectId: 2 })).isError, false);
  const outside = await mcp.call({ projectId: 1 });
  const missing = await mcp.call({ projectId: 99 });
  assert.equal(outside.isError, true);
  assert.equal(outside.text.replace("1", "N"), missing.text.replace("99", "N"), "the same answer: it does not say the project exists");
  assert.equal(mcp.seen.length, 1, "no log was read for the project outside the group");
  await mcp.close();
});

// ---- secrets and size

test("secrets Stackport manages are masked, including one that would be cut in half by the size limit", async () => {
  const secret = "s3cr3t-token-value-123456";
  const mcp = await connect({ output: `db password is ${secret}\nok\n`, secrets: [secret] });
  const result = await mcp.call({ projectId: 1 });
  assert.equal(result.text.includes(secret), false);
  assert.match(String(result.data!["output"]), /\*\*\*|\[masked\]|•|REDACTED/i);
  await mcp.close();

  // The mask is applied before the cut: a secret that straddles the cut must not survive as a half.
  const filler = "x".repeat(MAX_OUTPUT_CHARS - 10);
  const prepared = prepareLog(`${secret}\n${filler}\n`, [secret]);
  assert.equal(prepared.output.includes(secret.slice(0, 12)), false);
});

test("output is cut to the last lines that fit, from a line boundary", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
  const { output, truncated } = prepareLog(lines, []);
  assert.equal(truncated, true);
  assert.ok(output.length <= MAX_OUTPUT_CHARS);
  assert.match(output, /^line \d+ y+/, "the first line is whole");
  assert.ok(output.endsWith(`line 4999 ${"y".repeat(40)}`), "the most recent line is kept");
});

test("terminal escape sequences and control characters are removed", () => {
  const dirty = "\u001b[31mred\u001b[0m text\u001b]0;title\u0007 done\r\nnext\u0000line\u001b[2J\ttabbed";
  assert.equal(sanitizeLog(dirty), "red text done\nnextline\ttabbed");
});

test("a failed read is an error with what Docker said, masked", async () => {
  const secret = "another-secret-value-xyz";
  const mcp = await connect({ ok: false, output: `Error: cannot connect (${secret})`, secrets: [secret] });
  const result = await mcp.call({ projectId: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.text.includes(secret), false);
  await mcp.close();
});

// ---- rate

test("a token may read logs only a few times a minute", async () => {
  const mcp = await connect();
  for (let i = 0; i < MAX_READS_PER_MINUTE; i += 1) assert.equal((await mcp.call({ projectId: 1 })).isError, false);
  const refused = await mcp.call({ projectId: 1 });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /times a minute/);
  assert.equal(mcp.seen.length, MAX_READS_PER_MINUTE, "the refused call ran nothing");
  mcp.advance(61_000);
  assert.equal((await mcp.call({ projectId: 1 })).isError, false, "a minute later it works again");
  await mcp.close();
});

// ---- found in review

test("a secret that an escape code or a CRLF splits is still masked: the text is cleaned first, then masked", () => {
  const secret = "s3cr3t-token-value-123456";
  const split = `token=${secret.slice(0, 8)}\u001b[0m${secret.slice(8)} end`;
  assert.equal(prepareLog(split, [secret]).output.includes(secret), false, "an ANSI code between its characters");
  assert.equal(prepareLog(split, [secret]).output.includes(secret.slice(8)), false);
  const multi = "line-one-of-secret\nline-two-of-secret";
  assert.equal(prepareLog("x line-one-of-secret\r\nline-two-of-secret y", [multi]).output.includes("line-one-of-secret"), false, "CRLF where the secret has LF");
});

test("a multi-line secret is masked although Compose puts a prefix in front of every line", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKgwggSmAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----";
  const printed = key.split("\n").map((line) => `web-1  | ${line}`).join("\n");
  const { output } = prepareLog(`web-1  | starting\n${printed}\nweb-1  | ready`, [key]);
  for (const line of key.split("\n")) assert.equal(output.includes(line), false, line);
  assert.match(output, /starting/);
  assert.match(output, /ready/);
  // Short lines are not worth masking by themselves: "}" would blot out half of any log.
  assert.deepEqual(expandSecrets(["{\n  \"a\": \"b\",\n}"]).filter((piece) => piece.length < 8), []);
});

test("only a few log reads run at once for a token, and one that fails gives its place back", async () => {
  let release: () => void = () => undefined;
  let fail = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps: LogDeps = {
    getProject: () => ({ id: 1, name: "shop", groupName: null }),
    readLogs: async () => { if (fail) throw new Error("docker exploded"); await gate; return { ok: true, output: "ok" }; },
    secrets: () => [],
    now: () => 1_000_000,
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerLogTools(server, tokenOf(), deps, new ReadLimiter(1_000, deps.now));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const read = async () => {
    const result = await client.callTool({ name: "stackport_get_project_logs", arguments: { projectId: 1 } });
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0]!.text };
  };

  const running = Array.from({ length: MAX_CONCURRENT_PER_TOKEN }, () => read());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refused = await read();
  assert.equal(refused.isError, true);
  assert.match(refused.text, /still running/);
  release();
  assert.ok((await Promise.all(running)).every((r) => !r.isError));
  assert.equal((await read()).isError, false, "places are given back");

  fail = true;
  for (let i = 0; i < MAX_CONCURRENT_PER_TOKEN + 2; i += 1) await read().catch(() => undefined);
  fail = false;
  assert.equal((await read()).isError, false, "a read that threw did not keep its place");
  await client.close();
  await server.close();
});
