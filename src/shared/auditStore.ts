import fs from "fs";
import path from "path";
import { config } from "../config/env";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  target: string;
  result: "ok" | "fail";
  meta?: Record<string, unknown>;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditResult {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const CAPACITY = 500;
const DISK_READ_LIMIT = 1_000;
const auditLogPath = path.join(config.logDir, "audit.log");
const appLogPath = path.join(config.logDir, "app.log");
const store: AuditEntry[] = [];
let loadedFromDisk = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuditEntry(value: unknown): AuditEntry | null {
  if (!isRecord(value)) return null;

  const ts = value["ts"];
  const actor = value["actor"];
  const action = value["action"];
  const target = value["target"];
  const result = value["result"];
  const meta = value["meta"];

  if (
    typeof ts !== "string" ||
    typeof actor !== "string" ||
    typeof action !== "string" ||
    typeof target !== "string" ||
    (result !== "ok" && result !== "fail")
  ) {
    return null;
  }

  return {
    ts,
    actor,
    action,
    target,
    result,
    ...(isRecord(meta) ? { meta } : {}),
  };
}

function readJsonLines(filePath: string, onlyAuditRecords: boolean): AuditEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    return lines
      .slice(-DISK_READ_LIMIT)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (onlyAuditRecords && (!isRecord(parsed) || parsed["audit"] !== true)) {
            return null;
          }
          return parseAuditEntry(parsed);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => entry !== null);
  } catch {
    return [];
  }
}

function entryKey(entry: AuditEntry): string {
  return `${entry.ts}\0${entry.actor}\0${entry.action}\0${entry.target}\0${entry.result}`;
}

function loadFromDisk(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;

  const entries = [...readJsonLines(auditLogPath, false), ...readJsonLines(appLogPath, true)];
  const seen = new Set(store.map(entryKey));

  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    store.push(entry);
  }

  store.sort((a, b) => b.ts.localeCompare(a.ts));
  if (store.length > CAPACITY) store.length = CAPACITY;
}

export function pushAuditEntry(entry: AuditEntry): void {
  loadFromDisk();
  store.unshift(entry);
  if (store.length > CAPACITY) store.length = CAPACITY;

  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Keep audit events available in memory even if the log directory is unavailable.
  }
}

export function getAuditEntries(limit = 100): readonly AuditEntry[] {
  loadFromDisk();
  return store.slice(0, limit);
}

function includesFilter(value: string, filter: string | undefined): boolean {
  if (!filter) return true;
  return value.toLowerCase().includes(filter.toLowerCase());
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function queryAuditEntries(query: AuditQuery = {}): AuditResult {
  loadFromDisk();

  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const fromTime = parseTime(query.from);
  const toTime = parseTime(query.to);
  const filtered = store.filter((entry) => {
    const entryTime = Date.parse(entry.ts);
    return includesFilter(entry.actor, query.actor) &&
      includesFilter(entry.action, query.action) &&
      includesFilter(entry.target, query.target) &&
      (fromTime === null || (Number.isFinite(entryTime) && entryTime >= fromTime)) &&
      (toTime === null || (Number.isFinite(entryTime) && entryTime <= toTime));
  });
  const total = filtered.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const normalizedPage = Math.min(page, totalPages);
  const start = (normalizedPage - 1) * pageSize;

  return {
    entries: filtered.slice(start, start + pageSize),
    total,
    page: normalizedPage,
    pageSize,
    totalPages,
  };
}
