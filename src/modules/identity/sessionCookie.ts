/**
 * The browser session lives in an httpOnly cookie (S6), so a script on the page can
 * never read it. The cookie is `SameSite=Strict`, which keeps the browser from sending
 * it on cross-site requests; as a second layer, a cookie-authenticated request that
 * changes state must also carry a header a cross-site page cannot add without a CORS
 * preflight (which this app refuses). A token sent as `Authorization: Bearer` is not
 * ambient, so it needs neither.
 */

export const SESSION_COOKIE = "stackport_session";

/** Set by the web app on every request. */
export const CLIENT_HEADER = "x-requested-with";
export const CLIENT_HEADER_VALUE = "stackport";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

export function buildSessionCookie(token: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(1, Math.floor(options.maxAgeSeconds))}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function buildClearedSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

/** True when a cookie-authenticated request is allowed to go ahead. */
export function passesCsrfCheck(method: string, clientHeader: string | undefined): boolean {
  return SAFE_METHODS.has(method.toUpperCase()) || clientHeader === CLIENT_HEADER_VALUE;
}

/** A WebSocket handshake cannot carry the header, so check where it came from instead:
 *  no Origin (not a browser) is fine, a browser's must be this host. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}
