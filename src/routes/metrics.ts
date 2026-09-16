import { Router } from "express";
import { execFile } from "child_process";
import * as os from "os";
import { requireAuth } from "../middleware/auth";
import { getDatabase } from "../config/database";
import { cachedVms } from "../services/vps";
import { HEALTH_CHECK_USER_AGENT } from "../services/healthChecker";

const router = Router();
router.use(requireAuth);

const NGINX_LOG_SOURCE = "docker:stackport-nginx";
const CLEARED_AT_KEY = "nginx_traffic_cleared_at";

const NGINX_LOG_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseNginxDate(timeLocal: string): Date | null {
  const m = timeLocal.match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/);
  if (!m) return null;
  const [, day, monStr, year, hour, min, sec, tz] = m;
  const month = NGINX_LOG_MONTHS[monStr];
  if (month === undefined) return null;
  const tzSign = tz[0] === "-" ? -1 : 1;
  const tzH = parseInt(tz.slice(1, 3), 10);
  const tzM = parseInt(tz.slice(3, 5), 10);
  const tzOffsetMs = tzSign * (tzH * 60 + tzM) * 60000;
  const utcMs = Date.UTC(parseInt(year, 10), month, parseInt(day, 10), parseInt(hour, 10), parseInt(min, 10), parseInt(sec, 10)) - tzOffsetMs;
  return new Date(utcMs);
}

const MIN_DEPLOY_DAYS = 1;
const MAX_DEPLOY_DAYS = 90;

function clampDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(n, MIN_DEPLOY_DAYS), MAX_DEPLOY_DAYS);
}

router.get("/", (req, res) => {
  const db = getDatabase();
  const days = clampDays(req.query.days);

  // Deploy stats: grouped by day + status, over the requested window
  const deployRows = db.prepare(`
    SELECT date(created_at) AS day, status, COUNT(*) AS cnt
    FROM project_deploys
    WHERE created_at >= datetime('now', ?)
    GROUP BY day, status
    ORDER BY day ASC
  `).all(`-${days} days`) as Array<{ day: string; status: string; cnt: number }>;

  const byDayMap: Record<string, { date: string; success: number; failed: number }> = {};
  for (const r of deployRows) {
    byDayMap[r.day] ??= { date: r.day, success: 0, failed: 0 };
    if (r.status === "success") byDayMap[r.day].success += r.cnt;
    else if (r.status === "failed") byDayMap[r.day].failed += r.cnt;
  }

  const windowArg = `-${days} days`;
  const totalDeploys = (db.prepare("SELECT COUNT(*) AS c FROM project_deploys WHERE created_at >= datetime('now', ?)").get(windowArg) as { c: number }).c;
  const successDeploys = (db.prepare("SELECT COUNT(*) AS c FROM project_deploys WHERE status = 'success' AND created_at >= datetime('now', ?)").get(windowArg) as { c: number }).c;
  const failedDeploys = (db.prepare("SELECT COUNT(*) AS c FROM project_deploys WHERE status = 'failed' AND created_at >= datetime('now', ?)").get(windowArg) as { c: number }).c;

  const recentFailedDeploys = db.prepare(`
    SELECT pd.id, pd.project_id, p.name AS project_name, pd.created_at
    FROM project_deploys pd
    JOIN projects p ON p.id = pd.project_id
    WHERE pd.status = 'failed' AND pd.created_at >= datetime('now', ?)
    ORDER BY pd.created_at DESC
    LIMIT 10
  `).all(windowArg) as Array<{ id: number; project_id: number; project_name: string; created_at: string }>;

  // Health check stats from projects — a live snapshot of current status, not
  // windowed by period: there's no history of past checks to filter, only the
  // latest result per project.
  const healthProjects = db.prepare(`
    SELECT id, name, last_status, last_checked_at, last_response_ms
    FROM projects
    WHERE health_check_interval_s > 0
    ORDER BY name ASC
  `).all() as Array<{ id: number; name: string; last_status: string; last_checked_at: string | null; last_response_ms: number | null }>;

  // Notification log stats, scoped to the same window as deploys
  const notifTotal = (db.prepare("SELECT COUNT(*) AS c FROM notification_logs WHERE sent_at >= datetime('now', ?)").get(windowArg) as { c: number }).c;
  const notifSuccess = (db.prepare("SELECT COUNT(*) AS c FROM notification_logs WHERE result = 'ok' AND sent_at >= datetime('now', ?)").get(windowArg) as { c: number }).c;

  res.json({
    deploys: {
      total: totalDeploys,
      success: successDeploys,
      failed: failedDeploys,
      byDay: Object.values(byDayMap),
      recentFailures: recentFailedDeploys.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        createdAt: r.created_at,
      })),
    },
    healthChecks: {
      projects: healthProjects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.last_status,
        lastCheckedAt: p.last_checked_at,
        lastResponseMs: p.last_response_ms,
      })),
    },
    notifications: {
      total: notifTotal,
      success: notifSuccess,
      failed: notifTotal - notifSuccess,
    },
  });
});

