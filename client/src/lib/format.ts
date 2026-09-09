const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function truncateLabel(value: string, max = 28): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(max - 1, 1))}…`;
}

export function formatShortDateTime(ts: string | null | undefined, fallback = "Never"): string {
  if (!ts) return fallback;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return fallback;
  const day = String(date.getDate()).padStart(2, "0");
  const month = MONTHS[date.getMonth()];
  const year = String(date.getFullYear()).slice(2);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year}, ${hour}:${minute}`;
}

export function formatShortDate(ts: string): string {
  return formatShortDateTime(ts).split(",")[0] ?? "";
}

/** MM:ss, computed client-side from a startedAt timestamp — never streamed from the
 *  backend. Minutes keep counting past 59 for very long-running builds rather than
 *  rolling into an hours segment. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimeAgo(ts: string | null | undefined, fallback = "Never"): string {
  if (!ts) return fallback;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return fallback;
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 5)   return "just now";
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7)     return `${d}d ago`;
  return formatShortDateTime(ts, fallback);
}
