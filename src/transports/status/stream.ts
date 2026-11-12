import type { IncomingMessage, Server } from "http";
import type { Socket } from "net";
import type { TLSSocket } from "tls";
import { WebSocketServer, type WebSocket } from "ws";
import { isApiTokenActive, verifyApiToken, type ApiToken } from "../../modules/identity/apiTokens";
import { statusHub, type StatusHub } from "../../modules/status/hub";
import { scopeSection, scopeSnapshot, type Scope } from "../../modules/status/scope";
import { isStatusStreamEnabled } from "../../modules/status/settings";
import { STATUS_PROTOCOL_VERSION, STATUS_SECTIONS, type StatusMessage, type StatusSection } from "../../modules/status/types";
import { auditLog } from "../../shared/logger";

/**
 * The live status stream: a WebSocket at /status/ws that only ever sends data out.
 *
 * What it guarantees, and where each guarantee is:
 *  - Off by default, and indistinguishable from a missing page when off (404).
 *  - Only a `status` API token opens it: sent in the Authorization header (never the address, which ends up in logs), hashed on lookup,
 *    checked again every REVALIDATE_MS so a revoked or expired token loses its connection within that time.
 *  - Only over TLS: a connection must be encrypted, or arrive from the proxy that said it was HTTPS, or come from this machine itself.
 *  - Never a browser: a request with an Origin header is refused, which also closes the cross-site WebSocket hijacking route.
 *  - Receive-only: frames from the client are limited to a few bytes and any data frame closes the connection.
 *  - Bounded: a cap on connections overall and per token, a cap on failed attempts per address, a cap on what a slow reader may buffer,
 *    and a ping that ends a connection that stops answering.
 *  - Scoped: a token limited to a project group sees only that group (modules/status/scope.ts).
 *  - Minimal: the data is the types in modules/status/types.ts, built field by field; nothing else can reach the wire.
 */

export const STREAM_PATH = "/status/ws";

export interface StreamLimits {
  maxConnections: number;
  maxConnectionsPerToken: number;
  /** Failed authentication attempts one address may make in `failureWindowMs` before it is refused outright. */
  maxFailuresPerAddress: number;
  failureWindowMs: number;
  /** A reader that lets more than this pile up is cut off rather than held in memory. */
  maxBufferedBytes: number;
  /** The largest frame a client may send. The server expects none, so this is only room for a close or pong. */
  maxClientFrameBytes: number;
  pingMs: number;
  heartbeatMs: number;
  revalidateMs: number;
}

export const DEFAULT_LIMITS: StreamLimits = {
  maxConnections: 20,
  maxConnectionsPerToken: 3,
  maxFailuresPerAddress: 10,
  failureWindowMs: 15 * 60_000,
  maxBufferedBytes: 1024 * 1024,
  maxClientFrameBytes: 125,
  pingMs: 30_000,
  heartbeatMs: 30_000,
  revalidateMs: 30_000,
};

export interface StreamDeps {
  /** Express's `trust proxy` function: may this peer set X-Forwarded-For and X-Forwarded-Proto? */
  trustProxy: (address: string) => boolean;
  isEnabled?: () => boolean;
  verifyToken?: (raw: string) => ApiToken | null;
  isTokenActive?: (id: number) => boolean;
  hub?: Pick<StatusHub, "subscribe" | "current" | "peek">;
  instance?: () => string;
  limits?: Partial<StreamLimits>;
}

export interface StreamConnection { tokenId: number; tokenName: string; address: string; since: string; group: string | null }

export interface StatusStream {
  close(): void;
  /** Ends every open connection now (the stream was turned off). */
  disconnectAll(reason: string): void;
  connections(): StreamConnection[];
}

let active: StatusStream | null = null;

/** The running stream, for the admin page that shows who is connected. */
export function getStatusStream(): StatusStream | null {
  return active;
}

const BEARER = /^Bearer (spk_[A-Za-z0-9_-]{16,128})$/;

function reject(socket: Socket, status: number, reason: string): void {
  // One short plain response, whatever the reason, so a client learns the class of problem and nothing more.
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

function isLoopback(address: string): boolean {
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1" || normalized.startsWith("127.");
}

/** The address a request really came from: the socket's, or when that is a trusted proxy, the first address on the right of X-Forwarded-For that is not one. */
export function clientAddress(req: IncomingMessage, trustProxy: (address: string) => boolean): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy(remote)) return remote;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  for (const hop of [...forwarded].reverse()) {
    if (!trustProxy(hop)) return hop;
  }
  return forwarded[0] ?? remote;
}

/** Whether the connection is protected in transit: encrypted here, vouched for as HTTPS by the proxy we trust, or on this machine.
 *  A proxy that says the client used plain HTTP (or a request that carries forwarding headers from a peer we do not trust) is not secure. */
export function isSecureTransport(req: IncomingMessage, trustProxy: (address: string) => boolean): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  const remote = req.socket.remoteAddress ?? "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
  if (trustProxy(remote) && forwardedProto === "https") return true;
  // Straight from this machine, with no proxy in between: the bytes never leave it.
  return isLoopback(remote) && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-proto"];
}

