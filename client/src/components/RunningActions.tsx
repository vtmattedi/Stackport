import { Link } from "react-router-dom";
import { CircleCheck, CircleX, Loader } from "lucide-react";
import type { ActionSummary } from "../api/types";
import { actionTracker, useRecentlyFinishedActions, useRunningActionRecords } from "../context/ActionTracker";
import { jsonEqual, useSystemSelector } from "../context/SystemContext";
import { actionLabel } from "../lib/actionLabels";
import { TimeAgo } from "./TimeAgo";
import styles from "./RunningActions.module.scss";

export interface RunningItem {
  id: string;
  label: string;
  /** Project name, certificate domain, or nothing for server-wide actions. */
  subject: string | null;
  href: string;
  startedAt: string;
  /** Set once finished: whether it succeeded, and when. */
  ok?: boolean | null;
  completedAt?: string | null;
}

/** Where a running action is followed: its project, or the System tab it belongs to. */
function hrefFor(record: ActionSummary): string {
  if (record.projectId !== undefined) return `/projects/${record.projectId}`;
  if (record.key.startsWith("system:certbot:")) return "/host/certbot";
  if (record.key.startsWith("system:docker")) return "/host/docker";
  if (record.key.startsWith("system:nginx")) return "/host/nginx";
  return "/host";
}

/** Every action running on the server right now (project builds, deploys and SSL, plus
 *  nginx, certbot and docker jobs), kept current by the action tracker's socket events. */
export function useRunningActions(): RunningItem[] {
  return useActionItems(useRunningActionRecords());
}

/** Actions that finished while this page was open, newest first; a reload clears them. */
export function useRecentActions(): RunningItem[] {
  return useActionItems(useRecentlyFinishedActions());
}

function useActionItems(records: ActionSummary[]): RunningItem[] {
  const projectNames = useSystemSelector(
    (s) => Object.fromEntries((s.projects ?? []).map((p) => [p.id, p.name])) as Record<number, string>,
    jsonEqual,
  );
  return records.map((record) => {
    const domain = typeof record.meta?.["domain"] === "string" ? record.meta["domain"] : null;
    return {
      id: record.id,
      label: actionLabel(record.kind),
      subject: (record.projectId !== undefined ? projectNames[record.projectId] : null) ?? domain,
      href: hrefFor(record),
      startedAt: record.startedAt,
      ...(record.status !== "running" ? { ok: record.ok, completedAt: record.completedAt } : {}),
    };
  });
}

/** The list itself; the nav decides where it opens (sidebar popover or the phone menu). */
export function RunningActionsList({ items, onNavigate }: { items: RunningItem[]; onNavigate?: () => void }) {
  if (items.length === 0) return <div className={styles.empty}>Nothing running.</div>;
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.id}>
          <Link to={item.href} className={styles.item} onClick={onNavigate}>
            {item.completedAt === undefined ? <Loader size={13} className="spin" />
              : item.ok ? <CircleCheck size={13} className={styles.ok} /> : <CircleX size={13} className={styles.failed} />}
            <span className={styles.text}>
              <span className={styles.label}>{item.subject ? `${item.subject}: ` : ""}{item.label}</span>
              <span className={styles.meta}>
                {item.completedAt === undefined
                  ? <>started <TimeAgo ts={item.startedAt} /></>
                  : <>{item.ok ? "finished" : "failed"} {item.completedAt ? <TimeAgo ts={item.completedAt} /> : null}</>}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The action runner's current state for the status strip: what runs now, then what
 *  finished since this page loaded. */
export function ActionsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const running = useRunningActions();
  const recent = useRecentActions();
  return (
    <div className={styles.panel}>
      <div className={styles.heading}>Running now</div>
      <RunningActionsList items={running} onNavigate={onNavigate} />
      {recent.length > 0 && (
        <>
          <div className={styles.heading}>
            Finished since this page loaded
            <button type="button" className={styles.clear} onClick={() => actionTracker.clearRecentlyFinished()}>Clear</button>
          </div>
          <RunningActionsList items={recent} onNavigate={onNavigate} />
        </>
      )}
    </div>
  );
}
