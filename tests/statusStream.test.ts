import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createApiToken, revokeApiToken, verifyApiToken } from "../src/modules/identity/apiTokens";
import { collectStatus } from "../src/modules/status/collect";
import type { SectionUpdate } from "../src/modules/status/hub";
import { STATUS_SECTIONS, type StatusSnapshot } from "../src/modules/status/types";
import { clientAddress, isSecureTransport, attachStatusStream, STREAM_PATH, type StatusStream } from "../src/transports/status/stream";
import { createProject } from "../src/modules/projects/operations";

before(() => { initializeDatabase(); });

// ---- a stand-in for the hub, so the tests control what is "collected"

const baseSnapshot = (): StatusSnapshot => ({
  host: { cpuPercent: 10, memPercent: 20, memUsedMb: 100, memTotalMb: 500, load1: 0.1, diskUsedPct: 30, netRxBps: 1, netTxBps: 2, sampledAt: "t" },
  projects: [
    { id: 1, name: "shop", group: "production", state: "ready", containers: { running: 1, total: 1 }, health: "ok", lastCheckedAt: null, traffic: null },
    { id: 2, name: "shop-staging", group: "staging", state: "down", containers: { running: 0, total: 1 }, health: "failing", lastCheckedAt: null, traffic: null },
  ],
  actions: [{ id: "a1", kind: "deploy", projectId: 2, projectName: "shop-staging", startedAt: "t", progress: 40 }],
  alerts: [{ id: "project_down:2", severity: "critical", code: "project_down", scope: "project", projectId: 2, subject: "shop-staging", message: "shop-staging is down: 0 of 1 containers are running.", since: "t", value: null, unit: null }],
});

