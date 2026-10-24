import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "lucide-react";
import { api } from "../api/client";
import type { ActionRecord } from "../api/types";
import { useSocket } from "../context/SocketContext";
import { useSystem } from "../context/SystemContext";
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

function systemItem(action: ActionRecord | null, href: string): RunningItem | null {
  if (!action || action.status !== "running") return null;
  const domain = typeof action.meta?.["domain"] === "string" ? action.meta["domain"] : null;
  return { id: action.id, label: actionLabel(action.kind), subject: domain, href, startedAt: action.startedAt };
}

/** Every action running on the server right now (project builds, deploys and SSL, plus nginx,
 *  certbot and docker jobs), kept current by the server's actions:changed ping. */
export function useRunningActions(): RunningItem[] {
  const { on, off, connected } = useSocket();
  const { systemActions } = useSystem();
  const [projectItems, setProjectItems] = useState<RunningItem[]>([]);

  const refetch = useCallback(() => {
    api.getRunningProjectActions().then((running) => {
      setProjectItems(running.map(({ action, projectId, projectName }) => ({
        id: action.id,
        label: actionLabel(action.kind),
        subject: projectName,
        href: projectId != null ? `/projects/${projectId}` : "/projects",
        startedAt: action.startedAt,
      })));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (connected) refetch();
  }, [connected, refetch]);

  useEffect(() => {
    on("actions:changed", refetch);
    return () => off("actions:changed", refetch);
  }, [on, off, refetch]);

  const systemItems = [
    systemItem(systemActions.nginx, "/system?tab=nginx"),
    systemItem(systemActions.docker, "/system?tab=docker"),
    ...systemActions.certbot.map((action) => systemItem(action, "/system?tab=certbot")),
  ].filter((item): item is RunningItem => item !== null);

  return [...projectItems, ...systemItems];
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