const BOT_UA_RE = /bot|crawler|spider|slurp|googlebot|bingbot|yandex|baidu|duckduckgo|facebookexternalhit|ahrefsbot|semrushbot|mj12bot/i;

function pct(sortedArr: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function parseNginxLine(line: string) {
  // Extended stackport format: ...'"agent" "host" rt'
  const ext = line.match(/^(\S+) - \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d+) (\d+) "[^"]*" "([^"]*)" "([^"]*)" (\S+)/);
  if (ext) {
    const [, ip, timeLocal, method, path, status, bytes, ua, host, rtStr] = ext;
    const rt = rtStr === "-" ? null : parseFloat(rtStr);
    return {
      ip, date: parseNginxDate(timeLocal), method, path,
      status: parseInt(status, 10), bytes: parseInt(bytes, 10),
      ua: ua || null, host: host === "-" ? null : host,
      requestTimeMs: rt != null && !isNaN(rt) ? Math.round(rt * 1000) : null,
    };
  }
  // Standard combined format
  const m = line.match(/^(\S+) - \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d+) (\d+) "[^"]*" "([^"]*)"/);
  if (m) {
    const [, ip, timeLocal, method, path, status, bytes, ua] = m;
    return {
      ip, date: parseNginxDate(timeLocal), method, path,
      status: parseInt(status, 10), bytes: parseInt(bytes, 10),
      ua: ua || null, host: null, requestTimeMs: null,
    };
  }
  const f = line.match(/^(\S+) - \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d+) (\d+)/);
  if (!f) return null;
  const [, ip, timeLocal, method, path, status, bytes] = f;
  return {
    ip, date: parseNginxDate(timeLocal), method, path,
    status: parseInt(status, 10), bytes: parseInt(bytes, 10),
    ua: null, host: null, requestTimeMs: null,
  };
}

const PERIOD_HOURS: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };
const TAIL_BYTES: Record<string, number> = { "24h": 2_000_000, "7d": 10_000_000, "30d": 30_000_000 };

function getServerIps(): Set<string> {
  const ips = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of (iface ?? [])) ips.add(addr.address);
  }
  // Health checks hit public domains that route back through nginx, so the
  // logged source is the VPS's public IP (NAT'd by the cloud provider) —
  // never visible via os.networkInterfaces(). Pull it from the cached
  // Hostinger VM data instead.
  try {
    for (const vm of cachedVms()) {
      const addrs = (vm as { ipAddresses?: unknown }).ipAddresses;
      if (Array.isArray(addrs)) {
        for (const addr of addrs) if (typeof addr === "string") ips.add(addr);
      }
    }
  } catch {
    // VPS not configured — fall back to interface/loopback IPs only
  }
  return ips;
}

interface DomainAgg {
  requests: number;
  errors: number;
  bytes: number;
  rts: number[];
  statusCodes: Record<string, number>;
  pathCounts: Record<string, number>;
  methodCounts: Record<string, number>;
  tsStats: Record<string, { count: number; errors: number }>;
}

