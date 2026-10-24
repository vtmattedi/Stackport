import { History, Loader, RotateCw } from "lucide-react";
import type { ProjectDeploy, ProjectDeploymentRevision } from "../../api/types";
import { ExpandableCard } from "../../components/ExpandableCard";
import { TimeAgo } from "../../components/TimeAgo";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import styles from "../ProjectDetails.module.scss";

const TRIGGER_LABEL: Record<ProjectDeploy["triggeredBy"], string> = { auto: "poller", webhook: "webhook", manual: "manual" };

/** Everything about past deploys in one place: what ran (and what started it), and the
 *  revisions Roll back can restore. */
export function DeploymentsCard({ deploys, revisions, loading, rollingBack, onRollback }: {
  deploys: ProjectDeploy[];
  revisions: ProjectDeploymentRevision[];
  loading: boolean;
  rollingBack: boolean;
  onRollback: () => void;
}) {
  const restorable = revisions.filter((r) => r.status !== "failed").length;
  const active = revisions.find((r) => r.status === "active") ?? null;
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
          onClick={onRollback}
          disabled={rollingBack || restorable < 2}
          title={restorable < 2 ? "Needs an earlier successful revision to go back to" : "Restore the previous successful revision's commit and compose file, then redeploy"}
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
                <span className={styles.historyMeta}>{TRIGGER_LABEL[d.triggeredBy]}</span>
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
                <span className={styles.historyMeta}><TimeAgo ts={rev.createdAt} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ExpandableCard>
  );
}
