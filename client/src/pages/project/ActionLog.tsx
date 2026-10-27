import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Loader, XCircle } from "lucide-react";
import type { ProjectDeploymentRevision } from "../../api/types";
import { actionLabel } from "../../lib/actionLabels";
import { cn } from "../../lib/utils";
import { TimeAgo } from "../../components/TimeAgo";
import { useActionOutput } from "../../hooks/useActionOutput";
import styles from "../ProjectDetails.module.scss";

/** The last repo-slot action that finished on this page (or was found finished on load). */
export interface FinishedAction {
  kind: string;
  ok: boolean | null;
  at: string | null;
}

const DEPLOYING_KINDS = new Set(["deploy", "compose", "build", "recreate", "force-rebuild", "rollback", "upload"]);

function summary(action: FinishedAction, revision: ProjectDeploymentRevision | null): string {
  const label = actionLabel(action.kind);
  if (action.ok === false) return `${label} failed. The log has the details.`;
  if (DEPLOYING_KINDS.has(action.kind) && revision?.status === "active" && revision.commitSha) {
    return `Deployed ${revision.commitSha.slice(0, 7)}${revision.branch ? ` from ${revision.branch}` : ""}`;
  }
  if (action.kind === "stop" || action.kind === "stop-purge") return "Stopped";
  return `${label} finished`;
}

/** One line saying how the last action ended, with its log folded underneath.
 *  The log opens by itself while an action runs or after one fails. `actionId` is
 *  the running action, else the last finished one: its output is attached live, so
 *  leaving and coming back (or reloading) mid-build picks the log up where it is. */
export function ActionResult({ actionId, running, finished, latestRevision }: {
  actionId: string | null;
  running: boolean;
  finished: FinishedAction | null;
  latestRevision: ProjectDeploymentRevision | null;
}) {
  const { text: log } = useActionOutput(actionId);
  const failed = finished?.ok === false;
  const [open, setOpen] = useState(running || failed);
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => { if (running || failed) setOpen(true); }, [running, failed]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log, open]);

  if (!running && !finished && !log) return null;
  return (
    <div className={styles.actionResult}>
      <div className={styles.actionResultLine}>
        {running ? <Loader size={13} className="spin" />
          : failed ? <XCircle size={13} className={styles.actionFailed} />
          : <CheckCircle2 size={13} className={styles.actionOk} />}
        <span className={cn(failed && styles.actionFailed)}>
          {running ? "Running…" : finished ? summary(finished, latestRevision) : "Last action log"}
        </span>
        {!running && finished?.at && <span className="muted-text"><TimeAgo ts={finished.at} /></span>}
        {log && (
          <button type="button" className={styles.logToggle} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <ChevronRight size={12} className={cn(styles.sectionChevron, open && styles.sectionChevronOpen)} />
            {open ? "Hide log" : "Show log"}
          </button>
        )}
      </div>
      {open && log && (
        <pre ref={ref} className={cn("output-block", failed && "output-stderr")}>{log}</pre>
      )}
    </div>
  );
}