class FakeHub {
  snapshot = baseSnapshot();
  listeners = new Set<(update: SectionUpdate) => void>();
  subscribe(listener: (update: SectionUpdate) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  peek(): StatusSnapshot { return this.snapshot; }
  current(): Promise<StatusSnapshot> { return Promise.resolve(this.snapshot); }
  push<S extends keyof StatusSnapshot>(section: S, data: StatusSnapshot[S]): void {
    this.snapshot = { ...this.snapshot, [section]: data };
    for (const listener of this.listeners) listener({ section, data } as SectionUpdate);
  }
}

let server: Server;
let stream: StatusStream;
let url = "";
let enabled = true;
let trusted = false;
const hub = new FakeHub();

before(async () => {
  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  stream = attachStatusStream(server, {
    trustProxy: () => trusted,
    isEnabled: () => enabled,
    hub,
    instance: () => "sp-test",
    // The lockout has its own test (and its own server): here many tests make failed attempts from the same address on purpose.
    limits: { maxConnections: 6, maxConnectionsPerToken: 2, maxFailuresPerAddress: 10_000, revalidateMs: 40, pingMs: 5_000, heartbeatMs: 5_000 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${STREAM_PATH}`;
});

after(async () => {
  stream.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Message = { type: string; [key: string]: unknown };

interface Client { ws: WebSocket; messages: Message[]; closed: Promise<{ code: number; reason: string }>; next(type: string): Promise<Message> }

function attach(ws: WebSocket): Client {
  const messages: Message[] = [];
  const waiting: { type: string; resolve: (m: Message) => void }[] = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as Message;
    messages.push(message);
    for (const w of [...waiting]) if (w.type === message.type) { waiting.splice(waiting.indexOf(w), 1); w.resolve(message); }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  return {
    ws, messages, closed,
    next: (type) => new Promise((resolve) => {
      const found = messages.find((m) => m.type === type && !m["__taken"]);
      if (found) { found["__taken"] = true; resolve(found); return; }
      waiting.push({ type, resolve: (m) => { m["__taken"] = true; resolve(m); } });
    }),
  };
}

/** Opens the stream; resolves with the client when it connects, or with the HTTP status when it is refused. */
function open(headers: Record<string, string> = {}, target = url): Promise<Client | { refused: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(target, { headers });
    ws.on("open", () => resolve(attach(ws)));
    ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) => { res.resume(); resolve({ refused: res.statusCode ?? 0 }); });
    ws.on("error", () => { /* the refusal is reported through unexpected-response */ });
  });
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const connected = async (headers: Record<string, string>): Promise<Client> => {
  const result = await open(headers);
  assert.ok("ws" in result, `expected a connection, got ${JSON.stringify(result)}`);
  return result;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const statusToken = createApiTokenOnce("status-all", "status");
function createApiTokenOnce(name: string, scope: string, projectGroup?: string): string {
  initializeDatabase();
  return createApiToken({ name, scope, projectGroup }).token;
}

// ---- who may open it

test("while it is off, the endpoint does not exist", async () => {
  enabled = false;
  assert.deepEqual(await open(bearer(statusToken)), { refused: 404 });
  enabled = true;
});

test("no token, a malformed header and an unknown token are all refused the same way", async () => {
  assert.deepEqual(await open(), { refused: 401 });
  assert.deepEqual(await open({ Authorization: "Basic abc" }), { refused: 401 });
  assert.deepEqual(await open({ Authorization: "Bearer not-a-token" }), { refused: 401 });
  assert.deepEqual(await open(bearer("spk_" + "x".repeat(43))), { refused: 401 });
});

test("a token in the address is refused outright, even a good one: it would be written to every access log", async () => {
  assert.deepEqual(await open(bearer(statusToken), `${url}?token=${statusToken}`), { refused: 400 });
});

test("scopes do not cross: read and write tokens cannot open it, and a status token cannot use MCP", async () => {
  const read = createApiToken({ name: "r", scope: "read" }).token;
  const write = createApiToken({ name: "w", scope: "write" }).token;
  assert.deepEqual(await open(bearer(read)), { refused: 401 });
  assert.deepEqual(await open(bearer(write)), { refused: 401 });
  assert.equal(verifyApiToken(statusToken, "read"), null);
  assert.equal(verifyApiToken(statusToken, "write"), null);
  assert.ok(verifyApiToken(statusToken, "status"));
});

test("a browser (any Origin header) is refused, whatever it sends", async () => {
  assert.deepEqual(await open({ ...bearer(statusToken), Origin: "https://evil.example" }), { refused: 403 });
  assert.deepEqual(await open({ ...bearer(statusToken), Origin: "null" }), { refused: 403 });
});

test("a revoked or expired token is refused", async () => {
  const { token, record } = createApiToken({ name: "short", scope: "status" });
  revokeApiToken(record.id);
  assert.deepEqual(await open(bearer(token)), { refused: 401 });
  const expired = createApiToken({ name: "old", scope: "status", expiresInDays: 1 });
  getDatabase().prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.record.id);
  assert.deepEqual(await open(bearer(expired.token)), { refused: 401 });
});

// ---- transport security

test("TLS: encrypted, vouched for by the proxy we trust, or straight from this machine", () => {
  const fake = (remote: string, headers: Record<string, string> = {}, encrypted = false): IncomingMessage => ({ socket: { remoteAddress: remote, encrypted }, headers }) as unknown as IncomingMessage;
  const trustAll = (): boolean => true;
  const trustNone = (): boolean => false;
  assert.equal(isSecureTransport(fake("203.0.113.5", {}, true), trustNone), true, "TLS terminated here");
  assert.equal(isSecureTransport(fake("172.18.0.5", { "x-forwarded-proto": "https" }), trustAll), true, "the proxy says https");
  assert.equal(isSecureTransport(fake("172.18.0.5", { "x-forwarded-proto": "http" }), trustAll), false, "the proxy says the client used plain http");
  assert.equal(isSecureTransport(fake("172.18.0.5", {}), trustAll), false, "a remote peer with no TLS and no word from the proxy");
  assert.equal(isSecureTransport(fake("203.0.113.5", { "x-forwarded-proto": "https" }), trustNone), false, "a peer we do not trust cannot vouch for itself");
  assert.equal(isSecureTransport(fake("127.0.0.1"), trustNone), true, "this machine");
  assert.equal(isSecureTransport(fake("::ffff:127.0.0.1"), trustNone), true);
  assert.equal(isSecureTransport(fake("127.0.0.1", { "x-forwarded-for": "198.51.100.7" }), trustNone), false, "forwarding headers from a peer we do not trust: not a local connection");
});

test("the client address is the first one from the right that is not a trusted proxy", () => {
  const fake = (remote: string, forwarded?: string): IncomingMessage => ({ socket: { remoteAddress: remote }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} }) as unknown as IncomingMessage;
  const trust = (address: string): boolean => address === "10.0.0.2" || address === "10.0.0.3";
  assert.equal(clientAddress(fake("10.0.0.2", "198.51.100.7"), trust), "198.51.100.7");
  assert.equal(clientAddress(fake("10.0.0.2", "6.6.6.6, 198.51.100.7, 10.0.0.3"), trust), "198.51.100.7", "a value the client put at the left is not believed");
  assert.equal(clientAddress(fake("203.0.113.9", "6.6.6.6"), trust), "203.0.113.9", "an untrusted peer cannot choose its address");
});

test("through a proxy that says plain http, the connection is refused", async () => {
  trusted = true;
  try {
    assert.deepEqual(await open({ ...bearer(statusToken), "X-Forwarded-Proto": "http" }), { refused: 403 });
    const client = await connected({ ...bearer(statusToken), "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.7" });
    client.ws.close();
  } finally { trusted = false; }
});

// ---- what it sends

test("hello, then a full snapshot, then only what changes", async () => {
  hub.snapshot = baseSnapshot();
  const client = await connected(bearer(statusToken));
  const hello = await client.next("hello");
  assert.deepEqual([hello["v"], hello["instance"], hello["scope"], hello["sections"]], [1, "sp-test", "all", [...STATUS_SECTIONS]]);
  const snapshot = await client.next("snapshot");
  assert.equal(snapshot["v"], 1);
  assert.deepEqual(Object.keys(snapshot["data"] as object).sort(), ["actions", "alerts", "host", "projects"]);
  assert.equal((snapshot["data"] as StatusSnapshot).projects.length, 2);

  hub.push("actions", []);
  const update = await client.next("update");
  assert.deepEqual([update["section"], update["data"]], ["actions", []]);
  assert.ok((update["seq"] as number) > (snapshot["seq"] as number));

  const before = client.messages.length;
  hub.push("actions", []); // the same again: nothing to say
  await sleep(50);
  assert.equal(client.messages.length, before, "an unchanged section is not sent twice");
  client.ws.close();
});

test("a token limited to a group sees that group and no host data", async () => {
  hub.snapshot = baseSnapshot();
  const token = createApiTokenOnce("staging-only", "status", "staging");
  const client = await connected(bearer(token));
  assert.equal((await client.next("hello"))["scope"], "group");
  const data = (await client.next("snapshot"))["data"] as StatusSnapshot;
  assert.equal(data.host, null);
  assert.deepEqual(data.projects.map((p) => p.name), ["shop-staging"]);
  assert.equal(data.actions.length, 1);
  assert.equal(data.alerts.length, 1);

  // An update to another group's project, and to the host, says nothing to this token.
  const before = client.messages.length;
  hub.push("host", { ...baseSnapshot().host!, cpuPercent: 99 });
  hub.push("projects", [baseSnapshot().projects[0]!]);
  await sleep(50);
  assert.equal(client.messages.length, before + 1, "the projects section changed for it (its own project went away); the host section did not");
  client.ws.close();
  hub.snapshot = baseSnapshot();
});

// ---- the connection is receive-only and bounded

test("the client may not send: a data frame closes the connection", async () => {
  const client = await connected(bearer(statusToken));
  await client.next("snapshot");
  client.ws.send("hello?");
  assert.equal((await client.closed).code, 1008);
});

test("a large frame from the client is refused before it is read", async () => {
  const client = await connected(bearer(statusToken));
  await client.next("snapshot");
  client.ws.send("x".repeat(5_000));
  assert.equal((await client.closed).code, 1009);
});

test("a token is limited to a few connections", async () => {
  const token = createApiTokenOnce("busy", "status");
  const one = await connected(bearer(token));
  const two = await connected(bearer(token));
  assert.deepEqual(await open(bearer(token)), { refused: 429 });
  one.ws.close();
  await one.closed;
  await sleep(20);
  const again = await connected(bearer(token));
  again.ws.close();
  two.ws.close();
  await Promise.all([again.closed, two.closed]);
});

test("a revoked token loses its open connection, with a reason", async () => {
  const { token, record } = createApiToken({ name: "to-revoke", scope: "status" });
  const client = await connected(bearer(token));
  await client.next("snapshot");
  revokeApiToken(record.id);
  assert.deepEqual(await client.closed, { code: 4001, reason: "token revoked or expired" });
});

test("turning the stream off disconnects everyone at once, and the feature check ends it too", async () => {
  const a = await connected(bearer(statusToken));
  await a.next("snapshot");
  stream.disconnectAll("stream disabled");
  assert.deepEqual(await a.closed, { code: 1001, reason: "stream disabled" });
  const b = await connected(bearer(statusToken));
  await b.next("snapshot");
  enabled = false;
  assert.equal((await b.closed).code, 1001);
  enabled = true;
});

test("repeated failures from one address lock it out, even for a valid token", async () => {
  const second = createServer();
  const guarded = attachStatusStream(second, { trustProxy: () => false, isEnabled: () => true, hub, limits: { maxFailuresPerAddress: 4 } });
  await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
  const target = `ws://127.0.0.1:${(second.address() as AddressInfo).port}${STREAM_PATH}`;
  try {
    for (let i = 0; i < 4; i += 1) assert.deepEqual(await open(bearer("spk_" + "y".repeat(43)), target), { refused: 401 });
    assert.deepEqual(await open(bearer(statusToken), target), { refused: 429 }, "locked out: even a good token is refused");
    assert.deepEqual(await open({}, target), { refused: 429 });
  } finally {
    guarded.close();
    await new Promise<void>((resolve) => second.close(() => resolve()));
  }
});

// ---- what is on the wire is only what the types say

test("a snapshot is built field by field: a project's secrets and paths are not in it, and its name is cleaned", async () => {
  const project = createProject({ name: "bad\u0000name\u001b[31m", groupName: "grp", sourceType: "upload" });
  getDatabase().prepare("UPDATE projects SET github_repo = ?, nginx_extra_config = ?, nginx_extra_blocks = ?, health_check_endpoint = ? WHERE id = ?")
    .run("owner/very-secret-repo", "proxy_pass http://internal-secret-host", "location /secret-block {}", "/internal-health-secret", project.id);
  const { snapshot } = await collectStatus();
  const mine = snapshot.projects.find((p) => p.id === project.id)!;
  assert.deepEqual(Object.keys(mine).sort(), ["containers", "group", "health", "id", "lastCheckedAt", "name", "state", "traffic"]);
  assert.equal(mine.name, "bad name [31m");
  const wire = JSON.stringify(snapshot);
  for (const secret of ["very-secret-repo", "internal-secret-host", "secret-block", "internal-health-secret"]) {
    assert.equal(wire.includes(secret), false, `${secret} must not reach the stream`);
  }
  assert.deepEqual(Object.keys(snapshot).sort(), ["actions", "alerts", "host", "projects"]);
});
