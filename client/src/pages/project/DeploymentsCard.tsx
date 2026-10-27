import { History, Loader, RotateCw } from "lucide-react";
import type { ProjectDeploy, ProjectDeploymentRevision } from "../../api/types";
import { ExpandableCard } from "../../components/ExpandableCard";
import { TimeAgo } from "../../components/TimeAgo";
import { Button } from "../../components/ui/button";
import { ACTION_LABEL } from "../../lib/actionLabels";
import { cn } from "../../lib/utils";
import styles from "../ProjectDetails.module.scss";

const TRIGGER_LABEL: Record<ProjectDeploy["triggeredBy"], string> = { auto: "poller", webhook: "webhook", manual: "manual" };

/** A revision that may be restored, as far as the client can tell; the server makes
 *  the final call (it also compares the stored compose files). */
function isRestorable(rev: ProjectDeploymentRevision, active: ProjectDeploymentRevision | null): boolean {
  if (rev.status !== "superseded" || !rev.commitSha || !rev.composeFileName) return false;
  return !active || rev.commitSha !== active.commitSha || rev.composeFileName !== active.composeFileName;
}

/** Everything about past deploys in one place: what ran (and what started it), and the
 *  revisions Roll back can restore. */
export function DeploymentsCard({ deploys, revisions, loading, rollingBack, onRollback }: {
  deploys: ProjectDeploy[];
  revisions: ProjectDeploymentRevision[];
  loading: boolean;
  rollingBack: boolean;
  /** No target: the server's default (newest earlier revision not rolled back from). */
  onRollback: (target?: ProjectDeploymentRevision) => void;
}) {
  const active = revisions.find((r) => r.status === "active") ?? null;
  const canRollBack = revisions.some((r) => !r.rolledBackAt && isRestorable(r, active));
  return (
    <ExpandableCard
      icon={<History size={13} />}
      title="Deployments"
      storageKey="project.deployments"
      defaultOpen
      summary={active?.commitSha
        ? <span className={styles.cardSummaryText}>live: <span className="mono">{active.commitSha.slice(0, 7)}</span>{active.branch ? ` · ${active.branch}` : ""}</span>
        : undefined}
      actions={(
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onRollback()}
          disabled={rollingBack || !canRollBack}
          title={canRollBack
            ? "Restore the newest earlier revision you haven't rolled back from, then redeploy"
            : "Needs an earlier successful revision to go back to. Use Restore on a revision to pick one explicitly"}
        >
          {rollingBack ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
          Roll back
        </Button>
      )}
    >
      <div className={styles.historyBlock}>
        <div className={styles.historyHeading}>Recent deploys</div>
        {deploys.length === 0 ? (
          <div className="muted-text">{loading ? "Loading…" : "No deploys recorded yet."}</div>
        ) : (
          <ul className={styles.historyList}>
            {deploys.slice(0, 10).map((d) => (
              <li key={d.id}>
                <span className={cn(styles.statusPill, d.status === "success" ? styles.statusUp : d.status === "failed" ? styles.statusDown : styles.statusUnknown)}>{d.status}</span>
                <span className={styles.historyMeta}>{d.kind === "deploy" ? TRIGGER_LABEL[d.triggeredBy] : (ACTION_LABEL[d.kind] ?? d.kind).toLowerCase()}</span>
                <span className="mono">{d.commitSha ? d.commitSha.slice(0, 7) : "—"}</span>
                <span className={styles.historyMessage} title={d.commitMessage ?? undefined}>{d.commitMessage ?? ""}</span>
                <span className={styles.historyMeta}><TimeAgo ts={d.createdAt} /></span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {revisions.length > 0 && (
        <div className={styles.historyBlock}>
          <div className={styles.historyHeading}>Revisions</div>
          <ul className={styles.historyList}>
            {revisions.slice(0, 8).map((rev) => (
              <li key={rev.id}>
                <span className={cn(styles.statusPill, rev.status === "active" ? styles.statusUp : rev.status === "failed" ? styles.statusDown : styles.statusUnknown)}>{rev.status}</span>
                <span className="mono">{rev.commitSha ? rev.commitSha.slice(0, 7) : "—"}</span>
                <span className={styles.historyMessage}>{[rev.branch, rev.composeFileName].filter(Boolean).join(" · ")}</span>
                {rev.healthFailedAt && (
                  <span className={cn(styles.statusPill, styles.statusDown)} title="The health check didn't pass after this deploy">
                    unhealthy
                  </span>
                )}
                {rev.rolledBackAt && (
                  <span className={styles.historyMeta} title="A rollback moved away from this revision, so Roll back skips it. Restore still works.">
                    rolled back
                  </span>
                )}
                <span className={styles.historyMeta}><TimeAgo ts={rev.createdAt} /></span>
                {isRestorable(rev, active) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onRollback(rev)}
                    disabled={rollingBack}
                    aria-label={`Restore revision ${rev.commitSha?.slice(0, 7)}`}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ExpandableCard>
  );
}
