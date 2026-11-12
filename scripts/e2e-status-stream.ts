/**
 * Starts the real server (src/index.ts) on a temporary database and drives the live status stream through its real admin API and a real WebSocket:
 * off by default, enabling it, minting a token, the refusals, the data, and turning it off. It needs nothing but Node; Docker is read if it is there.
 *
 *   npm run e2e:status
 */
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";
import WebSocket from "ws";

const free = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const log = (ok: boolean, what: string): void => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) process.exitCode = 1; };

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-e2e-"));
  const port = await free();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: "production", JWT_SECRET: "e2e-jwt-secret", WEBHOOK_SECRET: "e2e-webhook-secret",
      SQLITE_PATH: path.join(dir, "s.sqlite"), DEPLOY_ROOT: path.join(dir, "repos"), SCRIPTS_DIR: path.join(dir, "scripts"), LOG_DIR: path.join(dir, "logs"),
      NGINX_PATH: path.join(dir, "nginx"), LOG_LEVEL: "error", ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: bcrypt.hashSync("e2e-password", 4),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  try {
    for (let i = 0; i < 100 && !out.includes("running on port"); i += 1) await new Promise((r) => setTimeout(r, 200));
    log(out.includes("running on port"), `the real server starts (${out.includes("running on port") ? "ok" : out.slice(-300)})`);
    const base = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/status/ws`;

    const refusedWith = (headers: Record<string, string>): Promise<number | "open"> => new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, { headers });
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("unexpected-response", (_r, res) => { res.resume(); resolve(res.statusCode ?? 0); });
      ws.on("error", () => undefined);
    });
    log((await refusedWith({})) === 404, "off by default: a connection gets 404");

    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" }, body: JSON.stringify({ username: "admin", password: "e2e-password" }) });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    log(login.ok && cookie.length > 0, `admin login works (${login.status})`);
    const admin = (method: string, url: string, body?: unknown): Promise<Response> =>
      fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base, Host: new URL(base).host, "X-Requested-With": "stackport", "X-Forwarded-Proto": "https" }, body: body === undefined ? undefined : JSON.stringify(body) });

    const enabled = await admin("PUT", "/api/status-stream", { enabled: true });
    log(enabled.ok && ((await enabled.json()) as { enabled: boolean }).enabled === true, `the admin route turns it on (${enabled.status})`);
    const made = await admin("POST", "/api/api-tokens", { name: "e2e", scope: "status", expiresInDays: 1 });
    const { token } = (await made.json()) as { token: string };
    log(made.status === 201 && token.startsWith("spk_"), `a status token is created (${made.status})`);
    const readMade = await admin("POST", "/api/api-tokens", { name: "e2e-read", scope: "read" });
    const readToken = ((await readMade.json()) as { token: string }).token;

    log((await refusedWith({ Authorization: `Bearer ${readToken}` })) === 401, "a read token is refused");
    log((await refusedWith({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })) === 403, "an Origin header is refused");

    const messages: { type: string; [k: string]: unknown }[] = [];
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "snapshot"); i += 1) await new Promise((r) => setTimeout(r, 100));
    const snap = messages.find((m) => m.type === "snapshot") as { data: { host: unknown; projects: unknown[]; actions: unknown[]; alerts: { code: string }[] } } | undefined;
    log(messages[0]?.type === "hello", "hello arrives first");
    log(!!snap && Array.isArray(snap.data.projects) && Array.isArray(snap.data.alerts), `a snapshot with all four sections arrives: ${JSON.stringify(snap?.data).slice(0, 160)}`);
    log(JSON.stringify(snap?.data).includes("password") === false && JSON.stringify(messages).includes(token) === false, "neither the token nor a password is on the wire");

    // Socket.IO shares the same upgrade event: it must still answer.
    const polling = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    log(polling.status === 200 || polling.status === 400, `Socket.IO still answers next to it (${polling.status})`);

    await admin("PUT", "/api/status-stream", { enabled: false });
    const end = await Promise.race([closed, new Promise<{ code: number; reason: string }>((r) => setTimeout(() => r({ code: -1, reason: "timeout" }), 3000))]);
    log(end.code === 1001, `turning it off disconnects the adapter at once (${end.code} ${end.reason})`);
    log((await refusedWith({ Authorization: `Bearer ${token}` })) === 404, "and the endpoint is gone again");
  } finally {
    child.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the database file a moment longer */ }
  }
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
