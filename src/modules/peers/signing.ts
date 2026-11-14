import crypto from "crypto";

/** The control protocol this build speaks. Bump the number for an incompatible change; hello advertises every version supported. */
export const PROTOCOL_NAME = "sp-control/v1";
export const PROTOCOL_VERSIONS: readonly number[] = [1];
/** Requests older or newer than this are refused, which bounds how long a nonce must be remembered. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A nonce must be remembered for as long as a request carrying it could still pass the timestamp check (either side of now), so this is derived from the skew, never set separately. */
export const NONCE_RETENTION_MS = 2 * MAX_CLOCK_SKEW_MS;
/** A rotated-out key still verifies this long, so a rotation whose answer was lost can be retried. */
export const KEY_ROTATION_GRACE_MS = 60 * 60 * 1000;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const HEADERS = {
  protocol: "x-sp-protocol",
  instance: "x-sp-instance", // the caller's instance_id
  target: "x-sp-target", // the instance_id the caller believes it is talking to
  timestamp: "x-sp-timestamp",
  nonce: "x-sp-nonce",
  signature: "x-sp-signature",
  operation: "x-sp-operation", // idempotency key and audit correlation id for a mutation
  responseSignature: "x-sp-response-signature",
} as const;

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function newKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function hmac(key: string, text: string): string {
  return crypto.createHmac("sha256", key).update(text).digest("hex");
}

export interface SignedRequest {
  method: string;
  /** Path including the query string, as sent. */
  path: string;
  from: string;
  to: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
}

/** Binds the key to this caller, this target, this exact request and moment, so a captured request cannot be replayed elsewhere. */
export function signRequest(key: string, request: SignedRequest): string {
  return hmac(key, ["sp-control/v1", request.method.toUpperCase(), request.path, request.from, request.to, request.timestamp, request.nonce, sha256Hex(request.body)].join("\n"));
}

/** Lets the caller know the responder holds the shared key, so a different server at the same address cannot pass as the peer. */
export function signResponse(key: string, nonce: string, status: number, body: Buffer): string {
  return hmac(key, ["sp-control/v1/response", nonce, String(status), sha256Hex(body)].join("\n"));
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
