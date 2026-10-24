import { useEffect, useRef, useState } from "react";
import { KeyRound, Check, Loader, GitPullRequestArrow, Boxes } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { AppVersionInfo, SelfUpdateStatus } from "../../api/types";
import { Button } from "../../components/ui/button";
import { formatShortDateTime } from "../../lib/format";
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

  useEffect(() => {
    api.getVersion().then(setVersionInfo).catch(() => {});
  }, []);

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

  function formatBuild(value: string | null | undefined) {
    if (!value) return "Not built yet";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatShortDateTime(value);
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
          <div className={styles.versionGrid}>
            <div className={styles.versionItem}>
              <span>Backend</span>
              <strong>{versionInfo?.backend.version ?? "-"}</strong>
              <small>{formatBuild(versionInfo?.backend.builtAt)}</small>
              {versionInfo?.backend.gitCommit && (
                <small>
                  {versionInfo.backend.gitBranch || "git"} @ {versionInfo.backend.gitCommit}
                  {versionInfo.backend.gitMessage && <span className="muted-text"> — {versionInfo.backend.gitMessage}</span>}
                </small>
              )}
            </div>
            <div className={styles.versionItem}>
              <span>Frontend</span>
              <strong>{versionInfo?.frontend.version ?? "-"}</strong>
              <small>{formatBuild(versionInfo?.frontend.builtAt)}</small>
              {versionInfo?.frontend.gitCommit && (
                <small>
                  {versionInfo.frontend.gitBranch || "git"} @ {versionInfo.frontend.gitCommit}
                  {versionInfo.frontend.gitMessage && <span className="muted-text"> — {versionInfo.frontend.gitMessage}</span>}
                </small>
              )}
            </div>
          </div>

          <div className="row-actions" style={{ marginTop: 14 }}>

            <button className="btn btn-primary" type="button" onClick={() => void runSelfUpdate()} disabled={updatingApp}>
              {updatingApp ? <Loader size={13} className="spin" /> : <GitPullRequestArrow size={13} />}
              Update Stackport
            </button>
          </div>
          {(
            <span className="muted-text" style={{ display: "block", marginTop: 8 }}>
              Pulls the latest source, backs up the database and updates Stackport. Failed health checks restore the previous version. Progress resumes after a restart or page reload.
            </span>
          )}

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
