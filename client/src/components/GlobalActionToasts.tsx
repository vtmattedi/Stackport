import { useEffect, useRef } from "react";
import { api } from "../api/client";
import type { ActionSummary } from "../api/types";
import { actionTracker } from "../context/ActionTracker";
import { jsonEqual, useSystemSelector } from "../context/SystemContext";
import { actionLabel } from "../lib/actionLabels";
import { truncateLabel } from "../lib/format";
import { notify } from "../lib/notify";
import { BuildProgressToast } from "./BuildProgressToast";

type ToastId = string | number;

/** Kinds the server can cancel mid-run (long-lived docker/git processes). */
const CANCELABLE_KINDS = new Set(["pull", "compose", "deploy", "build", "recreate", "force-rebuild", "redeploy-service", "rollback"]);
/** Kinds that run a docker compose build/up, shown with a progress bar. */
const BUILD_PROGRESS_KINDS = new Set(["build", "compose", "deploy", "recreate", "force-rebuild", "rollback", "redeploy-service"]);
/** Kinds whose server flow already sends step-by-step nginx:flow / docker:flow events,
 *  which GlobalRealtime shows as toasts; a second toast here would duplicate them. */
const FLOW_TOASTED_KINDS = new Set(["nginx-apply", "nginx-app", "ssl-issue", "docker-prune"]);
const FAILURE_LOG_LINES = 12;

function subjectOf(record: ActionSummary, projectNames: Record<number, string>): string | null {
  const domain = typeof record.meta?.["domain"] === "string" ? record.meta["domain"] : null;
  const service = typeof record.meta?.["service"] === "string" ? record.meta["service"] : null;
  const project = record.projectId !== undefined ? projectNames[record.projectId] ?? null : null;
  if (project && (domain || service)) return `${truncateLabel(project)} (${domain ?? service})`;
  return project ? truncateLabel(project) : domain;
}

async function failureMessage(record: ActionSummary, label: string): Promise<string> {
  const log = await api.getActionLog(record.id).catch(() => "");
  const tail = log.trimEnd().split("\n").slice(-FAILURE_LOG_LINES).join("\n");
  return tail || `${label} failed`;
}

/**
 * One toast per server action, from start to finish, wherever it was started: this
 * tab, another tab, an auto-deploy, the MCP endpoint. Actions already running when the
 * page loads (or while the socket was down) are picked up by the tracker's resync.
 */
export function GlobalActionToasts() {
  const projectNames = useSystemSelector(
    (s) => Object.fromEntries((s.projects ?? []).map((p) => [p.id, p.name])) as Record<number, string>,
    jsonEqual,
  );
  const namesRef = useRef(projectNames);
  namesRef.current = projectNames;

  useEffect(() => {
    const toasts = new Map<string, ToastId>();
    const titleOf = (record: ActionSummary) => {
      const subject = subjectOf(record, namesRef.current);
      return `${subject ? `${subject}: ` : ""}${actionLabel(record.kind)}`;
    };

    const show = (record: ActionSummary) => {
      if (toasts.has(record.id) || FLOW_TOASTED_KINDS.has(record.kind)) return;
      const title = titleOf(record);
      let toastId: ToastId = "";
      const cancel = record.projectId !== undefined && CANCELABLE_KINDS.has(record.kind)
        ? {
            label: "Cancel",
            onClick: () => {
              notify.loading(`${title}: cancelling...`, { id: toastId });
              void api.cancelProjectAction(record.projectId!).catch(() => {});
            },
          }
        : undefined;
      toastId = record.projectId !== undefined && BUILD_PROGRESS_KINDS.has(record.kind)
        ? notify.loading(
            <BuildProgressToast
              projectId={record.projectId}
              title={title}
              initialPhase={record.phase}
              initialProgress={record.progress}
              startedAt={record.startedAt}
              onDone={() => { /* completion comes from the tracker */ }}
            />,
            { action: cancel },
          )
        : notify.loading(`${title}...`, { action: cancel });
      toasts.set(record.id, toastId);
    };

    const finish = async (record: ActionSummary) => {
      const toastId = toasts.get(record.id);
      if (toastId === undefined) return;
      toasts.delete(record.id);
      const title = titleOf(record);
      if (record.meta?.["cancelledByUser"]) notify.success(`${title} cancelled.`, { id: toastId });
      else if (record.ok) notify.success(`${title} completed.`, { id: toastId });
      else notify.error(new Error(`${title} failed`), `${title} failed`, { id: toastId, description: await failureMessage(record, actionLabel(record.kind)) });
    };

    for (const record of actionTracker.runningActions()) show(record);
    const offStart = actionTracker.onStarted(show);
    const offFinish = actionTracker.onFinished((record) => { void finish(record); });
    return () => {
      offStart();
      offFinish();
      for (const id of toasts.values()) notify.dismiss(id);
    };
  }, []);

  return null;
}
