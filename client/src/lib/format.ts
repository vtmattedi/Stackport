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

/** 1536 -> "1.5 KB"; binary units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Bytes per second, e.g. "1.5 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Seconds to "3d 4h", "5h 12m" or "7m". */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
