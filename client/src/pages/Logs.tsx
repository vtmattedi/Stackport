import { useState, useEffect, useCallback, type FormEvent } from "react";
import { ScrollText, RefreshCw, CheckCircle2, XCircle, Search, X, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../api/client";
import type { AuditEntry } from "../api/types";
import { AppSelect } from "../components/AppSelect";
import { formatShortDateTime } from "../lib/format";
import { cn } from "../lib/utils";
import styles from "./Logs.module.scss";

function formatTs(ts: string): string {
  return formatShortDateTime(ts, "never");
}

const PAGE_SIZE = 25;

type LogRange = "always" | "1d" | "1w" | "1m";

interface LogFilters {
  actor: string;
  action: string;
  target: string;
  range: LogRange;
}

const EMPTY_FILTERS: LogFilters = {
  actor: "",
  action: "",
  target: "",
  range: "always",
};

const RANGE_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
];

function trimFilters(filters: LogFilters): LogFilters {
  return {
    actor: filters.actor.trim(),
    action: filters.action.trim(),
    target: filters.target.trim(),
    range: filters.range,
  };
}

function rangeToFromIso(range: LogRange): string | undefined {
  if (range === "always") return undefined;
  const date = new Date();
  if (range === "1d") {
    date.setDate(date.getDate() - 1);
  } else if (range === "1w") {
    date.setDate(date.getDate() - 7);
  } else {
    date.setMonth(date.getMonth() - 1);
  }
  return date.toISOString();
}

export default function Logs() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setError(null);
    try {
      const data = await api.getLogs({
        actor: filters.actor || undefined,
        action: filters.action || undefined,
        target: filters.target || undefined,
        from: rangeToFromIso(filters.range),
        page,
        pageSize: PAGE_SIZE,
      });
      setLogs(data.entries);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs");
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    setFilters(trimFilters(draftFilters));
  }

  function clearFilters(): void {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  const activeFilters = Boolean(filters.actor || filters.action || filters.target || filters.range !== "always");
  const draftHasFilters = Boolean(draftFilters.actor || draftFilters.action || draftFilters.target || draftFilters.range !== "always");
  const startRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endRow = Math.min(page * PAGE_SIZE, total);

  return (
    <>
      <main className="main">
        <div className="page-header">
          <h1 className="page-title">
            <ScrollText size={20} />
            Audit Logs
          </h1>
          <button
            className="btn btn-ghost"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {lastRefresh && (
            <span className="muted-text">Updated {formatTs(lastRefresh.toISOString())}</span>
          )}
        </div>

        <form className={cn("card", styles.filterPanel)} onSubmit={handleFilterSubmit}>
          <div className="field">
            <label htmlFor="log-actor">Actor</label>
            <input
              id="log-actor"
              type="text"
              placeholder="admin"
              value={draftFilters.actor}
              onChange={(event) => setDraftFilters((current) => ({ ...current, actor: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="log-action">Action</label>
            <input
              id="log-action"
              type="text"
              placeholder="project.deploy"
              value={draftFilters.action}
              onChange={(event) => setDraftFilters((current) => ({ ...current, action: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="log-target">Target</label>
            <input
              id="log-target"
              type="text"
              placeholder="api.example.com"
              value={draftFilters.target}
              onChange={(event) => setDraftFilters((current) => ({ ...current, target: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="log-range">Range</label>
            <AppSelect
              value={draftFilters.range}
              onValueChange={(value) => setDraftFilters((current) => ({ ...current, range: value as LogRange }))}
              options={RANGE_OPTIONS}
              triggerClassName={styles.rangeSelect}
            />
          </div>
          <div className={styles.filterActions}>
            <button type="submit" className="btn btn-primary">
              <Search size={14} />
              Search
            </button>
            <button type="button" className="btn btn-ghost" onClick={clearFilters} disabled={!activeFilters && !draftHasFilters}>
              <X size={14} />
              Clear
            </button>
          </div>
        </form>

        <div className="card">
          {error ? (
            <div className="alert alert-error">{error}</div>
          ) : loading ? (
            <div className="empty">Loading…</div>
          ) : logs.length === 0 ? (
            <div className="empty">{activeFilters ? "No audit entries match those filters." : "No audit entries yet."}</div>
          ) : (
            <>
              <div className={styles.resultBar}>
                <span className="muted-text">
                  Showing {startRow}-{endRow} of {total}
                </span>
                <div className={styles.pagination}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPage((current) => Math.max(current - 1, 1))}
                    disabled={page <= 1 || refreshing}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </button>
                  <span className={cn("muted-text", styles.pageText)}>Page {page} of {totalPages}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
                    disabled={page >= totalPages || refreshing}
                  >
                    Next
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                <table className={styles.logsTable}>
                  <thead>
                    <tr>
                      <th className={styles.colTime}>Time</th>
                      <th className={styles.colActor}>Actor</th>
                      <th className={styles.colAction}>Action</th>
                      <th className={styles.colTarget}>Target</th>
                      <th className={styles.colResult}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((e) => (
                      <tr key={`${e.ts}-${e.actor}-${e.action}-${e.target}`}>
                        <td className={cn(styles.colTime, "mono", "nowrap")}>{formatTs(e.ts)}</td>
                        <td className={styles.colActor}>{e.actor}</td>
                        <td className={cn(styles.colAction, "mono", "nowrap")}>{e.action}</td>
                        <td className={styles.colTarget}>{e.target}</td>
                        <td className={styles.colResult}>
                          <span className={`badge ${e.result === "ok" ? "badge-ok" : "badge-fail"}`}>
                            {e.result === "ok" ? (
                              <CheckCircle2 size={11} />
                            ) : (
                              <XCircle size={11} />
                            )}
                            {e.result}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