export function attachStatusStream(server: Server, deps: StreamDeps): StatusStream {
  const limits: StreamLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const isEnabled = deps.isEnabled ?? isStatusStreamEnabled;
  const verifyToken = deps.verifyToken ?? ((raw: string) => verifyApiToken(raw, "status"));
  const isTokenActive = deps.isTokenActive ?? isApiTokenActive;
  const hub = deps.hub ?? statusHub;
  const instance = deps.instance ?? (() => "stackport");

  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxClientFrameBytes, perMessageDeflate: false, clientTracking: false });
  const open = new Map<WebSocket, StreamConnection>();
  const failures = new Map<string, { count: number; resetAt: number }>();

  function failuresFor(address: string, now: number): { count: number; resetAt: number } {
    const entry = failures.get(address);
    if (entry && entry.resetAt > now) return entry;
    const fresh = { count: 0, resetAt: now + limits.failureWindowMs };
    failures.set(address, fresh);
    return fresh;
  }

  // The table of failures must not grow without bound under a flood from many addresses.
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [address, entry] of failures) if (entry.resetAt <= now) failures.delete(address);
  }, 60_000);
  prune.unref();

  function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname !== STREAM_PATH) return; // not ours: Socket.IO and the rest handle their own paths
    socket.on("error", () => socket.destroy());

    if (req.method !== "GET") return reject(socket, 405, "Method Not Allowed");
    if (!isEnabled()) return reject(socket, 404, "Not Found");
    // A query string has no business here, and a token in one would be written to every access log on the way.
    if (url.search) return reject(socket, 400, "Bad Request");
    if (req.headers.origin !== undefined) return reject(socket, 403, "Forbidden");
    if (!isSecureTransport(req, deps.trustProxy)) return reject(socket, 403, "Forbidden");

    const address = clientAddress(req, deps.trustProxy);
    const now = Date.now();
    const failed = failuresFor(address, now);
    if (failed.count >= limits.maxFailuresPerAddress) return reject(socket, 429, "Too Many Requests");
    if (open.size >= limits.maxConnections) return reject(socket, 503, "Service Unavailable");

    const header = req.headers.authorization;
    const raw = typeof header === "string" ? BEARER.exec(header)?.[1] : undefined;
    const token = raw ? verifyToken(raw) : null;
    if (!token) {
      failed.count += 1;
      auditLog("status-stream", "status-stream.connect", address, "fail", { reason: raw ? "token" : "header" });
      return reject(socket, 401, "Unauthorized");
    }

    const perToken = [...open.values()].filter((connection) => connection.tokenId === token.id).length;
    if (perToken >= limits.maxConnectionsPerToken) return reject(socket, 429, "Too Many Requests");

    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, token, address));
  }

  function serve(ws: WebSocket, token: ApiToken, address: string): void {
    const scope: Scope = { group: token.projectGroup };
    const connection: StreamConnection = { tokenId: token.id, tokenName: token.name, address, since: new Date().toISOString(), group: token.projectGroup };
    open.set(ws, connection);
    auditLog(`token:${token.name}`, "status-stream.connect", address, "ok", { tokenId: token.id, group: token.projectGroup });

    let seq = 0;
    let alive = true;
    let ready = false;
    const lastSent = new Map<StatusSection, string>();
    const queued = new Set<StatusSection>();

    const send = (message: StatusMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > limits.maxBufferedBytes) { ws.terminate(); return; }
      ws.send(JSON.stringify(message));
    };
    const at = (): string => new Date().toISOString();

    const sendSection = (section: StatusSection): void => {
      const full = hub.peek();
      if (!full) return;
      const data = scopeSection(full, section, scope);
      const serialized = JSON.stringify(data);
      if (lastSent.get(section) === serialized) return;
      lastSent.set(section, serialized);
      seq += 1;
      send({ type: "update", v: STATUS_PROTOCOL_VERSION, seq, at: at(), section, data });
    };

    // Subscribe first and hold what arrives until the snapshot is out, so an update cannot overtake it.
    const unsubscribe = hub.subscribe(({ section }) => { if (ready) sendSection(section); else queued.add(section); });

    send({ type: "hello", v: STATUS_PROTOCOL_VERSION, instance: instance(), sections: [...STATUS_SECTIONS], scope: scope.group === null ? "all" : "group" });
    void hub.current().then((full) => {
      if (ws.readyState !== ws.OPEN) return;
      const data = scopeSnapshot(full, scope);
      // eslint-disable-next-line security/detect-object-injection -- the key is one of the fixed section names.
      for (const section of STATUS_SECTIONS) lastSent.set(section, JSON.stringify(data[section]));
      seq += 1;
      send({ type: "snapshot", v: STATUS_PROTOCOL_VERSION, seq, at: at(), data });
      ready = true;
      for (const section of queued) sendSection(section);
      queued.clear();
    }).catch(() => ws.close(1011, "unavailable"));

    ws.on("pong", () => { alive = true; });
    // The server expects nothing from the client. A data frame is a client that is not an adapter, or one that is misbehaving.
    ws.on("message", () => ws.close(1008, "receive-only"));
    ws.on("error", () => ws.terminate());

    const timers = [
      setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false;
        ws.ping();
      }, limits.pingMs),
      setInterval(() => { seq += 1; send({ type: "heartbeat", v: STATUS_PROTOCOL_VERSION, seq, at: at() }); }, limits.heartbeatMs),
      setInterval(() => {
        if (!isEnabled()) ws.close(1001, "stream disabled");
        else if (!isTokenActive(token.id)) ws.close(4001, "token revoked or expired");
      }, limits.revalidateMs),
    ];
    for (const timer of timers) timer.unref();

    ws.on("close", () => {
      for (const timer of timers) clearInterval(timer);
      unsubscribe();
      open.delete(ws);
      auditLog(`token:${token.name}`, "status-stream.disconnect", address, "ok", { tokenId: token.id });
    });
  }

  server.on("upgrade", onUpgrade);

  const stream: StatusStream = {
    close() {
      server.off("upgrade", onUpgrade);
      clearInterval(prune);
      for (const ws of open.keys()) ws.close(1001, "server stopping");
      wss.close();
      if (active === stream) active = null;
    },
    disconnectAll(reason) {
      for (const ws of open.keys()) ws.close(1001, reason);
    },
    connections: () => [...open.values()],
  };
  active = stream;
  return stream;
}