function parseNginxContent(
  content: string,
  isPartial: boolean,
  periodHours: number,
  excludeIps: Set<string>,
  excludeSelf: boolean,
) {
  const lines = content.split("\n").filter(Boolean);
  const startIdx = isPartial ? 1 : 0;

  const now = Date.now();
  const periodMs = periodHours * 3600 * 1000;
  const periodStart = now - periodMs;
  const granularity: "hour" | "day" = periodHours <= 24 ? "hour" : "day";

  const statusCodes: Record<string, number> = {};
  const pathCounts: Record<string, number> = {};
  const tsStats: Record<string, { count: number; errors: number }> = {};
  const domainMap = new Map<string, DomainAgg>();
  const methodCounts: Record<string, number> = {};
  const uniqueIps = new Set<string>();
  let totalRequests = 0;
  let totalBytes = 0;
  let botRequests = 0;
  let hasExtendedFormat = false;
  const allRts: number[] = [];

  function buildTimeSeries(stats: Record<string, { count: number; errors: number }>) {
    const series: Array<{ ts: string; count: number; errors: number }> = [];
    if (granularity === "hour") {
      for (let h = periodHours - 1; h >= 0; h--) {
        const d = new Date(now - h * 3600 * 1000);
        const key = d.toISOString().slice(0, 13);
        const s = stats[key] ?? { count: 0, errors: 0 };
        series.push({ ts: key + ":00", count: s.count, errors: s.errors });
      }
    } else {
      const days = Math.ceil(periodHours / 24);
      for (let d = days - 1; d >= 0; d--) {
        const date = new Date(now - d * 86_400_000);
        const key = date.toISOString().slice(0, 10);
        const s = stats[key] ?? { count: 0, errors: 0 };
        series.push({ ts: key, count: s.count, errors: s.errors });
      }
    }
    return series;
  }

  for (let i = startIdx; i < lines.length; i++) {
    const entry = parseNginxLine(lines[i]);
    if (!entry) continue;
    if (excludeIps.has(entry.ip)) continue;
    if (excludeSelf && entry.ua === HEALTH_CHECK_USER_AGENT) continue;
    if (entry.host) hasExtendedFormat = true;
    if (!entry.date || entry.date.getTime() < periodStart) continue;

    totalRequests++;
    totalBytes += entry.bytes;
    uniqueIps.add(entry.ip);

    const codeKey = String(entry.status);
    statusCodes[codeKey] = (statusCodes[codeKey] ?? 0) + 1;
    methodCounts[entry.method] = (methodCounts[entry.method] ?? 0) + 1;

    const isError = entry.status >= 400;
    if (entry.ua && BOT_UA_RE.test(entry.ua)) botRequests++;
    if (entry.requestTimeMs != null) allRts.push(entry.requestTimeMs);

    const tsKey = granularity === "hour"
      ? entry.date.toISOString().slice(0, 13)
      : entry.date.toISOString().slice(0, 10);
    const ts = tsStats[tsKey] ?? (tsStats[tsKey] = { count: 0, errors: 0 });
    ts.count++;
    if (isError) ts.errors++;

    const cleanPath = entry.path ? entry.path.split("?")[0] : null;
    if (cleanPath) pathCounts[cleanPath] = (pathCounts[cleanPath] ?? 0) + 1;

    if (entry.host) {
      let ds = domainMap.get(entry.host);
      if (!ds) {
        ds = { requests: 0, errors: 0, bytes: 0, rts: [], statusCodes: {}, pathCounts: {}, methodCounts: {}, tsStats: {} };
        domainMap.set(entry.host, ds);
      }
      ds.requests++;
      ds.bytes += entry.bytes;
      if (isError) ds.errors++;
      if (entry.requestTimeMs != null) ds.rts.push(entry.requestTimeMs);
      ds.statusCodes[codeKey] = (ds.statusCodes[codeKey] ?? 0) + 1;
      ds.methodCounts[entry.method] = (ds.methodCounts[entry.method] ?? 0) + 1;
      if (cleanPath) ds.pathCounts[cleanPath] = (ds.pathCounts[cleanPath] ?? 0) + 1;
      const dts = ds.tsStats[tsKey] ?? (ds.tsStats[tsKey] = { count: 0, errors: 0 });
      dts.count++;
      if (isError) dts.errors++;
    }
  }

  const timeSeries = buildTimeSeries(tsStats);

  const topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, count }));

  const errorCount = Object.entries(statusCodes)
    .filter(([code]) => parseInt(code, 10) >= 400)
    .reduce((sum, [, c]) => sum + c, 0);

  const domains = Array.from(domainMap.entries())
    .map(([host, ds]) => {
      const sorted = [...ds.rts].sort((a, b) => a - b);
      const avgRtMs = sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null;
      const domainTopPaths = Object.entries(ds.pathCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([path, count]) => ({ path, count }));
      return {
        host,
        requests: ds.requests,
        errors: ds.errors,
        bytes: ds.bytes,
        avgRtMs,
        statusCodes: ds.statusCodes,
        methodCounts: ds.methodCounts,
        topPaths: domainTopPaths,
        timeSeries: buildTimeSeries(ds.tsStats),
      };
    })
    .sort((a, b) => b.requests - a.requests);

  allRts.sort((a, b) => a - b);

  return {
    totalRequests,
    errorRate: totalRequests > 0 ? errorCount / totalRequests : 0,
    statusCodes,
    topPaths,
    timeSeries,
    granularity,
    domains,
    bytesTotal: totalBytes,
    uniqueIps: uniqueIps.size,
    botRequests,
    methodCounts,
    p50ResponseMs: allRts.length > 0 ? pct(allRts, 50) : null,
    p95ResponseMs: allRts.length > 0 ? pct(allRts, 95) : null,
    hasExtendedFormat,
  };
}

function readNginxLog(periodHours: number, bytes: number, cb: (err: Error | null, stdout: string) => void): void {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(CLEARED_AT_KEY) as { value: string } | undefined;
  const cutoff = row ? Date.parse(row.value) : 0;
  const since = new Date(Math.max(Date.now() - periodHours * 3600_000, Number.isFinite(cutoff) ? cutoff : 0)).toISOString();
  // Official nginx writes access logs to stdout and errors to stderr. Reading the
  // Docker API works as the app user without host log permissions or sudo.
  execFile("docker", ["logs", "--since", since, "--tail", "20000", "stackport-nginx"],
    { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) { cb(new Error("Cannot read stackport-nginx Docker logs. Check the container and Docker access."), ""); return; }
      // Preserve complete lines when bounding the returned window.
      const content = Buffer.from(stdout);
      const tail = content.length > bytes ? content.subarray(content.length - bytes).toString("utf8") : stdout;
      cb(null, content.length > bytes ? tail.slice(tail.indexOf("\n") + 1) : tail);
    });
}

