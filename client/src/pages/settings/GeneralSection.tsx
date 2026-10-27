import { useEffect, useRef, useState } from "react";
import { KeyRound, Check, Loader, GitPullRequestArrow, Boxes, RefreshCw, GitBranch, ChevronRight } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { AppUpdateCheck, AppVersionInfo, CommitInfo, SelfUpdateStatus } from "../../api/types";
import { Button } from "../../components/ui/button";
import { formatShortDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import styles from "../Settings.module.scss";

/** Stackport's own version and self-update, plus the admin password. */
export default function GeneralSection() {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const updateMounted = useRef(true);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateSuccess, setUpdateSuccess] = useState("");
  const [updateOutput, setUpdateOutput] = useState("");
  const [updateCheck, setUpdateCheck] = useState<AppUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.getVersion().then(setVersionInfo).catch(() => {});
    void checkForUpdates();
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    try {
      const result = await api.checkAppUpdate();
      if (updateMounted.current) setUpdateCheck(result);
    } catch (err) {
      if (updateMounted.current) setUpdateCheck(null);
      console.warn("update check failed", err);
    } finally {
      if (updateMounted.current) setChecking(false);
    }
  }

  useEffect(() => {
    updateMounted.current = true;
    let cancelled = false;
    api.getSelfUpdateStatus().then(status => {
      if (cancelled || !status) return;
      setUpdateOutput(status.output);
      if (status.status === "running") { setUpdatingApp(true); void monitorUpdate(status.id); }
      else showUpdateResult(status);
    }).catch(() => {});
    return () => { cancelled = true; updateMounted.current = false; };
  }, []);

  function showUpdateResult(status: SelfUpdateStatus) {
    setUpdatingApp(false);
    setUpdateOutput(status.output);
    if (status.status === "success") {
      setUpdateSuccess("Stackport is up to date.");
      void api.getVersion().then(setVersionInfo).catch(() => {});
      void checkForUpdates();
    } else {
      setUpdateError(status.status === "rolled-back"
        ? "Update failed health checks. The previous version was restored."
        : "Stackport update failed. Review the output below.");
    }
  }

  async function monitorUpdate(id: string) {
    const deadline = Date.now() + 30 * 60_000;
    while (updateMounted.current && Date.now() < deadline) {
      try {
        const status = await api.getSelfUpdateStatus();
        if (!updateMounted.current) return;
        if (status?.id === id) {
          setUpdateOutput(status.output);
          if (status.status !== "running") { showUpdateResult(status); return; }
        }
      } catch { /* The app can be unreachable while it is replaced. */ }
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    if (!updateMounted.current) return;
    setUpdatingApp(false);
    setUpdateError("The update is still unconfirmed. Reload this page to check its status.");
  }

  async function runSelfUpdate() {
    setUpdatingApp(true);
    setUpdateError(""); setUpdateSuccess(""); setUpdateOutput("");
    try {
      const status = await api.runSelfUpdate();
      if (!updateMounted.current) return;
      setUpdateOutput(status.output);
      await monitorUpdate(status.id);
    } catch (error) {
      setUpdatingApp(false);
      setUpdateError(error instanceof ApiError ? error.message : "Failed to start update");
    }
  }

  const commit = versionInfo?.commit ?? updateCheck?.current ?? null;
  const upToDate = !!updateCheck?.ok && updateCheck.available.length === 0;

  function commitLink(c: CommitInfo) {
    return updateCheck?.commitUrl
      ? <a href={updateCheck.commitUrl + c.sha} target="_blank" rel="noreferrer"><code>{c.shortSha}</code></a>
      : <code>{c.shortSha}</code>;
  }

  function commitList(commits: CommitInfo[]) {
    return (
      <ul className={styles.commitList}>
        {commits.map(c => (
          <li key={c.sha}>
            {commitLink(c)}
            <span className={styles.commitMessage} title={c.message}>{c.message}</span>
            {c.date && <span className={styles.commitDate}>{formatShortDateTime(c.date)}</span>}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
        <div className="card">
          <div className="card-title"><Boxes size={13} />Version Control</div>
          {updateError && <div className="alert alert-error">{updateError}</div>}
          {updateSuccess && (
            <div className="alert alert-success">
              <Check size={14} />{updateSuccess}
            </div>
          )}
          <div className={styles.versionCurrent}>
            <span>Running</span>
            <strong>{versionInfo ? `v${versionInfo.version}` : "-"}</strong>
            <div className={styles.versionMeta}>
              {updateCheck?.branch && <span className={styles.versionBranch}><GitBranch size={11} />{updateCheck.branch}</span>}
              {commit && commitLink(commit)}
              {commit?.message && <span className={styles.versionMessage} title={commit.message}>{commit.message}</span>}
              {commit?.date && <span>{formatShortDateTime(commit.date)}</span>}
              {!commit && versionInfo && <span>Commit unknown until the next update.</span>}
            </div>
          </div>
          {updateCheck && !updateCheck.ok && updateCheck.error && (
            <div className="alert alert-error" style={{ marginTop: 12 }}>{updateCheck.error}</div>
          )}
          {updateCheck?.ok && (updateCheck.available.length > 0 ? (
            <details className={styles.updateGroup}>
              <summary>
                <ChevronRight size={13} className={styles.summaryChevron} />
                {updateCheck.available.length} update{updateCheck.available.length === 1 ? "" : "s"} ready on <code>{updateCheck.branch}</code>
              </summary>
              {commitList(updateCheck.available)}
            </details>
          ) : (
            <p className={cn("muted-text", styles.upToDate)}>Up to date with <code>{updateCheck.branch}</code>.</p>
          ))}
          {updateCheck?.ok && updateCheck.pending.length > 0 && (
            <details className={styles.updateGroup}>
              <summary>
                <ChevronRight size={13} className={styles.summaryChevron} />
                <span className="muted-text">
                  {updateCheck.pending.length} newer commit{updateCheck.pending.length === 1 ? "" : "s"} on <code>main</code>, not released yet
                </span>
              </summary>
              <p className="muted-text">They reach <code>{updateCheck.branch}</code> once CI and the upgrade test pass.</p>
              {commitList(updateCheck.pending)}
            </details>
          )}
          <div className={cn("row-actions", styles.versionActions)} style={{ marginTop: 14 }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void runSelfUpdate()}
              disabled={updatingApp || upToDate}
              title={upToDate ? "Already on the latest released version" : undefined}
            >
              {updatingApp ? <Loader size={13} className="spin" /> : <GitPullRequestArrow size={13} />}
              Update Stackport
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => void checkForUpdates()} disabled={checking || updatingApp}>
              <RefreshCw size={13} className={checking ? "spin" : undefined} />
              Check for updates
            </button>
          </div>
          <span className="muted-text" style={{ display: "block", marginTop: 8 }}>
            Builds the new version first, backs up the database, then switches over. A version that fails its checks is rolled back automatically. Progress resumes after a restart or page reload.
          </span>

          {updateOutput && <pre className={styles.updateOutput}>{updateOutput}</pre>}
        </div>

        <div className="card">
          <div className={styles.passwordRow}>
            <div>
              <div className="card-title"><KeyRound size={12} />Admin password</div>
              <span className="muted-text">The password used to sign in to this Stackport.</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
              <KeyRound size={13} />
              Change password
            </Button>
          </div>
        </div>

        {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}
    </>
  );
}
