/** The one place that decides how many log lines may be asked for and which service names are acceptable, for the admin API, the peer-facing control API and the controller's proxy. */

export const LOG_TAIL = { min: 10, max: 1000, fallback: 100 } as const;

/** A Compose service name: letters, digits, dots, underscores and hyphens, not starting with a hyphen, so it can never be read as an option. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LogQuery {
  tail: number;
  service: string | undefined;
}

/** Returns null when the service name is not a plain name. An absent or empty service means every service. */
export function parseLogQuery(query: { tail?: unknown; service?: unknown }): LogQuery | null {
  const tail = Math.min(Math.max(parseInt(String(query.tail ?? LOG_TAIL.fallback), 10) || LOG_TAIL.fallback, LOG_TAIL.min), LOG_TAIL.max);
  const raw = typeof query.service === "string" ? query.service.trim() : "";
  if (!raw) return { tail, service: undefined };
  return SERVICE_NAME.test(raw) ? { tail, service: raw } : null;
}