router.get("/nginx", (req, res) => {
  const periodKey = typeof req.query.period === "string" && req.query.period in PERIOD_HOURS
    ? req.query.period
    : "24h";
  const periodHours = PERIOD_HOURS[periodKey]!;
  const tailBytes = TAIL_BYTES[periodKey]!;
  const serverIps = getServerIps();
  const excludeServerIp = req.query.excludeServerIp === "true";
  const excludeHealthChecks = req.query.excludeHealthChecks === "true";
  const excludeSelf = excludeServerIp || excludeHealthChecks;
  const excludeIps = excludeServerIp ? serverIps : new Set<string>();

  const parse = (stdout: string, logPath: string) =>
    res.json({
      available: true,
      logPath,
      period: periodKey,
      serverIps: Array.from(serverIps),
      ...parseNginxContent(stdout, false, periodHours, excludeIps, excludeSelf),
    });

  readNginxLog(periodHours, tailBytes, (err, stdout) => {
    if (err) { res.json({ available: false, error: err.message, serverIps: Array.from(serverIps) }); return; }
    parse(stdout, NGINX_LOG_SOURCE);
  });
});

interface NginxEntry {
  time: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string | null;
  host: string | null;
  requestTimeMs: number | null;
}

function extractNginxEntries(
  content: string,
  isPartial: boolean,
  periodHours: number,
  excludeIps: Set<string>,
  excludeSelf: boolean,
  hostFilter: string | undefined,
  limit: number,
): { entries: NginxEntry[]; truncated: boolean; hasExtendedFormat: boolean } {
  const lines = content.split("\n").filter(Boolean);
  const startIdx = isPartial ? 1 : 0;

  const now = Date.now();
  const periodStart = now - periodHours * 3600 * 1000;

  const entries: NginxEntry[] = [];
  let hasExtendedFormat = false;
  let matched = 0;

  for (let i = lines.length - 1; i >= startIdx; i--) {
    const entry = parseNginxLine(lines[i]);
    if (!entry) continue;
    if (excludeIps.has(entry.ip)) continue;
    if (excludeSelf && entry.ua === HEALTH_CHECK_USER_AGENT) continue;
    if (entry.host) hasExtendedFormat = true;
    if (!entry.date || entry.date.getTime() < periodStart) continue;
    if (hostFilter && entry.host !== hostFilter) continue;

    matched++;
    if (entries.length < limit) {
      entries.push({
        time: entry.date.toISOString(),
        ip: entry.ip,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        bytes: entry.bytes,
        ua: entry.ua,
        host: entry.host,
        requestTimeMs: entry.requestTimeMs,
      });
    }
  }

  return { entries, truncated: matched > entries.length, hasExtendedFormat };
}

router.get("/nginx/requests", (req, res) => {
  const periodKey = typeof req.query.period === "string" && req.query.period in PERIOD_HOURS
    ? req.query.period
    : "24h";
  const periodHours = PERIOD_HOURS[periodKey]!;
  const tailBytes = TAIL_BYTES[periodKey]!;
  const serverIps = getServerIps();
  const excludeServerIp = req.query.excludeServerIp === "true";
  const excludeHealthChecks = req.query.excludeHealthChecks === "true";
  const excludeSelf = excludeServerIp || excludeHealthChecks;
  const excludeIps = excludeServerIp ? serverIps : new Set<string>();
  const hostFilter = typeof req.query.host === "string" && req.query.host ? req.query.host : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "500"), 10) || 500, 1), 2000);

  const parse = (stdout: string, logPath: string) =>
    res.json({
      available: true,
      logPath,
      period: periodKey,
      serverIps: Array.from(serverIps),
      ...extractNginxEntries(stdout, false, periodHours, excludeIps, excludeSelf, hostFilter, limit),
    });

  readNginxLog(periodHours, tailBytes, (err, stdout) => {
    if (err) { res.json({ available: false, error: err.message, serverIps: Array.from(serverIps) }); return; }
    parse(stdout, NGINX_LOG_SOURCE);
  });
});

// Clearing the Traffic view stores a cutoff; Docker owns and rotates its logs.
router.post("/nginx/clear", (_req, res) => {
  getDatabase().prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(CLEARED_AT_KEY, new Date().toISOString());
  res.json({ ok: true });
});

export default router;
