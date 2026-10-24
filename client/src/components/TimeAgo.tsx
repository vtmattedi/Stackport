import { formatShortDateTime, formatTimeAgo } from "../lib/format";

/** Relative time ("3m ago") with the exact time on hover: the one way the app shows "when did this last happen". */
export function TimeAgo({ ts, fallback = "Never" }: { ts: string | null | undefined; fallback?: string }) {
  if (!ts) return <>{fallback}</>;
  return <time dateTime={ts} title={formatShortDateTime(ts)}>{formatTimeAgo(ts, fallback)}</time>;
}
