import { Link } from "react-router-dom";
import { Loader } from "lucide-react";
import type { ActionSummary } from "../api/types";
import { useRunningActionRecords } from "../context/ActionTracker";
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
  const running = useRunningActionRecords();
  const projectNames = useSystemSelector(
    (s) => Object.fromEntries((s.projects ?? []).map((p) => [p.id, p.name])) as Record<number, string>,
    jsonEqual,
  );
  return running.map((record) => {
    const domain = typeof record.meta?.["domain"] === "string" ? record.meta["domain"] : null;
    return {
      id: record.id,
      label: actionLabel(record.kind),
      subject: (record.projectId !== undefined ? projectNames[record.projectId] : null) ?? domain,
      href: hrefFor(record),
      startedAt: record.startedAt,
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
            <Loader size={13} className="spin" />
            <span className={styles.text}>
              <span className={styles.label}>{item.subject ? `${item.subject}: ` : ""}{item.label}</span>
              <span className={styles.meta}>started <TimeAgo ts={item.startedAt} /></span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
