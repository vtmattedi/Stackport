import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { PreviewCommit, Project, RevisionPreview as Preview } from "../api/types";
import { useSystemActions } from "../context/SystemContext";
import { useConfirm } from "./ConfirmDialog";
import { TimeAgo } from "./TimeAgo";
import styles from "./RevisionPreview.module.scss";

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

function CommitList({ commits, total, sign, label }: { commits: PreviewCommit[]; total: number; sign: "+" | "−"; label: string }) {
  if (total === 0) return null;
  // GitHub returns oldest first; newest first reads better here.
  const newestFirst = [...commits].reverse();
  return (
    <div className={styles.section}>
      <div className={styles.heading}>{label} ({total})</div>
      <ul className={styles.commits}>
        {newestFirst.map((c) => (
          <li key={c.sha}>
            <span className={sign === "+" ? styles.add : styles.remove}>{sign}</span>
            <span className="mono">{shortSha(c.sha)}</span>
            <span className={styles.message} title={c.message}>{c.message}</span>
            <span className={styles.meta}>{c.author ?? ""}{c.date ? <> · <TimeAgo ts={c.date} /></> : null}</span>
          </li>
        ))}
        {total > commits.length && <li className={styles.meta}>and {total - commits.length} older</li>}
      </ul>
    </div>
  );
}

function ComposeDiff({ compose }: { compose: NonNullable<Preview["compose"]> }) {
  const renamed = compose.fromFile !== compose.toFile;
  const basis = compose.basis === "effective" ? "as each revision ran" : "as committed";
  return (
    <div className={styles.section}>
      <div className={styles.heading}>
        Compose file{renamed ? ` (${compose.fromFile ?? "?"} → ${compose.toFile ?? "?"})` : compose.toFile ? ` (${compose.toFile})` : ""}, {basis}
      </div>
      {compose.diff.identical ? (
        <div className={styles.meta}>No changes.</div>
      ) : compose.diff.tooLarge ? (
        <div className={styles.meta}>Too large to show a diff.</div>
      ) : (
        <pre className={styles.diff}>
          {compose.diff.hunks.map((hunk, h) => (
            <div key={h}>
              <div className={styles.hunk}>@@ -{hunk.oldStart} +{hunk.newStart} @@</div>
              {hunk.lines.map((line, i) => (
                <div key={i} className={line.type === "add" ? styles.lineAdd : line.type === "remove" ? styles.lineRemove : undefined}>
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}{line.text}
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** What a deploy or rollback would change, for the confirm dialog: the commits between
 *  the running revision and the target, and the Compose diff. Loads on mount. */
export function RevisionPreview({ queryKey, load, direction }: {
  queryKey: readonly unknown[];
  load: () => Promise<Preview>;
  direction: "deploy" | "rollback";
}) {
  const { data, error, isPending } = useQuery({ queryKey, queryFn: load, staleTime: 0, gcTime: 0, retry: false });

  if (isPending) {
    return <div className={styles.loading}><Loader size={13} className="spin" /> Loading what changes…</div>;
  }
  if (error || !data) {
    return <div className={styles.note}>Couldn't load the preview: {error instanceof ApiError ? error.message : "request failed"}</div>;
  }

  const { from, to, commits } = data;
  return (
    <div className={styles.preview}>
      <div className={styles.revisions}>
        <span>Running <span className="mono">{shortSha(from?.sha)}</span>{from?.branch ? ` · ${from.branch}` : ""}</span>
        <span aria-hidden>→</span>
        <span>{direction === "deploy" ? "Deploys" : "Restores"} <span className="mono">{shortSha(to.sha)}</span>{to.branch ? ` · ${to.branch}` : ""}</span>
      </div>

      {commits ? (
        commits.status === "identical" ? (
          <div className={styles.meta}>Same commit as the running revision{direction === "deploy" ? ": this rebuilds it." : "."}</div>
        ) : (
          <>
            {commits.status === "diverged" && (
              <div className={styles.note}>The two revisions have diverged: some commits are added and others removed.</div>
            )}
            <CommitList commits={commits.added} total={commits.addedTotal} sign="+" label={direction === "deploy" ? "New commits" : "Commits brought back"} />
            <CommitList commits={commits.removed} total={commits.removedTotal} sign="−" label={direction === "deploy" ? "Commits no longer included" : "Commits undone"} />
          </>
        )
      ) : data.commitsNote && <div className={styles.note}>{data.commitsNote}</div>}

      {data.compose ? <ComposeDiff compose={data.compose} /> : data.composeNote && <div className={styles.note}>{data.composeNote}</div>}
    </div>
  );
}

/** Deploy with the preview confirmation: used by the project page and the command
 *  palette. Resolves once the deploy has started, or was cancelled. */
export function useDeployWithPreview(): (project: Pick<Project, "id" | "autoDeployBranch">, branch?: string) => Promise<void> {
  const confirm = useConfirm();
  const { startProjectAction } = useSystemActions();
  return useCallback(async (project, branch) => {
    const ok = await confirm({
      title: `Deploy ${branch ?? project.autoDeployBranch ?? "the branch"}?`,
      description: "Pulls the branch head, then runs docker compose up -d --build.",
      confirmLabel: "Deploy",
      body: (
        <RevisionPreview
          direction="deploy"
          queryKey={["project", project.id, "deploy-preview", branch ?? null]}
          load={() => api.getDeployPreview(project.id, branch)}
        />
      ),
    });
    if (ok) await startProjectAction(project.id, "deploy", branch ? { branch } : undefined);
  }, [confirm, startProjectAction]);
}
