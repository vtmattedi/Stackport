import http from "http";
import https from "https";
import net from "net";
import tls, { type TLSSocket } from "tls";
import { HEADERS, newNonce, safeEqual, signRequest, signResponse } from "./signing";

/** The calling side of the control channel: reaches a peer, optionally pinning its TLS certificate, and checks the response was signed with the shared key. */

export class PeerUnreachable extends Error {}
export class PeerIdentityError extends Error {}

export interface PeerResponse<T = unknown> {
  status: number;
  body: T;
  /** True when the response carried a valid signature from the shared key. Unsigned responses (errors from a proxy, a wrong server) are never trusted as the peer. */
  verified: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Plain http is accepted only to this machine (tests, a local proxy); everything else must be https. */
export function assertEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new PeerUnreachable("The peer endpoint is not a valid URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new PeerUnreachable("A peer endpoint must use https.");
  if (url.username || url.password) throw new PeerUnreachable("A peer endpoint must not contain credentials.");
  // Control paths are absolute (/control/v1/...), so a prefix would be silently dropped and the calls would land elsewhere.
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new PeerUnreachable("A peer endpoint is a bare address (https://host[:port]), without a path or query.");
  return url;
}

/** Connects over TLS and checks the certificate against the pin BEFORE anything is sent. Passing the socket to the request afterwards
 *  means the pairing secret or signed headers can never reach a server that presented another certificate. */
function connectPinned(url: URL, fingerprint: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (error: Error): void => { socket.destroy(); reject(error); };
    socket.once("timeout", () => fail(new PeerUnreachable("The peer did not answer in time.")));
    socket.once("error", (error) => fail(new PeerUnreachable(`Could not reach the peer: ${error.message}`)));
    socket.once("secureConnect", () => {
      const presented = (socket.getPeerCertificate().fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
      if (!presented || !safeEqual(presented, fingerprint.replace(/:/g, "").toLowerCase())) { fail(new PeerIdentityError("The peer's certificate is not the one that was pinned when it was registered.")); return; }
      socket.setTimeout(0);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

async function rawRequest(endpoint: string, fingerprint: string | null, method: string, path: string, headers: Record<string, string>, body: Buffer, timeoutMs: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const base = assertEndpoint(endpoint);
  const target = new URL(path, base.origin);
  const secure = target.protocol === "https:";
  // A pinned certificate replaces CA validation (a self-signed Stackport has none); without a pin the normal chain is checked.
  const pinned = secure && fingerprint ? await connectPinned(target, fingerprint, timeoutMs) : null;
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = { method, headers: { ...headers, "content-length": String(body.length) }, timeout: timeoutMs };
    if (pinned) {
      // The global agent would hand the request a pooled socket and ignore this one (leaking it), and would validate the chain again.
      // A dedicated agent that returns exactly this connection, used once and closed with the request, avoids both.
      const agent = new https.Agent({ keepAlive: false });
      (agent as unknown as { createConnection: () => TLSSocket }).createConnection = () => pinned;
      options.agent = agent;
      options.headers = { ...options.headers, connection: "close" };
    }
    const request = (secure ? https : http).request(target, options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { request.destroy(new PeerUnreachable("The peer's response is too large.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("close", () => { pinned?.destroy(); });
    request.on("timeout", () => request.destroy(new PeerUnreachable("The peer did not answer in time.")));
    request.on("error", (error) => reject(error instanceof PeerIdentityError || error instanceof PeerUnreachable ? error : new PeerUnreachable(`Could not reach the peer: ${error.message}`)));
    request.end(body);
  });
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return null;
  try { return JSON.parse(body.toString("utf8")); } catch { return null; }
}

export interface SignedCall {
  endpoint: string;
  fingerprint: string | null;
  key: string;
  selfId: string;
  targetId: string;
  method: string;
  path: string;
  body?: unknown;
  /** Names a mutation: the peer treats a repeated operation id as the same operation. */
  operationId?: string;
  timeoutMs?: number;
}

export async function signedCall<T = unknown>(call: SignedCall): Promise<PeerResponse<T>> {
  const body = call.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(call.body));
  const timestamp = String(Date.now());
  const nonce = newNonce();
  const headers: Record<string, string> = {
    [HEADERS.protocol]: "1",
    [HEADERS.instance]: call.selfId,
    [HEADERS.target]: call.targetId,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: signRequest(call.key, { method: call.method, path: call.path, from: call.selfId, to: call.targetId, timestamp, nonce, body }),
    accept: "application/json",
  };
  if (body.length) headers["content-type"] = "application/json";
  if (call.operationId) headers[HEADERS.operation] = call.operationId;
  const response = await rawRequest(call.endpoint, call.fingerprint, call.method, call.path, headers, body, call.timeoutMs ?? 10_000);
  const claimed = response.headers[HEADERS.responseSignature];
  const verified = typeof claimed === "string" && safeEqual(claimed, signResponse(call.key, nonce, response.status, response.body));
  return { status: response.status, body: parseJson(response.body) as T, verified };
}

/** The one unsigned call: presents a pairing code. The response carries the key, so it can only be trusted over a pinned or CA-validated channel. */
export async function pairCall<T = unknown>(endpoint: string, fingerprint: string | null, body: unknown, timeoutMs = 10_000): Promise<{ status: number; body: T }> {
  const payload = Buffer.from(JSON.stringify(body));
  const response = await rawRequest(endpoint, fingerprint, "POST", "/control/v1/pair", { "content-type": "application/json", accept: "application/json", [HEADERS.protocol]: "1" }, payload, timeoutMs);
  return { status: response.status, body: parseJson(response.body) as T };
}
